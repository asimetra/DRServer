import { loadGameMaster } from "../gamemaster.js";
import { netAttackDamage, statOffsetsFor } from "../combat-damage.js";
import { STAT_NAMES } from "../hero-stats.js";
import { buffMultiplierFor } from "./buffs.js";
import { heroMembersOf } from "./match-world.js";
import { info } from "../log.js";
import { RECEIVE_FIELD_BY_CLID, encodeCombatResults, receiveCombatResult, HITPOINTS_FIELD_BY_CLID, hitPointsUpdate } from "./combat-wire.js";
import { statsFor, generationFalloff } from "./hit-pricing.js";

/**
 * Healing, which is damage the other way round: what a heal is, its number,
 * and healing friendly targets from a hero's attack.
 */

/**
 * Whether an attack gives hit points back rather than taking them.
 *
 * The client's whole test, from `ActorGameObject.ReceiveCombatResult`:
 *
 *     if(gmAttack.DamageMod > 0) actorView.receiveHeal(...)
 *     else if(blocked == 0)      actorView.receiveDamage(...)
 *
 * `DamageMod` is signed and the table is unanimous about which way: all 452
 * HOSTILE rows that carry one are negative, 280 of them exactly -1, and none is
 * positive. The eleven positive rows are FRIENDLY and every one of them heals:
 * the four Healing Waves, the Healing Shot, the four drinks, the party bomb and
 * the frost dragon's nap.
 *
 * Read `Team` instead and the buffs come out wrong: fifty-one FRIENDLY rows sit
 * at `DamageMod` zero because they are buffs, and a buff is not a heal. Those
 * already work — a zero-magnitude result that carries `TargetBuff1`.
 *
 * A share of the bar is not priced here. Four of the eleven carry
 * `DoPercentHealthDamage` and all four are drinks, whose heal `useConsumable`
 * has already paid out through `healHero` by the time any result arrives; the
 * weapon formula on top of that would heal the drinker twice.
 */
const isHealing = (attack) =>
  Number(attack?.DamageMod ?? 0) > 0 && !attack?.DoPercentHealthDamage;

/**
 * What a friendly attack gives back, as a positive magnitude.
 *
 * The same arithmetic as a hit, because it is the same field: `DamageMod` is
 * the sign and `netAttackDamage` was written signed for exactly this. A Heal
 * Scroll is power 16 at `DamageMod` +1 against MAGIC_ATK's bonus of 1, so the
 * wave is worth about the caster's magic attack plus the scroll — it scales
 * with the healer, which is what makes carrying one a choice.
 *
 * What does *not* apply is mitigation. `MELEE_DEF` and its buffs are what a
 * defender turns aside, and nobody turns aside a heal; running the reduction
 * here would have a Berserker's own training halve every wave aimed at him.
 *
 * The generation falloff does apply, inherited rather than separately measured:
 * it is the same counter the client sends on the same field, and without it a
 * Healing Shot through a standing party is a full heal for everyone it clips.
 */
export const computeHealing = async (session, proposal, attack, weaponPower) => {
  const offsets = statOffsetsFor(attack);
  const signed = netAttackDamage({
    gm: await loadGameMaster(),
    attack,
    weaponPower: weaponPower ?? 1,
    attacker: await statsFor(session, proposal.attacker),
    defender: await statsFor(session, proposal.attackee),
    attackerBuff: offsets
      ? buffMultiplierFor(session, proposal.attacker, STAT_NAMES[offsets.offence])
      : 1,
    defenderBuff: 1,
  });
  if (signed <= 0) return 0;
  return generationFalloff(Math.max(1, Math.round(signed)), proposal.generation);
};

/**
 * Hit points back onto an actor, and the result that draws the floater.
 *
 * A sibling of `applyDamage` rather than a branch of it, because almost every
 * guard that function opens with is about harm: invulnerability turns aside a
 * hit and has no business refusing a heal, and neither has the timeline window
 * an ultimate holds open. Two guards are shared and both are about the floor
 * rather than the hit — an actor that has gone with its floor is not told
 * anything, and a downed hero is a revive's problem, not a heal's.
 */
const applyHealing = (session, doid, healing, announce) => {
  const actor = session.actors?.get(doid);
  const clid = session.objects?.get(doid);
  if (!session.objects?.has(doid)) return false;

  if (!actor || actor.dead || healing <= 0 || !HITPOINTS_FIELD_BY_CLID[clid]) {
    announce?.();
    return false;
  }

  const maximum = Number(actor.maxHitPoints) || actor.hitPoints;
  const before = actor.hitPoints;
  actor.hitPoints = Math.min(maximum, actor.hitPoints + healing);
  session.send(hitPointsUpdate(doid, clid, actor.hitPoints));
  announce?.();
  return actor.hitPoints > before;
};

/**
 * The `when` byte on a heal the server originated.
 *
 * Every one of the 25 healing results in the recordings carries 255, where an
 * ordinary hit carries the timeline frame it landed on — 0 or 4. Nothing was
 * proposed for these, so there is no frame to name, and 255 is what the
 * official writes in its place.
 */
const SERVER_ORIGINATED = 255;

/**
 * A healing wave, fanned out by the server off the cast.
 *
 * This is the part that took two attempts to find. A heal is not proposed: of
 * 7214 attack choreographies in the recordings exactly two name a healing
 * attack, and neither is followed by a single ProposeCombatResults — yet 25
 * healing results come back down the wire. The client asks to cast and the
 * server decides the rest, which is why fixing `handleProposeCombatResults`
 * changed nothing a player could feel.
 *
 * One cast, read off `socket-20260816-145437`:
 *
 *     14:55:56.874  out  choreography      HEALING_PULSE_COOLDOWN, slot 2
 *     14:55:57.048  in   hit points        304 -> 420
 *     14:55:57.049  in   combat result     +282, when 255
 *
 * Three things are settled by those two lines. Hit points go out *before* the
 * result, as they do for damage. The result carries the whole computed heal
 * and not the part that fit — 304 + 282 is 586 against a 420 bar, and the
 * client still draws 282. And the number is positive, which is the only way
 * `spawnHealFloater` can read it.
 *
 * Who it reaches is the attack's own business: `AffectsSelf` and
 * `AffectsOthers`, both set on every Healing Wave. A four-hero cast in
 * `socket-20260822-015753` lands 146 on the caster and on each of the three
 * others. Range is not consulted, which follows `buffFriendlyTarget` — the
 * same fan-out for the same family of attacks — rather than inventing a
 * distance rule from a single recording.
 */
export const healFriendlyTargets = async (session, attack, weaponSlot) => {
  if (!isHealing(attack) || !session.heroDoid) return null;

  const casterDoid = session.heroDoid;
  const weaponPower = Number(session.heroWeapons?.[weaponSlot]?.power) || 1;

  const targets = [];
  if (attack.AffectsSelf) targets.push(casterDoid);
  if (attack.AffectsOthers) {
    for (const doid of heroMembersOf(session).keys()) {
      if (doid !== casterDoid) targets.push(doid);
    }
  }
  if (!targets.length) return null;

  const healed = [];
  for (const doid of targets) {
    const fieldId = RECEIVE_FIELD_BY_CLID[session.objects?.get(doid)];
    if (!fieldId) continue;

    const healing = await computeHealing(
      session,
      { attacker: casterDoid, attackee: doid, generation: 0 },
      attack,
      weaponPower
    );
    if (healing <= 0) continue;

    const result = receiveCombatResult(
      doid,
      fieldId,
      encodeCombatResults({
        doid: casterDoid,
        attackType: attack.Id,
        weaponSlot,
        combatResults: [
          {
            attacker: casterDoid,
            attackee: doid,
            damage: healing,
            attackType: attack.Id,
            weaponSlot,
            when: SERVER_ORIGINATED,
          },
        ],
      })
    );
    if (applyHealing(session, doid, healing, () => session.send(result))) {
      healed.push(`${doid} +${healing}`);
    }
  }

  if (healed.length) info(`[${session.id}] ${attack.Constant}: ${healed.join(", ")}`);
  return healed.length ? healed : null;
};

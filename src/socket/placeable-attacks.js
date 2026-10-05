import { loadGameMaster } from "../gamemaster.js";
import { countsAsKill, isHuntable, isScenery } from "./actor-roles.js";
import { hasAbility } from "./buffs.js";
import { grantMana } from "./rewards.js";
import { heroOnFloor } from "./match-world.js";
import { spawnFoodDoober } from "./drops.js";
import { critRollFor, knockbackOf, foodChanceFor, FOOD_ON_HIT, FOOD_ON_DEATH } from "./modifiers.js";
import { RECEIVE_FIELD_BY_CLID, encodeCombatResults, receiveCombatResult } from "./combat-wire.js";
import { pushVictim, staggerFor } from "./impact.js";
import { areaTrapHits, trapVictims } from "./trap-attacks.js";
import { applyModifierBuffs, applyTargetBuff } from "./combat-effects.js";
import { priceHit } from "./hit-pricing.js";
import { applyDamage, payBusterForKill } from "./combat.js";

/**
 * A placeable's attack — a bomb, a fire, a cloud — as it goes off: whom it
 * reaches (scenery included when the attack says so) and the proposals it
 * applies, as though its owner had swung.
 */

/**
 * Everything a placeable's authored shape is currently covering.
 *
 * Separate from dealing the damage because whether there is anyone in it is the
 * question a trap asks before it goes off, and because an aura that fires into
 * an empty room sends an animation nobody asked for — the captured clouds are
 * silent until something walks in.
 */
export const placeableVictims = (session, attackerDoid, colliders = [], { attack = null } = {}) => {
  if (!colliders.length) return [];
  const hazard = { combatColliders: colliders };
  const found = [];
  /**
   * Monsters, and the scenery the attack says it breaks.
   *
   * The player's own placed things — all of them on TEAM.PLAYERS — do not set
   * each other off: a firebomb's fire was burning the trap that made it. Nor
   * does anything nothing may target — an Infinite ice bomb is not put out by
   * a bomb.
   *
   * Barrels and crates were left out altogether, and the official does not
   * leave them out: its hero placeables land on props as a matter of course —
   * the axe's fissure 25 times against 54 on monsters, the hammers' cracks 7
   * against 17, sticky mines 7 against 8, garlic and firebombs too — and every
   * one of those attacks authors `AffectsProps`. A Berserker's charge that
   * went through a barrel rack without a splinter looked wrong beside a
   * Samurai's, whose slash is a projectile the client proposes against
   * scenery itself. Whether scenery *springs* a waiting trap is the caller's
   * question (`strike` in placeables.js); here it is only whether the shape
   * reaches it.
   */
  const breaksScenery = Boolean(attack?.AffectsProps);
  for (const victim of trapVictims(session)) {
    if (victim.doid === attackerDoid || victim.doid === session.heroDoid) continue;
    if (!isHuntable(victim.actor) && !(breaksScenery && isScenery(victim.actor))) continue;
    const clid = session.objects?.get(victim.doid);
    if (victim.actor.dead || !RECEIVE_FIELD_BY_CLID[clid]) continue;
    // The same authored-shape test a floor trap uses, so a placed hazard and a
    // built-in one agree about what standing in it means.
    if (!areaTrapHits(hazard, victim.position, victim.actor)) continue;
    found.push(victim);
  }
  return found;
};

/**
 * One swing of something the hero put on the floor.
 *
 * A floor trap belongs to nobody and hits everything standing in it, the hero
 * included. A placeable belongs to whoever placed it — the official server
 * generates it on TEAM.PLAYERS with the hero as its master — so it hits what
 * the hero fights and never the hero, which `placeableVictims` has already
 * settled.
 *
 * Damage is priced like the hero's own attack rather than like a floor trap:
 * the hero's offence and the power of the weapon that placed it against the
 * victim's defence. Reading DamageMod alone gave a level-hundred chef's cloud
 * one point a tick, the poultry's own stat columns all being zero.
 *
 * The results carry the placeable's doid as the attacker, which is how the
 * captured FISSURE and GARLIC results name theirs.
 */
export const performPlaceableAttack = async (
  session,
  attackerDoid,
  { attack, victims = [], weaponPower, weapon = null, pushed = null }
) => {
  if (!attack) return 0;

  let hits = 0;
  for (const victim of victims) {
    const clid = session.objects?.get(victim.doid);
    if (!RECEIVE_FIELD_BY_CLID[clid] || victim.actor.dead) continue;

    /**
     * Priced with the weapon that placed it, modifiers and all.
     *
     * The power has always come from the weapon; its `DAMAGE` modifiers had
     * not, so a Sturdy bomb burned exactly as hard as a plain one. Reported as
     * a napalm bomb's fire not taking its power from the modifier.
     *
     * Only the lingering damage runs through here. A thrown weapon's impact is
     * proposed by the client and priced in `applyProposals`, which has had the
     * weapon since the modifiers went in — the recordings show 11 `THROW_MINE`
     * echoes against 11 proposals, and 13 `THROW_GARLIC` echoes against 7,
     * those extra six being the cloud ticking on its own.
     */
    const {
      damage: plainDamage,
      neutral,
      effectiveness,
    } = await priceHit(
      session,
      { attacker: session.heroDoid, attackee: victim.doid, attackType: attack.Id },
      attack,
      weaponPower,
      weapon
    );
    if (!(plainDamage > 0)) continue;

    /**
     * And whether the weapon's modifiers turn this one into a crit.
     *
     * Gated on there being a weapon at all, which is what keeps it off the
     * things that are not one: a floor trap passes none, and neither does a
     * consumable bomb. The official agrees — `THROW_GARLIC`, `THROW_FIREBOMB`
     * and `THROW_MINE` all crit, while `HEALTH_BOMB_ATTACK` and
     * `PARTY_BOMB_ATTACK` carry no crit across 623 recorded hits, and no floor
     * trap does either.
     *
     * That the *lingering* half crits is a decision rather than a measurement.
     * Every recorded crit on a thrown weapon has a client proposal behind it,
     * so the captures only ever show the impact critting; whether the cloud it
     * leaves does too is not separable from them.
     */
    const { critical, multiplier } = hasAbility(session, victim.doid, "CRIT_IMMUNE")
      ? { critical: false, multiplier: 1 }
      : critRollFor(await loadGameMaster(), weapon, session.random ?? Math.random);
    const damage = critical ? Math.round(plainDamage * multiplier) : plainDamage;
    const ticksFrom = critical ? Math.round(neutral * multiplier) : neutral;

    const reaction = receiveCombatResult(
      victim.doid,
      RECEIVE_FIELD_BY_CLID[clid],
      encodeCombatResults({
        doid: attackerDoid,
        attackType: attack.Id,
        combatResults: [
          {
            attacker: attackerDoid,
            attackee: victim.doid,
            damage: -damage,
            attackType: attack.Id,
            targetActorDoid: 0,
            criticalHit: critical ? 1 : 0,
            effectiveness,
            ...staggerFor(attack, damage, session.random ?? Math.random),
          },
        ],
      })
    );
    /**
     * And the shove, on the same gate as the crit beside it.
     *
     * A `HERO_WAR_MALLET` carrying `Knockback` did nothing while an ordinary
     * weapon carrying the same modifier worked, and the difference is this
     * path: the mallet's `FISSURE_HAMMER` does its damage through the placeable
     * it opens, not through a hit the client proposes, so it never reached the
     * push in `applyProposals`.
     *
     * Away from the placeable, which is what the official's results name as the
     * attacker on these hits — a mine throws outward from the mine, and a
     * `Trapper` mine reels in to the mine, not to a hero three rooms off. The
     * hero only when the thing has no position of its own.
     *
     * The official displaces here too, though less tidily than for a direct
     * hit: its `FISSURE_SMASH_ATTACK` victims, behind a mallet carrying 200,
     * move a median 138 (9 alive) and its `FISSURE_SLOW_SMASH_ATTACK` 142 (2).
     * Its `FISSURE_SMASH_AXE` — the axe's charge, behind an axe carrying 250 in
     * every recorded session — moves a median of nothing (5 alive, 5 to 37),
     * not even the 100 its own row authors. So the official pushes through a
     * hammer's crack and not through the axe's burst; this path pushes through
     * both, and which is right for the axe is an open question at that n.
     */
    const { distance: shove, durationMs } = knockbackOf(await loadGameMaster(), weapon);
    const placeable = session.actors?.get(attackerDoid)?.position ? attackerDoid : session.heroDoid;
    // And only what walks, as in applyProposals: a crack under a crate shakes it.
    // Once per body for as long as the thing lasts — `pushed` is the placeable's
    // own set, so a cloud that ticks on the same monster throws it once.
    const walks = (victim.actor.ai?.moveSpeed ?? 0) > 0;
    if (shove && walks && !pushed?.has(victim.doid)) {
      pushVictim(session, victim.doid, placeable, shove, durationMs);
      pushed?.add(victim.doid);
    }

    /**
     * Mana back for landing it, which `ManaPerHit` gives to exactly one attack
     * in the game — the Ranger's snare scroll. It was paid where the client
     * proposes a hit and nowhere else, so a scroll that lands through a
     * placeable gave nothing back.
     */
    // A bomb or a snare left behind goes on working after its hero walks out;
    // what it would pay the hero has nowhere to go by then.
    const heroPresent = heroOnFloor(session);
    if (heroPresent && Number(attack?.ManaPerHit) > 0) grantMana(session, Number(attack.ManaPerHit));

    const wasDead = Boolean(victim.actor.dead);
    const before = victim.actor.hitPoints ?? 0;
    if (applyDamage(session, victim.doid, damage, () => session.send(reaction))) {
      hits++;
      /**
       * And it counts on the report. Every hit a placeable landed was missing
       * from the run's damage and every kill from its tally, so a player who
       * fought with bombs or a fissure weapon finished the floor having, by the
       * server's reckoning, done very little.
       */
      if (countsAsKill(victim.actor)) {
        session.dungeonContribution ??= { kills: 0, damage: 0 };
        session.dungeonContribution.damage += Math.min(damage, before);
        if (!wasDead && victim.actor.dead) {
          session.dungeonContribution.kills += 1;
          if (heroPresent) payBusterForKill(session);
        }
      }
      /**
       * And the food, on the same two events as everywhere else — see
       * `foodChanceFor`. A Saucier fissure left nothing on the floor.
       */
      const onDeath = !wasDead && victim.actor.dead;
      const column = onDeath ? FOOD_ON_DEATH : FOOD_ON_HIT;
      const gm = await loadGameMaster();
      const chance = foodChanceFor(gm, weapon, column);
      if (chance > 0 && (session.random ?? Math.random)() < chance) {
        spawnFoodDoober(session, {
          gm,
          floorDoid: session.floorDoid,
          origin: { ...victim.actor.position },
          onDeath,
          random: session.random ?? Math.random,
        });
      }
    }

    if (!victim.actor.dead) {
      await applyTargetBuff(session, {
        attack,
        victimDoid: victim.doid,
        attackerDoid,
        damage: ticksFrom,
      });
      /**
       * And what the weapon that threw this leaves on whatever the fire caught.
       *
       * Reported: a Sticky napalm rooted only the enemy the bomb struck on its
       * way down, and anything that walked into the burning patch afterwards
       * walked out again. The debuffs were applied where the client proposes a
       * hit and nowhere else, so the lingering half of every placeable — the
       * cloud, the fire, the mine's field — left nothing behind.
       *
       * Gated on the weapon like the crit above, so a floor trap and a
       * consumable bomb still leave only what their own `TargetBuff1` says.
       *
       * Consistent with how the damage and the crit are handled rather than
       * separately measured: a capture cannot say which of a cloud's victims
       * were caught by the throw and which walked in afterwards.
       */
      if (weapon) {
        await applyModifierBuffs(session, {
          weapon,
          victimDoid: victim.doid,
          attackerDoid,
          damage: ticksFrom,
        });
      }
    }
  }
  return hits;
};

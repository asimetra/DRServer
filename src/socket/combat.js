import { slotGrantsAttack } from "./buster.js";
import { PacketWriter } from "./packet.js";
import { CLID, OP } from "./opcodes.js";
import { config } from "../config.js";
import { attackById, heroById, loadGameMaster } from "../gamemaster.js";
import { statOffsetsFor } from "../combat-damage.js";
import { countsAsKill } from "./actor-roles.js";
import { legendaryBusterPerKill } from "../hero-stats.js";
import { clearBuffsOn, hasAbility } from "./buffs.js";
import { beginFloorFailing, checkFloorCleared } from "./floorstate.js";
import { objectDisable } from "./objects.js";
import { grantMana } from "./rewards.js";
import { info, warn } from "../log.js";
import { RULE, noteViolation } from "./security-events.js";
import { spawnFoodDoober } from "./drops.js";
import { critRollFor, knockbackOf, foodChanceFor, cookingFoodChance, FOOD_ON_HIT, FOOD_ON_DEATH } from "./modifiers.js";
import { RECEIVE_FIELD_BY_CLID, MAX_EMBEDDED_RESULTS, WEAPON_SLOTS, POWERUP_SLOTS, readProposals, receiveCombatResult, stateUpdate, HITPOINTS_FIELD_BY_CLID, hitPointsUpdate, triggerStateUpdate } from "./combat-wire.js";
import { NO_KNOCKBACK, pushVictim, NO_STAGGER, staggerFor } from "./impact.js";
import { applyModifierBuffs, applyTargetBuff } from "./combat-effects.js";
import { priceHit, withDamage, withSuffer, holdStaggered, withKnockback, withCrit, withEffectiveness, withPowerMultiplier } from "./hit-pricing.js";
import { CASTLESS_ATTACKS, auditCombatResultWhen, consumeAcceptedCast, reachExcess } from "./cast-audit.js";
import { tellDowned, tellHit } from "./combat-events.js";
import { stealLife } from "./life-steal.js";
export { FLID_PROPOSE_COMBAT_RESULTS, npcAttackChoreography, withBaseAttack, stateUpdate, hitPointsUpdate, triggerStateUpdate, heroStateAndChoreography, isPartyHero } from "./combat-wire.js";
export { pushVictim, staggerFor, heroStaggerFor } from "./impact.js";
export { hazardCandidateDoids, trapProjectileReach, launchCarrierProjectile, tickTrapProjectiles, startTrapProjectiles, hazardVictims, dealTrapHit, performTrapAttack } from "./trap-attacks.js";
export { startHealthDrain, applyTargetBuff } from "./combat-effects.js";
export { placeableVictims, performPlaceableAttack } from "./placeable-attacks.js";
export { performNpcAttack } from "./npc-swings.js";
export { healFriendlyTargets } from "./hero-healing.js";
export { damageTurnedAside } from "./hit-pricing.js";
export { auditCombatResultWhen, noteCast, noteBombCast, clearBombCasts, castAccepted, clearAcceptedCasts, reachExcess } from "./cast-audit.js";

/**
 * Combat.
 *
 * The split is narrower than "client-authoritative" suggests. The client
 * decides *that* a hit happened — attacker, victim, attack type, blocked,
 * stun, knockback — and sends ProposeCombatResults. It does not decide how
 * much it hurt: CombatGameObject builds the result and leaves `damage` at
 * zero. The number, the resulting hit points and death are the server's.
 *
 * So this module does three things per proposal: work out the damage, echo the
 * result back so the victim reacts, and publish the victim's new hit points.
 *
 * Proposals are accepted without validation for now (docs/roadmap.md F4).
 *
 * This file keeps the centre — taking hit points off an actor and what
 * follows, and the hero's proposals — and re-exports what the rest of the
 * server has always imported from here. The rest is by concern:
 *
 *   combat-wire.js         the fields, encoding and updates on the wire
 *   hit-pricing.js         the number a hit is worth
 *   cast-audit.js          whether a proposed hit may be believed
 *   impact.js              knockback and stagger
 *   combat-effects.js      drains, damage over time, on-hit buffs
 *   hero-healing.js        healing
 *   npc-swings.js          an NPC's attack landing
 *   trap-attacks.js        traps and hazards as attackers
 *   placeable-attacks.js   a placeable going off
 */

/**
 * Takes hit points off an actor and publishes the consequences, in the order
 * the official server publishes them.
 *
 * That order is measured, not chosen. Across one session the new hit points
 * arrive **immediately before** the combat result that explains them — 854
 * times for monsters and 327 for the hero, against a single instance the other
 * way round — and a killing blow reads `hitPoints → result → state`, 529 times
 * against 2.
 *
 * So `announce` is the result frame's turn: hit points, then what caused them,
 * then death. Sending the result first put the damage number on screen before
 * the bar it came off, and told the client an actor was dead before it knew
 * what had killed it.
 */
const hasInvulnerabilityBuff = (session, doid) =>
  hasAbility(session, doid, "INVULNERABLE_ALL");

const hasTimelineInvulnerability = (session, doid) =>
  Date.now() < (session.invulnerableUntil?.get(doid) ?? 0);

export const isInvulnerable = (session, doid) =>
  hasInvulnerabilityBuff(session, doid) || hasTimelineInvulnerability(session, doid);

export const applyDamage = (session, doid, damage, announce) => {
  const actor = session.actors?.get(doid);
  const clid = session.objects.get(doid);

  /**
   * Nothing touches an invulnerable actor, and it is not told that anything
   * tried — no result, so no damage number and no stagger.
   *
   * Four buffs carry `INVULNERABLE_ALL` and every one of them is a revive:
   * INVULNERBILITY and SPAWN_INVULNERBILITY, and the party bomb's two. The
   * health bomb authors the first as its `SelfBuff` and it lasts five seconds
   * — long enough to walk out of whatever killed you.
   *
   * We granted it and then ignored it. Reviving inside a spike bed meant taking
   * a twelfth of the bar every second through what the client was drawing as
   * immunity, going down again, and reviving into the same trap: the reported
   * death that never ends.
   */
  if (hasInvulnerabilityBuff(session, doid)) return false;

  /**
   * And the window an attack's own timeline opens while it plays.
   *
   * Twenty-two timelines carry `invulnerable`, and every hero's Dungeon Buster
   * is among them: all six open it at frame zero and hold it for most of the
   * animation, 1625ms to 2917ms. That is the whole of why an ultimate is safe
   * to use — the performer is standing still, locked in something he cannot
   * cancel, in the middle of whatever he just dived into.
   *
   * We granted none of it, so a player using his ultimate took everything the
   * room had. It reads as the ultimate hurting him, which is what it looks like
   * from inside.
   */
  if (hasTimelineInvulnerability(session, doid)) return false;

  /**
   * And everything on a harmless floor: a ranked lobby (floors.js quietFloor),
   * whose skull piles mark the queue's ring and have to stay standing. Told
   * nothing, as the invulnerable are.
   */
  if (session.currentFloor?.harmless) return false;

  /**
   * An object we no longer track is not on the client's floor either.
   *
   * `announce` is what puts the CombatResult on the wire, and it used to run
   * whatever happened above it — including for a doid that had gone with its
   * floor. The client says so out loud and we had never read it:
   * `CombatResultAttackTimelineAction` looks the victim up with
   * `DistributedDungeonFloor.getActor` and warns "Tried to execute a combat
   * result on an actor that is not on the dungeon floor", 171 times in one
   * recorded session.
   *
   * A hit on something dead still announces — that is a real result and the
   * client draws the number. A hit on something *gone* announces nothing.
   */
  if (!session.objects?.has(doid)) return false;

  // TELEPORT_AI remains authoritative while hidden but is absent from every
  // client's floor between disable and regenerate. Nothing can hit an actor
  // that does not currently exist on the visible floor.
  if (actor?.teleportHidden) return false;

  if (!actor || actor.dead || damage <= 0 || !HITPOINTS_FIELD_BY_CLID[clid]) {
    announce?.();
    return false;
  }

  actor.hitPoints = Math.max(0, actor.hitPoints - damage);
  session.send(hitPointsUpdate(doid, clid, actor.hitPoints));
  // Past every guard above, so this is a real hit on something that was alive:
  // what an NPC_DAMAGE_TRIGGER is waiting for.
  actor.onDamage?.(doid);
  announce?.();

  if (actor.hitPoints === 0) {
    actor.dead = true;
    const recoverableHero = clid === CLID.HeroGameObject;
    if (recoverableHero && typeof session.releaseProximityActor === "function") {
      session.releaseProximityActor(session, doid);
    }
    /**
     * Whatever it does as it breaks goes out *before* it is called dead.
     *
     * The client drops a choreography aimed at a dead actor:
     * `ActorMacroStateMachine.enterChoreographyState` only runs while the macro
     * state is the default one, and a dead actor is in `mDeadState`, so it logs
     * "Trying to enter a choreographyState when the macro state is not in the
     * default state" and plays nothing. A barrel told to explode after it was
     * told to die therefore never shows an explosion.
     *
     * The official is unanimous about the order — 59 of 59 recorded barrels
     * read `hitPoints -> bang -> state=dead`, across the arena, catacomb and
     * temple blasts.
     */
    actor.onDeathAttack?.(doid);
    const callItDead = () => {
      if (actor.permCorpse) {
        // A gate does not die, it breaks. Twenty-four rows author PermCorpse —
        // the arena gates, the secret walls, the smashable exits — and the
        // captured one switched its trigger state and stayed standing.
        session.send(triggerStateUpdate(doid, 0));
        return;
      }
      // Every party hero is recoverably "down", not only the hero belonging to
      // whichever member context happened to run this hit. AI is shared and may
      // resolve a lethal hit through the host context against a remote hero.
      // Comparing doids there classified that remote hero as an NPC and bypassed
      // ActorReviveState, including both the rescue sensor and bomb screen.
      session.send(stateUpdate(doid, clid, recoverableHero ? "down" : "dead"));
    };
    /**
     * A body that is still going off is not ready to be taken away, and the
     * blast is drawn by the object doing it: destroy that and the barrel
     * vanishes without exploding. This server has made that mistake once
     * already and left the note on `retireSpentBomb`.
     *
     * The official waits. Of 9047 recorded deaths 96% are called dead within
     * 120ms of losing the last hit point — the granularity of its own loop —
     * and a separate 3.5% wait between 1.5 and 4 seconds, which is where the
     * authored blasts land: 1208ms for a barrel, 1583ms for a thrown bomb,
     * 2792ms for the party bomb.
     *
     * A gate has nothing to play and a hero is only down, so neither waits.
     */
    const blastMs =
      recoverableHero || actor.permCorpse ? 0 : Math.max(0, Number(actor.deathEffectMs) || 0);
    const retire = () => {
      /**
       * After the death hook, never before it: the loot drop, the death attack
       * and the boss chest all place themselves by reading this actor's
       * position, and each quietly falls back to the spawn point when the
       * actor is missing. Clearing it early does not break anything loudly, it
       * just moves the reward back to where the monster came from.
       */
      if (!recoverableHero && !actor.permCorpse) removeActor(session, doid);
      /**
       * And whatever was waiting for it to be gone rather than merely dead.
       *
       * A generator clears here: a chest is still throwing coins for six
       * seconds after it breaks, and the floor's ending is wired to the
       * clearing, so signalling it at the death would start the countdown
       * underneath the shower.
       */
      actor.onGone?.(doid);
    };

    if (blastMs > 0) {
      const finish = () => (callItDead(), retire());
      const scope = session.floorScope;
      const timer = scope ? scope.timeout(finish, blastMs) : setTimeout(finish, blastMs);
      if (!scope) timer.unref?.();
    } else callItDead();

    actor.onDeath?.(doid);
    if (recoverableHero) {
      (session.beginFloorFailing ?? beginFloorFailing)(session);
      tellDowned(session, doid);
    } else {
      if (blastMs <= 0) retire();
      checkFloorCleared(session);
    }
  }
  return true;
};

/**
 * Takes a dead actor off the floor, as the official does within a millisecond
 * of announcing the death — 9015 of the 9051 recorded monster deaths are
 * followed by a disable, none later than 43ms, and the remainder are the ones
 * still standing when the recording stops.
 *
 * Keeping them was costing real work rather than memory: every floor sweep
 * walks `actors`, so a catacombs floor that ended with 141 enemies was paying
 * for all of them on every trap tick and every AI search long after the last
 * one could do anything.
 */
const removeActor = (session, doid) => {
  if (!session.actors?.delete(doid)) return false;
  // Whatever it was carrying goes with it — see `clearBuffsOn`. Before the
  // disable, so the buffs are taken off a floor that still holds their host.
  clearBuffsOn(session, doid);
  session.objects?.delete(doid);
  session.send(objectDisable(doid));
  return true;
};

/**
 * The end of a summoned actor's `timetolive`: it dies, and nobody killed it.
 *
 * The official's own summons show the shape. Of the Shaman Imp's ice imps left
 * alone for their authored ten seconds, 43 of 43 read `hitPoints 0 -> state
 * dead -> disable` at 10.1-10.2s, and none drops the experience and gold a
 * killed one does — 50 of 69 leave nothing at all, and the rest only what
 * something dying beside them left. So this is the death announcement without
 * the death: no `onDeath`, which is where the rewards and the trigger reports
 * live, and no blast, since nothing hit it.
 */
export const expireActor = (session, doid) => {
  const actor = session.actors?.get(doid);
  const clid = session.objects?.get(doid);
  if (!actor || actor.dead || !HITPOINTS_FIELD_BY_CLID[clid]) return false;
  actor.dead = true;
  actor.hitPoints = 0;
  session.send(hitPointsUpdate(doid, clid, 0));
  session.send(stateUpdate(doid, clid, "dead"));
  removeActor(session, doid);
  actor.onGone?.(doid);
  return true;
};

/**
 * Kills every enemy left standing, as the FLOOR_KILL_ALL_NPCS triggerable asks.
 *
 * Routed through applyDamage rather than setting a flag, so a death by this
 * route drops what it would have dropped, reports itself to the triggers that
 * were watching it, and is counted on the report. The doids are taken first
 * because a death can add to and remove from the same map.
 */
export const killAllEnemies = (session) => {
  const doomed = [...(session.actors?.entries() ?? [])]
    .filter(([doid, actor]) => actor.isEnemy && !actor.dead && doid !== session.heroDoid)
    .map(([doid, actor]) => [doid, actor.hitPoints]);

  for (const [doid, hitPoints] of doomed) applyDamage(session, doid, hitPoints);
  return doomed.length;
};

/**
 * What a kill pays into the Dungeon Buster.
 *
 * `Buster Gen` is the only source of it — nothing else in the game grants a
 * point for a kill — and it was unread, so a legendary that promises a point an
 * enemy gave none. Capped at the hero's own maximum, which is his buster's own
 * `CrowdCost`, so the bar fills rather than overflowing.
 *
 * Called from both places a hero's kill is counted, since a monster killed by a
 * thrown bomb is as dead as one killed by a swing.
 */
/**
 * Written here rather than imported from `rewards.js`, which already imports
 * `hitPointsUpdate` from this file — taking its buster packet back would close
 * the loop. `DistributedHeroGameObject.dungeonBusterPoints` is field 166.
 */
const busterPointsUpdate = (doid, value) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(166).u32(value).frame();

export const payBusterForKill = (session) => {
  const points = legendaryBusterPerKill(session.heroWeapons ?? []);
  if (!points) return 0;
  const full = Math.max(1, Number(session.maxDungeonBusterPoints ?? 0));
  const before = Number(session.dungeonBusterPoints ?? 0);
  const after = Math.min(full, before + points);
  if (after === before) return 0;
  session.dungeonBusterPoints = after;
  session.send?.(busterPointsUpdate(session.heroDoid, after));
  return after - before;
};

export const handleProposeCombatResults = async (session, reader) => {
  const proposals = readProposals(session, reader);
  if (!proposals) return;
  return applyProposals(session, proposals);
};

/**
 * The hits a client has proposed, however they arrived.
 *
 * Split out from the packet that used to be their only door because it is not:
 * a charge release posts its hits inside the choreography instead — see
 * `applyChoreographyResults`. The rules below are about what a result claims,
 * not about which packet carried it, so both ways in run all of them.
 */
const applyProposals = async (session, proposals) => {
  const summary = [];

  /**
   * Every result names its own attacker, and checking the field update's doid
   * does not reach it.
   *
   * That left the cast and reach rules guarding a branch rather than the
   * handler: they sat inside `if (proposal.attacker === session.heroDoid)`
   * while the damage below ran whatever the answer was. Writing any other doid
   * into the inner field therefore skipped both and still landed the hit —
   * with `DR_REQUIRE_CAST` on and no cast accepted at all:
   *
   *   attacker = hero 500   9000hp -> 9000hp   refused
   *   attacker = NPC  600   9000hp -> 8992hp   applied
   *
   * Deterministic, so refused rather than counted, and refused for the whole
   * packet: 14479 owner results across the recordings name the hero and not one
   * names anything else, and every packet carried exactly one. There is no
   * honest traffic on the other side of this, and nothing server-owned arrives
   * here — trap, placeable and NPC damage all have their own paths.
   */
  const forged = proposals.find((proposal) => proposal.attacker !== session.heroDoid);
  if (forged) {
    noteViolation(
      session,
      RULE.forgedAttacker,
      `attacker ${forged.attacker}, not the hero — dropped all ${proposals.length}`
    );
    return;
  }

  /**
   * And the slot it says it swung with has to be one.
   *
   * A hero carries four weapons and two powerups, so the byte has four or two
   * meanings and no others. The recordings use 0, 1 and 2 for weapon results
   * and never anything else. This is the shape of the message rather than a
   * reading of the game, so it is refused whatever the enforcement flags say —
   * and it has to be, because the slot now decides what the hit is priced with.
   */
  const badSlot = proposals.find(
    (proposal) => !Number.isInteger(proposal.weaponSlot) ||
      proposal.weaponSlot < 0 ||
      proposal.weaponSlot >= (proposal.isConsumable ? POWERUP_SLOTS : WEAPON_SLOTS)
  );
  if (badSlot) {
    noteViolation(
      session,
      RULE.malformedProposal,
      `result claims ${badSlot.isConsumable ? "powerup" : "weapon"} slot ${badSlot.weaponSlot}`
    );
    return;
  }

  for (const proposal of proposals) {
    const clid = session.objects.get(proposal.attackee);
    const fieldId = RECEIVE_FIELD_BY_CLID[clid];

    if (!fieldId) {
      warn(`combat: cannot deliver result to doid ${proposal.attackee} (class ${clid ?? "unknown"})`);
      continue;
    }

    const attack = await attackById(proposal.attackType);

    /**
     * An attack the weapon in that slot does not have is not a hit, whatever
     * the cast rule is set to.
     *
     * The slot names a weapon this server equipped, so what it can swing is
     * this server's table, not the client's word. Without this a modified
     * client could land any attack in the game with the weapon it holds — and
     * reach is measured against the attack named, so a sword claiming a
     * 3000-unit spell hit everything within 3000 units, about ten times what a
     * melee weapon reaches. The cast rule would catch it too, but that one rests
     * on timing and stays off by default.
     *
     * Measured before it was made to refuse: of 6616 hits by the player's own
     * hero across 84 official recordings, every one is granted by the slot's
     * weapon, or is a Dungeon Buster on slot 0, Berserk's RAMPAGE on a melee
     * weapon, or one of the two bombs, which go out through the revive path and
     * have rules of their own. Refused, logged, never a reason to end a session.
     */
    if (
      attack &&
      !proposal.isConsumable &&
      !CASTLESS_ATTACKS.has(attack.Constant) &&
      !(await slotGrantsAttack(session, attack, proposal.weaponSlot))
    ) {
      noteViolation(
        session,
        RULE.unownedAttack,
        `${attack.Constant} hit from slot ${proposal.weaponSlot}, whose weapon does not have it`
      );
      continue;
    }

    /**
     * The attacker is the hero — the guard above returned otherwise — so these
     * run for every result rather than for a branch of them.
     *
     * Reach refuses by default — see `reachMode` in config.js for what it was
     * measured against — and `ODS_REACH_MODE=audit` only reports. The cast rule
     * still only reports unless it is switched on.
     *
     * The reach call is wrapped because a check that only reports has no
     * business breaking anything. This one did: `projectileForConstant` was
     * never imported, so it threw on the first attack that carries a
     * projectile, the handler unwound, and the whole batch of results went with
     * it — an archer whose arrows landed on nothing at all, with enforcement
     * switched off.
     */
    const far = await reachExcess(session, proposal, attack).catch((error) => {
      warn(`[${session.id}] reach check failed, letting the hit through: ${error.message}`);
      return null;
    });
    const proposalAt = Date.now();
    const acceptedCast = consumeAcceptedCast(
      session,
      attack,
      proposal.attackType,
      proposal.weaponSlot,
      proposal.attackee,
      proposalAt,
      proposal.scalingMaxPowerMultiplier
    );
    await auditCombatResultWhen(session, proposal, attack, acceptedCast, proposalAt).catch(
      (error) => warn(`[${session.id}] CombatResult.when audit failed: ${error.message}`)
    );
    if (!acceptedCast) {
      noteViolation(
        session,
        RULE.noCast,
        `${attack?.Constant ?? proposal.attackType} with no cast behind it`
      );
      if (config.castMode === "enforce") continue;
    }

    if (far) {
      noteViolation(
        session,
        RULE.outOfReach,
        `${attack?.Constant ?? proposal.attackType} at ${Math.round(far.distance)} ` +
          `against ${Math.round(far.allowed)} (position ${far.staleMs}ms old)`
      );
      if (config.reachMode === "enforce") continue;
    }

    /**
     * Priced by the weapon that swung, which the result names.
     *
     * It was priced by `session.weaponPower` — the strongest of the four
     * equipped — so a hero carrying one strong weapon hit just as hard with the
     * weak ones. Both a parity bug for an honest loadout and an exploit, and
     * the slot has been on the wire the whole time.
     *
     * A powerup names one of the two consumable slots and is not a weapon at
     * all, so it keeps the flat fallback rather than reading a weapon that
     * index does not mean.
     */
    const swung = proposal.isConsumable ? null : session.heroWeapons?.[proposal.weaponSlot];
    const weaponPower = Number(swung?.power) || 1;

    /**
     * A scaling weapon charges its power, not every attack with "charge" in
     * its name. CombatResult carries the exact fractional multiplier the client
     * rendered, while the accepted cast carries the maximum justified by the
     * observed hold time and the equipped WeaponItem row. Taking the lower is
     * both faithful and bounded: Artemis' Bow sends 2.556 and 3.25 in the
     * official capture, but a forged 99 can never exceed its authored 3.5.
     */
    const claimedPowerMultiplier = Number(proposal.scalingMaxPowerMultiplier);
    const maxPowerMultiplier = Math.max(
      1,
      Number(acceptedCast?.maxPowerMultiplier) || 1
    );
    const powerMultiplier = Number.isFinite(claimedPowerMultiplier) && claimedPowerMultiplier > 1
      ? Math.min(claimedPowerMultiplier, maxPowerMultiplier)
      : 1;

    const priced = proposal.blocked
      ? { damage: 0, neutral: 0, effectiveness: 0 }
      : await priceHit(session, proposal, attack, weaponPower * powerMultiplier, swung);
    const plain = priced.damage;

    /**
     * And whether the weapon's own modifiers turned it into a crit, which is
     * the server's call and nobody else's.
     *
     * After the defender's reduction rather than before it, so a crit doubles
     * what actually landed rather than what was swung. Nothing measured
     * separates the two — the recordings hold no crit against a buffed defender
     * — but this is the order the rest of the pricing already runs in.
     *
     * Only for an attack that is a swing, a shot or a spell. The health and
     * party bombs are proposed as slot 0 and not consumable — 461 of 461 of the
     * official's — and priced from that slot's weapon (116 × 1.5 = 174), so the
     * slot's crit modifier reached them too: a katana's CRIT_DAMAGE_4 turned a
     * health bomb into 8946. The official's SUPPORT hits, 628 of them, never
     * crit; its melee, shooting and magic ones do.
     */
    const { critical, multiplier } = plain &&
      statOffsetsFor(attack) &&
      !hasAbility(session, proposal.attackee, "CRIT_IMMUNE")
      ? critRollFor(await loadGameMaster(), swung, session.random ?? Math.random)
      : { critical: false, multiplier: 1 };
    const damage = critical ? Math.round(plain * multiplier) : plain;
    const ticksFrom = critical ? Math.round(priced.neutral * multiplier) : priced.neutral;

    /**
     * Whether it flinches and whether it is thrown — `staggerFor`, which is the
     * same rule a monster's hit goes by. A weapon's `KNOCKBACK` or `PULL` names
     * its own distance and takes the place of the attack's; either way the
     * victim is thrown, so either way it flinches.
     */
    const landed = !proposal.blocked && damage > 0 && statOffsetsFor(attack);
    const weaponKnockback = landed ? knockbackOf(await loadGameMaster(), swung) : NO_KNOCKBACK;
    const weaponShove = weaponKnockback.distance;
    const stagger = landed
      ? staggerFor(attack, damage, session.random ?? Math.random)
      : NO_STAGGER;
    const authoredShove = weaponShove || (stagger.knockback ? Number(attack?.Knockback) || 0 : 0);
    const shoveAbility = authoredShove < 0 ? "PULL_IMMUNE" : "KNOCKBACK_IMMUNE";
    const thrown = authoredShove && !hasAbility(session, proposal.attackee, shoveAbility);
    const suffers =
      (stagger.suffer || authoredShove !== 0) &&
      !hasAbility(session, proposal.attackee, "SUFFER_IMMUNE");
    /**
     * Told it was thrown and actually moved are two things. A barrel is told —
     * 722 of the official's hits on props with these attacks carry both flags,
     * which is the client shaking it — and a barrel does not go anywhere. Nor
     * does a weapon's modifier move one: behind a `KNOCKBACK` weapon the
     * official flags 27 hits on props and moves none, as it moves none of the
     * 2334 prop hits in the corpus. Only what can walk is carried.
     */
    const walks = (session.actors?.get(proposal.attackee)?.ai?.moveSpeed ?? 0) > 0;
    /**
     * And a projectile throws with its first collision only. The client counts
     * a projectile's collisions in `generation`, and each one past the first
     * lands half the hit before it (generationFalloff); the throw rides with
     * the full hit. A swing is generation zero every time, so a combo throws
     * on every hit, which is what the official's combos do (25 alive victims
     * of a Blastback axe's first swing move a median 187, every swing). Without
     * this a Trapper's orbiting boomerangs reeled a crowd in on every pass
     * for twenty seconds, and a rock through a line threw everyone in it.
     */
    const firstCollision = !(Number(proposal.generation) > 0);
    const shove = thrown && walks && firstCollision ? authoredShove : 0;
    /**
     * Not gated on the client's flags, which is the mistake the first version
     * made: the client proposes both bytes as 0 on all but two of 13626
     * recorded results. It is the server that sets them — exactly as it decides
     * the crit beside them — and the client reacts to nothing it is not told.
     *
     * The attack's own `Knockback` throws the victim. That was held back once
     * on a measurement that had the monsters standing still; measured over the
     * 0.7 seconds after the hit, counting only victims still alive to be moved,
     * they do not: KATANA_SOUL_BANG authors 50 and moves its victim a median 47
     * (1803 alive of 6996 hits — counting the dead too, who send no position,
     * the median is 0, which is the count modifiers.js gives), the health bomb
     * 140 and 141, EARTHQUAKE 30 and 50, against a median 9 for a hit that
     * carries no flag.
     *
     * And not on a blocked result. The client's own resolver clears blocked
     * hits before it ever considers a knockback flag; letting a modifier push
     * through that gate would let a hit that landed for zero still reposition
     * the victim.
     */
    // Both flags are server decisions. Always overwrite the proposal so a
    // modified client cannot preserve a forged critical/knockback marker in
    // the authoritative echo when the corresponding effect was refused.
    let bytes = withPowerMultiplier(proposal.bytes, powerMultiplier);
    bytes = withCrit(bytes, critical);
    bytes = withEffectiveness(bytes, priced.effectiveness);
    bytes = withSuffer(bytes, Boolean(suffers));
    bytes = withKnockback(bytes, Boolean(suffers && thrown));
    const echo = receiveCombatResult(proposal.attackee, fieldId, withDamage(bytes, -damage));

    /**
     * Mana back for landing it. `ManaPerHit` belongs to exactly one attack in
     * the game — MAGIC_BLAST_L2, the Ranger's snare scroll, at five a hit —
     * and it is the whole reason to carry that weapon. Nothing read it, so the
     * scroll was a blast that gave nothing back.
     */
    if (!proposal.blocked && Number(attack?.ManaPerHit) > 0) {
      grantMana(session, Number(attack.ManaPerHit));
    }

    /**
     * The debuff the attack leaves. This was only ever applied on the placeable
     * path, so nothing a hero swung ever left anything: THUNDERSTORM authors
     * SHOCK_L1 and the captures show the official server granting it to every
     * victim it catches, one apiece.
     */
    if (!proposal.blocked) {
      await applyTargetBuff(session, {
        attack,
        victimDoid: proposal.attackee,
        attackerDoid: proposal.attacker,
        damage: ticksFrom,
      });
      /**
       * And what the weapon itself leaves behind, which is a different thing
       * from what the attack does — see `onHitBuffsFor`. A Noxious katana
       * poisons with every swing it has, so this is not `attack.TargetBuff1`
       * and does not go through its "already has one" guard: stacking is
       * `grantBuff`'s to decide, and `MaxStacks` is what decides it.
       */
      await applyModifierBuffs(session, {
        weapon: swung,
        victimDoid: proposal.attackee,
        attackerDoid: proposal.attacker,
        damage: ticksFrom,
      });
    }

    /**
     * And the shove, if this hit carries one.
     *
     * The flag was published and nothing followed it. Measured on official NPC
     * victims with the attack held constant: `TRAP_ARROWS` authors 30 and moves
     * its victim a median 27 when the flag is set and 0 when it is not, over 437
     * and 61 samples; `TRAP_FLAME_JET` authors 60 and moves it 57 against 5.
     *
     * The weapon's own `KNOCKBACK` or `PULL` takes precedence over the attack's,
     * because those modifiers name distances on the same scale rather than
     * bonuses — `Blastback` is 250 where the party bomb is 250. That part is a
     * reading of the table and not a measurement: no recorded player carried
     * one, so the corpus cannot show what a Trapper does.
     */

    const shoveMs = weaponShove
      ? weaponKnockback.durationMs
      : Math.max(0, Number(attack?.KnockbackDur) || 0) * 1000;
    if (shove) pushVictim(session, proposal.attackee, proposal.attacker, shove, shoveMs);
    if (suffers) holdStaggered(session, proposal.attackee, attack);

    const actor = session.actors?.get(proposal.attackee);
    const wasDead = Boolean(actor?.dead);
    const hitPointsBefore = actor?.hitPoints ?? 0;
    const origin = actor?.position ? { ...actor.position } : null;
    if (actor && applyDamage(session, proposal.attackee, damage, () => session.send(echo))) {
      // A monster's hit on a hero: the floor's toughest heal a share of it (life-steal.js).
      if (session.objects?.get(proposal.attackee) === CLID.HeroGameObject) {
        stealLife(session, proposal.attacker, Math.min(damage, hitPointsBefore));
      }
      /**
       * And what a Saucier or a Cook's weapon leaves on the floor for it.
       *
       * Two rolls at two moments, because they are two modifiers: killing rolls
       * `Cook's` and any other landed hit rolls `Saucier`. The victim's position
       * is taken before the hit, since a kill takes the actor off the floor and
       * the drop would otherwise fall back to the spawn point.
       */
      const onDeath = !wasDead && actor.dead;
      /**
       * Both sources of it, added. The weapon's `Saucier` or `Cook's` and the
       * Battle Chef's own `COOKING`, which is a class ability rather than a
       * property of what he is holding — see `cookingFoodChance`. They fire on
       * the same two events and make the same two doobers, so they are one roll.
       */
      const column = onDeath ? FOOD_ON_DEATH : FOOD_ON_HIT;
      const gm = await loadGameMaster();
      /**
       * The weapon has to promise food before any is made.
       *
       * `COOKING` was briefly read as its own source, on the strength of
       * `HitSpawnBase` being 1% — so a Chef made food with any weapon at all.
       * Nothing measured supports that. Three official captures drop chef food
       * and two of them are a Ghost Samurai, who has no `COOKING` slot, so that
       * food is the modifier's; and players on the live game report that a
       * weapon without the modifier makes none. A column that reads like a
       * standalone chance is not the same as one observed behaving like one.
       *
       * So the stat improves a chance rather than creating it, which is what
       * its description says of itself — "Better chance to make Food when
       * attacking enemies".
       */
      const fromWeapon = foodChanceFor(gm, swung, column);
      const chance = fromWeapon
        ? fromWeapon +
          cookingFoodChance(
            gm,
            await heroById(session.dungeonAvatar?.avatar_id),
            session.dungeonAvatar,
            column
          )
        : 0;
      if (chance > 0 && (session.random ?? Math.random)() < chance) {
        spawnFoodDoober(session, {
          gm,
          floorDoid: session.floorDoid,
          origin,
          onDeath,
          random: session.random ?? Math.random,
        });
      }
      if (countsAsKill(actor)) {
        session.dungeonContribution ??= { kills: 0, damage: 0 };
        session.dungeonContribution.damage += Math.min(damage, hitPointsBefore);
        if (!wasDead && actor.dead) {
          session.dungeonContribution.kills += 1;
          payBusterForKill(session);
        }
        tellHit(session, proposal.attackee, actor, Math.min(damage, hitPointsBefore), !wasDead && actor.dead);
      }
      summary.push(
        `${actor.constant ?? proposal.attackee} -${damage} -> ` +
          `${actor.hitPoints}/${actor.maxHitPoints}hp${actor.dead ? " DEAD" : ""}`
      );
    } else {
      summary.push(`${proposal.attackee} -${damage}`);
    }
  }

  if (summary.length) info(`[${session.id}] combat: ${summary.join(", ")}`);
  return true;
};

/**
 * The hits a charge release carries inside its own choreography.
 *
 * Muramasa was the report: the animation played, 25 Mana went, the cast was
 * recorded and nothing took any damage. `KATANA_SOUL_BANG` resolves its collider
 * on the first frame of the timeline, so the client has its victims before the
 * choreography leaves — and rather than send them again a moment later it writes
 * them into the same packet, after the header, in the same byte-length-prefixed
 * blob field 171 uses. `handleProposeAttackChoreography` read the header and
 * stopped, so every one of those hits was dropped on the floor.
 *
 * It is not a special case for one weapon. Field 172 carries a non-empty list on
 * 1521 casts across the recordings: `KATANA_SOUL_BANG` 7620 hits, up to 22 from
 * one swing, `KATANA_SHADOW_SLASH` 131, and eight other attacks besides. The
 * official server honours them — 1481 of 1490 readable casts are followed by a
 * hit-point update on a victim the embedded list named, a median 149ms later.
 *
 * There is no double counting to fear. Of those 1490 casts, four are followed
 * within 400ms by a field 171 naming a victim the choreography also named, and
 * all four carry a different `attackType` 283ms or more later — a second swing
 * at the same monster, not the same swing twice. The embedded list is the only
 * carrier these hits have.
 *
 * The list has to agree with the choreography it rides in, and it does: all 7264
 * recorded records repeat the outer attack, weapon slot and consumable flag
 * exactly, and name the packet's own hero as the attacker. A record that does
 * not is not a hit this choreography can vouch for.
 *
 * Called once the cast has been paid for and recorded, because `castAccepted` is
 * what these results are then checked against.
 */
export const applyChoreographyResults = async (session, reader, choreography) => {
  // Most choreographies carry no list at all, and an older client may send none.
  if (reader.pos >= reader.buf.length) return;

  const proposals = readProposals(session, reader, MAX_EMBEDDED_RESULTS);
  if (!proposals?.length) return;

  const stray = proposals.find(
    (proposal) =>
      proposal.attackType !== choreography.attackType ||
      proposal.weaponSlot !== choreography.weaponSlot ||
      proposal.isConsumable !== choreography.isConsumable
  );
  if (stray) {
    noteViolation(
      session,
      RULE.malformedProposal,
      `embedded result claims attack ${stray.attackType} from ` +
        `${stray.isConsumable ? "powerup" : "weapon"} slot ${stray.weaponSlot}, ` +
        `inside a choreography for ${choreography.attackType} from slot ${choreography.weaponSlot}`
    );
    return;
  }

  return applyProposals(session, proposals);
};

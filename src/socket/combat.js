import { PacketWriter, PacketReader } from "./packet.js";
import { CLID, OP } from "./opcodes.js";
import { config } from "../config.js";
import {
  attackById,
  FRAMES_PER_SECOND,
  npcForConstant,
  loadGameMaster,
  projectileForConstant,
} from "../gamemaster.js";
import { netAttackDamage, npcStats, statOffsetsFor } from "../combat-damage.js";
import { STAT_NAMES } from "../hero-stats.js";
import {
  buffColorTypeFor,
  buffEffectReport,
  buffMultiplierFor,
  damageReductionFor,
  grantBuff,
  hasAbility,
} from "./buffs.js";
import { buffForConstant } from "../gamemaster.js";
import { beginFloorFailing, checkFloorCleared } from "./floorstate.js";
import { objectDisable } from "./objects.js";
import { grantMana, queueAccountSave } from "./rewards.js";
import { collisionPointOf, hasLineOfSight, isPositionBlocked } from "./navigation.js";
import { heroMembersOf } from "./match-world.js";
import { worldColliders } from "./heading.js";
import { info, warn } from "../log.js";
import { RULE, noteViolation } from "./security-events.js";

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
 */

/** Field ids for ProposeCombatResults, per class. */
export const FLID_PROPOSE_COMBAT_RESULTS = 171;

/** ReceiveCombatResult has a different id on each class. */
const RECEIVE_FIELD_BY_CLID = {
  [CLID.HeroGameObject]: 160,
  [CLID.DistributedNPCGameObject]: 144,
};

const encodeCombatResults = ({
  doid,
  attackType,
  weaponSlot = 0,
  targetActorDoid = 0,
  combatResults = [],
}) => {
  const results = new PacketWriter();
  for (const result of combatResults) {
    results
      .u32(result.attacker ?? doid)
      .u32(result.attackee ?? targetActorDoid)
      .i32(result.damage ?? 0)
      .u8(result.weaponSlot ?? weaponSlot)
      .u8(result.isConsumableWeapon ?? 0)
      .u32(result.attackType ?? attackType)
      .u32(result.targetActorDoid ?? targetActorDoid)
      .u8(result.when ?? 0)
      .u8(result.suffer ?? 0)
      .u8(result.knockback ?? 0)
      .u8(result.blocked ?? 0)
      .u8(result.criticalHit ?? 0)
      .u8(result.effectiveness ?? 0)
      .i32(result.selfDamage ?? 0)
      .f32(result.scalingMaxPowerMultiplier ?? 1)
      .u8(result.generation ?? 0);
  }
  return results.body();
};

/** Makes an NPC play an attack timeline; projectile actions are client-local. */
export const npcAttackChoreography = ({
  doid,
  attackType,
  weaponSlot = 0,
  targetActorDoid = 0,
  playSpeed = 1,
  projectileMultiplier = 1,
  combatResults = [],
}) => {
  const resultBytes = encodeCombatResults({
    doid,
    attackType,
    weaponSlot,
    targetActorDoid,
    combatResults,
  });

  return new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(143) // DistributedNPCGameObject.ReceiveAttackChoreography
    .u8(weaponSlot) // Attack.weaponSlot (signed on the client; slot zero here)
    .u8(0) // Attack.isConsumableWeapon
    .u32(attackType)
    .u32(targetActorDoid)
    .u8(0) // choreography.loop
    .f32(playSpeed)
    .f32(projectileMultiplier)
    .u16(resultBytes.length)
    .raw(resultBytes)
    .frame();
};

/**
 * CombatResult is fixed width: u32 attacker, u32 attackee, i32 damage,
 * Attack (i8 weaponSlot, u8 isConsumable, u32 attackType, u32 targetDoid),
 * then u8 when/suffer/knockback/blocked/criticalHit, i8 effectiveness,
 * i32 selfDamage, f32 scaling, u8 generation.
 */
const COMBAT_RESULT_BYTES = 4 + 4 + 4 + 10 + 6 + 4 + 4 + 1;

/** Splits the byte-length-prefixed list the client sends into single results. */
/**
 * How many results one packet may carry.
 *
 * The blob's `u16` length can encode about 1771 of them, and each one costs an
 * attack lookup, a damage computation, a buff pass, a frame out and a log line
 * — all from one packet an attacker chooses the size of. That is a lever on
 * this server's time, whatever else it is.
 *
 * The recordings say what a packet actually carries: 14479 owner results in
 * 14479 packets, every one holding exactly one, and not a single blob whose
 * length was not a multiple of the record. Eight is eight times the most that
 * has ever been seen.
 */
const MAX_RESULTS_PER_PACKET = 8;

/**
 * And how many a *choreography* may carry, which is a different number.
 *
 * A charge release resolves its whole collider on the first frame and posts the
 * hits inside the choreography rather than in a packet of their own, so the
 * count is however many enemies were standing in it. `KATANA_SOUL_BANG` reaches
 * 22 in the recordings — 1490 casts carrying 7102 hits between them, and 177 of
 * those casts hold more than eight. The limit above would have refused one
 * honest cast in nine.
 *
 * Sixty-four is about three times the most ever recorded. What bounds an honest
 * cast is how many enemies fit inside the collider rather than anything the
 * format fixes, and a stocked floor carries sixty of them, so the headroom is
 * the point — while still being a bounded amount of work for one packet.
 */
const MAX_EMBEDDED_RESULTS = 64;

/**
 * A hero carries four weapons and two powerups, so a slot byte has four or two
 * meanings and no others. See `weaponsForAvatar`, which always writes exactly
 * four entries and fills the empty ones itself.
 */
const WEAPON_SLOTS = 4;
const POWERUP_SLOTS = 2;

/**
 * Reads the proposal vector, or refuses it.
 *
 * Returns null rather than a short list, because a blob that is the wrong shape
 * is not a partly honest packet — the layout is fixed width and the length is
 * declared, so anything that does not divide is either a client this server
 * cannot read or one that is probing. Neither should be half-processed.
 */
const readProposals = (session, reader, limit = MAX_RESULTS_PER_PACKET) => {
  const byteLength = reader.u16();
  const available = reader.buf.length - reader.pos;

  if (byteLength > available || byteLength % COMBAT_RESULT_BYTES !== 0) {
    noteViolation(
      session,
      RULE.malformedProposal,
      `${byteLength} bytes declared with ${available} left, record is ${COMBAT_RESULT_BYTES}`
    );
    reader.pos = reader.buf.length;
    return null;
  }

  const count = byteLength / COMBAT_RESULT_BYTES;
  if (count > limit) {
    noteViolation(session, RULE.malformedProposal, `${count} results in one packet`);
    reader.pos += byteLength;
    return null;
  }

  const blob = reader.buf.subarray(reader.pos, reader.pos + byteLength);
  reader.pos += byteLength;

  const results = [];
  for (let offset = 0; offset + COMBAT_RESULT_BYTES <= blob.length; offset += COMBAT_RESULT_BYTES) {
    const bytes = blob.subarray(offset, offset + COMBAT_RESULT_BYTES);
    const head = new PacketReader(bytes);
    const attacker = head.u32();
    const attackee = head.u32();
    head.u32(); // damage — always zero on the wire, we fill it in
    /**
     * Which of the equipped weapons swung, and whether it was a powerup rather
     * than a weapon. Both were read past and thrown away, and the comment where
     * the damage is priced said the slot was not on the wire. It is, here, and
     * the choreography carries it too — so every hit was priced with the
     * strongest thing the hero owned regardless of what made it.
     */
    const weaponSlot = head.u8();
    const isConsumable = head.u8() !== 0;
    const attackType = head.u32();
    head.u32(); // attack.targetActorDoid
    head.u8(); // when
    head.u8(); // suffer
    head.u8(); // knockback
    const blocked = head.u8();
    head.u8(); // criticalHit
    head.u8(); // effectiveness
    head.u32(); // selfDamage
    head.u32(); // scalingMaxPowerMultiplier
    /**
     * Which collision of the same projectile this is, counted from zero and
     * reset per cast. A thunderstorm cloud drifts through a crowd landing up to
     * twenty of them, and each is worth half the one before.
     */
    const generation = head.u8();
    results.push({ attacker, attackee, attackType, weaponSlot, isConsumable, blocked, generation, bytes });
  }

  return results;
};

const receiveCombatResult = (doid, fieldId, bytes) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(fieldId).raw(bytes).frame();

/** state is a UTF string; heroes use "down" for the recoverable revive state. */
const STATE_FIELD_BY_CLID = {
  [CLID.HeroGameObject]: 157,
  [CLID.DistributedNPCGameObject]: 138,
};

/**
 * Death is a state change, not a side effect of hit points reaching zero:
 * ActorGameObject.determineState switches on the string and only "dead" runs
 * enterDeadState (the death animation and cleanup). Publishing 0 hit points
 * alone leaves the corpse standing.
 */
export const stateUpdate = (doid, clid, state) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(STATE_FIELD_BY_CLID[clid])
    .utf(state)
    .frame();

/** hitPoints differs per class too. */
const HITPOINTS_FIELD_BY_CLID = {
  [CLID.HeroGameObject]: 151,
  [CLID.DistributedNPCGameObject]: 136,
};

export const hitPointsUpdate = (doid, clid, hitPoints) => {
  const writer = new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(HITPOINTS_FIELD_BY_CLID[clid]);

  // NPCs carry hit points as a u32, heroes as a u16.
  if (clid === CLID.DistributedNPCGameObject) writer.u32(hitPoints);
  else writer.u16(hitPoints);

  return writer.frame();
};

/**
 * Field 141, one byte: whether an NPC is "switched on".
 *
 * What a smashed gate gets instead of a death. Every one of them is generated
 * at 1 and switched to **0** when it breaks — the arena gate, the secret walls,
 * the smashable exits all do the same in the capture. The client reads
 * `triggerState = remoteTriggerState > 0` and derives `isAttackable` from it,
 * so zero is both the broken picture and the end of being hittable.
 *
 * Sending 1 leaves it exactly as generated: the door opens because its
 * navigation obstacle goes with the death, but nothing about it looks broken.
 */
export const triggerStateUpdate = (doid, value) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(141).u8(value).frame();

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
  if (hasAbility(session, doid, "INVULNERABLE_ALL")) return false;

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
  if (Date.now() < (session.invulnerableUntil?.get(doid) ?? 0)) return false;

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

    if (blastMs > 0) setTimeout(() => (callItDead(), retire()), blastMs).unref?.();
    else callItDead();

    actor.onDeath?.(doid);
    if (recoverableHero) (session.beginFloorFailing ?? beginFloorFailing)(session);
    else {
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
  session.objects?.delete(doid);
  session.send(objectDisable(doid));
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

const circleHitsCollider = (center, radius, collider) => {
  if (!center || !collider) return false;
  if (collider.type === "circle") {
    const dx = center.x - collider.x;
    const dy = center.y - collider.y;
    const combinedRadius = radius + Math.max(0, collider.radius ?? 0);
    return dx * dx + dy * dy <= combinedRadius * combinedRadius;
  }

  if (collider.type !== "rectangle") return false;
  const angle = -(collider.angle ?? 0);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = center.x - collider.x;
  const dy = center.y - collider.y;
  const localX = dx * cosine - dy * sine;
  const localY = dx * sine + dy * cosine;
  const closestX = Math.max(
    -(collider.halfWidth ?? 0),
    Math.min(collider.halfWidth ?? 0, localX)
  );
  const closestY = Math.max(
    -(collider.halfHeight ?? 0),
    Math.min(collider.halfHeight ?? 0, localY)
  );
  const distanceX = localX - closestX;
  const distanceY = localY - closestY;
  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
};

/**
 * Everything standing in a trap is standing in it.
 *
 * This asked only about the hero, so a spike bed or a flame jet was scenery to
 * every monster in the room — they walked through it untouched while the player
 * beside them burned.
 */
const areaTrapHits = (hazard, position, victim) => {
  const radius = Math.max(0, victim?.collisionRadius ?? 30);
  const centre = collisionPointOf(victim, position);
  return (hazard?.combatColliders ?? []).some((collider) =>
    circleHitsCollider(centre, radius, collider)
  );
};

/** Every actor a trap could hurt, hero included, with its position. */
/**
 * Whether an attack is allowed to connect at all, by side.
 *
 * `CombatGameObject.determineIfHitBasedOnTeam` is the entire rule and this
 * server had no equivalent: a HOSTILE attack lands when the teams differ, a
 * FRIENDLY one when they match, and 506 of the game's 573 attacks are HOSTILE.
 *
 * Without it every trap hit everything standing in it. Nine `MINE_PLACEABLE_ALL`
 * sit together on a temple floor, all on team 7 with ten hit points each, and a
 * mine's blast does 52 — so the first to go off killed the other eight inside
 * three milliseconds, on every floor, before the player had moved. The mines
 * were not invisible; there were none left to see.
 *
 * An unknown team is not a reason to refuse: a victim this server has not
 * classified should still be hittable, which is what it was before.
 */
const teamAllowsHit = (attack, attackerTeam, victimTeam) => {
  if (attackerTeam === undefined || victimTeam === undefined) return true;
  return String(attack?.Team) === "FRIENDLY"
    ? attackerTeam === victimTeam
    : attackerTeam !== victimTeam;
};

/**
 * Who a trap can reach.
 *
 * `includeFallen` is for the one caller that needs a body rather than a target:
 * a projectile is stopped by a downed player, which is what the client draws.
 * It admits fallen *heroes* only — a dead monster is faded out and is not cover
 * — and everything else asks who can be hurt, which a corpse cannot be.
 */
const trapVictims = (session, { attack, attackerTeam, includeFallen = false } = {}) => {
  const victims = [];
  for (const [doid, actor] of session.actors ?? []) {
    // Only a fallen *hero* counts as still being there. Killing an NPC leaves
    // its entry in the map with `dead` set — nothing removes it on the ordinary
    // path — so admitting every corpse turned each dead monster into cover and
    // an arrow trap with anything dead in front of it stopped hurting anybody.
    if (actor.dead && !(includeFallen && isPartyHero(session, doid))) continue;
    const clid = session.objects?.get(doid);
    if (!RECEIVE_FIELD_BY_CLID[clid]) continue;
    // A late join installs its actor before replay so its create/state can be
    // composed, but it is not part of live gameplay until snapshot activation.
    // Without this, shared traps could damage an unseen hero during that gap.
    if (clid === CLID.HeroGameObject && !isPartyHero(session, doid)) continue;
    if (attack && !teamAllowsHit(attack, attackerTeam, actor.team)) continue;
    /**
     * The session's cached position is preferred for its own hero because it is
     * the fresher of the two, but it is only a preference. Reading it as the
     * *only* source dropped that actor out of the list whenever the cache was
     * empty — and an actor missing from this list is not merely unhurt, it also
     * stops a projectile from noticing it at all.
     */
    const position =
      (doid === session.heroDoid ? session.heroPosition : null) ?? actor.position;
    if (position) victims.push({ doid, actor, position });
  }
  return victims;
};

const segmentHitsCircle = (from, to, center, radius) => {
  if (!from || !to || !center) return false;
  const segmentX = to.x - from.x;
  const segmentY = to.y - from.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  const centerX = center.x - from.x;
  const centerY = center.y - from.y;
  const ratio =
    lengthSquared > 0
      ? Math.max(0, Math.min(1, (centerX * segmentX + centerY * segmentY) / lengthSquared))
      : 0;
  const dx = from.x + segmentX * ratio - center.x;
  const dy = from.y + segmentY * ratio - center.y;
  return dx * dx + dy * dy <= radius * radius;
};

/**
 * What a trap takes off you.
 *
 * Most of them charge a share of the bar — `DoPercentHealthDamage` with a
 * twelfth on nearly every trap in the game, a fifth for Thor's hammer, a
 * thirtieth for the tar pit — and the captures agree: 50 off a 420-point Ranger
 * is 11.9%.
 *
 * Six do not: the five Jurassic slicers and `FLAME_BURN`. For those this used
 * to fall back to `|DamageMod|`, which is 1 on every one of them, so a disk
 * that should carve you took a single point. The official is not doing that —
 * `FLAME_BURN` lands between 6 and 22 in one session — and the row says how:
 * each carries a `Weapon1` of its own, `EN_SLICER_TRAP_WEAPON` and
 * `EN_TRAP_FLAME_WEAPON`. So they are priced like any other actor's swing, the
 * trap's weapon against the victim's defence.
 */
const trapDamage = async (session, attackerDoid, attack, victimDoid, victim, weaponPower) => {
  if (attack?.DoPercentHealthDamage) {
    return Math.max(
      1,
      Math.round(victim.maxHitPoints * Math.max(0, attack.PercentHealthDamageValue ?? 0))
    );
  }
  const priced = await computeDamage(
    session,
    { attacker: attackerDoid, attackee: victimDoid },
    attack,
    weaponPower
  );
  /**
   * `||` cannot tell "could not price it" from "priced it at nothing".
   *
   * Zero is a real answer: it is what `computeDamage` returns when the victim's
   * defence meets the hit, and the corpus sends it — 299 combat results carry a
   * damage of zero, across 39 attack types including plain monster swings like
   * EN_ARROW_SHOT and EN_MACE_CHOP. Flooring it back up contradicts that.
   *
   * Left alone because it is not worth a point of nothing. The percent-health
   * traps return above and never arrive here; the nine flat ones that do all
   * author DamageMod -1 against attackers with no offence stat, so one point of
   * the matching defence already zeroes them and the whole disagreement is 1
   * damage versus 0. None of the nine appears in any recording, so there is no
   * measurement to settle which the game did, and the cross-wired defence
   * columns above make this a bad place to guess.
   */
  return priced || Math.max(1, Math.round(Math.abs(attack?.DamageMod ?? -1)));
};

/**
 * The stagger a trap hit carries.
 *
 * The client reads these two as either/or and knockback wins
 * (`ActorGameObject.receiveDamage`): knockback plays
 * `GENERIC_SUFFER_KNOCKBACK`, suffer alone plays `GENERIC_STUN`. Its own
 * resolver writes them the same way it reads them (`CombatGameObject`) — roll
 * the stagger, and only consider a knockback if that roll won:
 *
 *     suffer = Math.random() <= StunChance ? 1 : 0;
 *     if (suffer == 1 && Knockback != 0) knockback = 1;
 *
 * Which is what the wire shows, once it is read at the right offset. Every
 * damaging trap result carries both, near enough always: 123 of 123 cave mace
 * results against monsters, 67 of 67 crusher, 50 of 50 blade, 261 of 273
 * arrows. The hero shrugs some of them off — 119 of 153 spike hits — but
 * nothing in a capture says what decides that, and `canBeKnockedBack` is the
 * client's own business.
 *
 * Two things do decide it here, and both are measured:
 *
 * A result that does no damage carries neither flag. All 44 zero-damage spike
 * results have both clear, against 119 of 153 damaging ones.
 *
 * A trap authored without them sends neither. `TRAP_TARPIT` is the only one:
 * `SufferChance` 0 and `Knockback` 0, and all 34 of its damaging hits are
 * unstaggered, where the spikes carry 30 knockback and the mace 90.
 */
const staggerFor = (attack, damage) =>
  damage <= 0
    ? { suffer: 0, knockback: 0 }
    : {
        suffer: Number(attack.SufferChance ?? attack.StunChance ?? 0) > 0 ? 1 : 0,
        knockback: Number(attack.Knockback ?? 0) !== 0 ? 1 : 0,
      };

/** Publishes the authoritative result only after an area/projectile contact. */
const applyTrapHit = async (
  session,
  attackerDoid,
  attack,
  victimDoid = session.heroDoid,
  weaponPower
) => {
  const victim = session.actors?.get(victimDoid);
  const clid = session.objects?.get(victimDoid);
  if (!victim || victim.dead || !attack || !RECEIVE_FIELD_BY_CLID[clid]) return false;
  const damage = await trapDamage(session, attackerDoid, attack, victimDoid, victim, weaponPower);

  const reaction = encodeCombatResults({
    doid: attackerDoid,
    attackType: attack.Id,
    combatResults: [
      {
        attacker: attackerDoid,
        attackee: victimDoid,
        // CombatResult uses negative numbers for damage and positive numbers
        // for healing; authoritative HP state below keeps a positive magnitude.
        damage: -damage,
        attackType: attack.Id,
        targetActorDoid: 0,
        ...staggerFor(attack, damage),
      },
    ],
  });
  applyDamage(session, victimDoid, damage, () =>
    session.send(receiveCombatResult(victimDoid, RECEIVE_FIELD_BY_CLID[clid], reaction))
  );

  /**
   * The mark a trap leaves.
   *
   * Four floor traps author one and none of them was leaving it: the tar pit's
   * `TAR_SLOW`, which is what makes a tar pit a tar pit — two seconds at a fifth
   * of your speed — and `FIRE_L1`/`FIRE_L5` off the two flame traps and the
   * burning ground.
   *
   * This ran on the hero's own swings and on placeables and simply was not
   * wired to floor traps. The capture is direct: a session in the Jurassic maps
   * generates fifteen `TAR_SLOW` buffs and every one of them names
   * `JURASSIC_DINO_TARPIT` as the attacker.
   */
  await applyTargetBuff(session, {
    attack,
    victimDoid,
    attackerDoid,
    damage,
  });

  /**
   * Named, because a doid is not something a person can act on.
   *
   * "trap 1437 hit hero for 6" says a trap somewhere did something; the report
   * that follows is then about a trap nobody can find. The constant and the
   * place are both already known here — the actor for its name, the hazard for
   * where it stands — and they turn the same line into somewhere to walk to.
   */
  const trap = session.trapNames?.get(attackerDoid) ?? session.actors?.get(attackerDoid);
  info(
    `[${session.id}] trap ${trap?.constant ?? attackerDoid}` +
      `${Number.isFinite(trap?.x) ? ` at ${Math.round(trap.x)},${Math.round(trap.y)}` : ""}` +
      ` (${attackerDoid}) hit ` +
      `${victimDoid === session.heroDoid ? "hero" : victim.constant ?? victimDoid} ` +
      `for ${damage} (${victim.hitPoints}/${victim.maxHitPoints}hp)`
  );
  return true;
};

/**
 * How far a turret's shot is allowed to reach, against what the data authors.
 *
 * `PROJ_ORB_FIREBALL` authors `Range` 1000 with `IgnoreWalls`, and the client
 * uses the same number — so this is a deliberate deviation, not a correction.
 * It is here because the statue is the one trap that tracks you: a nozzle
 * fires down its own corridor and stops at whatever it meets, while Loki turns
 * to face the player and then throws a fireball two-thirds of a screen through
 * the walls between them. Played back to back it reads as being shot at from
 * somewhere you cannot see, and the report has been consistent about it.
 *
 * Only the tracking launcher is shortened. Everything else keeps the authored
 * distance, because nothing about those has been reported and matching the game
 * is the default.
 *
 * If a measurement of how far the official's own fireballs actually reach turns
 * up later, this is the one line to delete.
 */
const TURRET_RANGE_FACTOR = (attack) =>
  attack?.Constant === "TRAP_LOKI_FIREBALL" ? 0.5 : 1;

/**
 * How far this trap's shot actually reaches, in one place.
 *
 * Shared with `withinReach`, because a statue deciding whether to bother with
 * you and the flight deciding where to stop have to agree: a turret that turns
 * to follow a player it cannot hit is the reported "they aggro from outside
 * their range", and one that stops tracking short of where its fireball still
 * lands is worse.
 */
export const trapProjectileReach = (attack, projectile) =>
  Math.max(1, (projectile?.Range ?? attack?.Range ?? 400) * TURRET_RANGE_FACTOR(attack));

const launchTrapProjectile = (session, attackerDoid, hazard) => {
  const { attack, projectile, position } = hazard ?? {};
  if (!attack || !projectile || !position) {
    warn(`trap ${attackerDoid}: cannot simulate projectile without authored data`);
    return false;
  }

  // A turret has turned to face the hero since it was placed; everything else
  // fires along the heading its tile authored. See startTurretAim.
  const radians = ((hazard.heading ?? position.heading ?? 0) * Math.PI) / 180;
  /**
   * From where the client draws it leaving, not from the mount.
   *
   * The timeline's `projectile` action carries the offset — Loki's is
   * `yOffset: -180`, a fireball out of the statue's raised hands — and reading
   * it is the difference between the drawn flame and the damaging one being
   * the same line. Resolved when the hazard is built; see `hazard.launch`.
   */
  const launch = hazard.launch ?? { xOffset: 0, yOffset: 0 };
  session.activeTrapProjectiles ??= [];
  session.activeTrapProjectiles.push({
    attackerDoid,
    attack,
    attackerTeam: hazard.team,
    position: {
      x: position.x + (launch.xOffset ?? 0),
      y: position.y + (launch.yOffset ?? 0),
    },
    direction: { x: Math.cos(radians), y: Math.sin(radians) },
    weaponPower: hazard.weaponPower,
    // Fired from inside its own mounting; see tickTrapProjectiles. Judged at
    // the muzzle, which is where the flight actually starts.
    speed: Math.max(1, projectile.ProjSpeed ?? 1),
    range: trapProjectileReach(attack, projectile),
    radius: Math.max(0, projectile.CollisionSize ?? 15),
    ignoreWalls: Object.hasOwn(projectile, "IgnoreWalls"),
    traveled: 0,
  });
  return true;
};

/**
 * Launches a projectile that exists only to carry something somewhere.
 *
 * The Vampire Hunter's traps are thrown this way: the attack itself has no
 * spawn action at all, only a `projectile`, and the Projectile row names what
 * appears where it lands — `PROJ_GARLIC.OnDeathNPC` is GARLIC_PLACEABLE_L3.
 * So the flight is the placement, and it ends wherever the throw ends: against
 * a wall, against whatever it hits, or at the end of its range.
 */
export const launchCarrierProjectile = (
  session,
  { attackerDoid, origin, headingDegrees, projectile, onDeath }
) => {
  if (!origin || !projectile) return false;
  const radians = (Number(headingDegrees ?? 0) * Math.PI) / 180;
  session.activeTrapProjectiles ??= [];
  session.activeTrapProjectiles.push({
    attackerDoid,
    attack: null,
    position: { x: origin.x, y: origin.y },
    direction: { x: Math.cos(radians), y: Math.sin(radians) },
    speed: Math.max(1, projectile.ProjSpeed ?? 500),
    range: Math.max(1, projectile.Range ?? 350),
    radius: Math.max(0, projectile.CollisionSize ?? 20),
    ignoreWalls: false,
    traveled: 0,
    ignoreDoid: attackerDoid,
    onDeath,
  });
  return true;
};

/**
 * Advances server-owned trap projectiles and resolves swept circle contacts.
 * The client runs the same GameMaster speed/range locally for visuals, but a
 * distributed trap has no owner callback that could propose its collision.
 */
export const tickTrapProjectiles = async (session, deltaSeconds) => {
  const active = session.activeTrapProjectiles ?? [];
  if (!active.length || !(deltaSeconds > 0)) return 0;

  const survivors = [];
  let hits = 0;

  for (const projectile of active) {
    const remaining = projectile.range - projectile.traveled;
    if (remaining <= 0) continue;

    const travel = Math.min(remaining, projectile.speed * deltaSeconds);
    const nextPosition = {
      x: projectile.position.x + projectile.direction.x * travel,
      y: projectile.position.y + projectile.direction.y * travel,
    };
    /**
     * A shot cannot be stopped by the wall it is mounted flush against.
     *
     * An aztec arrow trap firing along Y sits with geometry 5 units ahead and
     * nothing at all from 10 onwards, and its very first sweep clipped that lip
     * and killed it. So the muzzle is exempt: for the shot's own radius of
     * travel, a wall cannot stop it. That is bounded by construction — only the
     * radius, and only once.
     *
     * A shot mounted *inside* the wall used to be exempt as well, and for as
     * long as it stayed inside: a flag that only cleared when the bolt reached
     * open ground. It was added because ten of twelve
     * `NORDIC_CAVE_GARGOYLE_EMITTER_C` killed their arrow on the first tick and
     * went silent, and silent looked wrong.
     *
     * Silent was right. Splitting the official's own vertical gargoyles by
     * whether their muzzle sits in rock:
     *
     *   buried   11 emitters   135 shots    0 hits on the hero
     *   clear    10 emitters   144 shots   13 hits
     *
     * Not one hit in a hundred and thirty-five shots. The official's bolt dies
     * in the wall, which is also why nothing is drawn — the client builds its
     * projectile in the same rock and loses it there. The flag made ours fly on
     * through and land, so the report was an arrow you cannot see taking a
     * hundred and six health off you, on the tiles where the mount happens to
     * be buried and not on the ones where it is not.
     */
    const sweepFrom =
      projectile.traveled === 0
        ? {
            x: projectile.position.x + projectile.direction.x * projectile.radius,
            y: projectile.position.y + projectile.direction.y * projectile.radius,
          }
        : projectile.position;
    /**
     * Cleared *after* this tick is judged, not before it.
     *
     * The flag ends on the tick the shot reaches open ground — and that is the
     * one tick whose sweep still starts inside the wall it just left, so
     * clearing it first ran the line-of-sight test over the very segment the
     * flag exists to excuse. The ice caves' Y-firing gargoyle is mounted in
     * geometry that ends at 20 and its spear moves 12 a tick: the first tick
     * was excused, the second cleared the flag and then killed it, and it flew
     * 12 of an authored 800. That is the arrow reported as born and dying on
     * the spot.
     *
     * A shot that never leaves geometry keeps the flag and keeps going, which
     * is unchanged; one merely aimed at rock never had the flag to begin with
     * and still stops at the face.
     */
    const hitWall =
      !projectile.ignoreWalls &&
      !hasLineOfSight(session.navigation, sweepFrom, nextPosition, projectile.radius);
    if (hitWall) {
      projectile.onDeath?.(projectile.position);
      continue;
    }

    /**
     * An arrow stops in whatever it reaches first, which need not be the
     * player. Testing only against the hero let every bolt fly through the
     * monsters between it and you.
     */
    /**
     * Not on whoever threw it. A carrier leaves the hero's own position, and
     * the first sweep of the flight therefore starts inside the hero's own
     * collision circle — so a thrown trap died instantly and landed at his
     * feet. Arrow traps never showed this because a zero-hit-point trap is not
     * tracked as an actor at all.
     */
    const struck = trapVictims(session, {
      attack: projectile.attack,
      attackerTeam: projectile.attackerTeam,
      includeFallen: true,
    }).find(
      ({ doid, actor, position }) =>
        doid !== projectile.ignoreDoid &&
        segmentHitsCircle(
          projectile.position,
          nextPosition,
          collisionPointOf(actor, position),
          projectile.radius + Math.max(0, actor.collisionRadius ?? 30)
        )
    );
    /**
     * A body stops the shot whether or not it is still standing.
     *
     * The client draws the bolt hitting the fallen player, so a server that
     * flew it through the corpse and hurt whoever was behind disagreed with
     * what everybody could see. The corpse takes nothing, which is why the
     * flight ends here rather than falling through to the damage below.
     */
    if (struck?.actor?.dead) {
      projectile.onDeath?.(nextPosition);
      continue;
    }

    if (struck) {
      // A thrown trap carries no attack of its own: it is the delivery, and
      // what it leaves behind is the weapon.
      const landed = projectile.deal
        ? await projectile.deal(struck.doid)
        : projectile.attack &&
          (await applyTrapHit(
            session,
            projectile.attackerDoid,
            projectile.attack,
            struck.doid,
            projectile.weaponPower
          ));
      if (landed) hits++;
      projectile.onDeath?.(struck.position ?? nextPosition);
      continue;
    }

    projectile.position = nextPosition;
    projectile.traveled += travel;
    if (projectile.traveled < projectile.range) survivors.push(projectile);
    else projectile.onDeath?.(projectile.position);
  }

  session.activeTrapProjectiles = survivors;
  return hits;
};

/** Runs the authoritative projectile clock for one active dungeon session. */
export const startTrapProjectiles = (session) => {
  let previous = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - previous) / 1000;
    previous = now;
    tickTrapProjectiles(session, elapsed).catch((error) =>
      warn(`[${session.id}] trap projectiles: ${error.message}`)
    );
  }, config.projectileTickMs);
  timer.unref?.();
  info(`[${session.id}] trap projectiles ticking every ${config.projectileTickMs}ms`);
  return () => {
    clearInterval(timer);
    session.activeTrapProjectiles = [];
  };
};

/**
 * Whoever a set of world-space shapes is touching right now.
 *
 * Split out because a moving trap does not have one shape: its timeline gives
 * it a different one on each frame of the swing, and only the frame that is
 * playing should be able to catch anybody.
 */
export const hazardVictims = (session, colliders = [], hazard = null) =>
  trapVictims(session, { attack: hazard?.attack, attackerTeam: hazard?.team }).filter(
    ({ actor, position }) => areaTrapHits({ combatColliders: colliders }, position, actor)
  );

/**
 * Publishes one trap hit against one victim.
 *
 * `weaponPower` is the trap's own `Weapon1`, which only the flat-damage traps
 * need — the slicers and the burning ground. Everything else charges a share of
 * the bar and does not care.
 */
export const dealTrapHit = (session, attackerDoid, attack, victimDoid, weaponPower) =>
  applyTrapHit(session, attackerDoid, attack, victimDoid, weaponPower);

/**
 * Triggered traps have no owner client that can propose their collisions.
 * Area traps resolve on activation; projectile traps only enqueue their
 * authoritative flight here and resolve later in tickTrapProjectiles.
 */
export const performTrapAttack = async (session, attackerDoid, hazard) => {
  const attack = hazard?.attack;
  const isProjectile = Boolean(attack?.Projectile);
  const caught = isProjectile
    ? []
    : trapVictims(session, { attack, attackerTeam: hazard?.team }).filter(({ actor, position }) =>
        areaTrapHits(hazard, position, actor)
      );
  /**
   * Whoever it caught, not whoever owns the timer.
   *
   * `targetActorDoid` is where the client plays an effect authored to play at
   * its target, and zero is not neutral: `PlayEffectTimelineAction` returns
   * without drawing anything when there is no target to place it on. The
   * corpus names one on 20852 of 25003 choreographies, so it is a field the
   * game uses rather than one it leaves empty.
   *
   * Asked as "did this catch *my* hero", it was only ever true for the member
   * whose context the trap fired in — so in a party a trap that caught the
   * other player named nobody and drew nothing, for everybody.
   */
  const struck = caught.find(({ doid }) => isPartyHero(session, doid));
  const aimedHero = isPartyHero(session, hazard?.targetActorDoid) &&
      !session.actors?.get(hazard.targetActorDoid)?.dead
    ? hazard.targetActorDoid
    : 0;

  session.send(
    npcAttackChoreography({
      doid: attackerDoid,
      attackType: attack?.Id,
      targetActorDoid: struck?.doid ?? aimedHero,
    })
  );

  if (isProjectile) {
    launchTrapProjectile(session, attackerDoid, hazard);
    return false;
  }

  let hits = 0;
  for (const { doid } of caught) {
    if (await applyTrapHit(session, attackerDoid, attack, doid, hazard?.weaponPower)) hits++;
  }
  return hits > 0;
};

/**
 * One tick of something the hero put on the floor.
 *
 * A floor trap hits everything standing in it, the hero included, and that is
 * right for a spike bed. A placeable belongs to whoever placed it: the official
 * server generates it on TEAM.PLAYERS with the hero as its master, so it must
 * hit what the hero fights and never the hero. Everything else on the floor —
 * monsters and the scenery they stand among — is fair game, which is what a
 * fissure smashing barrels looks like.
 *
 * The results carry the placeable's own doid as the attacker, which is how the
 * captured FISSURE traffic credits them rather than naming the hero.
 */
/**
 * Makes the hero play an attack timeline, and sets its state in the same
 * message.
 *
 * `HeroGameObject::setStateAndAttackChoreography` — the hero's equivalent of the
 * NPC choreography above, and the only way the server can make a hero animate
 * something it did not ask for itself. The revive bombs are what need it: their
 * explosion is an authored attack that no client proposal covers, because the
 * hero was down when it went off.
 *
 * Both captured uses send an empty state and no combat results. The trailing
 * bytes the official server puts in `isConsumableWeapon`, `targetActorDoid` and
 * `loop` look like whatever was in memory — 252, 48, a doid from no known range
 * — and the client reads the timeline from `attackType` alone, so they are left
 * at zero here rather than reproduced.
 */
export const heroStateAndChoreography = ({
  doid,
  attackType,
  state = "",
  weaponSlot = 0,
  playSpeed = 1,
  projectileMultiplier = 1,
}) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(178)
    .utf(state)
    .u8(weaponSlot)
    .u8(0)
    .u32(attackType)
    .u32(0)
    .u8(0)
    .f32(playSpeed)
    .f32(projectileMultiplier)
    .u16(0)
    .frame();

/**
 * Burning, poison and the rest of the `DAMAGE_OVER_TIME` buffs.
 *
 * Captured against the official server, a mob that survived a firebomb lost
 * hit points once a second for five seconds — 4513, 3454, 2395, 1336, 277 —
 * which is FIRE_L5's authored `Duration` of five, one tick a second.
 *
 * Two details are why this went unnoticed for so long. The ticks carry **no
 * CombatResult at all**, so anything looking for combat packets finds an inert
 * buff — the damage is announced on the hero owner as a `ReportBuffEffect`
 * instead, which is what puts the number on screen. And the amount is flat
 * rather than a share of the victim — three mobs burning together each lost the
 * same 1059 a tick — so `PercentDamage` is not a fraction of anyone's health.
 * The tick came to within one percent of the blast that started it (1059
 * against 1068), so it is priced like the attack that applied it.
 */
/**
 * Whether a doid is one of the party's heroes — any of them, not one of them.
 *
 * Several rules here are about *kind*: heroes do not burn, a ground trap hurts
 * heroes and not monsters. Written against `session.heroDoid` each of them
 * answered a question about identity instead, which is the same answer while
 * there is one hero and the wrong one as soon as there are two.
 *
 * `playerActors` is the shared world's set of hero doids. A session without one
 * is solo or a fixture, where its single hero is the whole party.
 */
export const isPartyHero = (session, doid) =>
  session?.playerActors?.has(doid) ?? doid === session?.heroDoid;

const startDamageOverTime = (session, { victimDoid, buff, damage, colorType }) => {
  /**
   * The hero does not burn.
   *
   * Every damage-over-time tick in the recordings — 625 of them, fire and
   * poison, across 47 sessions — lands on a monster. Not one names a hero, and
   * that is not for want of the chance: the same corpus has flame jets hitting
   * the hero 152 times, and `TRAP_FLAME_JET` authors `FIRE_L1` as its
   * `TargetBuff1`. If the official burned the player it would be here.
   *
   * Ours did, and priced each tick as the applying attack's damage — which for
   * a trap is twelve percent of the bar. A single touch cost the hero twelve
   * percent and then sixty more, and that is what the flame traps felt like.
   *
   * An argument from absence, and flagged as one in docs/evidence.md. The buff
   * is still granted: traps are seen to leave things on the hero — fifteen
   * TAR_SLOW off the tarpit — and it is only the damage that never arrives.
   *
   * Asked of the party, not of one hero. Written against `session.heroDoid`
   * this was true for whoever's context applied the buff and false for
   * everybody else, so in a party the host did not burn and the other players
   * did — the same shape as the ground trap that hurt only one of two people
   * standing in it.
   */
  if (isPartyHero(session, victimDoid)) return;

  if (buff?.BuffType !== "DAMAGE_OVER_TIME" || !(damage > 0)) return;
  const ticks = Math.max(0, Math.round(Number(buff.Duration ?? 0)));
  if (!ticks) return;

  let remaining = ticks;
  const timer = setInterval(() => {
    const actor = session.actors?.get(victimDoid);
    const done = !actor || actor.dead || !session.dungeonActive || remaining <= 0;
    if (done) {
      clearInterval(timer);
      session.damageOverTimeTimers?.delete(timer);
      return;
    }
    remaining -= 1;
    // Hit points first, then the floater — the order every captured tick shows.
    if (!applyDamage(session, victimDoid, damage)) return;
    session.send(
      buffEffectReport({
        heroDoid: session.heroDoid,
        actorDoid: victimDoid,
        amount: -damage,
        colorType,
      })
    );
  }, 1000);
  timer.unref?.();
  session.damageOverTimeTimers ??= new Set();
  session.damageOverTimeTimers.add(timer);
};

/**
 * What a hit leaves on whoever it caught.
 *
 * `TargetBuff1` is the debuff an attack applies, and it is most of what
 * separates these from one another: garlic stuns, the fire patch burns, the
 * poison cloud poisons. Not restacked while the same one is still running,
 * since an aura ticking every second would otherwise pile up copies of its own
 * burn — the captured buffs arrive once and are left to run.
 */
export const applyTargetBuff = async (session, { attack, victimDoid, attackerDoid, damage }) => {
  if (!attack?.TargetBuff1) return;
  // A friendly attack with a distinct SelfBuff has already covered its caster.
  // DBUSTER_BERSERK gives BERSERK_DB to the Berserker and BERSERK to allies;
  // the caster's impact result must not turn that into two simultaneous buffs.
  if (
    attack.Team === "FRIENDLY" &&
    attack.SelfBuff &&
    Number(victimDoid) === Number(attackerDoid)
  ) {
    return;
  }
  const already = [...(session.activeBuffs?.values() ?? [])].some(
    (active) =>
      active.affectedActor === victimDoid && active.buff?.Constant === attack.TargetBuff1
  );
  if (already) return;

  await grantBuff(session, attack.TargetBuff1, {
    affectedActor: victimDoid,
    attackerActor: attackerDoid,
  });
  const buff = await buffForConstant(attack.TargetBuff1);
  startDamageOverTime(session, {
    victimDoid,
    buff,
    damage,
    colorType: await buffColorTypeFor(buff),
  });
};

/**
 * Everything a placeable's authored shape is currently covering.
 *
 * Separate from dealing the damage because whether there is anyone in it is the
 * question a trap asks before it goes off, and because an aura that fires into
 * an empty room sends an animation nobody asked for — the captured clouds are
 * silent until something walks in.
 */
export const placeableVictims = (session, attackerDoid, colliders = []) => {
  if (!colliders.length) return [];
  const hazard = { combatColliders: colliders };
  const found = [];
  for (const victim of trapVictims(session)) {
    if (victim.doid === attackerDoid || victim.doid === session.heroDoid) continue;
    /**
     * Monsters only. Barrels, crates and tables are scenery to these: a trap
     * is not sprung by a crate and does not go off against one, and the
     * player's own placed things — all of them on TEAM.PLAYERS — do not set
     * each other off either. A firebomb's fire was burning the trap that made
     * it, and a bomb thrown past a barrel rack was spending itself on the
     * furniture.
     */
    if (!victim.actor.isEnemy) continue;
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
  { attack, victims = [], weaponPower }
) => {
  if (!attack) return 0;

  let hits = 0;
  for (const victim of victims) {
    const clid = session.objects?.get(victim.doid);
    if (!RECEIVE_FIELD_BY_CLID[clid] || victim.actor.dead) continue;

    const damage = await computeDamage(
      session,
      { attacker: session.heroDoid, attackee: victim.doid, attackType: attack.Id },
      attack,
      weaponPower
    );
    if (!(damage > 0)) continue;

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
            ...staggerFor(attack, damage),
          },
        ],
      })
    );
    if (applyDamage(session, victim.doid, damage, () => session.send(reaction))) hits++;

    if (!victim.actor.dead) {
      await applyTargetBuff(session, {
        attack,
        victimDoid: victim.doid,
        attackerDoid,
        damage,
      });
    }
  }
  return hits;
};

/**
 * Lands one monster swing, if it is still landing on anybody.
 *
 * `shape` is the attack's own colliders in world space, or nothing for an
 * attack that authors none. Given a shape, the hero has to be inside it — this
 * is the moment of contact, not the moment the monster decided to swing.
 */
/**
 * Prices and publishes one hit dealt by a monster, on whoever it landed on.
 *
 * Shared by the swing and by the shot, which is the point: a monster's arrow
 * costs the same as its sword by the same formula, and both are the server's to
 * decide. The official is unambiguous about that last part — across 54 captures
 * the client proposes 4646 combat results and every one of them is the hero
 * hitting something. It never once proposes a monster hitting the hero, and the
 * 4469 results that do are all sent by the server.
 */
const dealNpcHit = async (session, attackerDoid, { attack, attackType, weaponPower, fallback }, victimDoid) => {
  const victim = session.actors?.get(victimDoid);
  const attacker = session.actors?.get(attackerDoid);
  const clid = session.objects?.get(victimDoid);
  if (!victim || victim.dead || !RECEIVE_FIELD_BY_CLID[clid]) return false;

  const petResult = attacker?.isPet
    ? await computePetDamage(session, attackerDoid, victimDoid, attack, weaponPower)
    : null;
  const damage = petResult?.damage ?? (
    (await computeDamage(
      session,
      { attacker: attackerDoid, attackee: victimDoid },
      attack,
      weaponPower
    )) || Math.max(1, fallback ?? 1)
  );

  const reaction = receiveCombatResult(
    victimDoid,
    RECEIVE_FIELD_BY_CLID[clid],
    encodeCombatResults({
      doid: attackerDoid,
      attackType,
      combatResults: [
        {
          attacker: attackerDoid,
          attackee: victimDoid,
          damage: -damage,
          attackType,
          targetActorDoid: 0,
          effectiveness: petResult?.effectiveness ?? 0,
          ...staggerFor(attack, damage),
        },
      ],
    })
  );
  applyDamage(session, victimDoid, damage, () => session.send(reaction));
  info(
    `[${session.id}] AI ${attackerDoid} hit ${victimDoid} for ${damage} ` +
      `(${victim.hitPoints}/${victim.maxHitPoints}hp)`
  );
  return true;
};

const landNpcSwing = async (session, attackerDoid, ai, attack, shape, victimDoid) => {
  const attacker = session.actors?.get(attackerDoid);
  const victim = session.actors?.get(victimDoid);
  if (!attacker || attacker.dead || !victim || victim.dead) return false;

  if (shape?.length) {
    const reach = worldColliders(
      attacker.position,
      attacker.heading ?? 0,
      shape
    );
    const caught = hazardVictims(session, reach, { attack, team: attacker.team })
      .filter(({ doid }) => doid !== attackerDoid);
    if (!caught.length) return false;

    /**
     * The chosen target decides where the NPC faces, not everything the arc
     * touches. This distinction is what lets a pet take the occasional melee
     * hit without owning the monster's aggro: in official pet captures only
     * 12.7% of measurable pet hits align with the pet, while most align with a
     * nearby hero. Resolving only `victimDoid` turned collateral into target
     * selection and forced AI to aggro pets merely so they could ever be hit.
     */
    let hits = 0;
    for (const caughtActor of caught) {
      if (await dealNpcHit(
        session,
        attackerDoid,
        { attack, attackType: ai.attackType, weaponPower: ai.weaponPower, fallback: ai.damage },
        caughtActor.doid
      )) hits += 1;
    }
    return hits > 0;
  }

  return dealNpcHit(
    session,
    attackerDoid,
    { attack, attackType: ai.attackType, weaponPower: ai.weaponPower, fallback: ai.damage },
    victimDoid
  );
};

/**
 * Puts a monster's shot into the air, to be resolved by where it gets to.
 *
 * The same flight the traps have used since their arrows stopped passing
 * through people: one record on the shared list, swept against actors and
 * walls, dead at its authored range. Only the pricing differs, so only the
 * pricing is passed in.
 *
 * Launched from the frame the timeline authors rather than from the start of
 * the animation, and that frame is not a rounding detail — a bow looses on
 * frame 2 and a specter's cast leaves its hands on frame 30, which is 1250ms.
 * The official's median delay between a `PURPLE_SPECTER` announcing and the
 * hero's result arriving is 1494ms, so the cast is most of it.
 */
const launchNpcProjectile = (session, attackerDoid, ai, attack, launch = {}) => {
  const attacker = session.actors?.get(attackerDoid);
  const projectile = ai.projectile;
  if (!attacker || attacker.dead || !projectile || !attacker.position) return false;

  /**
   * The client's own transform, which keeps four things apart:
   *
   *   ProjectileAttackTimelineAction.execute
   *     angle  = heading + headingOffsetAngle (+ rand(-r, r))
   *     origin = worldCenter
   *            + headingOffset x (cos, sin)(angle)     <- a distance
   *            + (xOffset, yOffset)                    <- world axes, unrotated
   *     direction = getHeadingAsVector(headingOffsetAngle)
   *
   * This read `headingOffset` as though it were degrees. It is not, and
   * `TM_GATLING_ARROW` says so loudest: 40 with an angle of zero, which turned
   * six arrows out of a statue's mouth into six fired forty degrees off the
   * ones the player can see.
   *
   * `worldCenter` is the body above the feet — the same `collisionPointOf` the
   * victims are tested at, so both ends of the shot are finally in one
   * coordinate system.
   */
  const spread = Number(launch.headingRandomnessAngle ?? 0);
  const angle =
    Number(attacker.heading ?? 0) +
    Number(launch.headingOffsetAngle ?? 0) +
    (spread ? (Math.random() * 2 - 1) * spread : 0);
  const radians = (angle * Math.PI) / 180;
  const centre = collisionPointOf(attacker, attacker.position) ?? attacker.position;
  const muzzle = Number(launch.headingOffset ?? 0);
  const origin = {
    x: centre.x + muzzle * Math.cos(radians) + Number(launch.xOffset ?? 0),
    y: centre.y + muzzle * Math.sin(radians) + Number(launch.yOffset ?? 0),
  };
  const radius = Math.max(0, projectile.CollisionSize ?? 15);

  session.activeTrapProjectiles ??= [];
  session.activeTrapProjectiles.push({
    attackerDoid,
    attack,
    attackerTeam: attacker.team,
    position: origin,
    direction: { x: Math.cos(radians), y: Math.sin(radians) },
    // It leaves from inside the shooter's own body, so the shooter cannot be
    // the first thing it hits.
    ignoreDoid: attackerDoid,
    speed: Math.max(1, projectile.ProjSpeed ?? 1),
    range: Math.max(1, projectile.Range ?? attack?.Range ?? 400),
    radius,
    ignoreWalls: Object.hasOwn(projectile, "IgnoreWalls"),
    traveled: 0,
    // What makes this a monster's shot rather than a trap's: an actor's damage
    // formula instead of a share of the health bar.
    deal: (victimDoid) =>
      dealNpcHit(
        session,
        attackerDoid,
        { attack, attackType: ai.attackType, weaponPower: ai.weaponPower, fallback: ai.damage },
        victimDoid
      ),
  });
  return true;
};

/**
 * A monster swings, and the swing is resolved where and when it actually lands.
 *
 * "Their attacks don't connect and we take damage anyway." Both halves of the
 * geometry were wrong, and each on its own is enough to produce that.
 *
 * *When*: this used to compute the damage and take it off the bar in the same
 * breath as sending the animation, while telling the client the impact was at
 * frame `impactFrame`. A knight's `EN_SWORD_SLASH` authors its collider at
 * frame 11 of 12 — 458ms of windup — so the health dropped while the sword was
 * still going up, and a player who stepped away during it was hit by a swing
 * they watched miss.
 *
 * *Where*: reach was `Range` measured from the monster's middle in every
 * direction, so a knight hit whoever stood behind it. The timeline says
 * otherwise, and it says it per attack:
 *
 *   EN_SWORD_SLASH    circle r40 at 45 in front, frame 11
 *   EN_MACE_CHOP      circle r35 at 70 in front, frame 3
 *   EN_SPEAR_THRUST   200x70 box at 100 in front, frame 4
 *   EN_RAPTOR_BITE    circle r35 at 70 in front, frame 3
 *
 * These are the same shapes, read the same way, that traps have been resolved
 * with since the mace stopped hurting people it swung over.
 *
 * Ranged attacks author no collider — `EN_ICE_IMP_ATTACK` and `EN_ARROW_SHOT`
 * carry Range 700 and 600 and nothing else — and are left resolving as they
 * did, at the moment they are thrown. Giving them a projectile of their own is
 * a separate piece of work; making them miss in the meantime would be worse
 * than the bug.
 */
export const performNpcAttack = async (
  session,
  attackerDoid,
  ai,
  victimDoid = session.heroDoid
) => {
  const victim = session.actors?.get(victimDoid);
  if (!victim || victim.dead || !ai?.attackType) return false;
  const attack = await attackById(ai.attackType);

  /**
   * Announced once, on its own. `ReceiveAttackChoreography` restarts the
   * animation from frame zero, so the result cannot ride along on a second one
   * — it goes out by itself when the swing connects, the way a trap's does.
   */
  session.send(
    npcAttackChoreography({
      doid: attackerDoid,
      attackType: ai.attackType,
      targetActorDoid: victimDoid,
    })
  );

  /**
   * A shot is put in the air and resolved by where it gets to; a swing is
   * resolved by what its collider covers when it comes round. Which of the two
   * this is comes from the attack row, not from a list of names.
   */
  const shape = ai.attackColliders ?? [];
  const shots = ai.projectile ? ai.projectileLaunches ?? [] : [];
  const frameMs = (frame) => Math.max(0, Number(frame ?? 0)) * (1000 / FRAMES_PER_SECOND);

  // A swing with no collider and nothing to throw resolves where it stands;
  // two enemy attacks in the game are like that and both are measured in
  // dungeon.js.
  if (!shots.length && !shape.length) {
    return landNpcSwing(session, attackerDoid, ai, attack, shape, victimDoid);
  }

  const timers = [];
  const later = (delay, run) => {
    if (!delay) return void Promise.resolve(run()).catch(report);
    timers.push(setTimeout(() => Promise.resolve(run()).catch(report), delay));
  };
  const report = (error) =>
    warn(`npc attack ${attackerDoid}: ${error.stack ?? error.message ?? error}`);

  if (shots.length) {
    /**
     * Every action the timeline authors, each on its own frame. A gatling
     * statue looses six between frames 35 and 54 and a specter's triple cast
     * three on one frame; taking only the first left five sixths of the burst
     * drawn by the client and unknown to the server.
     */
    for (const launch of shots) {
      later(frameMs(launch.frame), () =>
        launchNpcProjectile(session, attackerDoid, ai, attack, launch)
      );
    }
  } else {
    later(frameMs(ai.impactFrame), () =>
      landNpcSwing(session, attackerDoid, ai, attack, shape, victimDoid)
    );
  }

  // Keyed by the attacker, so its next attack replaces this one and a floor
  // change cancels every beat still in flight.
  if (timers.length) {
    session.hazardBeats ??= new Map();
    session.hazardBeats.get(`swing:${attackerDoid}`)?.();
    session.hazardBeats.set(`swing:${attackerDoid}`, () => timers.forEach(clearTimeout));
  }
  return true;
};

/**
 * Damage is the server's to compute. The client fills in who hit whom, with
 * which attack, and whether it was blocked — but never the number: look at
 * CombatGameObject, which reads the weapon's power and then leaves
 * `damage` at zero. So a relayed proposal with its zero intact produces a hit
 * that does nothing.
 *
 * The arithmetic itself is not ours: the client still carries it whole in
 * DistributedDungionArea.calculateNetAttackDamage, with every call site removed.
 * See combat-damage.js — attacker offence stat and weapon power against the
 * victim's defence, scaled by the attack's DamageMod.
 *
 * Returned as a positive magnitude; the caller negates it for the wire.
 */
/**
 * Asked of the floor rather than of a connection.
 *
 * A monster's numbers come from its `constant`, which anything holding the
 * floor can look up. A hero's lived on its own session, so this had to ask "is
 * this doid the session's own hero?" to find them — and any other member of the
 * party fell through to an NPC lookup that cannot succeed, because no hero
 * constant is in the Npc table. Their defence silently counted as zero, and the
 * lookup warned about a missing NPC on every hit.
 *
 * That question was also the only reason floor code had a notion of *whose*
 * hero at all. A server has no self: a hazard firing, a bomb going off and a
 * monster swinging happen to actors on a floor, and which connection is holding
 * the timer is not part of the arithmetic. Heroes now carry their numbers on
 * the actor, like everything else on the floor does.
 */
const statsFor = async (session, doid) => {
  const actor = session.actors?.get(doid);
  if (actor?.stats) return actor.stats;
  // For a hero installed before its stats were known, and for hand-built
  // sessions in tests that predate the actor carrying them.
  if (doid === session.heroDoid) return session.heroStats;
  if (!actor?.constant) return undefined;
  return npcStats(await loadGameMaster(), await npcForConstant(actor.constant));
};

/**
 * How much a repeated hit is worth.
 *
 * The client counts each collision of a projectile in `generation`, and the
 * captures show the damage halving with it. One victim caught by two different
 * storms settles it: at generation 0 it took 2877, and at generation 2 it took
 * 720, which is 2877 over four. So a cloud mauls the first thing it reaches and
 * is nearly spent by the fifth.
 *
 * Harmless for everything else — an ordinary swing is generation zero and
 * divides by one.
 */
const generationFalloff = (generation) => 2 ** Math.max(0, Number(generation ?? 0));

/**
 * The most a hero may turn aside through training alone.
 *
 * Everything earned rather than granted is bounded, so no amount of levelling
 * arrives at untouchable — that is reserved for a buff that says it outright,
 * and there is exactly one. It is not reached today: a Berserker with every
 * point in the slot sits at 24.75%, which is half the ceiling.
 */
const MAX_TRAINED_REDUCTION = 0.5;

/**
 * What a defender turns aside from one type of hit, as a share of it.
 *
 * The trained half is the `*_DEF` stat, which only one hero has any of:
 * `MASTER_DEFENSE` is the Berserker's fourth slot and gives 0.0033 a point
 * across all three types, so every point in it reaches 24.75% and nobody else
 * reaches anything — a Ranger with all seventy-five there still measures zero.
 * That is the tankiness he trains for, and it is his.
 *
 * Combined with the buffs multiplicatively rather than added, so the two leave
 * a remainder: a quarter off from training and half off from `DEFENDER_L2` is
 * 62%, not 75%. Only a source that is itself all of it gets to all of it, and
 * the trained half is capped well below that in any case.
 *
 * A function rather than four lines inside `computeDamage` because `/stats`
 * reports this number to the player, and a second copy of the formula written
 * to read it out is a copy that drifts from the one that charges for it.
 */
export const damageTurnedAside = (session, doid, stats, offsets) => {
  if (!offsets) return 0;
  const stat = STAT_NAMES[offsets.defence];
  const trained = Math.min(
    MAX_TRAINED_REDUCTION,
    Math.max(0, Number(stats?.get(stat)) || 0)
  );
  return 1 - (1 - trained) * (1 - damageReductionFor(session, doid, stat));
};

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

const computeDamage = async (session, proposal, attack, weaponPower) => {
  const offsets = statOffsetsFor(attack);
  const defender = await statsFor(session, proposal.attackee);
  const signed = netAttackDamage({
    gm: await loadGameMaster(),
    attack,
    // The slot that swung, which the result names. NPCs and placeables pass
    // their own weapon explicitly and never reach the fallback.
    weaponPower: weaponPower ?? 1,
    attacker: await statsFor(session, proposal.attacker),
    defender,
    attackerBuff: offsets
      ? buffMultiplierFor(session, proposal.attacker, STAT_NAMES[offsets.offence])
      : 1,
    /**
     * The defence *stat* is still a flat subtraction and still tiny; what a
     * buff does is take a share off the hit, which is handled below.
     */
    defenderBuff: 1,
  });

  if (signed >= 0) return 0; // a heal is `computeHealing`'s to price
  const raw = -signed / generationFalloff(proposal.generation);

  /**
   * And then what the defender's buffs take off it, by the type of the hit.
   *
   * Separately from the stat, because the two are different things wearing the
   * same column name: `MELEE_DEF` on a hero is a small flat number, and
   * `MELEE_DEF` on a buff is a share of the incoming hit. Reading the second as
   * a multiplier on the first is what left the whole family doing nothing.
   *
   * Type by type, which is what makes a Berserker a tank against the pack he
   * has waded into without making him one against the archers behind it — the
   * data separates melee, shooting and magic and this keeps them separate.
   *
   * Traps are not here. Twenty-four of the game's forty trap attacks take a
   * share of maximum health and never reach this path at all, so no amount of
   * reduction saves a player from walking into spikes. That is the floor's job
   * and it stays the floor's job.
   */
  const reduction = damageTurnedAside(session, proposal.attackee, defender, offsets);
  // All of it is all of it. The floor of one exists so a hit that lands is felt,
  // and a hit that is entirely turned aside did not land.
  if (reduction >= 1) return 0;
  return Math.max(1, Math.round(raw * (1 - reduction)));
};

const PET_DEFENCE_FIELD = {
  MELEE: "MELEE_DEF",
  SHOOTING: "SHOOT_DEF",
  MAGIC: "MAGIC_DEF",
};

/**
 * Pet results use an authored categorical defence, not the hero's trained
 * fractional defence path above. A target rating of +1 resists (half damage),
 * zero is neutral, and -1 is weak (double damage); the result carries the
 * inverse value so the client draws the matching effectiveness floater.
 */
const petEffectivenessAgainst = async (victim, attack) => {
  const field = PET_DEFENCE_FIELD[attack?.AttackType];
  if (!field || !victim?.constant) return 0;
  const row = await npcForConstant(victim.constant);
  const rating = Math.round(Number(row?.[field] ?? 0));
  return Math.max(-2, Math.min(2, -rating));
};

/** Prices one persistent pet hit exactly as the official pet corpus does. */
const computePetDamage = async (session, attackerDoid, victimDoid, attack, weaponPower) => {
  const offsets = statOffsetsFor(attack);
  const effectiveness = await petEffectivenessAgainst(
    session.actors?.get(victimDoid),
    attack
  );
  const signed = netAttackDamage({
    gm: await loadGameMaster(),
    attack,
    weaponPower: weaponPower ?? 1,
    attacker: await statsFor(session, attackerDoid),
    // The categorical multiplier below is the target's defence for pet hits.
    defender: undefined,
    attackerBuff: offsets
      ? buffMultiplierFor(session, attackerDoid, STAT_NAMES[offsets.offence])
      : 1,
    defenderBuff: 1,
  });
  if (signed >= 0) return { damage: 0, effectiveness };

  const buffed = offsets
    ? damageReductionFor(session, victimDoid, STAT_NAMES[offsets.defence])
    : 0;
  if (buffed >= 1) return { damage: 0, effectiveness };
  // The official rounds the neutral pet hit first, then applies the categorical
  // half/double. L75 Wolf bite is 287.56 -> 288 -> 144/288/576.
  const neutral = Math.round(-signed);
  const damage = Math.max(1, Math.round(neutral * (2 ** effectiveness) * (1 - buffed)));
  return { damage, effectiveness };
};

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
const computeHealing = async (session, proposal, attack, weaponPower) => {
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
  return Math.max(1, Math.round(signed / generationFalloff(proposal.generation)));
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

/** Rewrites the signed wire damage field of a CombatResult on a copy. */
const withDamage = (bytes, wireDamage) => {
  const copy = Buffer.from(bytes);
  copy.writeInt32LE(wireDamage, 8); // attacker(4) + attackee(4)
  return copy;
};

/**
 * Applies each proposed result: computes the damage, tells the victim, and
 * publishes its new hit points. Returns true when handled so the caller does
 * not log it as unimplemented.
 */
/**
 * How far a claimed hit may reasonably have reached.
 *
 * The client says *that* a hit happened and the server prices it; it is the one
 * claim on the hot path with nothing checking it, so a modified client can
 * report hitting every monster on the floor from where it stands. The damage
 * would still be ours, but the hits would be theirs.
 *
 * The bound comes from the official's own play rather than from a guess. Over
 * 5445 of its hit claims, measured as the distance to the victim minus the
 * attack's authored reach:
 *
 *   median -227   p90 -37   p99 +35   p999 +190   worst +253
 *
 * Only 221 of the 5445 exceed the authored reach at all, and the ones that do
 * are explicable: `IMPALE_DASH_FORWARD` and `KATANA_SHADOW_SLASH` carry the
 * hero along with the swing, `THROW_GARLIC` is thrown, and every sample is read
 * against a hero position up to 208ms old — a fifth of a second at 250 a second
 * is another 52 units.
 *
 * So the slack is set well past the worst honest case. Nothing in those 5445
 * would have been questioned, and a claim on something across the floor still
 * would be.
 *
 * A teleport does not trip this. It compares the hit to where the hero *is*,
 * not to where it was, so being dropped beside a party member on joining — or
 * anywhere else the server puts you — reads as an ordinary hit from wherever
 * you landed. Only a speed check would have that problem, which is why this is
 * the one that goes first.
 */
const REACH_SLACK = 400;

/**
 * How far past its authored reach an honest claim lands.
 *
 * There was a staleness term here: the bound grew with the age of the hero's
 * position, up to a cap, past which this server declined to judge at all. Both
 * halves were wrong, and in opposite directions. The client chooses whether to
 * send field 147, so the growing allowance was bought on demand — and declining
 * past the cap turned withholding into a way to switch the rule off entirely.
 *
 * Neither is needed, because age is not error. The client sends a position when
 * it changes, so a hero standing still legitimately has an old one — the oldest
 * used by an honest claim in the recordings is 64.9 seconds — and it is still
 * exactly where he is. Measured against those same last-known positions, over
 * 14479 claims with a locatable victim, the distance beyond the attack's
 * authored reach is -39 at the median, 69 at the p99 and **253 at the worst**.
 *
 * So the allowance is fixed and the answer is always given. `REACH_SLACK` is
 * 400, which is a little over half again the widest honest excess.
 */
const claimedReachOf = async (attack) => {
  let reach = Math.max(0, Number(attack?.Range ?? 0));
  if (attack?.Projectile) {
    const projectile = await projectileForConstant(attack.Projectile);
    reach = Math.max(reach, Number(projectile?.Range ?? 0));
  }
  return reach + REACH_SLACK;
};

/**
 * How far past its reach a claimed hit was, or nothing when it was within it.
 *
 * Exported so the projectile branch is exercised by a test: the first version
 * of this shipped with `projectileForConstant` missing from the imports, and
 * the melee-only test never reached the line that needed it.
 */
/**
 * Two attacks the hero lands without ever casting them.
 *
 * `HEALTH_BOMB_ATTACK` and `PARTY_BOMB_ATTACK` go out through the revive path
 * rather than through a choreography. They are the whole of the exception: of
 * 5447 hero hit claims in the official recordings, 4998 follow a choreography
 * of the same attack and the 449 that do not are these two and nothing else.
 */
const CASTLESS_ATTACKS = new Set(["HEALTH_BOMB_ATTACK", "PARTY_BOMB_ATTACK"]);

/**
 * Remembers that an attack was *accepted*, which is the point.
 *
 * A refusal in `handleProposeAttackChoreography` used to be cosmetic. Costing
 * nothing and spawning nothing, it still let the damage through, because hit
 * results arrive on their own field and nothing tied the two together — so a
 * client could skip the cast entirely and land the attack for free: no Mana, no
 * Crowd points, no cooldown.
 *
 * The Battle Chef showed it by accident. Its Dungeon Buster was refused for
 * months by a guard that should never have caught it, and the meteors never
 * spawned and the bar never emptied — and the damage landed every time.
 */
/**
 * How long one cast may still be answering for hits, and how many it may
 * answer for. Both are bounds on honest play rather than models of it.
 *
 * The recordings say what honest looks like, over 14297 hits matched back to
 * the cast that preceded them: the gap is 108ms at the median and 249 at p90,
 * but the tail is long and legitimate — `DBUSTER_MEATEOR_SHOWER` lands 124 hits
 * from one cast, and `LAZY_BOOMERANG` was still hitting 22.0 seconds after it
 * was thrown, 66 times. A window drawn near the median would delete those.
 *
 * So these sit above the observed maximum with room to spare and do not try to
 * be exact. Being exact per attack means deriving flight time and lifetime from
 * the authored timeline, and a formula of ours that comes out short refuses
 * hits the player earned — which is how the cooldown gap behaved before it was
 * measured. A generous finite bound is the honest version of what is knowable
 * now, and it is the whole of what was missing: the map had no expiry and no
 * budget at all, so one accepted cast authorised that attack for the rest of
 * the socket's life.
 */
const CAST_WINDOW_MS = 30_000;

/**
 * How many results one accepted cast may answer for.
 *
 * 124 is the most any single cast has ever landed — a Battle Chef's meteor
 * shower — with a boomerang next at 66 and an ordinary combo at 35. The bound
 * is a little over the widest of those rather than the 256 it was, which was
 * picked to clear the meteor shower and gave an axe swing the same allowance.
 *
 * Per-attack budgets would be better and are not yet derivable. The authored
 * `MaxCollisions` is 30 on every row in the game, and two attacks beat it
 * outright, because one cast can spawn several projectiles and each carries its
 * own. The recordings only cover 18 of 573 attacks, so a table built from them
 * would be a guess everywhere else and would rot as the rest arrived.
 */
const CAST_HIT_BUDGET = 160;

/**
 * How many accepted casts a hero may have in flight.
 *
 * Bounded so a client cannot make this server remember an unbounded number of
 * them, and large enough that nothing honest is displaced — which is where the
 * first attempt at this went wrong. Thirty-two sounded generous and is not:
 * honest play has up to 322 casts live inside one 30-second window, and 137 of
 * a single attack and slot, because a combo chain and a meteor shower each send
 * many choreographies for one visible action. Dropping the oldest would have
 * refused the hits still arriving for it.
 *
 * What bounds damage is the tally below, not this. This only bounds memory.
 */
const MAX_LIVE_CASTS = 512;

/**
 * What one body may absorb from one attack and slot, across the window.
 *
 * This is the bound that matters, and it deliberately sits outside the cast
 * records. Per-record ceilings multiply: a client that sends many
 * choreographies — which honest clients do, 137 of one attack and slot inside
 * thirty seconds — gets a fresh allowance with each, so 24 a record was 3000
 * against the same boss.
 *
 * One tally per attack, slot and target instead, over the same 30-second
 * window. Honest play's worst is 30, a Battle Chef's cleaver combo against one
 * monster; 96 is more than three times that.
 *
 * Uniqueness on `(target, generation)` would be tighter and is not safe: honest
 * play repeats those pairs 3683 times inside a single cast, because a melee
 * attack has no projectile and every one of its hits is generation zero.
 */
const HITS_PER_TARGET = 96;

/** Bounded like everything else, and pruned on the packet already running. */
const MAX_TARGET_TALLIES = 4096;

/**
 * Remembers that an attack was *accepted*, which is the point.
 *
 * A refusal in `handleProposeAttackChoreography` used to be cosmetic. Costing
 * nothing and spawning nothing, it still let the damage through, because hit
 * results arrive on their own field and nothing tied the two together — so a
 * client could skip the cast entirely and land the attack for free: no Mana, no
 * Crowd points, no cooldown.
 *
 * The Battle Chef showed it by accident. Its Dungeon Buster was refused for
 * months by a guard that should never have caught it, and the meteors never
 * spawned and the bar never emptied — and the damage landed every time.
 */
export const noteCast = (session, attack, weaponSlot = 0, now = Date.now()) => {
  if (!attack?.Id) return false;
  session.acceptedCasts ??= [];

  /**
   * A list rather than one record per attack id.
   *
   * Keyed by the attack, a second swing overwrote the first and handed back a
   * full budget — so the budget bounded nothing a client could not renew by
   * asking again. Casts of the same attack now coexist and are spent oldest
   * first, which is the order they were made in.
   *
   * The slot rides along because a result names one, and a hit made with the
   * axe should not be answered for by the cast of the staff.
   */
  const live = session.acceptedCasts.filter((record) => now - record.at <= CAST_WINDOW_MS);
  // Lazily, on the packet that is already here: no timers.
  live.push({
    attackId: Number(attack.Id),
    weaponSlot: Number(weaponSlot ?? 0),
    at: now,
    hits: 0,
  });
  session.acceptedCasts = live.slice(-MAX_LIVE_CASTS);
  return true;
};

/**
 * How long after a revive its bomb may still be landing.
 *
 * The two bombs send no choreography of their own, which is why they are exempt
 * from the cast rule — but they are not uncaused. Every one of the 18
 * detonations in the recordings follows a `ProposeSelfRevive` that this server
 * accepted and charged an account bomb for, and the gap is remarkably tight:
 * 2331ms at the shortest, 2394 at the median, 3411 at the longest.
 *
 * Ten seconds is three times the widest of those. It does not need to be close,
 * only finite: what was wrong was that the exemption was unconditional.
 */
const BOMB_WINDOW_MS = 10_000;

/**
 * And how many bodies one detonation may reach.
 *
 * The window alone said when, not how much, so one paid bomb answered for
 * every result that arrived inside ten seconds — enough to clear a floor from a
 * single item. A bomb is one blast: across the recordings the health bomb lands
 * a median of 9 hits and at most 27, the party bomb 5 and at most 16, and every
 * burst finishes within 3 milliseconds.
 *
 * Sixty-four is well over twice the widest of those. The authored row agrees
 * about the shape — `MaxCollisions` 30, `HitsPerCollision` 1 — so this is a
 * ceiling rather than a model of the blast.
 */
const BOMB_HIT_BUDGET = 64;

/**
 * A blast reaches a body once or twice, never sixty-four times. The health bomb
 * has hit the same target twice in the recordings and the party bomb once, so
 * eight is four times the worst seen and still closes "erase a boss with one
 * item".
 */
const BOMB_HITS_PER_TARGET = 8;

const BOMB_ATTACK_FOR = { party: "PARTY_BOMB_ATTACK", health: "HEALTH_BOMB_ATTACK" };

/**
 * A revive is the bomb's cast.
 *
 * `handleProposeSelfRevive` is where the bomb is actually paid for — it spends
 * one from the account and refuses when there is none — so nothing further is
 * charged here. All that was missing is that the *results* were accepted
 * whatever had happened, so a modified client could land a bomb's damage having
 * never revived and never spent anything.
 */
export const noteBombCast = (session, reviveAll, now = Date.now()) => {
  session.bombCasts ??= new Map();
  session.bombCasts.set(BOMB_ATTACK_FOR[reviveAll ? "party" : "health"], {
    at: now,
    hits: 0,
    perTarget: new Map(),
  });
  return true;
};

/** Nothing survives the floor it was thrown on. */
export const clearBombCasts = (session) => {
  session.bombCasts?.clear();
};

const bombWasCast = (session, attack, targetDoid, now) => {
  const record = session.bombCasts?.get(attack?.Constant);
  if (!record || now - record.at > BOMB_WINDOW_MS) {
    noteViolation(session, RULE.bombWithoutRevive, `${attack?.Constant} with no revive behind it`);
    return false;
  }
  const onThisOne = record.perTarget.get(targetDoid) ?? 0;
  if (record.hits >= BOMB_HIT_BUDGET || onThisOne >= BOMB_HITS_PER_TARGET) {
    noteViolation(
      session,
      RULE.bombBudget,
      `${attack?.Constant} past what one blast reaches (${record.hits} hits, ${onThisOne} on this body)`
    );
    return false;
  }

  // Spent by landing, or the budget means nothing.
  record.hits += 1;
  record.perTarget.set(targetDoid, onThisOne + 1);
  return true;
};

/**
 * One body's share of one attack and slot, counted across the window rather
 * than per cast, and spent by landing.
 */
const spendOnTarget = (session, source, targetDoid, now) => {
  session.targetTally ??= new Map();
  const key = `${source}|${targetDoid}`;
  const seen = session.targetTally.get(key);

  if (!seen || now - seen.at > CAST_WINDOW_MS) {
    if (session.targetTally.size >= MAX_TARGET_TALLIES) {
      for (const [old, record] of session.targetTally) {
        if (now - record.at > CAST_WINDOW_MS) session.targetTally.delete(old);
      }
      // Still full of live tallies: that is more bodies than a floor holds.
      if (session.targetTally.size >= MAX_TARGET_TALLIES) return false;
    }
    session.targetTally.set(key, { at: now, hits: 1 });
    return true;
  }

  if (seen.hits >= HITS_PER_TARGET) return false;
  seen.hits += 1;
  return true;
};

/**
 * Whether this hit belongs to an attack the hero was allowed to make, and is
 * still within what that permission covers.
 *
 * Consuming rather than asking: the window and the budget only mean something
 * if landing a hit spends them.
 */
export const castAccepted = async (
  session,
  attack,
  attackType,
  weaponSlot = 0,
  targetDoid = 0,
  now = Date.now()
) => {
  if (CASTLESS_ATTACKS.has(attack?.Constant)) return bombWasCast(session, attack, targetDoid, now);

  // Oldest first: a hit belongs to the earliest cast still able to answer for
  // it, which is the one that was made first — and which still has room both
  // overall and for this particular body.
  const record = (session.acceptedCasts ?? []).find(
    (candidate) =>
      candidate.attackId === Number(attackType) &&
      candidate.weaponSlot === Number(weaponSlot ?? 0) &&
      now - candidate.at <= CAST_WINDOW_MS &&
      candidate.hits < CAST_HIT_BUDGET
  );
  if (!record) return false;
  if (!spendOnTarget(session, `${attackType}|${weaponSlot ?? 0}`, targetDoid, now)) return false;

  record.hits += 1;
  return true;
};

/** Nothing authorises anything across a floor or a dungeon. */
export const clearAcceptedCasts = (session) => {
  session.acceptedCasts = [];
  session.targetTally?.clear();
};

export const reachExcess = async (session, proposal, attack) => {
  const victim = session.actors?.get(proposal.attackee);
  const from = session.heroPosition;
  const at = victim?.position;
  if (!from || !at) return null;

  /**
   * Judged against the last position this server accepted, whatever its age.
   * That position is not stale in the sense of wrong: the client sends one when
   * it changes, so an old one means the hero has not moved. Turning age into
   * either a wider bound or a refusal to answer both handed the decision to the
   * one party this rule exists to check.
   */
  const staleMs = Date.now() - (session.heroPositionAt ?? Date.now());
  const distance = Math.hypot(from.x - at.x, from.y - at.y);
  const allowed = await claimedReachOf(attack);
  return distance > allowed ? { distance, allowed, staleMs } : null;
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
     * The attacker is the hero — the guard above returned otherwise — so these
     * run for every result rather than for a branch of them.
     *
     * Reported, not refused. The bound has never been run against this server's
     * own players, and a check that has only been measured on somebody else's
     * recordings has no business dropping a hit yet — see REACH_SLACK. Turn it
     * on with DR_ENFORCE_REACH=1 once the log has been quiet for a while.
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
    if (
      !(await castAccepted(
        session,
        attack,
        proposal.attackType,
        proposal.weaponSlot,
        proposal.attackee
      ))
    ) {
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

    const damage = proposal.blocked
      ? 0
      : await computeDamage(session, proposal, attack, weaponPower);

    const echo = receiveCombatResult(
      proposal.attackee,
      fieldId,
      withDamage(proposal.bytes, -damage)
    );

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
        damage,
      });
    }

    const actor = session.actors?.get(proposal.attackee);
    const wasDead = Boolean(actor?.dead);
    const hitPointsBefore = actor?.hitPoints ?? 0;
    if (actor && applyDamage(session, proposal.attackee, damage, () => session.send(echo))) {
      if (actor.isEnemy) {
        session.dungeonContribution ??= { kills: 0, damage: 0 };
        session.dungeonContribution.damage += Math.min(damage, hitPointsBefore);
        if (!wasDead && actor.dead) session.dungeonContribution.kills += 1;
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

import { baseAttackOf } from "../content-packs.js";
import { PacketWriter, PacketReader } from "./packet.js";
import { CLID, OP } from "./opcodes.js";
import { RULE, noteViolation } from "./security-events.js";

/**
 * The combat wire: ProposeCombatResults as the client sends it and the server
 * echoes it. The field ids per class, how a result is encoded and read, the
 * embedded-result limits, the state and hit-point updates every member is
 * sent, and the hero's own state-and-choreography frame. Nothing here decides
 * a number: combat.js does, and hands it here to be published.
 */

/** Field ids for ProposeCombatResults, per class. */
export const FLID_PROPOSE_COMBAT_RESULTS = 171;

/** ReceiveCombatResult has a different id on each class. */
export const RECEIVE_FIELD_BY_CLID = {
  [CLID.HeroGameObject]: 160,
  [CLID.DistributedNPCGameObject]: 144,
};

export const encodeCombatResults = ({
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
      .i8(result.weaponSlot ?? weaponSlot)
      .u8(result.isConsumableWeapon ?? 0)
      .u32(result.attackType ?? attackType)
      .u32(result.targetActorDoid ?? targetActorDoid)
      .u8(result.when ?? 0)
      .u8(result.suffer ?? 0)
      .u8(result.knockback ?? 0)
      .u8(result.blocked ?? 0)
      .u8(result.criticalHit ?? 0)
      .i8(result.effectiveness ?? 0)
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
    .i8(weaponSlot)
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
export const MAX_EMBEDDED_RESULTS = 64;

/**
 * A hero carries four weapons and two powerups, so a slot byte has four or two
 * meanings and no others. See `weaponsForAvatar`, which always writes exactly
 * four entries and fills the empty ones itself.
 */
export const WEAPON_SLOTS = 4;
export const POWERUP_SLOTS = 2;

/**
 * Reads the proposal vector, or refuses it.
 *
 * Returns null rather than a short list, because a blob that is the wrong shape
 * is not a partly honest packet — the layout is fixed width and the length is
 * declared, so anything that does not divide is either a client this server
 * cannot read or one that is probing. Neither should be half-processed.
 */
/** Where a combat result names its attack: attacker, attackee, damage, slot, consumable. */
const RESULT_ATTACK_AT = 14;

/** `bytes` with the attack at `at` as the base a variant dresses; the same bytes when it is one. */
export const withBaseAttack = (bytes, at) => {
  if (bytes.length < at + 4) return bytes;
  const named = bytes.readUInt32LE(at);
  const base = baseAttackOf(named);
  if (base === named) return bytes;
  const copy = Buffer.from(bytes);
  copy.writeUInt32LE(base, at);
  return copy;
};

export const readProposals = (session, reader, limit = MAX_RESULTS_PER_PACKET) => {
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
    // A skin's variant attack is the base it dresses, here and in the echo
    // every client receives (content-packs.js).
    const bytes = withBaseAttack(blob.subarray(offset, offset + COMBAT_RESULT_BYTES), RESULT_ATTACK_AT);
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
    const weaponSlot = head.i8();
    const isConsumable = head.u8() !== 0;
    const attackType = head.u32();
    head.u32(); // attack.targetActorDoid
    const when = head.u8();
    head.u8(); // suffer
    const knockback = head.u8();
    const blocked = head.u8();
    head.u8(); // criticalHit
    const effectiveness = head.i8();
    head.u32(); // selfDamage
    const scalingMaxPowerMultiplier = head.f32();
    /**
     * Which collision of the same projectile this is, counted from zero and
     * reset per cast. A thunderstorm cloud drifts through a crowd landing up to
     * twenty of them, and each is worth half the one before.
     */
    const generation = head.u8();
    results.push({
      attacker, attackee, attackType, weaponSlot, isConsumable, when,
      knockback, blocked, effectiveness, scalingMaxPowerMultiplier, generation, bytes,
    });
  }

  return results;
};

export const receiveCombatResult = (doid, fieldId, bytes) =>
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
export const HITPOINTS_FIELD_BY_CLID = {
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
    .i8(weaponSlot)
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

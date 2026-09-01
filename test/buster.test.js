import assert from "node:assert/strict";
import test from "node:test";

import {
  FLID_RECEIVE_ATTACK_CHOREOGRAPHY,
  FLID_PROPOSE_ATTACK_CHOREOGRAPHY,
  handleProposeAttackChoreography,
  remoteAttackChoreography,
  remoteStopChoreography,
} from "../src/socket/buster.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

const attackProposal = (attackType, weaponSlot = 0, isConsumable = 0) =>
  new PacketWriter()
    .u8(weaponSlot)
    .u8(isConsumable)
    .u32(attackType)
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

test("remote stop choreography uses the hero's empty field 179", () => {
  const frame = remoteStopChoreography(500);
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), 500);
  assert.equal(reader.u16(), 179);
  assert.equal(reader.eof(), true);
});

test("Dungeon Buster consumes Crowd points and generates its self buff", async () => {
  const sent = [];
  const session = {
    id: 31,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 10,
    dungeonBusterPoints: 110,
    // A Dungeon Buster is the hero's, not a weapon's; naming it is what a real
    // dungeon entry does, and the slot rule now asks.
    dungeonBusterAttack: "DBUSTER_BERSERK",
    heroWeapons: [{ type: 11001 }],
    objects: new Map([
      [400, CLID.DistributedDungeonFloor],
      [500, CLID.HeroGameObject],
    ]),
    allocateDoid(clid) {
      this.objects.set(600, clid);
      return 600;
    },
    send: (frame) => sent.push(frame),
  };

  assert.equal(FLID_PROPOSE_ATTACK_CHOREOGRAPHY, 172);
  const handled = await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(900100))
  );

  assert.equal(handled, true);
  assert.equal(session.dungeonBusterPoints, 0);
  assert.equal(sent.length, 2);

  const points = new PacketReader(sent[0].subarray(2));
  assert.equal(points.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(points.u32(), session.heroDoid);
  assert.equal(points.u16(), 166);
  assert.equal(points.u32(), 0);
  assert.equal(points.eof(), true);

  const buff = new PacketReader(sent[1].subarray(2));
  assert.equal(buff.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(buff.u32(), session.floorDoid);
  assert.equal(buff.u32(), session.dungeonZone);
  assert.equal(buff.u16(), CLID.DistributedBuffGameObject);
  assert.equal(buff.u32(), 600);
  assert.equal(buff.u32(), 35006); // BERSERK_DB
  assert.equal(buff.u32(), session.heroDoid);
  assert.equal(buff.u32(), session.heroDoid);
  assert.equal(buff.eof(), true);
});

test("Dungeon Buster is rejected without enough Crowd points", async () => {
  const sent = [];
  const session = {
    id: 32,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 10,
    dungeonBusterPoints: 109,
    dungeonBusterAttack: "DBUSTER_BERSERK",
    heroWeapons: [{ type: 11001 }],
    objects: new Map(),
    send: (frame) => sent.push(frame),
  };

  const handled = await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(900100))
  );

  assert.equal(handled, true);
  assert.equal(session.dungeonBusterPoints, 109);
  assert.deepEqual(sent, []);
});

test("a charged skill consumes its authored Mana cost", async () => {
  const sent = [];
  const session = {
    id: 33,
    heroDoid: 500,
    heroManaPoints: 50,
    heroWeapons: [{ type: 11001, modifier1: 0, modifier2: 0 }],
    send: (frame) => sent.push(frame),
  };

  const handled = await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(900106)) // SLICE&DICE: 20 Mana
  );

  assert.equal(handled, true);
  assert.equal(session.heroManaPoints, 30);
  assert.equal(sent.length, 1);
  const mana = new PacketReader(sent[0].subarray(2));
  assert.equal(mana.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(mana.u32(), session.heroDoid);
  assert.equal(mana.u16(), 163);
  assert.equal(mana.u16(), 30);
  assert.equal(mana.eof(), true);
});

test("weapon MP_COST modifiers reduce charged-skill Mana consumption", async () => {
  const sent = [];
  const session = {
    id: 34,
    heroDoid: 500,
    heroManaPoints: 20,
    heroWeapons: [
      {},
      { type: 10003, modifier1: 70165, modifier2: 0 }, // Brilliant: MP_COST 0.4
    ],
    send: (frame) => sent.push(frame),
  };

  await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(900056, 1)) // IMPALE: 10 * 0.4
  );

  assert.equal(session.heroManaPoints, 16);
  assert.equal(sent.length, 1);
});

test("a charged skill is rejected when authoritative Mana is insufficient", async () => {
  const sent = [];
  const session = {
    id: 35,
    heroDoid: 500,
    heroManaPoints: 19,
    heroWeapons: [{ type: 11001, modifier1: 0, modifier2: 0 }],
    send: (frame) => sent.push(frame),
  };

  await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(900106))
  );

  assert.equal(session.heroManaPoints, 19);
  assert.deepEqual(sent, []);
});

test("Quake Axe releases are not throttled by the NPC-only recharge value", async () => {
  const session = {
    id: 351,
    heroDoid: 500,
    heroManaPoints: 100,
    heroWeapons: [{ type: 11003, modifier1: 0, modifier2: 0 }],
    send: () => {},
  };
  let accepted = 0;
  const release = () =>
    handleProposeAttackChoreography(
      session,
      new PacketReader(attackProposal(900108)), // FISSURE: 30 Mana, AI_RechargeT 25
      { onAccepted: () => (accepted += 1) }
    );

  await release();
  await release();

  assert.equal(accepted, 2, "both client-authorised release choreographies are relayed");
  assert.equal(session.heroManaPoints, 40, "each accepted release still pays its Mana cost");
});

test("only an accepted attack exposes its choreography for remote field 159", async () => {
  const accepted = [];
  const payload = attackProposal(900106);
  const session = {
    id: 36,
    heroDoid: 500,
    heroManaPoints: 50,
    heroWeapons: [{ type: 11001, modifier1: 0, modifier2: 0 }],
    send: () => {},
  };

  await handleProposeAttackChoreography(session, new PacketReader(payload), {
    onAccepted: () => accepted.push(true),
  });
  assert.deepEqual(accepted, [true]);

  const relay = new PacketReader(remoteAttackChoreography(500, payload).subarray(2));
  assert.equal(relay.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(relay.u32(), 500);
  assert.equal(relay.u16(), FLID_RECEIVE_ATTACK_CHOREOGRAPHY);
  assert.deepEqual(relay.rest(), payload);

  session.heroManaPoints = 0;
  await handleProposeAttackChoreography(session, new PacketReader(payload), {
    onAccepted: () => accepted.push(false),
  });
  assert.deepEqual(accepted, [true]);
});

test("the speed scroll spends its Mana on an actual boost", async () => {
  const { grantBuff, clearDungeonBuffs } = await import("../src/socket/buffs.js");
  void grantBuff;
  const sent = [];
  let next = 900;
  const session = {
    id: 32,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 0,
    heroManaPoints: 200,
    maxHeroManaPoints: 200,
    dungeonBusterPoints: 0,
    heroWeapons: [{ type: 24001 }], // HERO_SCROLL_SPEED
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map(),
    allocateDoid: () => ++next,
    send: (frame) => sent.push(frame),
  };

  // SPEED_BUFF_PULSE_COOLDOWN: FRIENDLY, 35 Mana, TargetBuff1 SPEED_BOOSTER_L3
  // and no SelfBuff at all, so the caster is its own target.
  await handleProposeAttackChoreography(session, new PacketReader(attackProposal(900080)));

  assert.equal(session.heroManaPoints, 165, "the authored 35 Mana is spent");
  const boosts = [...(session.activeBuffs?.values() ?? [])].filter(
    (active) => active.buff?.Constant === "SPEED_BOOSTER_L3"
  );
  assert.equal(boosts.length, 1, "and something is actually granted for it");
  assert.equal(boosts[0].affectedActor, 500, "on the hero that cast it");
  clearDungeonBuffs(session);
});

test("the snare scroll pays Mana back for every hit it lands", async () => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { PacketWriter } = await import("../src/socket/packet.js");

  const session = {
    id: 33,
    heroDoid: 500,
    floorDoid: 400,
    heroManaPoints: 100,
    maxHeroManaPoints: 200,
    heroStats: undefined,
    weaponPower: 100,
    objects: new Map([
      [500, CLID.HeroGameObject],
      [700, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [700, { hitPoints: 9000, maxHitPoints: 9000, constant: "KNIGHT_TUTORIAL", isEnemy: true }],
    ]),
    send: () => {},
  };

  // MAGIC_BLAST_L2 is the only attack in the game carrying ManaPerHit, at five.
  const result = new PacketWriter()
    .u32(500).u32(700).i32(0).u8(0).u8(0).u32(900081).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  const packet = new PacketWriter().u16(result.length).raw(result).body();

  await handleProposeCombatResults(session, new PacketReader(packet));
  assert.equal(session.heroManaPoints, 105, "five Mana back for landing it");
});

test("a scroll on cooldown is refused, and its Mana is not taken", async () => {
  const session = {
    id: 34,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 0,
    heroManaPoints: 200,
    maxHeroManaPoints: 200,
    dungeonBusterPoints: 0,
    heroWeapons: [{ type: 24001 }],
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map(),
    allocateDoid: () => 900,
    send: () => {},
  };

  /**
   * SPEED_BUFF_PULSE_COOLDOWN authors twenty seconds. The client greys the
   * button out, which is why nothing looked wrong — but the server was taking
   * every proposal it was sent, so a modified client could spend the scroll as
   * fast as it could ask.
   */
  await handleProposeAttackChoreography(session, new PacketReader(attackProposal(900080)));
  assert.equal(session.heroManaPoints, 165, "the first cast is paid for");

  await handleProposeAttackChoreography(session, new PacketReader(attackProposal(900080)));
  assert.equal(session.heroManaPoints, 165, "the second is refused before it costs anything");

  const { clearDungeonBuffs } = await import("../src/socket/buffs.js");
  clearDungeonBuffs(session);
});

test("a hero's own attack leaves the debuff it authors", async () => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { PacketWriter } = await import("../src/socket/packet.js");
  const { clearDungeonBuffs } = await import("../src/socket/buffs.js");

  let next = 900;
  const session = {
    id: 35,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 0,
    weaponPower: 100,
    objects: new Map([
      [500, CLID.HeroGameObject],
      [700, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [700, { hitPoints: 90000, maxHitPoints: 90000, constant: "KNIGHT_TUTORIAL", isEnemy: true }],
    ]),
    allocateDoid: () => ++next,
    send: () => {},
  };

  /**
   * THUNDERSTORM authors SHOCK_L1, and the captured storm granted it to every
   * victim it caught. TargetBuff1 was only read on the placeable path, so
   * nothing a hero swung ever left anything behind.
   */
  const result = new PacketWriter()
    .u32(500).u32(700).i32(0).u8(0).u8(0).u32(901104).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  const packet = new PacketWriter().u16(result.length).raw(result).body();

  await handleProposeCombatResults(session, new PacketReader(packet));

  const shocks = [...(session.activeBuffs?.values() ?? [])].filter(
    (active) => active.affectedActor === 700 && active.buff?.Constant === "SHOCK_L1"
  );
  assert.equal(shocks.length, 1, "the knight it struck is shocked");
  clearDungeonBuffs(session);
});

test("a hit claimed from across the floor is reported, and dropped when told to", async () => {
  /**
   * The client says *that* a hit happened; the server only prices it. Nothing
   * checked the claim, so a modified client could report hitting every monster
   * on the floor from where it stands.
   *
   * The bound is the official's own play rather than a guess. Over 5445 of its
   * hit claims, distance to the victim minus the attack's authored reach:
   *
   *   median -227   p90 -37   p99 +35   p999 +190   worst +253
   *
   * Only 221 of 5445 pass the authored reach at all, and those are the attacks
   * that carry the hero along with them or throw something. 400 units of slack
   * clears the worst of them by half again.
   */
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { PacketWriter } = await import("../src/socket/packet.js");
  const { config } = await import("../src/config.js");

  const claim = (victimAt) => {
    const session = {
      id: 35,
      heroDoid: 500,
      floorDoid: 400,
      heroPosition: { x: 0, y: 0 },
      heroManaPoints: 100,
      maxHeroManaPoints: 200,
      weaponPower: 100,
      objects: new Map([
        [500, CLID.HeroGameObject],
        [700, CLID.DistributedNPCGameObject],
      ]),
      actors: new Map([
        [700, { hitPoints: 9000, maxHitPoints: 9000, constant: "KNIGHT_TUTORIAL", position: victimAt }],
      ]),
      allocateDoid: () => 9999,
      send: () => {},
    };
    // AXE_COMBO_1, a melee swing: nothing about it reaches across a room.
    const result = new PacketWriter()
      .u32(500).u32(700).i32(0).u8(0).u8(0).u32(900001).u32(0)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
      .body();
    return {
      session,
      packet: new PacketWriter().u16(result.length).raw(result).body(),
    };
  };

  // Reported but still applied, because the bound has never been watched on a
  // real server and a check measured only on somebody else's recordings has no
  // business dropping a hit yet.
  const near = claim({ x: 60, y: 0 });
  await handleProposeCombatResults(near.session, new PacketReader(near.packet));
  assert.ok(near.session.actors.get(700).hitPoints < 9000, "a swing in reach lands");

  const far = claim({ x: 4000, y: 0 });
  await handleProposeCombatResults(far.session, new PacketReader(far.packet));
  assert.ok(
    far.session.actors.get(700).hitPoints < 9000,
    "and one from across the floor is only reported while enforcement is off"
  );

  config.reachMode = "enforce";
  try {
    const refused = claim({ x: 4000, y: 0 });
    await handleProposeCombatResults(refused.session, new PacketReader(refused.packet));
    assert.equal(
      refused.session.actors.get(700).hitPoints,
      9000,
      "with it on, the claim is dropped"
    );
    const allowed = claim({ x: 60, y: 0 });
    await handleProposeCombatResults(allowed.session, new PacketReader(allowed.packet));
    assert.ok(allowed.session.actors.get(700).hitPoints < 9000, "and an honest one still lands");
  } finally {
    config.reachMode = "off";
  }
});

test("the hero's own Dungeon Buster fires, and spends the bar it needed", async () => {
  /**
   * "I press the buster and the points are not taken."
   *
   *   rejected DBUSTER_MEATEOR_SHOWER: wrong equipped weapon
   *
   * A Dungeon Buster comes from the hero's `DBuster1` and none of the six is
   * `Attack1` on any `WeaponItem`, so asking the equipped weapon for permission
   * refused it. It bit exactly one of them, which is why nobody noticed:
   * `isPowerupAttack` asks whether the timeline spawns anything, and only the
   * Battle Chef's meteor shower does. Berserk, Arrowstorm, Ball Lightning,
   * Garlic Nuke and Iron Legion all passed straight through.
   *
   * The official fires it as an ordinary proposal like any other — field 172,
   * slot 0 — and its bar goes 120 to 0 on the frame after.
   */
  const { handleProposeAttackChoreography } = await import("../src/socket/buster.js");
  const { PacketWriter, PacketReader } = await import("../src/socket/packet.js");

  const sessionWith = (busterAttack) => ({
    id: 36,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    heroWeapons: [{ type: 1 }],
    dungeonBusterAttack: busterAttack,
    dungeonBusterPoints: 120,
    maxDungeonBusterPoints: 120,
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map(),
    allocateDoid: () => 9999,
    send: () => {},
  });

  // DBUSTER_MEATEOR_SHOWER, 120 Crowd points, no Mana.
  const proposal = () =>
    new PacketReader(
      new PacketWriter().u8(0).u8(0).u32(901500).u32(0).u8(0).f32(1).f32(1).u16(0).body()
    );

  const mine = sessionWith("DBUSTER_MEATEOR_SHOWER");
  await handleProposeAttackChoreography(mine, proposal());
  assert.equal(mine.dungeonBusterPoints, 0, "a full bar pays for it exactly");

  // And it is still the hero's own buster that is allowed, not any buster.
  const borrowed = sessionWith("DBUSTER_BERSERK");
  await handleProposeAttackChoreography(borrowed, proposal());
  assert.equal(
    borrowed.dungeonBusterPoints,
    120,
    "somebody else's buster is still refused, and costs nothing"
  );
});

test("a bow reaches as far as its arrow, and the check cannot break a hit", async () => {
  /**
   * The first version of the reach check shipped with `projectileForConstant`
   * missing from its imports. Nothing caught it: the syntax was fine, and the
   * only test covering the check used a melee swing, so the line that needed
   * the import was never run. In play it threw on the first attack carrying a
   * projectile, took the whole result batch down with it, and an archer's
   * arrows landed on nothing — with enforcement switched off.
   *
   * So this exercises the projectile branch, and asserts the property that
   * would have made the bug harmless anyway: a check that only reports must
   * never be able to drop a hit.
   */
  const { reachExcess } = await import("../src/socket/combat.js");
  const { attackForConstant } = await import("../src/gamemaster.js");

  const session = {
    heroDoid: 1,
    heroPosition: { x: 0, y: 0 },
    heroPositionAt: Date.now(),
    actors: new Map([[2, { position: { x: 700, y: 0 } }]]),
  };
  const claim = { attacker: 1, attackee: 2 };

  // LONG_BOW_SHOT: Range 600 on the attack, 800 on PROJ_ARROW.
  const bow = await attackForConstant("LONG_BOW_SHOT");
  assert.equal(await reachExcess(session, claim, bow), null, "an arrow carries that far");

  // AXE_COMBO_2 swings 80 units, and 700 is not 80.
  const axe = await attackForConstant("AXE_COMBO_2");
  const swing = await reachExcess(session, claim, axe);
  assert.ok(swing, "a sword claimed across the room is not");
  assert.ok(swing.allowed < 700, `allowed ${Math.round(swing.allowed)} should fall short of 700`);

  // An attack this server cannot resolve is not a reason to drop anybody's hit.
  assert.doesNotReject(() => reachExcess(session, claim, undefined));
});

test("a hit only lands for an attack this server let the hero make", async () => {
  /**
   * A refusal in the choreography path used to be cosmetic. It cost nothing and
   * spawned nothing and the damage arrived anyway, because hit results come in
   * on their own field and nothing tied the two together — so a client could
   * skip the cast entirely and land the attack for free: no Mana, no Crowd, no
   * cooldown.
   *
   * The Battle Chef showed it by accident. Its buster was refused by a guard
   * that should never have caught it, the meteors never spawned, the bar never
   * emptied, and every press still did its damage.
   *
   * The official always casts first. Of 5447 hero hit claims, 4998 follow a
   * choreography of the same attack and the 449 that do not are entirely
   * `HEALTH_BOMB_ATTACK` (308) and `PARTY_BOMB_ATTACK` (141), which go out
   * through the revive path instead.
   */
  const { handleProposeAttackChoreography } = await import("../src/socket/buster.js");
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { PacketWriter, PacketReader } = await import("../src/socket/packet.js");
  const { config } = await import("../src/config.js");

  const world = () => ({
    id: 37,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroPositionAt: Date.now(),
    heroManaPoints: 0,
    maxHeroManaPoints: 100,
    heroWeapons: [{ type: 1 }],
    dungeonBusterAttack: "DBUSTER_BERSERK",
    dungeonBusterPoints: 0,
    maxDungeonBusterPoints: 120,
    objects: new Map([[500, CLID.HeroGameObject], [700, CLID.DistributedNPCGameObject]]),
    actors: new Map([
      [700, { hitPoints: 9000, maxHitPoints: 9000, constant: "KNIGHT_TUTORIAL", position: { x: 40, y: 0 } }],
    ]),
    allocateDoid: () => 9999,
    send: () => {},
  });

  // The meteor shower, with no Crowd points and no Mana to pay for it.
  const cast = () =>
    new PacketReader(
      new PacketWriter().u8(0).u8(0).u32(901500).u32(0).u8(0).f32(1).f32(1).u16(0).body()
    );
  const claim = () => {
    const result = new PacketWriter()
      .u32(500).u32(700).i32(0).u8(0).u8(0).u32(901500).u32(0)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
      .body();
    return new PacketReader(new PacketWriter().u16(result.length).raw(result).body());
  };

  config.castMode = "enforce";
  config.placementMode = "enforce";
  try {
    const refused = world();
    await handleProposeAttackChoreography(refused, cast());
    assert.equal(refused.dungeonBusterPoints, 0, "the cast paid nothing, having nothing");
    await handleProposeCombatResults(refused, claim());
    assert.equal(
      refused.actors.get(700).hitPoints,
      9000,
      "and its hit lands nowhere, which is the whole point"
    );

    // The same claim, once the cast was actually allowed.
    const allowed = world();
    allowed.dungeonBusterAttack = "DBUSTER_MEATEOR_SHOWER";
    allowed.dungeonBusterPoints = 120;
    await handleProposeAttackChoreography(allowed, cast());
    assert.equal(allowed.dungeonBusterPoints, 0, "a real cast is paid for");
    await handleProposeCombatResults(allowed, claim());
    assert.ok(allowed.actors.get(700).hitPoints < 9000, "and its hit lands");
  } finally {
    config.castMode = "off";
    config.placementMode = "off";
  }
});

/**
 * Every combat result names its own attacker, and the field update's doid does
 * not reach it. The cast and reach rules used to sit inside
 * `if (proposal.attacker === session.heroDoid)` while the damage below ran
 * regardless, so writing any other doid into the inner field skipped both and
 * still landed the hit.
 *
 * Deterministic rather than a judgement: 14479 owner results across the
 * recordings name the hero and not one names anything else, and every packet
 * carried exactly one result. So this is refused whatever the flags say.
 */
test("a combat result naming somebody else as the attacker is dropped", async () => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");

  const world = () => ({
    id: 99,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroPositionAt: Date.now(),
    heroWeapons: [{ power: 1 }],
    objects: new Map([
      [500, CLID.HeroGameObject],
      [600, CLID.DistributedNPCGameObject],
      [700, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [600, { hitPoints: 500, maxHitPoints: 500, constant: "KNIGHT_TUTORIAL", position: { x: 0, y: 0 }, isEnemy: true }],
      [700, { hitPoints: 9000, maxHitPoints: 9000, constant: "KNIGHT_TUTORIAL", position: { x: 40, y: 0 }, isEnemy: true }],
    ]),
    allocateDoid: () => 9999,
    send: () => {},
  });

  const claim = (attacker) => {
    const result = new PacketWriter()
      .u32(attacker).u32(700).i32(0).u8(0).u8(0).u32(901500).u32(0)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
      .body();
    return new PacketReader(new PacketWriter().u16(result.length).raw(result).body());
  };

  const forged = world();
  await handleProposeCombatResults(forged, claim(600));
  assert.equal(
    forged.actors.get(700).hitPoints,
    9000,
    "a result attributed to an NPC lands nowhere"
  );

  // The hero's own claim is untouched by the guard: enforcement is off, so it
  // still lands, which is what makes the refusal above about the attacker.
  const honest = world();
  await handleProposeCombatResults(honest, claim(500));
  assert.ok(
    honest.actors.get(700).hitPoints < 9000,
    "and the hero's own result still does"
  );
});

/**
 * One accepted cast used to authorise its attack for the rest of the socket's
 * life: `noteCast` stored a timestamp, `castAccepted` only asked whether the
 * key existed, and nothing ever read the time or counted the hits.
 *
 * The bounds are drawn above honest play rather than around it. Over 14297
 * hits matched back to the cast before them the gap is 108ms at the median, but
 * the tail is real and legitimate — `LAZY_BOOMERANG` was still landing 22.0
 * seconds later, 66 times from one throw, and `DBUSTER_MEATEOR_SHOWER` lands
 * 124. So a window near the median would delete earned damage; a finite one
 * well above the maximum only removes "for ever".
 */
test("an accepted cast expires and is spent", async () => {
  const { noteCast, castAccepted, clearAcceptedCasts } = await import("../src/socket/combat.js");
  const { attackForConstant } = await import("../src/gamemaster.js");

  const attack = await attackForConstant("AXE_COMBO_1");
  const id = Number(attack.Id);
  const at = 1_000_000;

  const session = { id: 7 };
  noteCast(session, attack, 0, at);
  assert.equal(await castAccepted(session, attack, id, 0, 700, at), true, "the hit it was cast for lands");

  // Twenty-two seconds is inside the window, because a boomerang does that.
  assert.equal(await castAccepted(session, attack, id, 0, 700, at + 22_000), true, "and a long tail still lands");

  // A day later is not a tail, it is the bug.
  assert.equal(await castAccepted(session, attack, id, 0, 700, at + 86_400_000), false, "a day later does not");
  // And asking late does not destroy what is still live: a stale query used to
  // delete the record it failed to match, so one out-of-order check disarmed a
  // cast that had every right to keep answering.
  assert.equal(await castAccepted(session, attack, id, 0, 700, at + 100), true, "the live cast survives it");

  // The slot is part of the match: the axe's swing is not the staff's cast.
  assert.equal(
    await castAccepted(session, attack, id, 1, 700, at),
    false,
    "another slot does not answer for it"
  );

  // The budget is spent by landing, or it means nothing.
  const spender = { id: 7 };
  noteCast(spender, attack, 0, at);
  let landed = 0;
  // Spread over bodies, because one body has a ceiling of its own below.
  while (await castAccepted(spender, attack, id, 0, 700 + landed, at)) landed += 1;
  assert.ok(landed > 124, `the budget clears the widest cast ever seen, got ${landed}`);
  assert.ok(landed < 256, "and is no longer the blanket 256 an axe swing used to get");

  /**
   * And one body absorbs a bounded share of one attack and slot, counted across
   * the window rather than per cast. Per-record ceilings multiply: honest play
   * has 137 casts of a single attack and slot live inside thirty seconds, so a
   * fresh allowance with each was thousands against the same boss.
   *
   * Honest play's worst is 30 hits on one body from one attack and slot in that
   * window — a Battle Chef's cleaver combo against one monster.
   */
  const focused = { id: 7 };
  let onOne = 0;
  for (let swing = 0; swing < 40; swing++) {
    noteCast(focused, attack, 0, at);
    while (await castAccepted(focused, attack, id, 0, 700, at)) onOne += 1;
  }
  assert.ok(onOne > 30, `it clears the worst honest focus, got ${onOne}`);
  assert.ok(onOne < 200, "but forty swings do not buy forty allowances");

  /**
   * A second swing is a second cast, not a refilled one. Keyed by attack id, a
   * new choreography overwrote the record and handed back a full budget — so
   * the budget bounded nothing a client could not renew by asking again.
   */
  noteCast(spender, attack, 0, at);
  assert.equal(spender.acceptedCasts.length, 2, "both casts are remembered");
  assert.equal(spender.acceptedCasts[0].hits, landed, "and the spent one stays spent");

  // Nothing authorises anything across a floor.
  const crossing = { id: 7 };
  noteCast(crossing, attack, 0, at);
  clearAcceptedCasts(crossing);
  assert.equal(await castAccepted(crossing, attack, id, 0, 700, at), false, "a new floor starts owing nothing");
});

/**
 * The proposal blob is fixed width with a declared length, and both were taken
 * on trust. A `u16` can encode about 1771 results, each costing an attack
 * lookup, a damage computation, a buff pass, a frame out and a log line — from
 * one packet whose size the sender chooses.
 *
 * The recordings say what one actually carries: 14479 owner results in 14479
 * packets, every one holding exactly one, and no blob whose length was not a
 * multiple of the record. So the bound is generous and the shape is exact.
 */
test("a malformed or oversized proposal packet is refused whole", async () => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const RESULT_BYTES = 37;

  const world = () => ({
    id: 96,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroPositionAt: Date.now(),
    heroWeapons: [{ power: 1 }],
    objects: new Map([[500, CLID.HeroGameObject], [700, CLID.DistributedNPCGameObject]]),
    actors: new Map([
      [700, { hitPoints: 9000, maxHitPoints: 9000, constant: "KNIGHT_TUTORIAL", position: { x: 40, y: 0 }, isEnemy: true }],
    ]),
    allocateDoid: () => 9999,
    send: () => {},
  });

  const oneResult = () =>
    new PacketWriter()
      .u32(500).u32(700).i32(0).u8(0).u8(0).u32(901500).u32(0)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
      .body();

  // A length that is not a whole number of records.
  const ragged = new PacketWriter().u16(RESULT_BYTES + 5).raw(oneResult()).raw(Buffer.alloc(5)).body();
  const raggedWorld = world();
  await handleProposeCombatResults(raggedWorld, new PacketReader(ragged));
  assert.equal(raggedWorld.actors.get(700).hitPoints, 9000, "a ragged blob lands nothing");

  // A length longer than the packet actually holds.
  const overlong = new PacketWriter().u16(RESULT_BYTES * 4).raw(oneResult()).body();
  const overlongWorld = world();
  await handleProposeCombatResults(overlongWorld, new PacketReader(overlong));
  assert.equal(overlongWorld.actors.get(700).hitPoints, 9000, "nor does one that overruns");

  // More results than any honest packet has ever carried.
  const many = new PacketWriter().u16(RESULT_BYTES * 9);
  for (let i = 0; i < 9; i++) many.raw(oneResult());
  const manyWorld = world();
  await handleProposeCombatResults(manyWorld, new PacketReader(many.body()));
  assert.equal(manyWorld.actors.get(700).hitPoints, 9000, "nor nine at once");

  // And the shape the official actually sends still works.
  const honest = new PacketWriter().u16(RESULT_BYTES).raw(oneResult()).body();
  const honestWorld = world();
  await handleProposeCombatResults(honestWorld, new PacketReader(honest));
  assert.ok(honestWorld.actors.get(700).hitPoints < 9000, "one result lands");
});

/**
 * The two bombs send no choreography, which is why their attacks are exempt
 * from the cast rule — but the exemption was unconditional, so their damage was
 * accepted in an empty session with nothing spent. `DamageMod` -1.5 and -2, and
 * the sign is damage.
 *
 * They are not uncaused. Every one of the 18 detonations in the recordings
 * follows a `ProposeSelfRevive` that this server accepts and charges an account
 * bomb for, and the gap is tight: 2331ms at the shortest, 2394 at the median,
 * 3411 at the longest. So the revive is the cast.
 */
test("a bomb lands only for a revive that happened", async () => {
  const { castAccepted, noteBombCast, clearBombCasts } = await import("../src/socket/combat.js");
  const { attackForConstant } = await import("../src/gamemaster.js");

  const health = await attackForConstant("HEALTH_BOMB_ATTACK");
  const party = await attackForConstant("PARTY_BOMB_ATTACK");
  const at = 3_000_000;

  const never = { id: 8 };
  assert.equal(
    await castAccepted(never, health, Number(health.Id), 0, 700, at),
    false,
    "a bomb with no revive behind it lands nothing"
  );

  const revived = { id: 8 };
  noteBombCast(revived, false, at);
  assert.equal(await castAccepted(revived, health, Number(health.Id), 0, 700, at + 2394), true,
    "the detonation that follows a revive does land");
  assert.equal(await castAccepted(revived, health, Number(health.Id), 0, 700, at + 3411), true,
    "including the longest gap seen");

  // The whole burst rides on the one revive; the window does not run out mid-blast.
  assert.equal(await castAccepted(revived, health, Number(health.Id), 0, 700, at + 3412), true,
    "and the rest of the burst with it");

  // A health bomb revive does not authorise a party bomb.
  assert.equal(await castAccepted(revived, party, Number(party.Id), 0, 700, at + 2394), false,
    "and it is the bomb that was used, not either of them");

  // Long after, it is over.
  assert.equal(await castAccepted(revived, health, Number(health.Id), 0, 700, at + 60_000), false,
    "a minute later is not a detonation");

  /**
   * And one blast reaches a bounded number of bodies. The window said when, not
   * how much, so one paid bomb answered for every result inside ten seconds —
   * enough to clear a floor from a single item. The health bomb lands a median
   * of 9 hits in the recordings and at most 27.
   */
  const blast = { id: 8 };
  noteBombCast(blast, false, at);
  let reached = 0;
  while (await castAccepted(blast, health, Number(health.Id), 0, 700 + reached, at + 100)) reached += 1;
  assert.ok(reached > 27, `the budget clears the widest blast seen, got ${reached}`);
  assert.ok(reached < 128, "and is still a budget");

  // And a blast reaches one body once or twice, never sixty-four times.
  const focusedBlast = { id: 8 };
  noteBombCast(focusedBlast, false, at);
  let onOneBody = 0;
  while (await castAccepted(focusedBlast, health, Number(health.Id), 0, 700, at)) onOneBody += 1;
  assert.ok(onOneBody > 2, `it clears the worst honest blast on one body, got ${onOneBody}`);
  assert.ok(onOneBody < 16, "but one item cannot erase a boss");

  // And nothing carries across a floor.
  const crossing = { id: 8 };
  noteBombCast(crossing, true, at);
  clearBombCasts(crossing);
  assert.equal(await castAccepted(crossing, party, Number(party.Id), 0, 700, at), false,
    "a new floor starts owing nothing");
});

/**
 * Ownership was only ever asked about attacks whose timeline spawns something —
 * `hasPowerupWeapon` opens by returning true for everything else. So a client
 * holding an axe could propose a boss's attack and this server would accept the
 * cast and pay out its damage. 270 of the game's 573 attack rows belong to no
 * player weapon at all.
 *
 * The authored columns are the answer, and they cover honest play exactly:
 * across the recordings all 6951 proposed casts are named by one, and the only
 * four attacks that are not are the `CONSUMABLE_*` potions — which are exactly
 * the four carrying the consumable flag, so they leave through `useConsumable`
 * before this is asked.
 */
test("an attack no weapon grants is not proposable", async () => {
  const { attackForConstant } = await import("../src/gamemaster.js");

  const monster = await attackForConstant("EN_BREATHE_LIGHTNING");
  const mine = await attackForConstant("THUNDERSTORM");

  const world = () => ({
    id: 95,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroHeading: 0,
    heroManaPoints: 500,
    maxHeroManaPoints: 500,
    heroWeapons: [{ type: 19503, power: 1 }, { type: 19503, power: 1 }, { type: 19503, power: 1 }],
    dungeonBusterPoints: 0,
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => 9999,
    send: () => {},
  });

  const forged = world();
  await handleProposeAttackChoreography(forged, new PacketReader(attackProposal(Number(monster.Id))));
  assert.equal(forged.acceptedCasts, undefined, "a monster's attack records no cast");

  // One a weapon really does grant still goes through.
  const honest = world();
  await handleProposeAttackChoreography(honest, new PacketReader(attackProposal(Number(mine.Id))));
  assert.ok(
    honest.acceptedCasts?.some((c) => c.attackId === Number(mine.Id)),
    "and a weapon's own attack does"
  );
});

test("Berserk mode legitimately replaces a melee weapon's attacks with RAMPAGE", async () => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  const rampage = gm.raw.Attack.find((attack) => attack.Constant === "RAMPAGE");
  const berserk = gm.raw.Buff.find((buff) => buff.Constant === "BERSERK_DB");
  assert.equal(berserk.Ability2, "BERSERK_MODE", "the second ability is the client override");

  const world = () => ({
    id: 89,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroHeading: 0,
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    heroWeapons: [{ type: 11001, power: 1 }], // HERO_HAND_AXE, ClassType MELEE
    dungeonBusterPoints: 0,
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map(),
    send: () => {},
  });

  const inactive = world();
  await handleProposeAttackChoreography(
    inactive,
    new PacketReader(attackProposal(Number(rampage.Id), 0))
  );
  assert.equal(inactive.acceptedCasts, undefined, "without the buff it is not the axe's attack");

  const active = world();
  active.activeBuffs = new Map([
    [1, { affectedActor: active.heroDoid, buff: berserk }],
  ]);
  await handleProposeAttackChoreography(
    active,
    new PacketReader(attackProposal(Number(rampage.Id), 0))
  );
  assert.ok(
    active.acceptedCasts?.some((cast) => cast.attackId === Number(rampage.Id)),
    "the server-known BERSERK_MODE grants the same override as WeaponController"
  );
  assert.equal(active.violations, undefined, "an ordinary Berserk swing is not security evidence");
});

/**
 * There was a staleness term in the reach bound: the allowance grew with the
 * age of the hero's position, up to a cap, past which this server declined to
 * judge at all. Both halves were wrong and in opposite directions — the client
 * chooses whether to send field 147, so the growing allowance was bought on
 * demand, and declining past the cap turned withholding into a way to switch
 * the rule off.
 *
 * Age is not error. The client sends a position when it changes, so a hero
 * standing still legitimately has an old one — the oldest behind an honest
 * claim in the recordings is 64.9 seconds — and it is still where he is.
 * Measured against those same positions across 14479 claims, the distance
 * beyond authored reach is -39 at the median, 69 at the p99 and 253 at the
 * worst, against a fixed slack of 400.
 */
test("an old position is still the hero's position", async () => {
  const { reachExcess } = await import("../src/socket/combat.js");
  const { attackForConstant } = await import("../src/gamemaster.js");

  const melee = await attackForConstant("AXE_COMBO_1");
  const world = (ageMs, victimX) => ({
    id: 94,
    heroPosition: { x: 0, y: 0 },
    heroPositionAt: Date.now() - ageMs,
    actors: new Map([[700, { position: { x: victimX, y: 0 } }]]),
  });
  const claim = { attackee: 700 };

  // A minute of standing still is ordinary, and does not stop the rule working.
  const stationary = await reachExcess(world(65_000, 100_000), claim, melee);
  assert.ok(stationary, "a still hero is still judgeable");
  assert.ok(stationary.distance > stationary.allowed, "and a remote claim is caught");

  // Withholding buys nothing: the same claim is caught at every age.
  for (const age of [0, 2100, 30_000]) {
    assert.ok(await reachExcess(world(age, 100_000), claim, melee), `caught at ${age}ms old`);
  }

  // And the bound does not grow with age, so an honest close hit passes at any.
  for (const age of [0, 65_000]) {
    assert.equal(await reachExcess(world(age, 40), claim, melee), null, `a real hit at ${age}ms old`);
  }
});

/**
 * The coarse rule only asks whether a player could ever swing this, so an axe
 * in slot 0 and a staff in slot 1 still let the staff's spell be proposed from
 * the axe. The slot is what pays for it — the Mana modifier, the cooldown key
 * and the placement permit are all read from the weapon there.
 *
 * The recordings are exact: of 6951 weapon casts, 6783 are granted by the
 * weapon in the slot they claim, 168 are Dungeon Busters, which come from the
 * hero and belong to no slot, and none arrive from an empty slot or from a
 * weapon that does not grant them.
 */
test("an attack comes out of the slot that grants it", async () => {
  const { attackForConstant } = await import("../src/gamemaster.js");
  const storm = await attackForConstant("THUNDERSTORM");

  // Slot 0 holds a hand axe; slot 1 holds the book the spell belongs to.
  const world = () => ({
    id: 92,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroHeading: 0,
    heroManaPoints: 500,
    maxHeroManaPoints: 500,
    heroWeapons: [{ type: 11001, power: 1 }, { type: 19503, power: 1 }],
    dungeonBusterPoints: 0,
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => 9999,
    send: () => {},
  });

  const fromAxe = world();
  await handleProposeAttackChoreography(fromAxe, new PacketReader(attackProposal(Number(storm.Id), 0)));
  assert.equal(fromAxe.acceptedCasts, undefined, "the axe does not cast the book's spell");

  const fromBook = world();
  await handleProposeAttackChoreography(fromBook, new PacketReader(attackProposal(Number(storm.Id), 1)));
  assert.ok(
    fromBook.acceptedCasts?.some((c) => c.attackId === Number(storm.Id)),
    "and the book does"
  );

  /**
   * And a slot that is not one at all.
   *
   * The number on the wire is a single attacker-controlled byte, and this used
   * to return true for anything outside the four real slots on the reasoning
   * that refusing on our own ignorance deletes honest attacks. None of it is
   * ignorance: `weaponsForAvatar` always writes exactly four entries and fills
   * the empty ones itself. Slot 255 was accepted, spent Mana, and opened a
   * cooldown clock of its own — one per byte value.
   */
  for (const slot of [4, 200, 255]) {
    const forged = world();
    await handleProposeAttackChoreography(forged, new PacketReader(attackProposal(Number(storm.Id), slot)));
    assert.equal(forged.acceptedCasts, undefined, `slot ${slot} is not a slot`);
    assert.equal(forged.heroManaPoints, 500, `and slot ${slot} spends nothing`);
    assert.equal(forged.attackCooldownUntil, undefined, `nor opens a clock of its own`);
  }

  // An empty slot holds no weapon, which is a fact this server wrote itself.
  const empty = world();
  empty.heroWeapons = [{}, {}, {}, {}];
  await handleProposeAttackChoreography(empty, new PacketReader(attackProposal(Number(storm.Id), 0)));
  assert.equal(empty.acceptedCasts, undefined, "an empty slot grants nothing");
});

/**
 * The result names which of the four equipped weapons swung, and the parser
 * read that byte and threw it away — so damage was priced with
 * `session.weaponPower`, the strongest of them. A hero carrying one strong
 * weapon therefore hit just as hard with the weak ones: a parity bug for an
 * honest loadout and an exploit for a dishonest one.
 */
test("a hit is priced by the weapon that swung", async () => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { attackForConstant } = await import("../src/gamemaster.js");
  const axe = await attackForConstant("AXE_COMBO_1");

  const world = () => ({
    id: 91,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroPositionAt: Date.now(),
    heroWeapons: [{ power: 1 }, { power: 1000 }],
    objects: new Map([[500, CLID.HeroGameObject], [700, CLID.DistributedNPCGameObject]]),
    actors: new Map([
      [700, { hitPoints: 99999, maxHitPoints: 99999, constant: "KNIGHT_TUTORIAL", position: { x: 40, y: 0 }, isEnemy: true }],
    ]),
    allocateDoid: () => 9999,
    send: () => {},
  });
  const claim = (slot) => {
    const result = new PacketWriter()
      .u32(500).u32(700).i32(0).u8(slot).u8(0).u32(Number(axe.Id)).u32(0)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
      .body();
    return new PacketReader(new PacketWriter().u16(result.length).raw(result).body());
  };

  const damageFrom = async (slot) => {
    const session = world();
    await handleProposeCombatResults(session, claim(slot));
    return 99999 - session.actors.get(700).hitPoints;
  };

  const weak = await damageFrom(0);
  const strong = await damageFrom(1);
  assert.ok(strong > weak * 10, `the strong slot hits harder: ${weak} against ${strong}`);

  /**
   * And a slot that is not one is refused outright, whatever the flags say: a
   * hero has four weapons and two powerups, and the byte has no other meaning.
   * The recordings use 0, 1 and 2 and nothing else.
   */
  for (const slot of [4, 255]) {
    const session = world();
    await handleProposeCombatResults(session, claim(slot));
    assert.equal(session.actors.get(700).hitPoints, 99999, `slot ${slot} lands nothing`);
  }
});

/**
 * A Dungeon Buster is the hero's rather than any weapon's, so no slot grants it
 * — but it still names one, and the recordings are unanimous about which: all
 * 168 buster casts and all 340 buster results arrive on slot zero.
 *
 * Accepting it from any real slot let a modified client pick its strongest, and
 * since the result is priced by the slot that swung, that is a damage choice
 * rather than a cosmetic one.
 */
test("a Dungeon Buster comes from the slot it is sent on", async () => {
  const world = () => ({
    id: 90,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 10,
    dungeonBusterPoints: 120,
    dungeonBusterAttack: "DBUSTER_BERSERK",
    heroWeapons: [{ type: 11001 }, { type: 11001 }, { type: 11001 }, { type: 11001 }],
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map(),
    allocateDoid: () => 600,
    send: () => {},
  });

  for (const slot of [1, 2, 3]) {
    const forged = world();
    await handleProposeAttackChoreography(forged, new PacketReader(attackProposal(900100, slot)));
    assert.equal(forged.dungeonBusterPoints, 120, `slot ${slot} pays nothing`);
    assert.equal(forged.acceptedCasts, undefined, `and records nothing`);
  }

  const honest = world();
  await handleProposeAttackChoreography(honest, new PacketReader(attackProposal(900100, 0)));
  assert.ok(honest.dungeonBusterPoints < 120, "slot zero is the one it comes on");
  assert.ok(
    honest.acceptedCasts?.some((cast) => cast.weaponSlot === 0),
    "and the cast is recorded against it"
  );
});

/**
 * The buster potions, which are the only thing that fills the meter.
 *
 * A Dungeon Buster costs 120 Crowd and Crowd arrives 2, 6 and 20 at a time, so
 * without these the meter never gets there — in play it crept to 2, then 4, and
 * stopped. The official wire shows the shortcut twice in one fight: the potion,
 * then 120 about 140ms later, then the buster, then 0.
 *
 * Both refilling attacks are bottles, so this only ever runs down the consumable
 * branch — which returns before the rest of the cast handling.
 */
const consumableProposal = (attackType) =>
  new PacketWriter()
    .u8(0)
    .u8(1)
    .u32(attackType)
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

const BUSTER_POTION = 910508;
const BUSTER_PARTY_POTION = 910513;

const drinkerSession = (sent, overrides = {}) => ({
  id: 33,
  heroDoid: 500,
  floorDoid: 400,
  dungeonZone: 10,
  dungeonBusterPoints: 2,
  maxDungeonBusterPoints: 120,
  dungeonBusterAttack: "DBUSTER_IRON_LEGION",
  heroWeapons: [{ type: 11001 }],
  // Its UsageAttack is what useConsumable matches the cast against.
  heroConsumables: [{ type: 70009, count: 3 }],
  objects: new Map([
    [400, CLID.DistributedDungeonFloor],
    [500, CLID.HeroGameObject],
  ]),
  allocateDoid(clid) {
    this.objects.set(600, clid);
    return 600;
  },
  send: (frame) => sent.push(frame),
  ...overrides,
});

test("a buster potion fills the Dungeon Buster meter", async () => {
  const sent = [];
  const session = drinkerSession(sent);

  await handleProposeAttackChoreography(
    session,
    new PacketReader(consumableProposal(BUSTER_POTION))
  );

  assert.equal(session.dungeonBusterPoints, 120, "full, not topped up");

  const update = sent
    .map((frame) => new PacketReader(frame.subarray(2)))
    .find((reader) => {
      reader.u16();
      reader.u32();
      return reader.u16() === 166;
    });
  assert.ok(update, "and the client is told, on field 166");
  assert.equal(update.u32(), 120);
});

test("the meter fills to the hero's own buster cost", async () => {
  const sent = [];
  const session = drinkerSession(sent, { maxDungeonBusterPoints: 80 });

  await handleProposeAttackChoreography(
    session,
    new PacketReader(consumableProposal(BUSTER_POTION))
  );

  assert.equal(session.dungeonBusterPoints, 80);
});

/**
 * Only one of the two carries AffectsOthers, and it is the party bottle. The
 * solo one must not reach anybody else.
 */
test("the solo bottle fills only the drinker", async () => {
  const sent = [];
  const session = drinkerSession(sent);
  const peer = { heroDoid: 501, dungeonBusterPoints: 5, maxDungeonBusterPoints: 120, send: () => {} };
  session.dungeonMatch = { world: null };
  session.member = session;

  await handleProposeAttackChoreography(
    session,
    new PacketReader(consumableProposal(BUSTER_POTION))
  );

  assert.equal(peer.dungeonBusterPoints, 5, "untouched");
});

test("a potion that does not refill leaves the meter alone", async () => {
  const sent = [];
  const session = drinkerSession(sent, {
    heroConsumables: [{ type: 70006, count: 3 }],
  });

  await handleProposeAttackChoreography(
    session,
    new PacketReader(consumableProposal(910505))
  );

  assert.equal(session.dungeonBusterPoints, 2, "still where it was");
});

/**
 * Mana consumables, which are authored as a negative cost.
 *
 * Every one of them says so: Mana Shot is `ManaCost: -15`, the potion and the
 * keg are -999, which is the table's way of writing "all of it". The cost was
 * clamped at zero on the way in, so all three read as free and did nothing —
 * no Mana spent, and none given. The bar never moved.
 */
const manaSession = (sent, manaPoints, stackable) => ({
  id: 77,
  heroDoid: 500,
  floorDoid: 400,
  dungeonZone: 10,
  heroManaPoints: manaPoints,
  maxHeroManaPoints: 200,
  heroWeapons: [{ type: 11001 }],
  // A consumable is used out of a powerup slot, not a weapon slot.
  heroConsumables: [{ type: stackable, count: 3 }],
  objects: new Map([
    [400, CLID.DistributedDungeonFloor],
    [500, CLID.HeroGameObject],
  ]),
  allocateDoid(clid) {
    this.objects.set(600, clid);
    return 600;
  },
  send: (frame) => sent.push(frame),
});

test("a Mana Shot gives back the fifteen the table says", async () => {
  const sent = [];
  const session = manaSession(sent, 40, 70017);

  await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(910516, 0, 1)),
    FLID_PROPOSE_ATTACK_CHOREOGRAPHY
  );

  assert.equal(session.heroManaPoints, 55, "forty and fifteen");
});

/** -999 is the table asking for the whole bar, not for nine hundred points. */
test("a Mana Potion fills the bar rather than overfilling it", async () => {
  const sent = [];
  const session = manaSession(sent, 12, 70002);

  await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(910502, 0, 1)),
    FLID_PROPOSE_ATTACK_CHOREOGRAPHY
  );

  assert.equal(session.heroManaPoints, 200, "capped at the hero's maximum");
});

/**
 * And it is drinkable on empty, which is the only time it matters. The
 * affordability check refuses a cost nobody can pay; a gift is not a cost.
 */
test("a mana consumable is not refused for want of mana", async () => {
  const sent = [];
  const session = manaSession(sent, 0, 70017);

  await handleProposeAttackChoreography(
    session,
    new PacketReader(attackProposal(910516, 0, 1)),
    FLID_PROPOSE_ATTACK_CHOREOGRAPHY
  );

  assert.equal(session.heroManaPoints, 15);
});

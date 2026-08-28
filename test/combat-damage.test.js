import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { statTotals } from "../src/hero-stats.js";
import { netAttackDamage, npcStats, statOffsetsFor } from "../src/combat-damage.js";

/**
 * Ported from DistributedDungionArea.calculateNetAttackDamage, which the client
 * still carries in full with every call site removed. These pin the parts that
 * look like mistakes and are not.
 */

const melee = (gm) => gm.raw.Attack.find((row) => row.AttackType === "MELEE" && row.DamageMod < 0);

test("damage travels as a negative number, healing as a positive one", async () => {
  const gm = await loadGameMaster();
  const attack = melee(gm);

  const harm = netAttackDamage({ gm, attack, weaponPower: 100 });
  assert.ok(harm < 0, `${attack.Constant} should hurt, got ${harm}`);

  // DamageMod carries the sign, so a positive one heals.
  const heal = netAttackDamage({ gm, attack: { ...attack, DamageMod: 2 }, weaponPower: 100 });
  assert.ok(heal > 0);
});

test("defence is added, because it pulls a negative result toward zero", async () => {
  const gm = await loadGameMaster();
  const attack = melee(gm);
  const bare = netAttackDamage({ gm, attack, weaponPower: 100 });

  // A melee attack reads SHOOT_DEF — see the cross-wiring note below.
  const armoured = netAttackDamage({
    gm,
    attack,
    weaponPower: 100,
    defender: new Map([["SHOOT_DEF", 50]]),
  });

  assert.equal(armoured, bare + 50, "defence adds");
  assert.ok(armoured > bare, "and so reduces the harm done");
});

/**
 * The shipped game pairs MELEE_ATK with SHOOT_DEF and SHOOT_ATK with MELEE_DEF.
 * The stat name list has those two entries swapped relative to the attack list
 * and the offsets are literal indices into it. It reads like an original bug —
 * but the client shipped with it, so a server that "fixed" it would disagree
 * with every damage number the game ever produced.
 */
test("melee is resisted by SHOOT_DEF and shooting by MELEE_DEF", async () => {
  const gm = await loadGameMaster();

  const meleeAttack = melee(gm);
  const shootAttack = gm.raw.Attack.find((row) => row.AttackType === "SHOOTING" && row.DamageMod < 0);

  const bare = (attack) => netAttackDamage({ gm, attack, weaponPower: 100 });
  const against = (attack, stat) =>
    netAttackDamage({ gm, attack, weaponPower: 100, defender: new Map([[stat, 40]]) });

  assert.equal(against(meleeAttack, "SHOOT_DEF"), bare(meleeAttack) + 40);
  assert.equal(against(meleeAttack, "MELEE_DEF"), bare(meleeAttack), "melee ignores MELEE_DEF");

  assert.equal(against(shootAttack, "MELEE_DEF"), bare(shootAttack) + 40);
  assert.equal(against(shootAttack, "SHOOT_DEF"), bare(shootAttack), "shooting ignores SHOOT_DEF");
});

test("attacks without stat offsets are just power times the modifier", async () => {
  const gm = await loadGameMaster();
  const support = gm.raw.Attack.find((row) => !statOffsetsFor(row));

  assert.ok(support, "the roster has SUPPORT or ANIMATION attacks");
  assert.equal(
    netAttackDamage({
      gm,
      attack: support,
      weaponPower: 100,
      attacker: new Map([["MELEE_ATK", 999]]),
      defender: new Map([["SHOOT_DEF", 999]]),
    }),
    100 * Number(support.DamageMod ?? 0),
    "stats are skipped entirely"
  );
});

test("a stronger attacker hits harder than a weaker one", async () => {
  const gm = await loadGameMaster();
  const attack = melee(gm);
  const hero = gm.heroById.get(104);

  const novice = statTotals(gm, hero, { experience: 0 });
  const veteran = statTotals(gm, hero, { experience: 9_999_999 });

  const weak = netAttackDamage({ gm, attack, weaponPower: 50, attacker: novice });
  const strong = netAttackDamage({ gm, attack, weaponPower: 50, attacker: veteran });

  assert.ok(strong < weak, "more offence means a more negative result");
});

// NPCs carry the same stat columns as heroes, so one vector serves both.
test("NPC rows produce a usable stat vector", async () => {
  const gm = await loadGameMaster();
  const skeleton = gm.raw.Npc.find((row) => row.Constant === "SKELETON_WARRIOR");
  const stats = npcStats(gm, skeleton);

  assert.equal(stats.get("MELEE_DEF"), Number(skeleton.MELEE_DEF));
  assert.doesNotThrow(() => npcStats(gm, undefined), "a missing row is not fatal");
});

test("a projectile's repeated hits are each worth half the last", async () => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { PacketWriter, PacketReader } = await import("../src/socket/packet.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  /**
   * The client counts each collision of the same projectile in `generation`,
   * reset per cast. One victim caught by two storms settles the curve: at
   * generation 0 it took 2877 and at generation 2 it took 720, which is that
   * over four.
   */
  const hitAt = async (generation) => {
    const session = {
      id: 90,
      heroDoid: 500,
      floorDoid: 400,
      // The slot that swung is what prices the hit now, so the hero has to be
      // carrying something rather than merely having a strongest weapon.
      heroWeapons: [{ power: 500 }],
      objects: new Map([
        [500, CLID.HeroGameObject],
        [700, CLID.DistributedNPCGameObject],
      ]),
      actors: new Map([
        [700, { hitPoints: 900000, maxHitPoints: 900000, constant: "KNIGHT_TUTORIAL", isEnemy: true }],
      ]),
      allocateDoid: () => 900,
      send: () => {},
    };
    const result = new PacketWriter()
      .u32(500).u32(700).i32(0).u8(0).u8(0).u32(901104).u32(0)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(generation)
      .body();
    const packet = new PacketWriter().u16(result.length).raw(result).body();
    await handleProposeCombatResults(session, new PacketReader(packet));
    return 900000 - session.actors.get(700).hitPoints;
  };

  const first = await hitAt(0);
  assert.ok(first > 8, "the first collision lands in full");
  assert.equal(await hitAt(1), Math.max(1, Math.round(first / 2)), "the second is half");
  assert.equal(await hitAt(2), Math.max(1, Math.round(first / 4)), "the third a quarter");
  assert.equal(await hitAt(3), Math.max(1, Math.round(first / 8)), "and so on down");
});

test("a lethal hero result credits damage and one kill to that member's report", async () => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { PacketWriter, PacketReader } = await import("../src/socket/packet.js");
  const { CLID } = await import("../src/socket/opcodes.js");
  const session = {
    id: 92,
    heroDoid: 500,
    floorDoid: 400,
    heroWeapons: [{ power: 500 }],
    dungeonContribution: { kills: 0, damage: 0 },
    objects: new Map([
      [500, CLID.HeroGameObject],
      [700, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [700, { hitPoints: 1, maxHitPoints: 1, constant: "KNIGHT_TUTORIAL", isEnemy: true }],
    ]),
    send: () => {},
  };
  const result = new PacketWriter()
    .u32(500).u32(700).i32(0).u8(0).u8(0).u32(920050).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  const packet = () => new PacketWriter().u16(result.length).raw(result).body();

  await handleProposeCombatResults(session, new PacketReader(packet()));
  await handleProposeCombatResults(session, new PacketReader(packet()));

  assert.deepEqual(session.dungeonContribution, { kills: 1, damage: 1 });
});

/**
 * The buff floater, decoded from `socket-20260816-191126.jsonl`.
 *
 * A damage-over-time tick publishes hit points and then this, on the hero owner
 * rather than the victim. Two captured ticks fix the layout and the colour:
 * `0CE92403 EEFFFFFF 0B000000 00` is actor 52750604 losing 18 to poison, and
 * the firebomb's burn reported the same shape with colour 12.
 */
test("a buff tick reports its damage on the hero owner, signed and coloured", async () => {
  const { buffColorTypeFor, buffEffectReport } = await import("../src/socket/buffs.js");
  const { buffForConstant } = await import("../src/gamemaster.js");
  const { PacketReader } = await import("../src/socket/packet.js");
  const { OP } = await import("../src/socket/opcodes.js");

  const poison = await buffColorTypeFor(await buffForConstant("POISON_L3"));
  const fire = await buffColorTypeFor(await buffForConstant("FIRE_L5"));
  assert.equal(poison, 11, "BuffColorType names the poison row 11");
  assert.equal(fire, 12);

  const frame = buffEffectReport({
    heroDoid: 1100219925,
    actorDoid: 52750604,
    amount: -18,
    colorType: poison,
  });

  // 2 length + 2 opcode + 4 doid + 2 field + 13 payload, as captured.
  assert.equal(frame.length, 23);
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), 1100219925);
  assert.equal(reader.u16(), 168);
  assert.equal(reader.u32(), 52750604);
  assert.equal(reader.u32() | 0, -18, "negative is damage; a positive number heals");
  assert.equal(reader.u32(), 11);
  assert.equal(reader.u8(), 0, "effectiveness, which the captured ticks leave at zero");
});

test("a buff nothing colours reports zero rather than guessing", async () => {
  const { buffColorTypeFor } = await import("../src/socket/buffs.js");
  const { buffForConstant } = await import("../src/gamemaster.js");

  // BLEEDING authors no Ability1, and no capture shows what colour it took.
  assert.equal(await buffColorTypeFor(await buffForConstant("BLEEDING")), 0);
});

test("a smashed gate breaks in place instead of vanishing", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  const sent = [];
  const session = {
    id: 91,
    heroDoid: 500,
    objects: new Map([
      [700, CLID.DistributedNPCGameObject],
      [701, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      // CASTLE_ARENA_GATE_B: Species DOOR, PermCorpse, twenty-five hit points.
      [700, { hitPoints: 25, maxHitPoints: 25, constant: "CASTLE_ARENA_GATE_B", permCorpse: true }],
      [701, { hitPoints: 10, maxHitPoints: 10, constant: "CASTLE_ARENA_SMASH_CAGE_B" }],
    ]),
    send: (frame) => sent.push(frame),
  };

  const fieldsFor = (doid) =>
    sent
      .filter((frame) => frame.readUInt16LE(2) === 124 && frame.readUInt32LE(4) === doid)
      .map((frame) => frame.readUInt16LE(8));

  applyDamage(session, 700, 25);
  /**
   * The captured door took its trigger state and stayed standing for the rest
   * of the floor; "dead" runs enterDeadState and it disappears outright.
   */
  const gateFrames = sent.filter(
    (frame) => frame.readUInt16LE(2) === 124 && frame.readUInt32LE(4) === 700
  );
  const trigger = gateFrames.find((frame) => frame.readUInt16LE(8) === 141);
  assert.ok(trigger, "the gate switches to its broken form");
  // Generated at 1, broken at 0 — sending 1 leaves it looking untouched.
  assert.equal(trigger[10], 0, "and the value is the one the captures carry");
  assert.ok(!fieldsFor(700).includes(138), "and is never told it died");

  applyDamage(session, 701, 10);
  assert.ok(fieldsFor(701).includes(138), "a cage still dies as before");
  assert.ok(!fieldsFor(701).includes(141), "and has no broken form to switch to");
});

/**
 * 625 damage-over-time ticks across the recordings, every one on a monster.
 * The same corpus has flame jets hitting the hero 152 times and TRAP_FLAME_JET
 * authors FIRE_L1, so the chance was there and the official never took it.
 */
test("a burn ticks on a monster and never on the hero", async (t) => {
  const { applyTargetBuff } = await import("../src/socket/combat.js");
  const { CLID } = await import("../src/socket/opcodes.js");
  t.mock.timers.enable({ apis: ["setInterval"] });

  const build = (victimDoid) => ({
    id: 1,
    heroDoid: 10,
    dungeonActive: true,
    floorDoid: 55,
    dungeonZone: 0,
    allocateDoid: () => 900,
    objects: new Map([
      [10, CLID.HeroGameObject],
      [20, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [10, { hitPoints: 200, maxHitPoints: 200 }],
      [20, { hitPoints: 500, maxHitPoints: 500, isEnemy: true }],
    ]),
    send: () => {},
    victimDoid,
  });

  const burned = build(20);
  await applyTargetBuff(burned, {
    attack: { TargetBuff1: "FIRE_L1" },
    victimDoid: 20,
    attackerDoid: 30,
    damage: 24,
  });
  t.mock.timers.tick(3000);
  assert.ok(burned.actors.get(20).hitPoints < 500, "a monster burns");

  const spared = build(10);
  await applyTargetBuff(spared, {
    attack: { TargetBuff1: "FIRE_L1" },
    victimDoid: 10,
    attackerDoid: 30,
    damage: 24,
  });
  t.mock.timers.tick(10000);
  assert.equal(spared.actors.get(10).hitPoints, 200, "the hero does not");
});

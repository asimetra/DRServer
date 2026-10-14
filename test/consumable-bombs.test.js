import assert from "node:assert/strict";
import test from "node:test";

import {
  attackForConstant,
  heroById,
  loadGameMaster,
  npcForConstant,
  projectileForConstant,
} from "../src/gamemaster.js";
import { experienceForLevel } from "../src/progression.js";
import {
  applyDamage,
  handleProposeCombatResults,
  hazardVictims,
  performTrapAttack,
  tickTrapProjectiles,
} from "../src/socket/combat.js";
import { handleProposeAttackChoreography } from "../src/socket/buster.js";
import { weaponsForAvatar } from "../src/socket/dungeon.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import { clearDungeonPlaceables, heroPlacer, spawnPlaceable } from "../src/socket/placeables.js";
import { decodeGenerate } from "../tools/wire.js";

/**
 * The consumable bombs: `CONSUMABLE_*_BOMB`, rows authored IsAttackable 0, HP 1,
 * CharType HERO, a DeathAttack and `CONSUMABLE_BOMB_WEAPON`.
 */

const HERO_TYPE = 104;
const DEMOLITION = 70004;
const BOMB_ACTION = {
  spawnname: "CONSUMABLE_DEMOLITION_BOMB",
  offset: 0,
  headingOffsetAngle: 0,
  timetolive: 0.1,
};

const levelExperience = async (level) =>
  experienceForLevel(await loadGameMaster(), await heroById(HERO_TYPE), level);

const sessionWith = (overrides = {}) => {
  let nextDoid = 900;
  const sent = [];
  return {
    id: 77,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    heroManaPoints: 200,
    dungeonBusterPoints: 0,
    dungeonAvatar: { avatar_id: HERO_TYPE, experience: 0 },
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => ++nextDoid,
    random: () => 0.99,
    sent,
    send: (packet) => sent.push(packet),
    ...overrides,
  };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Framed: u16 length, u16 opcode, u32 doid, u16 field, then the field. */
const swingsOf = (session, doid) =>
  session.sent
    .filter((packet) => packet.length >= 16 && packet.readUInt32LE(4) === doid && packet.readUInt16LE(8) === 143)
    .map((packet) => packet.readUInt32LE(12));

/** The generate of the one NPC of this row the session was sent. */
const generateOfRow = (session, npcId) =>
  session.sent
    .filter((frame) => frame.readUInt16LE(2) === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP)
    .map((frame) => decodeGenerate(frame.subarray(2)).fields)
    .find((fields) => fields?.type === npcId);

const standing = (session, doid, actor) => {
  session.objects.set(doid, CLID.DistributedNPCGameObject);
  session.actors.set(doid, { collisionRadius: 30, ...actor });
};

test("a monster's swing that reaches a bomb passes it by: the row says it cannot be attacked", async () => {
  const session = sessionWith();
  const bomb = await spawnPlaceable(session, {
    owner: await heroPlacer(session),
    action: BOMB_ACTION,
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });
  // A barricade on the same spot: the players' side and attackable, so the
  // same swing does take it and the test is not passing on the side test.
  standing(session, 701, {
    hitPoints: 500,
    maxHitPoints: 500,
    constant: "BARRICADE",
    team: TEAM.PLAYERS,
    isAlly: true,
    attackable: true,
    position: { x: 1000, y: 1000 },
  });

  const charge = await attackForConstant("EN_WARHOG_SLOW_CHARGE");
  const caught = hazardVictims(
    session,
    [{ type: "circle", x: 1000, y: 1000, radius: 80 }],
    { attack: charge, team: TEAM.ENEMIES }
  ).map(({ doid }) => doid);

  assert.deepEqual(caught, [701]);
  assert.equal(session.actors.get(bomb).hitPoints, 1, "the bomb is untouched");
  clearDungeonPlaceables(session);
});

test("a trap's arrow stops at a bomb as at a wall, and the bomb takes nothing", async () => {
  const npc = await npcForConstant("CASTLE_ARENA_TRAP_ARROW_A");
  const attack = await attackForConstant(npc.Attack1);
  const projectile = await projectileForConstant(attack.Projectile);
  const session = sessionWith({
    heroDoid: 7401,
    heroPosition: { x: 1600, y: 1000 },
    playerActors: new Set([7401]),
    navigation: null,
  });
  session.objects.set(7401, CLID.HeroGameObject);
  session.actors.set(7401, {
    hitPoints: 4000,
    maxHitPoints: 4000,
    collisionRadius: 22,
    constant: "RANGER",
    team: TEAM.PLAYERS,
    position: { x: 1600, y: 1000 },
  });
  const bomb = await spawnPlaceable(session, {
    owner: await heroPlacer(session),
    action: BOMB_ACTION,
    origin: { x: 1200, y: 1000 },
    heading: 0,
  });

  await performTrapAttack(session, 9700, {
    attack,
    npc,
    projectile,
    team: TEAM.ENVIRONMENT,
    position: { x: 1000, y: 1000 },
    heading: 0,
    combatColliders: [],
  });
  for (let step = 0; step < 20; step += 1) await tickTrapProjectiles(session, 0.05);

  assert.equal(session.actors.get(7401).hitPoints, 4000, "the hero behind the bomb is not hit through it");
  assert.equal(session.actors.get(bomb)?.hitPoints, 1, "and the bomb is not hit either");
  clearDungeonPlaceables(session);
});

test("a bomb killed by some other hit before it goes off still goes off, once", async () => {
  const session = sessionWith();
  standing(session, 700, {
    hitPoints: 60_000,
    maxHitPoints: 60_000,
    constant: "BRUTE",
    isEnemy: true,
    position: { x: 1060, y: 1000 },
  });
  const bomb = await spawnPlaceable(session, {
    owner: await heroPlacer(session),
    action: BOMB_ACTION,
    origin: { x: 1000, y: 1000 },
    heading: 0,
    weaponPower: 100,
  });

  // Inside the 80ms before its own death begins.
  assert.equal(applyDamage(session, bomb, 5), true);
  const death = await attackForConstant("CONSUMABLE_DEMOLITION_BOMB_DEATH_ATTACK");
  assert.deepEqual(swingsOf(session, bomb), [death.Id], "the blast plays as it dies");

  // Past its activation and the blast's frame 38 (1583ms).
  await wait(1900);
  assert.deepEqual(swingsOf(session, bomb), [death.Id], "and only once");
  assert.ok(session.actors.get(700).hitPoints < 60_000, "and lands on the brute beside it");
  clearDungeonPlaceables(session);
});

/**
 * Throws a demolition bomb from the powerup slot for a hero of `level` whose
 * first weapon is `slot0`, and answers with the bomb's generate and what the
 * blast did to a brute standing in it.
 */
const throwDemolition = async (level, slot0) => {
  const experience = await levelExperience(level);
  const session = sessionWith({
    dungeonAvatar: {
      avatar_id: HERO_TYPE,
      experience,
      consumable1_id: DEMOLITION,
      consumable1_count: 2,
    },
    dungeonAccount: { account_stackables: [{ stack_id: DEMOLITION, count: 2 }] },
    queueAccountSave: () => {},
    heroConsumables: [{ type: DEMOLITION, count: 2 }],
    heroWeapons: [{ type: 11003, power: slot0, requiredlevel: level, rarity: 4 }],
  });
  standing(session, 700, {
    hitPoints: 60_000,
    maxHitPoints: 60_000,
    constant: "BRUTE",
    isEnemy: true,
    position: { x: 1060, y: 1000 },
  });
  const attack = await attackForConstant("CONSUMABLE_DEMOLITION_ATTACK");
  const proposal = new PacketWriter()
    .u8(0) // powerup slot
    .u8(1) // isConsumableWeapon
    .u32(attack.Id)
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();
  await handleProposeAttackChoreography(session, new PacketReader(proposal));
  await wait(2400);

  const generate = generateOfRow(session, (await npcForConstant("CONSUMABLE_DEMOLITION_BOMB")).Id);
  clearDungeonPlaceables(session);
  return { generate, damage: 60_000 - session.actors.get(700).hitPoints };
};

test("a bomb is generated at the hero's level holding twice his consumable power, and blasts with it", async () => {
  const { generate, damage } = await throwDemolition(100, 1325);
  assert.equal(generate.level, 100);
  assert.deepEqual(generate.weaponDetails[0], [27100, 1020, 1, 1, 0, 0, 0], "the official's own, at level 100");
  // DamageMod -5 × 1020, not × 1325 from the weapon in slot 0.
  assert.equal(damage, 5100);
});

test("twice the consumable power is doubled before it is rounded: 669 at level 75, not 2 × 334", async () => {
  const { generate, damage } = await throwDemolition(75, 381);
  assert.equal(generate.level, 75);
  assert.deepEqual(generate.weaponDetails[0], [27100, 669, 1, 1, 0, 0, 0]);
  assert.equal(damage, 3345, "the official's 3345 on every victim");
});

test("a hero's empty fourth slot carries his consumable power at his level", () => {
  const account = {
    account_items: [{ item_id: 11001, avatar_id: 4, avatar_slot: 0, power: 402, requiredlevel: 68, rarity: 3 }],
  };
  assert.deepEqual(weaponsForAvatar(account, { id: 4 }, 100)[3], {
    type: 0,
    power: 510,
    requiredlevel: 100,
    rarity: 1,
  });
  assert.equal(weaponsForAvatar(account, { id: 4 }, 75)[3].power, 334);
  assert.equal(weaponsForAvatar(account, { id: 4 }, 1)[3].power, 10);
  assert.equal(weaponsForAvatar(account, { id: 4 }, 75)[0].power, 402, "the weapons themselves are unchanged");
});

/**
 * The health and party bombs are proposed by the client as slot 0 and priced by
 * that slot's weapon — 525 of 525 official hits. Nothing about the consumable
 * slot reaches them.
 */
for (const [constant, mod] of [
  ["HEALTH_BOMB_ATTACK", 1.5],
  ["PARTY_BOMB_ATTACK", 2],
]) {
  test(`${constant} is still priced by slot 0, not the consumable slot`, async () => {
    const attack = await attackForConstant(constant);
    const session = sessionWith({
      heroWeapons: [
        { type: 11003, power: 1298, requiredlevel: 98, rarity: 4 },
        {},
        {},
        { type: 0, power: 510, requiredlevel: 100, rarity: 1 },
      ],
    });
    session.objects.set(500, CLID.HeroGameObject);
    standing(session, 700, { hitPoints: 60_000, maxHitPoints: 60_000, constant: "BRUTE", isEnemy: true });
    const result = new PacketWriter()
      .u32(500).u32(700).i32(0).u8(0).u8(0).u32(attack.Id).u32(0)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
      .body();
    await handleProposeCombatResults(
      session,
      new PacketReader(new PacketWriter().u16(result.length).raw(result).body())
    );
    assert.equal(60_000 - session.actors.get(700).hitPoints, Math.round(1298 * mod));
  });
}

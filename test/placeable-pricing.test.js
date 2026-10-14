import assert from "node:assert/strict";
import test from "node:test";

import { attackForConstant, heroById, loadGameMaster } from "../src/gamemaster.js";
import { experienceForLevel } from "../src/progression.js";
import { handleProposeAttackChoreography } from "../src/socket/buster.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import { clearDungeonPlaceables, heroPlacer, spawnPlaceable } from "../src/socket/placeables.js";
import { decodeGenerate } from "../tools/wire.js";

/**
 * What a hero's placeables are worth when they land.
 *
 * Put down by a weapon (a thrown or placed trap, and the fire a firebomb
 * lights) it is priced as the hero's own swing, and the victim's rating takes
 * its tier exactly as it does his: the official halves 69 of 69 trap and fire
 * hits on MELEE_DEF +1 rows and doubles every one on -1 (n 115 in all).
 *
 * Put down by no weapon (a Dungeon Buster) it swings as itself: its row at
 * the hero's combat level, holding its row's weapon on his level curve
 * (placeables.js `swingsAsItself`).
 */

const VAMPIRE_HUNTER = 105;
const HERO = 500;
const MELEE_ATK = 21; // a level-100 Vampire Hunter: 6 + 0.15 × 100

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const atLevel = async (level) =>
  experienceForLevel(await loadGameMaster(), await heroById(VAMPIRE_HUNTER), level);

const world = async ({ level = 100, heroWeapons = [], buster = null } = {}) => {
  let next = 900;
  const session = {
    id: 88,
    heroDoid: HERO,
    floorDoid: 400,
    dungeonZone: 0,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    heroManaPoints: 500,
    maxHeroManaPoints: 500,
    dungeonBusterPoints: 999,
    maxDungeonBusterPoints: 999,
    dungeonBusterAttack: buster,
    dungeonAvatar: { avatar_id: VAMPIRE_HUNTER, experience: await atLevel(level) },
    heroStats: new Map([["MELEE_ATK", MELEE_ATK]]),
    heroWeapons,
    objects: new Map([[HERO, CLID.HeroGameObject]]),
    actors: new Map(),
    navigation: null,
    random: () => 0.99,
    allocateDoid: (clid) => {
      const doid = ++next;
      session.objects.set(doid, clid);
      return doid;
    },
    sent: [],
    send: (frame) => session.sent.push(frame),
  };
  return session;
};

const standing = (session, doid, constant, position, level = 50) => {
  session.objects.set(doid, CLID.DistributedNPCGameObject);
  session.actors.set(doid, {
    hitPoints: 9_000_000,
    maxHitPoints: 9_000_000,
    constant,
    level,
    isEnemy: true,
    collisionRadius: 20,
    position,
  });
};

/** Every hit echoed on `doid`: its damage and the effectiveness it says. */
const hitsOn = (session, doid) =>
  session.sent
    .filter((frame) => frame.length >= 38 && frame.readUInt32LE(4) === doid && frame.readUInt16LE(8) === 144)
    .map((frame) => ({ damage: -frame.readInt32LE(18), effectiveness: frame.readInt8(37) }));

/** One hero-placed placeable of `constant`, a victim inside it, and what it took. */
const placedHit = async (constant, victim, { level = 50 } = {}) => {
  const weapon = { type: 17503, power: 1476, requiredlevel: 100, rarity: 4 };
  const session = await world({ heroWeapons: [weapon] });
  standing(session, 700, victim, { x: 1000, y: 1000 }, level);
  await spawnPlaceable(session, {
    owner: await heroPlacer(session),
    action: { spawnname: constant, offset: 0, headingOffsetAngle: 0, timetolive: 10 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
    weaponPower: weapon.power,
    heroWeapon: weapon,
  });
  // Past the trap's collider on frame 2 and the fire's on frame 0.
  await settle(250);
  clearDungeonPlaceables(session);
  const [first] = hitsOn(session, 700);
  assert.ok(first, `${constant} lands on ${victim}`);
  return first;
};

// Melee against MELEE_DEF: BRUTE 0, PURPLE_SPECTER +1, SKELETON_WARRIOR -1.
for (const constant of ["GARLIC_PLACEABLE_L3", "BURNING_FIRE_PLACEABLE"]) {
  test(`${constant} lands as the hero's swing: halved on +1, doubled on -1, as before on 0`, async () => {
    const neutral = await placedHit(constant, "BRUTE");
    const resisted = await placedHit(constant, "PURPLE_SPECTER");
    const weak = await placedHit(constant, "SKELETON_WARRIOR");

    assert.deepEqual(neutral, { damage: 1476 + MELEE_ATK, effectiveness: 0 });
    assert.deepEqual(resisted, { damage: Math.round((1476 + MELEE_ATK) / 2), effectiveness: -1 });
    assert.deepEqual(weak, { damage: (1476 + MELEE_ATK) * 2, effectiveness: 1 });
  });
}

/**
 * Below level 7 no rating counts, for a trap as for a swing (hit-pricing.js
 * `RATED_FROM_LEVEL`). It is what the seven unhalved trap and fire hits in our
 * 2026-10-13 capture were: KNIGHT, KNIGHT_THROWING and JUGGERNAUT at level 3
 * on node 50004.
 */
test("a hero's trap on a resistant monster below level 7 is neutral, as his swing is", async () => {
  const knight = await placedHit("GARLIC_PLACEABLE_L3", "KNIGHT", { level: 3 });
  assert.deepEqual(knight, { damage: 1476 + MELEE_ATK, effectiveness: 0 });
});

const castNuke = async (victims) => {
  const attack = await attackForConstant("DBUSTER_GARLIC_NUKE");
  const session = await world({
    buster: "DBUSTER_GARLIC_NUKE",
    // The slot the buster names, holding a far stronger weapon than the nuke.
    heroWeapons: [{ type: 17503, power: 2195, requiredlevel: 100, rarity: 4 }],
  });
  for (const [doid, constant] of victims) standing(session, doid, constant, { x: 1120, y: 1000 }, 61);
  await handleProposeAttackChoreography(
    session,
    new PacketReader(
      new PacketWriter().u8(0).u8(0).u32(Number(attack.Id)).u32(0).u8(0).f32(1).f32(1).u16(0).body()
    )
  );
  // Spawned on frame 20 (833ms), armed 1.25 to 2.5s later, struck on frame 2.
  await settle(3600);
  clearDungeonPlaceables(session);
  return session;
};

/**
 * The official's level-100 Vampire Hunter's nukes: 655 on a neutral monster,
 * 328 on one rated +1 and 1310 on one rated -1, generated holding
 * [27042, 51, 1, 1, 0, 0, 0] — not the cast slot's weapon.
 */
test("a Dungeon Buster's nuke is priced from its row at the hero's level, not from slot 0", async () => {
  const session = await castNuke([
    [701, "BRUTE"],
    [702, "ICE_IMP"],
    [703, "BABY_YETI"],
  ]);
  const damages = (doid) => [...new Set(hitsOn(session, doid).map(({ damage }) => damage))];
  assert.deepEqual(damages(701), [655]);
  assert.deepEqual(damages(702), [328]);
  assert.deepEqual(damages(703), [1310]);

  const gm = await loadGameMaster();
  const nuke = gm.raw.Npc.find((row) => row.Constant === "GARLIC_NUKE_PLACEABLE");
  const generates = session.sent
    .filter((frame) => frame.readUInt16LE(2) === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP)
    .map((frame) => decodeGenerate(frame.subarray(2)).fields)
    .filter((fields) => fields?.type === nuke.Id);
  assert.equal(generates.length, 6);
  for (const fields of generates) {
    assert.equal(fields.level, 100);
    assert.deepEqual(fields.weaponDetails[0], [27042, 51, 1, 1, 0, 0, 0]);
  }
});

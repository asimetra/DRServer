import assert from "node:assert/strict";
import { weaponWith } from "./helpers/weapons.js";
import test from "node:test";

import { attackForConstant, buffForConstant } from "../src/gamemaster.js";
import { dealTrapHit, handleProposeCombatResults, startHealthDrain } from "../src/socket/combat.js";
import { CLID } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

/**
 * What a buff's `*_DEF` columns mean.
 *
 * They were read as "the share of a hit taken off", with anything at or above
 * one meaning all of it. Most of the family is fractions and reads that way —
 * 0.1, 0.25, 0.3, 0.5. But a whole number there is not a share: it is the same
 * rating a monster's own row carries, +1 for "resists", and it halves the hit
 * and says so.
 *
 * What brought it up is the Infinite dungeons' Poison Gas, whose row authors 1
 * in all three columns. Read as "all of it", a gassed hero took nothing from
 * 153 hits running and the gas itself did nothing either. The gas is a penalty
 * and is treated as one here: it poisons, and it protects from nothing.
 */

const HERO = 500;
const FOE = 20;
const VICTIM = 700;
const EFFECTIVENESS_AT = 37;
const AXE_COMBO_1 = 900101;
const LONG_BOW_SHOT = 900504;

const under = async (...constants) =>
  new Map(
    await Promise.all(
      constants.map(async ([constant, actor], index) => [
        900 + index,
        { affectedActor: actor, buff: await buffForConstant(constant) },
      ])
    )
  );

/** One monster's blow on the hero: what landed and how it was marked. */
const blowOn = async (attackConstant, { buffs = [], weapons = [{ power: 10 }] } = {}) => {
  const sent = [];
  const session = {
    id: 97,
    heroDoid: HERO,
    playerActors: new Set([HERO]),
    dungeonActive: true,
    heroWeapons: weapons,
    heroStats: new Map([["MELEE_DEF", 0], ["SHOOT_DEF", 0], ["MAGIC_DEF", 0]]),
    activeBuffs: await under(...buffs.map((constant) => [constant, HERO])),
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [FOE, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [HERO, { hitPoints: 60_000, maxHitPoints: 60_000, constant: "GHOST_SAMURAI" }],
      [FOE, { constant: "SKELETON_WARRIOR", isEnemy: true }],
    ]),
    send: (frame) => sent.push(frame),
  };
  await dealTrapHit(session, FOE, await attackForConstant(attackConstant), HERO, 400);
  const hit = sent.find((frame) => frame.readUInt32LE(4) === HERO && frame.readUInt16LE(8) === 160);
  assert.ok(hit, "the blow lands");
  return { damage: 0 - hit.readInt32LE(18), effectiveness: hit.readInt8(EFFECTIVENESS_AT) };
};

/**
 * The one recording of a gassed hero on the official shows the opposite — half
 * of every blow, marked resisted. It is a single floor of a single run, and a
 * poison that shields is taken to be a row filled in by habit rather than a
 * rule worth copying. See `buffRatingFor`.
 */
test("the poison gas protects from nothing: a blow lands whole, unmarked", async () => {
  const bare = await blowOn("EN_SWORD_CHOP");
  const gassed = await blowOn("EN_SWORD_CHOP", { buffs: ["INFINITE_POISONOUS_GAS"] });

  assert.ok(bare.damage > 10, "a blow worth measuring");
  assert.deepEqual(gassed, bare, "not nothing, as it was, and not half either");
});

test("a legendary shield under the gas is still exactly a shield", async () => {
  const cover = [{ power: 10, legendarymodifier: 11 }];
  const shielded = await blowOn("EN_ARROW_SHOT", { weapons: cover });
  const both = await blowOn("EN_ARROW_SHOT", { weapons: cover, buffs: ["INFINITE_POISONOUS_GAS"] });

  assert.deepEqual(both, shielded);
  assert.equal(both.effectiveness, -1, "Cover's own mark, and Cover's alone");
});

/** A resisting buff and a shield are one resistance, not two halves. */
test("the berserker's rage and a legendary shield do not stack", async () => {
  const barrier = [{ power: 10, legendarymodifier: 10 }];
  const shielded = await blowOn("EN_SWORD_CHOP", { weapons: barrier });
  const both = await blowOn("EN_SWORD_CHOP", { weapons: barrier, buffs: ["BERSERK_DB"] });

  assert.deepEqual(both, shielded);
});

test("a fraction in those columns is still a share taken off, and says nothing", async () => {
  const bare = await blowOn("EN_SWORD_CHOP");
  const defended = await blowOn("EN_SWORD_CHOP", { buffs: ["DEFENDER_L1"] }); // 0.25

  assert.equal(defended.damage, Math.ceil(bare.damage * 0.75));
  assert.equal(defended.effectiveness, 0);
});

/**
 * The Berserker's rage authors 100, which was read as untouchable. The
 * official's is not: fifteen of the twenty-three hits recorded on a raging
 * Berserker land, at three where the same yeti scratched for four, each marked
 * resisted.
 */
test("the berserker's rage resists a blow rather than erasing it", async () => {
  const bare = await blowOn("EN_SWORD_CHOP");
  const raging = await blowOn("EN_SWORD_CHOP", { buffs: ["BERSERK_DB"] });

  assert.equal(raging.damage, Math.ceil(bare.damage / 2));
  assert.equal(raging.effectiveness, -1);
});

/** The same columns on a monster: "Enemies resist melee damage." */
const heroHit = async (attackId, buffs = []) => {
  const sent = [];
  const session = {
    id: 98,
    heroDoid: HERO,
    floorDoid: 400,
    dungeonActive: true,
    heroWeapons: [await weaponWith(attackId, { power: 500 })],
    random: () => 0.99,
    activeBuffs: await under(...buffs.map((constant) => [constant, VICTIM])),
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [VICTIM, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [VICTIM, { hitPoints: 9_000_000, maxHitPoints: 9_000_000, constant: "BRUTE", isEnemy: true }],
    ]),
    allocateDoid: () => 990,
    send: (frame) => sent.push(frame),
  };
  const result = new PacketWriter()
    .u32(HERO).u32(VICTIM).i32(0).u8(0).u8(0).u32(attackId).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  await handleProposeCombatResults(
    session,
    new PacketReader(new PacketWriter().u16(result.length).raw(result).body())
  );
  const echo = sent.find((frame) => frame.readUInt32LE(4) === VICTIM && frame.readUInt16LE(8) === 144);
  return { damage: 0 - echo.readInt32LE(18), effectiveness: echo.readInt8(EFFECTIVENESS_AT) };
};

test("a monster under Iron Armor resists a sword and not an arrow", async () => {
  const swing = await heroHit(AXE_COMBO_1);
  const armoured = await heroHit(AXE_COMBO_1, ["INFINITE_MELEE_DEFENSE"]);
  assert.equal(armoured.damage, Math.round(swing.damage / 2), "resisted, not immune");
  assert.equal(armoured.effectiveness, -1);

  const arrow = await heroHit(LONG_BOW_SHOT);
  const armouredArrow = await heroHit(LONG_BOW_SHOT, ["INFINITE_MELEE_DEFENSE"]);
  assert.deepEqual(armouredArrow, arrow, "the column that is zero changes nothing");
});

/**
 * And the gas itself, which did nothing at all. On the official it takes one
 * percent of the hero's full health every second for as long as it is on him:
 * 9 off a hero of 880, forty-two times running, a median 973ms apart.
 */
test("the gas takes a hundredth of the hero's health every second", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent = [];
  const gas = await buffForConstant("INFINITE_POISONOUS_GAS");
  const session = {
    id: 99,
    heroDoid: HERO,
    dungeonActive: true,
    objects: new Map([[HERO, CLID.HeroGameObject]]),
    actors: new Map([[HERO, { hitPoints: 880, maxHitPoints: 880, constant: "GHOST_SAMURAI" }]]),
    activeBuffs: new Map([[900, { affectedActor: HERO, buff: gas }]]),
    send: (frame) => sent.push(frame),
  };
  startHealthDrain(session, { buffDoid: 900, victimDoid: HERO, buff: gas });
  const hero = session.actors.get(HERO);

  t.mock.timers.tick(999);
  assert.equal(hero.hitPoints, 880, "nothing before the first second is out");
  t.mock.timers.tick(1);
  assert.equal(hero.hitPoints, 871, "then nine, which is one percent of 880 rounded up");
  t.mock.timers.tick(3000);
  assert.equal(hero.hitPoints, 844);
  assert.ok(sent.length >= 4, "and the client is told each time");

  session.activeBuffs.delete(900);
  t.mock.timers.tick(5000);
  assert.equal(hero.hitPoints, 844, "it stops with the buff");
});

/**
 * Whether the official's gas can finish a hero is not something its recordings
 * settle — the one gassed hero was killed by a skeleton. Until one does, it
 * wears him down and leaves the killing to the monsters.
 */
test("the gas does not take the last point", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const gas = await buffForConstant("INFINITE_POISONOUS_GAS");
  const session = {
    id: 100,
    heroDoid: HERO,
    dungeonActive: true,
    objects: new Map([[HERO, CLID.HeroGameObject]]),
    actors: new Map([[HERO, { hitPoints: 12, maxHitPoints: 880, constant: "GHOST_SAMURAI" }]]),
    activeBuffs: new Map([[900, { affectedActor: HERO, buff: gas }]]),
    send: () => {},
  };
  startHealthDrain(session, { buffDoid: 900, victimDoid: HERO, buff: gas });

  t.mock.timers.tick(10_000);
  const hero = session.actors.get(HERO);
  assert.equal(hero.hitPoints, 1);
  assert.notEqual(hero.dead, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster, npcForConstant } from "../src/gamemaster.js";
import {
  infiniteDamageBonus,
  infiniteDepthBonus,
  npcMaxHitPoints,
  partyHealthMultiplier,
  partyStatMultiplier,
} from "../src/npc-stats.js";

/**
 * Every expectation here is a fixed reference value rather than one derived
 * from the formula it checks. BRUTE alone pins the shape: five levels, five exact hits, and a wrong
 * exponent or a missing `Stats.HP_BOOST.Bonus` breaks all but the first.
 */
test("an enemy's health matches the reference at that level", async () => {
  const gm = await loadGameMaster();
  const brute = await npcForConstant("BRUTE");

  for (const [level, expected] of [
    [1, 33],
    [3, 45],
    [43, 875],
    [45, 935],
    [53, 1187],
  ]) {
    assert.equal(npcMaxHitPoints(gm, brute, level, 1), expected, `level ${level}`);
  }
});

test("a row with no per-level boost is flat at every level", async () => {
  const gm = await loadGameMaster();
  // CASTLE_ARENA_SMASH_STATUE_LION is 60 at levels 1, 43, 45, 53 and 100.
  const statue = await npcForConstant("CASTLE_ARENA_SMASH_STATUE_LION");
  for (const level of [1, 43, 45, 53, 100]) {
    assert.equal(npcMaxHitPoints(gm, statue, level, 1), 60, `level ${level}`);
  }
});

test("indestructible scenery stays at zero rather than gaining a health bar", async () => {
  const gm = await loadGameMaster();
  const gargoyle = await npcForConstant("NORDIC_CAVE_GARGOYLE_EMITTER_C");
  // This prop has hitPoints 0 at every level.
  assert.equal(gargoyle.HP ?? 0, 0);
  for (const level of [5, 59, 61]) {
    assert.equal(npcMaxHitPoints(gm, gargoyle, level, 1), 0);
  }
});

/**
 * The level scale has an exception: an actor on team 5 scales linearly with its
 * level, and everybody else by the level to the power one and a half.
 *
 * Team 5 is the player team, and a pet is on it. WOLF_PET, DRAGON_PET,
 * RHINO_PET and GHOST_SAMURAI_CLONE are all priced linearly, and it is not a
 * near miss: a level 74 wolf reads 840 against 6465.
 */
test("a pet is priced by its level, not by the power of one and a half", async () => {
  const gm = await loadGameMaster();

  for (const [constant, level, expected] of [
    ["WOLF_PET", 74, 840],
    ["WOLF_PET", 75, 850],
    ["DRAGON_PET", 97, 802],
    ["DRAGON_PET", 100, 825],
    ["RHINO_PET", 100, 1100],
    ["GHOST_SAMURAI_CLONE", 100, 1100],
  ]) {
    const pet = await npcForConstant(constant);
    assert.equal(npcMaxHitPoints(gm, pet, level, 1), expected, `${constant} L${level}`);
  }
});

test("everything off the player team keeps the exponent", async () => {
  const gm = await loadGameMaster();
  // The same level that prices a wolf at 840 prices a brute by the exponent.
  const brute = await npcForConstant("BRUTE");
  assert.equal(npcMaxHitPoints(gm, brute, 43, 1), 875);
});

test("a solo run is unscaled by party size", async () => {
  const gm = await loadGameMaster();
  assert.equal(partyHealthMultiplier(gm, 1), 1);
});

test("party attack scaling keeps each authored damage type separate", async () => {
  const gm = await loadGameMaster();
  assert.equal(partyStatMultiplier(gm, 4, "MELEE_ATK"), 2.5);
  assert.equal(partyStatMultiplier(gm, 4, "SHOOT_ATK"), 1.75);
  assert.equal(partyStatMultiplier(gm, 4, "MAGIC_ATK"), 1.75);
  assert.equal(partyStatMultiplier(gm, 4, "MELEE_DEF"), 1);
});

/**
 * Props are priced by the party as well: a prison prop comes in at 1.8x its
 * authored health for a pair and 2.2x for a trio — the 2_PLAYER and 3_PLAYER
 * HP_BOOST, in the order the party grew. Every unlevelled actor lands on a
 * PlayerScale multiple of its authored health, one multiplier at a time.
 *
 * The rule this replaces said props keep their authored health in a party, and
 * it survived because the evidence for it was counted per floor rather than per
 * moment. A floor spans a join, so it holds two multipliers and matches neither.
 */
test("party health scales props and traps as well as enemies", async () => {
  const gm = await loadGameMaster();

  for (const constant of [
    "BRUTE",
    "CASTLE_PRISON_SMASH_KINGSTATUE",
    "MINE_PLACEABLE_ALL",
    "BURNING_FIRE_PLACEABLE",
  ]) {
    const npc = await npcForConstant(constant);
    assert.ok(
      npcMaxHitPoints(gm, npc, 21, 4) > npcMaxHitPoints(gm, npc, 21, 1),
      `${constant} should cost a party more than it costs one player`
    );
  }
});

test("a prison prop is priced by the party that walked in", async () => {
  const gm = await loadGameMaster();
  // Authored 80: 144 for a pair and 176 for a trio.
  const statue = await npcForConstant("CASTLE_PRISON_SMASH_KINGSTATUE");
  assert.equal(npcMaxHitPoints(gm, statue, 21, 1), 80);
  assert.equal(npcMaxHitPoints(gm, statue, 21, 2), 144);
  assert.equal(npcMaxHitPoints(gm, statue, 21, 3), 176);
});

test("an infinite run's monsters grow with the depth, not with the level", async () => {
  /**
   * Level stops at 100 and the infinite tiers all start there, so without this
   * the fifty-fifth floor of Infinite Castle held exactly the monsters of the
   * first. The depth is priced instead: BRUTE at level 100 arrives at
   *
   *   4980  6930  8879  10830  12780  14729  16680  18630  20580  22530
   *
   * and its level term is 3000 flat, so each is 30 + 3000 × (1 + 0.65n).
   */
  const gm = await loadGameMaster();
  const brute = await npcForConstant("BRUTE");
  const tier = gm.raw.ColiseumTiers.find((row) => row.Constant === "ARENA_INFINITE");
  const official = [4980, 6930, 8879, 10830, 12780, 14729, 16680, 18630, 20580, 22530];

  for (const [index, expected] of official.entries()) {
    const depth = index + 1;
    const got = npcMaxHitPoints(gm, brute, 100, 1, infiniteDepthBonus(gm, tier, depth));
    /**
     * Floors three and six read one point low, and the tolerance is not a
     * shrug: no formula of this shape can produce the series at all.
     *
     * A floored linear price `floor(A + B*d)` is pinned by consecutive
     * values. From 6930 and 8879 the step B lies in (1948, 1950); from
     * 8879 and 10830 it lies in (1950, 1952). The two intervals do not meet, so
     * depth does not enter linearly however the arithmetic is arranged.
     *
     * It was arranged every way worth trying — the level term built in four
     * orders, the growth as a double and as a float32, the bonus multiplied in
     * or accumulated a floor at a time, floor against round against truncate,
     * and the whole series shifted by up to three floors. Nothing reproduces
     * both this run and STATIONARY_KNIGHT's, which reads low on floors three
     * and seven where this one reads low on three and six.
     *
     * So what is left is unexplained rather than approximated, and it is worth
     * one health point in nine thousand.
     */
    assert.ok(
      Math.abs(got - expected) <= 1,
      `floor ${depth} of an infinite run: expected ${expected}, got ${got}`
    );
    if (depth !== 3 && depth !== 6) {
      assert.equal(got, expected, `floor ${depth} of an infinite run`);
    }
  }

  // Three more constants at the first floor's multiplier, each a different row.
  for (const [constant, expected] of [
    ["KNIGHT_BOXERS", 3320],
    ["RAPTOR", 6640],
    ["KNIGHT_THROWING_PRISON", 4150],
    ["BRUTE_DARK", 3320],
  ]) {
    const npc = await npcForConstant(constant);
    assert.equal(
      npcMaxHitPoints(gm, npc, 100, 1, infiniteDepthBonus(gm, tier, 1)),
      expected,
      constant
    );
  }
});

test("an ordinary run is untouched by the infinite growth", async () => {
  /**
   * The same BRUTE at 33, 45, 875, 935, 1187 and 2591 on
   * finite floors, which is the fit this server already had and must keep.
   */
  const gm = await loadGameMaster();
  const arena = gm.raw.ColiseumTiers.find((row) => row.Constant === "CASTLE_TIER1");
  assert.equal(infiniteDepthBonus(gm, arena, 40), 0, "a finite tier never grows");

  const brute = await npcForConstant("BRUTE");
  for (const [level, expected] of [[1, 33], [3, 45], [43, 875], [45, 935], [53, 1187], [90, 2591]]) {
    assert.equal(
      npcMaxHitPoints(gm, brute, level, 1, infiniteDepthBonus(gm, arena, 12)),
      expected,
      `level ${level}`
    );
  }
});

test("Infinite damage growth follows its own authored curve and ceiling", async () => {
  const gm = await loadGameMaster();
  const infinite = gm.raw.ColiseumTiers.find((row) => row.Constant === "ARENA_INFINITE");
  const finite = gm.raw.ColiseumTiers.find((row) => row.Constant === "CASTLE_TIER1");

  assert.equal(infiniteDamageBonus(gm, infinite, 1), 0.75);
  assert.equal(infiniteDamageBonus(gm, infinite, 10), 7.5);
  assert.equal(infiniteDamageBonus(gm, infinite, 10_000), 100, "DamageMax caps the growth");
  assert.equal(infiniteDamageBonus(gm, finite, 10), 0);
});

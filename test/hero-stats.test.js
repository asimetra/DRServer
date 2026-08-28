import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { statTotals, maxHitPoints, maxManaPoints, wireSlotPoints, STAT_NAMES } from "../src/hero-stats.js";

const GHOST_SAMURAI = 106;
const RANGER = 102;

/**
 * Replayed from a captured dungeon entry against the live official server: a
 * level-100 Ghost Samurai with [0, 75, 75, 50] placed arrived carrying 879 hit
 * points and 79 mana. Those are current values a tick below the maximum, which
 * this reproduces as 880 and 80 — 180 base health, 250 from the fifty points in
 * its health slot, 450 from LV_HP_BOOST over a hundred levels.
 */
test("reproduces the health the live server gave a maxed hero", async () => {
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(GHOST_SAMURAI);
  const avatar = {
    avatar_id: GHOST_SAMURAI,
    experience: 5249298,
    statupgrade1: 0,
    statupgrade2: 75,
    statupgrade3: 75,
    statupgrade4: 50,
  };

  assert.equal(maxHitPoints(gm, hero, avatar), 880);
  assert.equal(maxManaPoints(gm, hero, avatar), 80);
});

/**
 * The reason none of this may be written slot-by-slot: the health stat sits in
 * slot 3 for Berserker and Battle Chef, slot 4 for Vampire Hunter and Ghost
 * Samurai, and two heroes have no health stat at all. Any hard-coded slot would
 * be wrong for most of the roster.
 */
test("finds the health stat wherever the hero happens to keep it", async () => {
  const gm = await loadGameMaster();
  const slotsWithHealth = new Set();

  for (const hero of gm.heroById.values()) {
    const slot = [1, 2, 3, 4].find((index) => hero[`StatUpgrade${index}`] === "HP_BOOST");
    if (slot) slotsWithHealth.add(slot);

    const avatar = { experience: 9_999_999 };
    const bare = maxHitPoints(gm, hero, avatar);
    const trained = maxHitPoints(gm, hero, { ...avatar, [`statupgrade${slot ?? 1}`]: 10 });

    if (slot) {
      assert.equal(trained - bare, 50, `${hero.Constant}: ten points should be fifty health`);
    } else {
      assert.equal(trained, bare, `${hero.Constant} has no health stat and must gain none`);
    }
  }

  assert.ok(slotsWithHealth.size > 1, "the roster really does use different slots");
});

test("a hero with no health stat still grows with level", async () => {
  const gm = await loadGameMaster();
  const ranger = gm.heroById.get(RANGER);

  const early = maxHitPoints(gm, ranger, { experience: 0 });
  const late = maxHitPoints(gm, ranger, { experience: 9_999_999 });

  assert.ok(late > early, "levels alone add health");
  assert.equal(late - Number(ranger.HP), Math.round(Number(ranger.LV_HP_BOOST) * 10 * 100));
});

/**
 * A slot can name a SuperStats row instead of a plain stat, and then every
 * non-zero column of that row applies — one slot feeding several stats.
 */
test("a super-stat slot spreads across every stat it declares", async () => {
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(GHOST_SAMURAI); // slot 2 is SPIRIT_POWER
  assert.ok(!STAT_NAMES.includes(hero.StatUpgrade2), "slot 2 is not a plain stat");

  const bare = statTotals(gm, hero, { experience: 0 });
  const spread = statTotals(gm, hero, { experience: 0, statupgrade2: 75 });

  const moved = STAT_NAMES.filter((stat) => (spread.get(stat) ?? 0) !== (bare.get(stat) ?? 0));
  assert.ok(moved.length > 1, `one slot should move several stats, moved ${moved}`);
});

// The wire values are what the training screen reads back, so a row claiming
// more than the account earned must not travel.
test("stat points that were never earned do not reach the dungeon", async () => {
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(GHOST_SAMURAI);

  assert.deepEqual(
    wireSlotPoints(gm, hero, { experience: 0, statupgrade1: 75, statupgrade2: 75 }),
    [0, 0, 0, 0],
    "a level-1 hero cannot carry 150 points"
  );
  assert.deepEqual(
    wireSlotPoints(gm, hero, { experience: 9_999_999, statupgrade1: 75, statupgrade2: 75 }),
    [75, 75, 0, 0]
  );
});

/**
 * Legendary modifiers are the one part that GameMaster only describes in prose;
 * the arithmetic is hard-coded in the client, keyed by modifier id. Its own
 * Description column spells out the same numbers: "Increases player health by
 * 10 + Weapon Level * 0.9".
 */
test("STAMINA and APTITUDE follow the weapon's level, not the hero's", async () => {
  const { legendaryBonuses } = await import("../src/hero-stats.js");

  assert.deepEqual(legendaryBonuses([{ legendarymodifier: 1, requiredlevel: 100 }]), {
    health: 100,
    mana: 0,
    moveSpeed: 0,
  });
  assert.deepEqual(legendaryBonuses([{ legendarymodifier: 2, requiredlevel: 100 }]), {
    health: 0,
    mana: 50,
    moveSpeed: 0,
  });
  // Every weapon carrying one counts, and unhandled ids contribute nothing.
  assert.equal(
    legendaryBonuses([
      { legendarymodifier: 1, requiredlevel: 100 },
      { legendarymodifier: 1, requiredlevel: 0 },
      { legendarymodifier: 11, requiredlevel: 100 },
    ]).health,
    110
  );
});

/**
 * The wire carries the base; the client adds legendary bonuses itself, so
 * including them here would count them twice. Pinned to the same capture: the
 * hero carried an APTITUDE weapon worth 49 mana and still reported 79.
 */
test("legendary bonuses stay off the wire but count towards the real ceiling", async () => {
  const gm = await loadGameMaster();
  const { effectiveMaxManaPoints } = await import("../src/hero-stats.js");
  const hero = gm.heroById.get(GHOST_SAMURAI);
  const avatar = {
    experience: 5249298,
    statupgrade1: 0,
    statupgrade2: 75,
    statupgrade3: 75,
    statupgrade4: 50,
  };
  const weapons = [{ legendarymodifier: 2, requiredlevel: 98 }];

  assert.equal(maxManaPoints(gm, hero, avatar), 80, "what the capture shows on the wire");
  assert.equal(effectiveMaxManaPoints(gm, hero, avatar, weapons), 129, "what the bar reads");
});

import test from "node:test";
import assert from "node:assert/strict";

import { loadGameMaster } from "../src/gamemaster.js";
import { experienceForLevel, heroLevel, maxLevel } from "../src/progression.js";

/**
 * The Leveling table's per-hero column is the cost of *that* level, not the
 * total to reach it, and the difference is not academic: read as a threshold it
 * calls a level-30 hero level 100.
 *
 * The client settles it. `GameMaster.hx` walks the same table accumulating —
 *
 *     TotalExperience += levelValue;
 *     LoadingOnly_addExpRecord(levelId, TotalExperience - 1, TotalStats);
 *
 * — and files the running sum against the level, which is what `levelTable`
 * does here. This file exists because a second reading of the table once lived
 * in chests.js and quietly disagreed with this one for every hero below the cap.
 */

const HEROES = [101, 102, 103, 104, 105, 106];

/** The client's own loop, transcribed, as the thing to agree with. */
const clientLevelFor = (gm, hero, experience) => {
  let total = 0;
  let level = 1;
  for (const row of gm.raw.Leveling) {
    const cost = Number(row[hero.Constant] ?? 0);
    if (!cost) continue;
    total += cost;
    // getLevelIndex takes the first record whose stored experience is not below
    // the amount held, and the record stores TotalExperience - 1.
    if (total - 1 >= experience) return Number(row.Level);
    level = Number(row.Level);
  }
  return level;
};

test("hero levels agree with the client's own accumulation, hero by hero", async () => {
  const gm = await loadGameMaster();

  for (const heroId of HEROES) {
    const hero = gm.heroById.get(heroId);
    for (const experience of [0, 1, 330, 1510, 8810, 26860, 115210, 640910, 874210, 5_000_000]) {
      assert.equal(
        heroLevel(gm, hero, experience),
        clientLevelFor(gm, hero, experience),
        `${hero.Constant} at ${experience} experience`
      );
    }
  }
});

test("the experience for a level reads back as that level", async () => {
  const gm = await loadGameMaster();

  for (const heroId of HEROES) {
    const hero = gm.heroById.get(heroId);
    for (let level = 1; level <= maxLevel(gm, hero); level++) {
      assert.equal(
        heroLevel(gm, hero, experienceForLevel(gm, hero, level)),
        level,
        `${hero.Constant} level ${level}`
      );
    }
  }
});

/**
 * A hero cannot pass the last row of its own ladder, which is what makes an
 * award rolled above it unequippable rather than merely rare.
 */
test("no amount of experience reads as a level the table does not have", async () => {
  const gm = await loadGameMaster();

  for (const heroId of HEROES) {
    const hero = gm.heroById.get(heroId);
    const cap = maxLevel(gm, hero);
    assert.equal(cap, 100, `${hero.Constant} caps at 100`);
    assert.equal(heroLevel(gm, hero, Number.MAX_SAFE_INTEGER), cap);
  }
});

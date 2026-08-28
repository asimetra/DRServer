import test from "node:test";
import assert from "node:assert/strict";

import { damageReductionFor } from "../src/socket/buffs.js";
import { buffForConstant } from "../src/gamemaster.js";

const wearing = async (...constants) => {
  const activeBuffs = new Map();
  for (const [index, constant] of constants.entries()) {
    activeBuffs.set(index, { affectedActor: 500, buff: await buffForConstant(constant) });
  }
  return { activeBuffs };
};

/**
 * The three `*_DEF` columns were read as multipliers on the defender's defence
 * stat, which made the whole family inert: a fully trained Berserker's
 * `MELEE_DEF` stat is 0.2, defence is subtracted flat, and multiplying 0.2 by
 * anything is still nothing. Against a 400 damage swing the measurements were
 * 400 with no buff, 400 with `DEFENDER_L1`, 400 with `DEFENDER_L2`, and 375
 * with the Berserker's own Dungeon Buster — six per cent, for the ultimate
 * meant to make him a tank.
 */
test("a defence buff takes a share of the hit", async () => {
  const close = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);

  close(damageReductionFor(await wearing("DEFENDER_L1"), 500, "MELEE_DEF"), 0.25, "DEFENDER_L1");
  close(damageReductionFor(await wearing("DEFENDER_L2"), 500, "MELEE_DEF"), 0.5, "DEFENDER_L2");
  close(
    damageReductionFor(await wearing("CONSUMABLE_DEFENSE_BUFF"), 500, "SHOOT_DEF"),
    0.1,
    "the potion"
  );
});

/**
 * Stacked multiplicatively, so two sources leave a remainder rather than adding
 * to a total. Nothing reaches all of it by accumulation — only a source that is
 * itself all of it.
 */
test("stacked reductions leave a remainder", async () => {
  const both = await wearing("DEFENDER_L2", "FRENZY");
  const reduction = damageReductionFor(both, 500, "MELEE_DEF");
  assert.ok(Math.abs(reduction - 0.65) < 1e-9, `0.5 and 0.3 make 0.65, got ${reduction}`);
  assert.ok(reduction < 1, "and never all of it");

  const everything = await wearing("DEFENDER_L2", "FRENZY", "DEFENDER_L1", "CONSUMABLE_DEFENSE_BUFF");
  assert.ok(damageReductionFor(everything, 500, "MELEE_DEF") < 0.9, "not even all four");
});

/**
 * The only total reduction in the game is the Berserker's own Dungeon Buster,
 * on himself, for twelve seconds. No item can be one: none of the 162 modifier
 * rows across `Modifiers`, `LegendaryModifiers` and `DungeonModifier` carries a
 * defence field at all.
 */
test("only the Berserker's own ultimate is all of it", async () => {
  const ult = await wearing("BERSERK_DB");
  for (const type of ["MELEE_DEF", "SHOOT_DEF", "MAGIC_DEF"]) {
    assert.equal(damageReductionFor(ult, 500, type), 1, `${type} entirely`);
  }

  // What the party gets from him is attack and movement, and no defence at all.
  const party = await wearing("BERSERK");
  for (const type of ["MELEE_DEF", "SHOOT_DEF", "MAGIC_DEF"]) {
    assert.equal(damageReductionFor(party, 500, type), 0, `${type} untouched`);
  }
});

/** And it is per type, which is what keeps a tank from being a god. */
test("reduction is read per damage type", async () => {
  const frost = await wearing("FROST_DRAGON_BUFF");
  // A negative authored value is not a reduction; it does not turn into one.
  assert.equal(damageReductionFor(frost, 500, "MELEE_DEF"), 0);

  const nobody = { activeBuffs: new Map() };
  assert.equal(damageReductionFor(nobody, 500, "MELEE_DEF"), 0);
  assert.equal(damageReductionFor(undefined, 500, "MELEE_DEF"), 0);
});

/**
 * The trained half, which is one hero's alone.
 *
 * `MASTER_DEFENSE` is the Berserker's fourth slot and gives 0.0033 a point
 * across all three types, so every point in it reaches 24.75%. No other hero
 * authors it, so a Ranger with all seventy-five there measures zero — the
 * tankiness is trained for and it does not transfer.
 *
 * The stat was read as a flat subtraction, which at 0.2475 against a 400 hit is
 * nothing at all.
 */
test("only the Berserker trains into turning damage aside", async () => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const { statTotals } = await import("../src/hero-stats.js");
  const gm = await loadGameMaster();

  const trained = (hero, points) =>
    statTotals(gm, gm.raw.Hero.find((row) => row.Constant === hero), {
      experience: 5_000_000,
      statupgrade4: points,
    }).get("MELEE_DEF") ?? 0;

  assert.ok(Math.abs(trained("BERSERKER", 75) - 0.2475) < 1e-6, "a quarter, fully trained");
  assert.ok(Math.abs(trained("BERSERKER", 25) - 0.0825) < 1e-6, "and it earns in evenly");
  assert.equal(trained("BERSERKER", 0), 0, "untrained is untrained");

  for (const hero of ["RANGER", "SORCERER", "BATTLE_CHEF", "VAMPIRE_HUNTER", "GHOST_SAMURAI"]) {
    assert.equal(trained(hero, 75), 0, `${hero} cannot train into it`);
  }
});

/**
 * Training and buffs leave a remainder rather than adding to a total, so the
 * only route to all of it stays the one buff that is all of it.
 */
test("trained and buffed reduction compose without reaching everything", async () => {
  const combine = (trained, buffed) => 1 - (1 - trained) * (1 - buffed);

  const berserker = 0.2475;
  assert.ok(Math.abs(combine(berserker, 0.5) - 0.62375) < 1e-6, "a quarter and a half make 62%");
  assert.ok(combine(berserker, 0.65) < 1, "and four sources still leave a remainder");
  assert.equal(combine(berserker, 1), 1, "while the ultimate is all of it");

  // Even at the ceiling training is bounded well short on its own.
  assert.ok(combine(0.5, 0) < 1, "no amount of levelling arrives at untouchable");
});

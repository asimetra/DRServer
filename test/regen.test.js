import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster } from "../src/gamemaster.js";
import { manaRegenFor, startManaRegen } from "../src/socket/regen.js";

test("the authored regen is the hero's own, and training feeds three of them", async () => {
  const gm = await loadGameMaster();
  const hero = (constant) => gm.raw.Hero.find((row) => row.Constant === constant);

  // No level growth anywhere: LV_MP_REGEN is zero on all six, so this is the
  // whole of it — a base and whatever the slot has been fed.
  assert.equal(manaRegenFor(hero("BERSERKER"), {}), 3, "a berserker's flat three");
  assert.equal(manaRegenFor(hero("SORCERER"), {}), 6, "a sorcerer starts higher");

  // The Sorcerer trains it on slot 2 at a fifth of a point each.
  assert.equal(manaRegenFor(hero("SORCERER"), { statupgrade2: 75 }), 21, "and can reach 21");
  assert.equal(
    manaRegenFor(hero("BERSERKER"), { statupgrade2: 75 }),
    3,
    "while a hero without the slot gains nothing from the same points"
  );
});

/**
 * The period, which is the half that was wrong.
 *
 * It is authored nowhere and was guessed at a second, so the bar refilled five
 * times faster than the game's — a spell's cost was back before its animation
 * finished. Field 163 across 49 official captures says otherwise: 409
 * unprompted rises, median gap 4.999s, p75 5.008s, and every amount is one
 * hero's own MP_REGEN.
 *
 * Driven by mock timers rather than by sleeping, so the assertion is the period
 * itself — nothing at 4.9 seconds, exactly one hero's worth at 5.
 */
test("mana arrives on the game's clock, not a second's", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const session = {
    id: 80,
    heroDoid: 500,
    dungeonActive: true,
    heroManaPoints: 0,
    maxHeroManaPoints: 200,
    dungeonAvatar: { avatar_id: 101 }, // a Berserker, flat three
    actors: new Map([[500, { hitPoints: 400, maxHitPoints: 400 }]]),
    send: () => {},
  };

  const stop = await startManaRegen(session);

  t.mock.timers.tick(4900);
  assert.equal(session.heroManaPoints, 0, "nothing has arrived a tenth of a second early");

  t.mock.timers.tick(100);
  assert.equal(session.heroManaPoints, 3, "and one hero's worth lands on the five");

  t.mock.timers.tick(5000);
  assert.equal(session.heroManaPoints, 6, "once per period, not once per second");

  stop();
});

test("a fractional trained rate is carried between ticks rather than rounded away", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const session = {
    id: 81,
    heroDoid: 500,
    dungeonActive: true,
    heroManaPoints: 0,
    maxHeroManaPoints: 500,
    // One point into the slot: 6.2 a tick, which truncation would make 6.
    dungeonAvatar: { avatar_id: 103, statupgrade2: 1 },
    actors: new Map([[500, { hitPoints: 400, maxHitPoints: 400 }]]),
    send: () => {},
  };

  const stop = await startManaRegen(session);
  t.mock.timers.tick(5000 * 5);

  assert.equal(session.heroManaPoints, 31, "5 x 6.2 arrives whole, not as 5 x 6");
  stop();
});

test("mana comes back on its own, and stops when the hero is down", async () => {
  const session = {
    id: 80,
    heroDoid: 500,
    dungeonActive: true,
    heroManaPoints: 0,
    maxHeroManaPoints: 200,
    dungeonAvatar: { avatar_id: 103, statupgrade2: 75 }, // a trained Sorcerer
    actors: new Map([[500, { hitPoints: 400, maxHitPoints: 400 }]]),
    send: () => {},
  };

  const stop = await startManaRegen(session);
  await new Promise((resolve) => setTimeout(resolve, 5400));
  const regained = session.heroManaPoints;
  assert.ok(regained > 0, "the bar refills without a potion");

  // A hero on the floor regenerates nothing.
  session.actors.get(500).dead = true;
  await new Promise((resolve) => setTimeout(resolve, 5400));
  assert.equal(session.heroManaPoints, regained, "and not while down");
  stop();
});

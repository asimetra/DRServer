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
  await new Promise((resolve) => setTimeout(resolve, 2400));
  const regained = session.heroManaPoints;
  assert.ok(regained > 0, "the bar refills without a potion");

  // A hero on the floor regenerates nothing.
  session.actors.get(500).dead = true;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(session.heroManaPoints, regained, "and not while down");
  stop();
});

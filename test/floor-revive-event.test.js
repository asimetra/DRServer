import assert from "node:assert/strict";
import test from "node:test";

import { installModeHooks } from "../src/modes/hooks.js";
import { buildPartyHeroes } from "../src/socket/dungeon.js";

/** One player on their own, down when the floor ended. */
const soloRun = ({ down }) => {
  const actors = new Map([[20, { hitPoints: 0, maxHitPoints: 100, dead: down }]]);
  const session = {
    id: "solo",
    accountId: 7,
    heroDoid: 20,
    playerDoid: 21,
    actors,
    objects: new Map(),
    heroSpawn: { hitPoints: 100, effectiveHitPoints: 100, manaPoints: 50, collisionRadius: 26, constant: "BERSERKER", heroType: 101, skinType: 151, playerId: 7, screenName: "P" },
    send: () => {},
  };
  return session;
};

const heard = (t) => {
  const events = [];
  t.after(installModeHooks("listener", { combatEvent: (session, event) => events.push(event) }));
  return events;
};

test("a hero down when the floor ended stands on the next, and a mode hears it as a revive", async (t) => {
  const events = heard(t);
  await buildPartyHeroes(soloRun({ down: true }), { spawn: { x: 0, y: 0 } }, 0);
  assert.deepEqual(events, [{ type: "revived", hero: 20, by: "floor" }]);
});

test("a hero who was standing is not revived by a new floor", async (t) => {
  const events = heard(t);
  await buildPartyHeroes(soloRun({ down: false }), { spawn: { x: 0, y: 0 } }, 0);
  assert.deepEqual(events, []);
});

test("as the real floor's end leaves it: actors cleared, the down noted first, and the revive still heard", async (t) => {
  const events = heard(t);
  const run = soloRun({ down: false });
  run.actors.clear();
  run.downAtFloorEnd = new Set([20]);
  await buildPartyHeroes(run, { spawn: { x: 0, y: 0 } }, 0);
  assert.deepEqual(events, [{ type: "revived", hero: 20, by: "floor" }]);
  assert.equal(run.downAtFloorEnd, null, "said once; the next floor's end notes its own");
});

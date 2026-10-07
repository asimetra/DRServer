import assert from "node:assert/strict";
import test from "node:test";

import { plannedModifiers } from "../src/infinite.js";
import { plannedNpcLevel, plannedTier } from "../src/socket/floors.js";

const gm = { raw: { DungeonModifier: [{ Id: 3, Constant: "FAST" }, { Id: 7, Constant: "TOUGH" }] } };

test("a floor plan's modifiers become the rows an Infinite floor would have", () => {
  assert.deepEqual(plannedModifiers(gm, [3, 7]), [
    { Id: 3, Constant: "FAST", newThisFloor: 1 },
    { Id: 7, Constant: "TOUGH", newThisFloor: 1 },
  ]);
});

test("new is new since the floor before", () => {
  const before = plannedModifiers(gm, [3]);
  assert.deepEqual(plannedModifiers(gm, [3, 7], before).map((row) => [row.Id, row.newThisFloor]), [[3, 0], [7, 1]]);
});

test("an id the game data lacks is dropped and said, never sent", () => {
  const said = [];
  assert.deepEqual(plannedModifiers(gm, [99, 3], [], (line) => said.push(line)).map((row) => row.Id), [3]);
  assert.equal(said.length, 1);
  assert.match(said[0], /99/);
});

test("named twice is active once", () => {
  assert.deepEqual(plannedModifiers(gm, [3, 3, "3"]).map((row) => row.Id), [3]);
});

test("the NPC level and tier: the floor's, else the run's", () => {
  const run = (floorIndex, floors, plan = {}) => ({ floorIndex, floorPlan: { floors, ...plan } });
  const plan = { npcLevel: 20, tier: { Constant: "RUN" } };
  const floors = [{ authored: "a" }, { authored: "b", npcLevel: 60, tier: { Constant: "DEEP" } }];
  assert.equal(plannedNpcLevel(run(0, floors, plan)), 20);
  assert.equal(plannedNpcLevel(run(1, floors, plan)), 60);
  assert.equal(plannedTier(run(0, floors, plan)).Constant, "RUN");
  assert.equal(plannedTier(run(1, floors, plan)).Constant, "DEEP");
});

test("an NPC level that is not a number is 1, never NaN; and never under 1", () => {
  const at = (npcLevel) => plannedNpcLevel({ floorIndex: 0, floorPlan: { floors: [{ authored: "a", npcLevel }] } });
  assert.equal(at("abc"), 1);
  assert.equal(at(-5), 1);
  assert.equal(at(42.7), 42);
  assert.equal(plannedNpcLevel(null), 1, "no run");
  assert.equal(plannedNpcLevel({ floorPlan: {} }), 1, "no level anywhere");
});

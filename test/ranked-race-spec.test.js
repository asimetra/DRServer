import assert from "node:assert/strict";
import test from "node:test";

import { createSpec, fixedPicker, nodePool, randomPicker } from "../src/modes/ranked/race-spec.js";

const pages = [
  { Id: 50001, Constant: "TUTORIAL", NodeType: "DUNGEON" },
  { Id: 50003, Constant: "ARENA_1", NodeType: "DUNGEON" },
  { Id: 50005, Constant: "ARENA_BOSS", NodeType: "BOSS" },
  { Id: 50006, Constant: "ICE_CAVES_1", NodeType: "DUNGEON" },
  { Id: 50150, Constant: "INFINITE_ARENA", NodeType: "INFINITE" },
  { Id: 50200, Constant: "RANKED_LOBBY", NodeType: "HUB" },
  { Id: 50300, Constant: "SOMETHING", NodeType: "TAVERN" },
];

test("the pool is every normal dungeon: no trophy boss, no tutorial, hubs or Ultimate", () => {
  assert.deepEqual(nodePool(pages).map((node) => node.Id), [50003, 50006]);
});

test("an operator who wants the trophy bosses in the draw names them", () => {
  assert.deepEqual(nodePool(pages, { nodeTypes: ["DUNGEON", "BOSS"] }).map((node) => node.Id), [50003, 50005, 50006]);
});

test("an operator can narrow the pool by type and leave nodes out by id or constant", () => {
  assert.deepEqual(nodePool(pages, { nodeTypes: ["DUNGEON"] }).map((node) => node.Id), [50003, 50006]);
  assert.deepEqual(nodePool(pages, { exclude: [50003, "ARENA_BOSS"] }).map((node) => node.Id), [50006]);
});

test("the random picker draws a node from the pool and a fresh seed, with the race's rules", () => {
  const rolls = [0.99, 0.5];
  const pick = randomPicker({
    pool: nodePool(pages),
    random: () => rolls.shift(),
    rules: { maxDurationMs: 1 },
  });
  const spec = pick();
  assert.equal(spec.mapNodeId, 50006);
  assert.ok(Number.isInteger(spec.seed) && spec.seed > 0 && spec.seed <= 0x7fffffff);
  assert.deepEqual(spec.rules, { maxDurationMs: 1 });
  assert.ok(Object.isFrozen(spec));
});

test("an empty pool is a configuration mistake, said when the picker is made", () => {
  assert.throws(() => randomPicker({ pool: [] }), /no dungeon to draw/);
});

test("a fixed picker races the same spec every time — the shape a set seed takes", () => {
  const pick = fixedPicker(createSpec({ mapNodeId: 50006, seed: 1234, rules: {} }));
  assert.deepEqual(pick(), pick());
  assert.equal(pick().seed, 1234);
});

test("a spec needs a node and a positive seed", () => {
  assert.throws(() => createSpec({ seed: 1 }), /node/);
  assert.throws(() => createSpec({ mapNodeId: 50006, seed: 0 }), /seed/);
});

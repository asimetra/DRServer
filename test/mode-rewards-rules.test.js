import assert from "node:assert/strict";
import test from "node:test";

import { installModeHooks } from "../src/modes/hooks.js";
import { runRules } from "../src/socket/run-rules.js";
import { awardTreasureChest } from "../src/socket/rewards.js";
import { noteFloorEnemy, stealLife } from "../src/socket/life-steal.js";
import { beginFloorFailing, clearFloorFailing } from "../src/socket/floorstate.js";
import { CLID } from "../src/socket/opcodes.js";

/** A run under `rules`, its floor plan saying `floor`. */
const runUnder = (t, rules, floor = {}) => {
  const uninstall = installModeHooks("rules-test", { runRules: (session) => (session.modeEntry === "rules-test" ? runRules({ mode: "rules-test", ...rules }) : null) });
  t.after(uninstall);
  return {
    id: "s",
    modeEntry: "rules-test",
    floorIndex: 0,
    floorPlan: { floors: [{ authored: "a.json", ...floor }] },
    dungeonAccount: { id: 7, account_chests: [] },
    dungeonTreasures: [],
    sent: [],
    send(frame) {
      this.sent.push(frame);
    },
  };
};

test("a floor's chestMost holds a better chest down to it; item boxes are not a rarity", async (t) => {
  const run = runUnder(t, {}, { chestMost: 2 });
  assert.equal(await awardTreasureChest(run, 30103), 60002, "a legendary held to uncommon");
  assert.equal(await awardTreasureChest(run, 30100), 60001, "a common stays common");
  assert.equal(await awardTreasureChest(run, 30104), 60005, "an item box stays an item box");
  assert.deepEqual(run.dungeonTreasures.map((t) => t.chestId), [60002, 60001, 60005], "owed on the report, as the game keeps them");
});

test("chestsKept pickup: the chest is on the account as it is picked up, owing nothing on the report", async (t) => {
  const run = runUnder(t, { chestsKept: "pickup" });
  assert.equal(await awardTreasureChest(run, 30101), 60002);
  assert.deepEqual(run.dungeonAccount.account_chests.map((c) => c.chest_id), [60002]);
  assert.deepEqual(run.dungeonTreasures, [], "nothing left for the report to offer again");
});

test("the floor's toughest heal a share of what they deal to a hero; the rest do not", (t) => {
  const run = { npcLifeSteal: 0.25, objects: new Map([[50, CLID.DistributedNPCGameObject], [51, CLID.DistributedNPCGameObject]]), actors: new Map(), sent: [], send(f) { this.sent.push(f); } };
  run.actors.set(50, { hitPoints: 500, maxHitPoints: 1000, isEnemy: true });
  run.actors.set(51, { hitPoints: 50, maxHitPoints: 100, isEnemy: true });
  noteFloorEnemy(run, 1000);
  noteFloorEnemy(run, 100);
  assert.equal(stealLife(run, 50, 40), 10, "the boss heals a quarter of the 40 it dealt");
  assert.equal(run.actors.get(50).hitPoints, 510);
  assert.equal(stealLife(run, 51, 40), 0, "an add is not the floor's toughest");
  run.actors.get(50).hitPoints = 999;
  assert.equal(stealLife(run, 50, 400), 1, "never past its most");
  run.npcLifeSteal = 0;
  assert.equal(stealLife(run, 50, 40), 0, "a floor that does not steal heals nobody");
});

test("defeatCountdownSeconds: the client counts down from the mode's number", (t) => {
  const run = runUnder(t, { defeatCountdownSeconds: 12 });
  Object.assign(run, { areaDoid: 9, heroDoid: 20, actors: new Map([[20, { dead: true, hitPoints: 0 }]]), playerActors: new Set([20]) });
  beginFloorFailing(run);
  t.after(() => clearFloorFailing(run));
  const frame = run.sent.at(-1);
  assert.ok(frame, "the countdown was sent");
  assert.equal(frame.readUInt16LE(frame.length - 2), 12);
});

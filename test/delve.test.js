import assert from "node:assert/strict";
import test from "node:test";

import {
  DELVE_DEFAULTS,
  DELVE_MODE,
  DELVE_RUN_RULES,
  bossesFromGameData,
  createDelve,
  difficultyAt,
  giftFor,
} from "../examples/modes/delve/index.js";
import { createModeRecords } from "../src/modes/records.js";

const boss = (id, maps = 1) => ({
  node: { Id: id, Name: `Boss ${id}` },
  floors: Array.from({ length: maps }, (_, i) => ({ authored: `boss${id}_${i}.json` })),
  tier: { Constant: `TIER_${id}` },
});

/** The controls a delve speaks through, as plain records of what it asked. */
const fakeControls = () => {
  const said = [];
  const gifts = [];
  return {
    said,
    gifts,
    say: (session, text) => said.push([session.accountId, text]),
    gift: async (session, offerId, { from }) => gifts.push([session.accountId, offerId, from]),
    party: (session) => session.party ?? [session],
    planAhead: (session, floors) => {
      session.floorPlan.floors = [...session.floorPlan.floors, ...floors];
      session.floorCount = session.floorPlan.floors.length;
      return () => {};
    },
  };
};

const setup = ({ bosses = [boss(1), boss(2, 2), boss(3)], random = () => 0, records = null } = {}) => {
  const controls = fakeControls();
  const delve = createDelve({ bosses, modifierIds: [101, 102, 103], tileLibraries: ["t.json"], controls, random, records, clock: () => 5 });
  /** /delve, then an entry, through to standing on the first boss. */
  const enter = async (accountId = 7) => {
    delve.toggle(accountId);
    const request = delve.hooks.routeEntry({ accountId }, { mapNodeId: 50004, friendId: 0, mapId: 0 });
    const session = { accountId, modeEntry: request.mode, floorIndex: 0 };
    session.floorPlan = await delve.hooks.planFor(session, request.mapNodeId);
    session.floorCount = session.floorPlan.floors.length;
    delve.hooks.heroRequested(session);
    return { request, session };
  };
  /** The floor in hand ends, as the core's completeFloor would end it. */
  const clear = (session) => {
    assert.equal(delve.hooks.floorCompleting(session), true, "a delve never holds a floor");
    session.floorIndex += 1;
    delve.hooks.heroRequested(session);
  };
  return { delve, controls, enter, clear };
};

test("/delve makes the player's own next entry a delve, at the one node strangers are matched by", async () => {
  const { delve, enter } = setup();
  const { request, session } = await enter();
  assert.equal(request.mode, DELVE_MODE);
  assert.equal(request.mapNodeId, delve.entryNode);
  assert.equal(request.friendOnly, 0, "public: anybody delving may be matched in");
  assert.equal(delve.armed(7), false, "one entry");
  assert.equal(session.floorPlan.floors[0].node.Id, 1, "the first floor is a boss's own map");
  assert.deepEqual(session.floorPlan.preloadTileLibraries, ["t.json"]);
});

test("joining somebody keeps the arming; nobody unarmed is touched", () => {
  const { delve } = setup();
  delve.toggle(7);
  const join = { mapNodeId: 0, friendId: 8 };
  assert.equal(delve.hooks.routeEntry({ accountId: 7 }, join), join);
  assert.equal(delve.armed(7), true);
  const plain = { mapNodeId: 50004 };
  assert.equal(delve.hooks.routeEntry({ accountId: 9 }, plain), plain);
});

test("each boss beaten puts the next on the plan, never the same twice running, and harder", async () => {
  const { enter, clear } = setup();
  const { session } = await enter();
  const bossOf = (index) => session.floorPlan.floors[index].node.Id;
  clear(session);
  assert.equal(session.floorPlan.floors.length > 1, true, "the next boss came before the core asked whether this was the last");
  assert.notEqual(bossOf(1), bossOf(0), "not the same boss twice running");
  const first = session.floorPlan.floors[0];
  const second = session.floorPlan.floors[1];
  assert.ok(second.npcLevel > first.npcLevel);
  assert.ok(second.healthBonus > first.healthBonus && second.damageBonus > first.damageBonus && second.attackSpeedBonus > first.attackSpeedBonus);
  assert.equal(second.tier.Constant, `TIER_${second.node.Id}`, "the boss's own tier");
});

test("a two-map boss is one boss: the next is drawn after its last map, and it is announced once", async () => {
  // Draws boss 1 first, then boss 2 (two maps): the first of the two not just fought.
  const draws = [0, 0];
  const { enter, clear, controls } = setup({ random: () => draws.shift() ?? 0 });
  const { session } = await enter();
  clear(session); // boss 1 beaten: boss 2's two maps go on
  const lengthWithTwoMaps = session.floorPlan.floors.length;
  assert.equal(session.floorPlan.floors[1].node.Id, 2);
  assert.equal(session.floorPlan.floors[2].node.Id, 2);
  clear(session); // boss 2's first map: no new boss yet
  assert.equal(session.floorPlan.floors.length, lengthWithTwoMaps);
  clear(session); // boss 2's last map: the next boss
  assert.ok(session.floorPlan.floors.length > lengthWithTwoMaps);
  const announcements = controls.said.filter(([, text]) => /boss 2/.test(text));
  assert.equal(announcements.length, 1, "boss 2 announced once, not per map");
});

test("a modifier joins every few bosses and stays; a gift waits every few bosses, better the deeper", async () => {
  const { enter, clear, controls } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter();
  session.party = [session, { accountId: 8 }];
  for (let i = 0; i < 6; i++) clear(session);
  const atDepth = (depth) => session.floorPlan.floors[depth - 1];
  assert.deepEqual(atDepth(1).modifiers, []);
  assert.equal(atDepth(4).modifiers.length, 1, "one more on the fourth boss (every third after the first)");
  assert.equal(atDepth(7).modifiers.length, 2);
  assert.ok(atDepth(7).modifiers.includes(atDepth(4).modifiers[0]), "and the earlier one stays");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controls.gifts, [
    [7, 51201, 0], [8, 51201, 0],
    [7, 51205, 0], [8, 51205, 0],
  ], "after the 3rd and the 6th boss, to everybody there, from nobody's account");
});

test("how deep each player went is kept once a run, on falling or on walking out", async () => {
  const records = createModeRecords({ mode: DELVE_MODE, storage: "memory" });
  // One-map bosses: each floor cleared is a boss beaten.
  const { delve, enter, clear } = setup({ records, bosses: [boss(1), boss(3)] });
  const { session } = await enter(7);
  clear(session);
  clear(session);
  delve.hooks.runFailed(session);
  // A leave after the fall, arriving raw — no plan to read — is not a second record.
  delve.hooks.runLeft({ accountId: 7, modeEntry: DELVE_MODE });
  await new Promise((resolve) => setImmediate(resolve));
  const kept = await records.all();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].beaten, 2);
  assert.deepEqual(kept[0].accounts, [7]);

  const other = await enter(9);
  clear(other.session);
  delve.hooks.runLeft({ accountId: 9 }); // raw: only the account
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await records.forAccount(9)).map((r) => r.beaten), [1], "walking out keeps it too, found by account");
});

test("its rules: anybody may join, no trophy, keys or gems, nothing marked", () => {
  assert.equal(DELVE_RUN_RULES.joinable, true);
  assert.equal(DELVE_RUN_RULES.unlockCheck, false);
  assert.deepEqual([DELVE_RUN_RULES.pays.keys, DELVE_RUN_RULES.pays.trophies, DELVE_RUN_RULES.pays.gems], [false, false, false]);
  assert.equal(DELVE_RUN_RULES.pays.gold, true);
  assert.equal(DELVE_RUN_RULES.mapCredit, false);
});

test("difficulty and gifts by the numbers", () => {
  assert.deepEqual(difficultyAt(1), { npcLevel: 10, healthBonus: 0, damageBonus: 0, attackSpeedBonus: 0 });
  assert.equal(difficultyAt(3).npcLevel, 22);
  assert.equal(giftFor(2), null);
  assert.equal(giftFor(3).offerId, 51201);
  assert.equal(giftFor(12).offerId, 51213);
  assert.equal(giftFor(15).offerId, 51213, "past the last step, the best");
});

test("from the game data: every boss but the tutorial's and the village defence, boss maps only", async () => {
  const { bosses, tileLibraries, modifierIds } = await bossesFromGameData();
  const constants = bosses.map((b) => b.node.Constant);
  assert.ok(!constants.includes("TUTORIAL") && !constants.includes("NORDIC_VILLAGE_BOSS"));
  assert.equal(bosses.length, 10);
  assert.ok(bosses.every((b) => b.floors.length >= 1 && b.floors.every((floor) => floor.authored)), "authored maps only");
  assert.ok(tileLibraries.length > 0);
  assert.equal(modifierIds.length, DELVE_DEFAULTS.modifiers.length, "every default modifier is in the game data");
});

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
  itemFor,
} from "../src/modes/delve/index.js";
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
  const weapons = [];
  return {
    said,
    gifts,
    weapons,
    weapon: async (session, item) => {
      weapons.push([session.accountId, item]);
      return session.pileFull ? null : { weapon: { requiredlevel: item.level } };
    },
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
  const presence = [];
  // As the seat channel would carry it, without workers: every count heard at once, from the seat.
  let delve = null;
  delve = createDelve({
    bosses, modifierIds: [101, 102, 103], tileLibraries: ["t.json"], controls, random, records, clock: () => 5,
    tellInside: (inside) => delve.heardInside(0, inside),
    tellPresence: (session, id, where) => presence.push([session.accountId, id, where]),
  });
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
  return { delve, controls, enter, clear, presence };
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
  const { enter, clear, controls, delve } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter();
  // A second player, there from the first boss.
  const friend = { accountId: 8, modeEntry: DELVE_MODE, floorIndex: 0, floorPlan: session.floorPlan, floorCount: session.floorCount };
  delve.hooks.heroRequested(friend);
  session.party = [session, friend];
  for (let i = 0; i < 6; i++) clear(session);
  const atDepth = (depth) => session.floorPlan.floors[depth - 1];
  assert.deepEqual(atDepth(1).modifiers, []);
  assert.equal(atDepth(4).modifiers.length, 1, "one more on the fourth boss (every third after the first)");
  assert.equal(atDepth(7).modifiers.length, 2);
  assert.ok(atDepth(7).modifiers.includes(atDepth(4).modifiers[0]), "and the earlier one stays");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controls.gifts, [
    [7, 51306, 0], [8, 51306, 0],
    [7, 51369, 0], [8, 51369, 0],
  ], "after the 3rd and the 6th boss, to everybody there, from nobody's account");
});

test("the tenth boss may drop a weapon gift for whoever fought for it", async () => {
  const { enter, clear, controls, delve } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter();
  const full = { accountId: 8, modeEntry: DELVE_MODE, floorIndex: 0, floorPlan: session.floorPlan, floorCount: session.floorCount, pileFull: true };
  delve.hooks.heroRequested(full);
  session.party = [session, full];
  for (let i = 0; i < 9; i++) clear(session);
  // A friend arriving for the tenth boss rolls too: they fought it.
  const late = { ...full, accountId: 9, pileFull: false, floorIndex: session.floorIndex };
  delve.hooks.heroRequested(late);
  session.party = [session, full, late];
  clear(session);
  await new Promise((resolve) => setImmediate(resolve));
  const asked = { rarity: "UNCOMMON", level: 64, from: 0 };
  assert.deepEqual(controls.weapons, [[7, asked], [8, asked], [9, asked]], "from nobody's account, as the gifts");
  assert.ok(controls.said.some(([id, text]) => id === 7 && /dropped a uncommon weapon, level 64 - it waits in town/.test(text)));
  assert.ok(!controls.said.some(([id, text]) => id === 8 && /weapon/.test(text)), "no gift given, nothing said of one");
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

test("its rules: anybody may join, strangers early on; no trophy, keys or gems, nothing marked", () => {
  assert.equal(DELVE_RUN_RULES.joinable, true);
  assert.equal(DELVE_RUN_RULES.strangersUntil, 5, "strangers are matched into a delve on its first five floors, not deeper");
  assert.equal(DELVE_RUN_RULES.unlockCheck, false);
  assert.deepEqual([DELVE_RUN_RULES.pays.keys, DELVE_RUN_RULES.pays.trophies, DELVE_RUN_RULES.pays.gems], [false, false, false]);
  assert.equal(DELVE_RUN_RULES.pays.gold, true);
  assert.equal(DELVE_RUN_RULES.mapCredit, false);
  assert.equal(DELVE_RUN_RULES.chestsKept, "pickup", "no report until the party falls: chests are kept as picked up");
  assert.equal(DELVE_RUN_RULES.defeatCountdownSeconds, 10);
});

test("difficulty and gifts by the numbers", () => {
  assert.deepEqual(difficultyAt(1), { npcLevel: 10, healthBonus: 0, damageBonus: 0, attackSpeedBonus: 0, lifeSteal: 0, treasure: 30104 });
  assert.equal(difficultyAt(2).lifeSteal, 0, "no stealing before the third boss");
  assert.equal(difficultyAt(3).lifeSteal, 0.05);
  assert.equal(difficultyAt(30).lifeSteal, 0.4, "and never more than the most");
  assert.deepEqual([1, 5, 6, 20].map((d) => difficultyAt(d).treasure), [30104, 30104, 30105, 30105], "item boxes, never chests: small, then royal from the sixth");
  assert.equal(difficultyAt(3).npcLevel, 22);
  assert.equal(giftFor(2), null);
  assert.equal(giftFor(3).offerId, 51306, "bombs early: what a delve runs on");
  assert.equal(giftFor(9).offerId, 51250, "a few gems deep down");
  assert.equal(giftFor(30).offerId, 51250, "and never more: a delve can be run again and again");
  assert.equal(giftFor(9, DELVE_DEFAULTS, 2).offerId, 51306, "two fought at the ninth: the first gift");
  assert.equal(giftFor(9, DELVE_DEFAULTS, 0), null, "none fought: nothing");
  assert.equal(itemFor(25, DELVE_DEFAULTS, 1).rarity, "UNCOMMON", "a legendary step reached on the first boss fought: uncommon");
  assert.equal(itemFor(25, DELVE_DEFAULTS, 1).level, 154, "at the boss's level all the same");
  assert.equal(itemFor(25, DELVE_DEFAULTS, 0), null);
  assert.deepEqual([9, 11, 12, 14].map((d) => itemFor(d)), [null, null, null, null], "a weapon only on the milestones");
  assert.deepEqual(itemFor(10), { rarity: "UNCOMMON", level: 64 }, "at the boss's monster level");
  assert.deepEqual(itemFor(15), { rarity: "RARE", level: 94 });
  assert.equal(itemFor(25).rarity, "LEGENDARY");
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

test("the way in is DELVE on the friend list: first, online in a dungeon, and JOIN on it is a delve", async () => {
  const { delve, presence, enter } = setup();
  const [row, ...rest] = delve.hooks.friendList([{ account_id: 5, name: "a friend" }, { account_id: 998, name: "stale copy" }]);
  assert.equal(row.account_id, 998);
  assert.equal(row.name, "DELVE");
  assert.equal(row.is_online, true);
  assert.equal(row.current_dungeon, delve.entryNode, "in a dungeon: the client draws JOIN");
  assert.equal(row.trophies, 998, "under MATCHMAKER's 999: the two doors keep one order on every list");
  assert.deepEqual(rest.map((friend) => friend.account_id), [5], "any stored copy dropped");
  delve.hooks.loggedIn({ accountId: 7 });
  assert.deepEqual(presence, [[7, 998, delve.entryNode]]);
  assert.equal(delve.hooks.isSystemAccount(998), true, "the id is never an account's");

  const join = delve.hooks.routeEntry({ accountId: 7 }, { mapNodeId: 0, friendId: 998, mapId: 0, friendOnly: 0 });
  assert.equal(join.mode, DELVE_MODE);
  assert.equal(join.mapNodeId, delve.entryNode);
  assert.equal(join.friendId, 0, "not a join of anybody: a delve of its own, public");

  // Somebody delving: the door says so.
  await enter(7);
  assert.equal(delve.hooks.friendList([])[0].name, "DELVE (1)");
  delve.hooks.runLeft({ accountId: 7 });
  assert.equal(delve.hooks.friendList([])[0].name, "DELVE");
});

test("what each worker counts is added up where friend lists are answered", () => {
  const { delve } = setup();
  delve.heardInside(0, 2);
  delve.heardInside(1, 3);
  delve.heardInside(1, 1);
  assert.equal(delve.inside(), 3, "worker 1's latest replaces its earlier count");
});

test("a gift step pays whoever fought its boss, by how many they fought: a late arrival gets the first gift, not the deep one", async () => {
  const { enter, clear, controls, delve } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter(7);
  clear(session); // boss 1 beaten
  // A friend arrives on boss 2 and stands on its floor.
  const late = { accountId: 8, modeEntry: DELVE_MODE, floorIndex: session.floorIndex, floorPlan: session.floorPlan, floorCount: session.floorCount };
  delve.hooks.heroRequested(late);
  session.party = [session, late];
  clear(session); // boss 2
  clear(session); // boss 3: the first gift step
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controls.gifts.map(([who, offer]) => [who, offer]), [[7, 51306], [8, 51306]], "both there for it: bombs");
  clear(session); clear(session); clear(session); // up to boss 6
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    controls.gifts.slice(2).map(([who, offer]) => [who, offer]),
    [[7, 51369], [8, 51306]],
    "six fought, a Party Bomb; five fought, still the first gift"
  );
});

test("a stranger matched in deep gets the first gift at the next step, never the gems the run's depth would pay", async () => {
  const { enter, clear, controls, delve } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter(7);
  for (let i = 0; i < 7; i++) clear(session); // bosses 1 to 7
  const stranger = { accountId: 8, modeEntry: DELVE_MODE, floorIndex: session.floorIndex, floorPlan: session.floorPlan, floorCount: session.floorCount };
  delve.hooks.heroRequested(stranger); // in for boss 8
  session.party = [session, stranger];
  clear(session); clear(session); // bosses 8 and 9
  await new Promise((resolve) => setImmediate(resolve));
  const atNine = controls.gifts.slice(-2).map(([who, offer]) => [who, offer]);
  assert.deepEqual(atNine, [[7, 51250], [8, 51306]], "the gems for nine fought, the bombs for two");
});

test("somebody who arrives after the gift step's boss is beaten gets nothing of it", async () => {
  const { enter, clear, controls, delve } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter(7);
  clear(session); clear(session); // bosses 1, 2
  // Not here for boss 3: listed in the party as it ends, but never stood on its floor.
  session.party = [session, { accountId: 8, modeEntry: DELVE_MODE }];
  clear(session); // boss 3
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controls.gifts.map(([who]) => who), [7]);
});

test("what happens is told through the effect book: its event, then its line, the words falling back when it has none", async () => {
  const shown = [];
  const said = [];
  const bosses = [boss(1), boss(2)];
  let delve = null;
  delve = createDelve({
    bosses,
    modifierIds: [101],
    modifierNames: { 101: "BEEFY BROS" },
    controls: { ...fakeControls(), say: (session, text) => said.push(text), party: (s) => [s], gift: async () => null },
    show: (session, notice) => (shown.push(`${notice.mode}.${notice.type}`), null),
    line: (notice) => (notice.type === "boss" ? `BOOK boss ${notice.depth}` : null),
    random: () => 0,
  });
  delve.toggle(7);
  const request = delve.hooks.routeEntry({ accountId: 7 }, { mapNodeId: 1 });
  const session = { accountId: 7, modeEntry: request.mode, floorIndex: 0 };
  session.floorPlan = await delve.hooks.planFor(session, 1);
  session.floorCount = session.floorPlan.floors.length;
  const planAhead = (floors) => {
    session.floorPlan.floors = [...session.floorPlan.floors, ...floors];
    session.floorCount = session.floorPlan.floors.length;
  };
  delve.hooks.heroRequested(session);
  assert.deepEqual(shown, ["delve.entered", "delve.boss"]);
  assert.equal(said[0], "Delve: boss after boss, each harder, until your party falls.", "no line in the book: the words");
  assert.equal(said[1], "BOOK boss 1", "the book's line where it has one");
  // Through to the fourth boss, where the first curse comes.
  for (let i = 0; i < 3; i++) {
    delve.hooks.floorCompleting({ ...session, floorPlan: session.floorPlan });
    planAhead([]);
    session.floorIndex += 1;
    delve.hooks.heroRequested(session);
  }
  assert.ok(shown.includes("delve.cursed"), "a new curse is told");
  assert.ok(said.some((line) => /BEEFY BROS/.test(line)));
  delve.hooks.runFailed(session);
  assert.equal(shown.at(-1), "delve.lost");
});

test("a player who walks out and comes back has fought from their return, not from their first arrival", async () => {
  const { enter, clear, controls, delve } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter(7);
  // A friend there from the first boss walks out after it, and comes back for the fifth.
  const friend = { accountId: 8, modeEntry: DELVE_MODE, floorIndex: 0, floorPlan: session.floorPlan, floorCount: session.floorCount };
  delve.hooks.heroRequested(friend);
  session.party = [session, friend];
  clear(session); // boss 1
  delve.hooks.runLeft({ accountId: 8 }, "left");
  session.party = [session];
  clear(session); clear(session); clear(session); // bosses 2 to 4
  const back = { ...friend, floorIndex: session.floorIndex };
  delve.hooks.heroRequested(back);
  session.party = [session, back];
  clear(session); clear(session); // bosses 5 and 6: the second gift step
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    controls.gifts.slice(-2).map(([who, offer]) => [who, offer]),
    [[7, 51369], [8, 51306]],
    "two bosses since coming back: the first gift, not the Party Bomb"
  );
});

test("a dropped connection is not walking out: back in the same delve, the bosses fought before still count", async () => {
  const { enter, clear, controls, delve } = setup({ bosses: [boss(1), boss(2)] });
  const { session } = await enter(7);
  const friend = { accountId: 8, modeEntry: DELVE_MODE, floorIndex: 0, floorPlan: session.floorPlan, floorCount: session.floorCount };
  delve.hooks.heroRequested(friend);
  session.party = [session, friend];
  clear(session); // boss 1
  delve.hooks.runLeft({ accountId: 8 }, "dropped");
  session.party = [session];
  clear(session); clear(session); clear(session); // bosses 2 to 4
  const back = { ...friend, floorIndex: session.floorIndex };
  delve.hooks.heroRequested(back);
  session.party = [session, back];
  clear(session); clear(session); // bosses 5 and 6
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    controls.gifts.slice(-2).map(([who, offer]) => [who, offer]),
    [[7, 51369], [8, 51369]],
    "there since the first boss, as far as the gift goes"
  );
});

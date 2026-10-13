import test from "node:test";
import assert from "node:assert/strict";

import { awardDungeonCompletion, setMapNodeBit } from "../src/socket/rewards.js";
import { buildDungeonReport } from "../src/socket/summary.js";
import { handleTakeChest } from "../src/socket/summary-chests.js";
import { installModeHooks } from "../src/modes/hooks.js";
import { runRules } from "../src/socket/run-rules.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import { loadGameMaster } from "../src/gamemaster.js";

/**
 * A boss's chest is a first clear's, on the report — never a pickup on the floor.
 *
 * Official: opening REWARD_CHEST_A left no treasure doober in 0 of 17 opened
 * chests, only its own shower (chest-loot.test.js); the node's
 * BossRewardTreasureId reached the player once, on a first clear, as report
 * chest slot 1 (n=1, node 50002: WOODEN 30100 -> loot 60001, kept), and on 16
 * repeat clears there was no boss chest at all. Whose first clear — the hero's
 * or the account's — n=1 cannot say; the hero's is the maintainer's call.
 */

const ACCOUNT_ID = 1000000005;
const SUMMARY_DOID = 7001;
const PROVING_GROUNDS = { Id: 50002, Name: "Proving Grounds", NodeType: "BOSS", BitIndex: 0, BossRewardTreasureId: 30100, TotalEnemyCoin: 750, CompletionXPBonus: 55, BasicKeys: 1 };
const ICEWATER_2 = { Id: 50083, Name: "Icewater Caverns Boss", NodeType: "BOSS", BitIndex: 81, BossRewardTreasureId: 30103, TotalEnemyCoin: 800, CompletionXPBonus: 0, BasicKeys: 0 };

const run = (overrides = {}) => ({
  id: "boss",
  summaryDoid: SUMMARY_DOID,
  dungeonAccount: {
    id: ACCOUNT_ID,
    basic_currency: 0,
    trophies: 0,
    account_chests: [],
    account_avatars: [{ id: 1, avatar_id: 101, experience: 0 }, { id: 2, avatar_id: 102, experience: 0 }],
  },
  dungeonTreasures: [],
  mapPage: PROVING_GROUNDS,
  send: () => {},
  objects: new Map(),
  persistDungeonAccount: async () => {},
  ...overrides,
});

/** A run under a mode's `rules`, its one floor saying `floor`. */
const runUnder = (t, rules, floor = {}, overrides = {}) => {
  const uninstall = installModeHooks("boss-chest-test", {
    runRules: (session) => (session.modeEntry === "boss-chest-test" ? runRules({ mode: "boss-chest-test", ...rules }) : null),
  });
  t.after(uninstall);
  return run({ modeEntry: "boss-chest-test", floorIndex: 0, floorPlan: { floors: [{ authored: "a.json", ...floor }] }, ...overrides });
};

const keep = (session, slot) => handleTakeChest(session, new PacketReader(new PacketWriter().u32(ACCOUNT_ID).u32(slot).body()));

test("breaking the boss's chest drops its own shower and no treasure", async () => {
  const { buildFloor } = await import("./helpers/floor.js");
  const { applyDamage } = await import("../src/socket/combat.js");
  const gm = await loadGameMaster();

  const { session } = await buildFloor("castle/arena/db_floor_TUTORIAL_LEVEL_final.json", { tileCount: 24 });
  session.areaDoid ??= 999;
  session.floorSettled = true;
  session.mapPage = gm.raw.MapPage.find((node) => node.Id === 50002);
  assert.equal(session.mapPage.BossRewardTreasureId, 30100, "a node that names a chest of its own");

  applyDamage(session, session.npcDoids.get("1:5.1336431165310"), 9999);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const [doid, chest] = [...session.actors].find(([, actor]) => actor.constant === "REWARD_CHEST_A");
  const before = new Set(session.doobers?.keys() ?? []);
  applyDamage(session, doid, chest.hitPoints);
  await new Promise((resolve) => setTimeout(resolve, 6600));

  const dropped = [...(session.doobers?.entries() ?? [])].filter(([key]) => !before.has(key)).map(([, doober]) => doober);
  const counts = {};
  for (const doober of dropped) counts[doober.constant] = (counts[doober.constant] ?? 0) + 1;
  assert.deepEqual(counts, { EXP_SMALL: 24, GOLD_SMALL: 19, GOLD_MEDIUM: 4 }, "LOOT_SPAWN_A1's forty-seven, as all 17 official breaks");
  assert.ok(dropped.every((doober) => !doober.treasure), "no chest to pick up");
  assert.equal(dropped.reduce((sum, doober) => sum + doober.gold, 0), 59, "59 gold, not the node's TotalEnemyCoin of 750");
});

test("a first clear of a boss node owes the node's chest on the report, slot 1, kept by Keep", async () => {
  const session = run();
  // Not awaited, as sendDungeonSummary does not: the report is drawn at once.
  const paying = awardDungeonCompletion(session);
  const report = buildDungeonReport(session, true);
  const paid = await paying;
  assert.equal(paid.trophies, 1);
  assert.equal(paid.chest, 60001);
  assert.deepEqual(session.dungeonTreasures, [{ dooberType: 30100, chestId: 60001 }]);
  assert.deepEqual(session.dungeonAccount.account_chests, [], "a claim until it is kept, as a picked-up treasure is");

  assert.equal(report.receivedTrophy, 1);
  assert.equal(report.chestType1, 30100, "the node's BossRewardTreasureId");
  assert.equal(report.lootType1, 60001, "and the chest it stands for");
  assert.equal(report.chestType2, undefined);

  await keep(session, 0);
  assert.deepEqual(session.dungeonAccount.account_chests.map((row) => row.chest_id), [60001], "one chest, on Keep");
  await keep(session, 0);
  assert.equal(session.dungeonAccount.account_chests.length, 1, "and once");
});

test("a treasure picked up on the floor stays where it was; the first clear's comes after it", async () => {
  const { awardTreasureChest } = await import("../src/socket/rewards.js");
  const session = run({ mapPage: { ...PROVING_GROUNDS, BossRewardTreasureId: 30101 } });
  await awardTreasureChest(session, 30104);
  await awardDungeonCompletion(session);
  assert.deepEqual(session.dungeonTreasures.map((treasure) => treasure.dooberType), [30104, 30101]);
});

test("a hero's repeat clear owes no chest; another hero's own first clear of the node does, once", async () => {
  const replay = run();
  replay.dungeonAvatar = replay.dungeonAccount.account_avatars[0];
  replay.dungeonAvatar.completed_mapnode_mask = setMapNodeBit("", 0);
  replay.dungeonAccount.completed_mapnode_mask = setMapNodeBit("", 0);
  const paid = await awardDungeonCompletion(replay);
  assert.equal(paid.chest, 0);
  assert.deepEqual(replay.dungeonTreasures, []);
  assert.equal(buildDungeonReport(replay, true).chestType1, undefined, "nothing on the report");

  // The chest is the hero's (the client keeps map progress per hero); the trophy stays the account's.
  const first = run();
  first.dungeonAvatar = first.dungeonAccount.account_avatars[0];
  assert.equal((await awardDungeonCompletion(first)).chest, 60001);
  const second = run({ dungeonAccount: first.dungeonAccount });
  second.dungeonAvatar = second.dungeonAccount.account_avatars[1];
  const other = await awardDungeonCompletion(second);
  assert.equal(other.trophies, 0, "no second trophy for the account");
  assert.equal(other.chest, 60001, "but the second hero's own first clear owes the chest");
  const again = run({ dungeonAccount: first.dungeonAccount });
  again.dungeonAvatar = again.dungeonAccount.account_avatars[1];
  assert.equal((await awardDungeonCompletion(again)).chest, 0, "and that hero's repeat does not");
});

test("an ordinary dungeon's first clear owes no chest", async () => {
  const session = run({ mapPage: { ...PROVING_GROUNDS, NodeType: "DUNGEON", BossRewardTreasureId: 0 } });
  assert.equal((await awardDungeonCompletion(session)).chest, 0);
  assert.deepEqual(session.dungeonTreasures, []);
});

test("the run rules' treasure: \"none\" owes none, a treasure named stands in, chestMost holds it down", async (t) => {
  const none = runUnder(t, { treasure: "none" });
  const paid = await awardDungeonCompletion(none);
  assert.equal(paid.trophies, 1, "the trophy stands");
  assert.equal(paid.chest, 0, "no chest");
  assert.deepEqual(none.dungeonTreasures, []);

  const forced = runUnder(t, { treasure: "ROYAL_ITEM_BOX" });
  await awardDungeonCompletion(forced);
  assert.deepEqual(forced.dungeonTreasures, [{ dooberType: 30105, chestId: 60006 }]);

  const floorWins = runUnder(t, { treasure: "none" }, { treasure: 30101 });
  await awardDungeonCompletion(floorWins);
  assert.deepEqual(floorWins.dungeonTreasures, [{ dooberType: 30101, chestId: 60002 }], "the floor plan's own first");

  const held = runUnder(t, { chestMost: 2 }, {}, { mapPage: ICEWATER_2 });
  await awardDungeonCompletion(held);
  assert.deepEqual(held.dungeonTreasures, [{ dooberType: 30103, chestId: 60002 }], "the legendary held to uncommon");
});

test("a run that pays no chests, or marks no map, owes none; one kept on pickup has it at once", async (t) => {
  const noChests = runUnder(t, { pays: { chests: false } });
  await awardDungeonCompletion(noChests);
  assert.deepEqual(noChests.dungeonTreasures, []);
  assert.deepEqual(noChests.dungeonAccount.account_chests, []);

  const noCredit = runUnder(t, { mapCredit: false });
  assert.equal((await awardDungeonCompletion(noCredit)).chest, 0, "no first clear without map credit");

  const pickup = runUnder(t, { chestsKept: "pickup" });
  await awardDungeonCompletion(pickup);
  assert.deepEqual(pickup.dungeonAccount.account_chests.map((row) => row.chest_id), [60001]);
  assert.deepEqual(pickup.dungeonTreasures, [], "nothing left for the report to offer again");
});

/**
 * And the boss node's map spots roll their tier, as every node's do.
 *
 * Official: the 13 treasures on boss-node maps were SMALL_ITEM_BOX 6, WOODEN 4,
 * SILVER 3 — the RaritySpawn roll, the node's BossRewardTreasureId in only 2 —
 * and of all 223 official map-spot treasures not one was a DRAGON chest.
 */
test("a boss node's map spot rolls its tier, never the node's own chest; a legendary never", async () => {
  const { buildCollectables } = await import("../src/socket/floor-collectables.js");
  const { treasureForTier, mapNode } = await import("../src/gamemaster.js");
  const node = await mapNode(50083);
  assert.equal(node.BossRewardTreasureId, 30103, "the one node whose chest is a legendary");
  const spotAt = async (roll) => {
    let doid = 1000;
    const session = { id: "spots", mapNodeId: 50083, dungeonZone: 1, random: () => roll, allocateDoid: () => doid++, doobers: new Map(), send: () => {} };
    await buildCollectables({ session, floorDoid: 8, isActive: () => true }, [{ constant: "TREASURE", x: 0, y: 0 }]);
    return [...session.doobers.values()][0].treasure;
  };
  for (const roll of [0, 0.05, 0.2, 0.4, 0.55, 0.7, 0.9, 0.999]) {
    const paid = await spotAt(roll);
    assert.equal(paid, (await treasureForTier(node.TierRank, () => roll)).Id, `the tier's roll at ${roll}`);
    assert.notEqual(paid, 30103, `no legendary at ${roll}`);
  }
});

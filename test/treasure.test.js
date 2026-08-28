import test from "node:test";
import assert from "node:assert/strict";
import { treasureForCategory, dooberById, mapNode, coliseumTier } from "../src/gamemaster.js";

/**
 * What a RANDOM_REWARD placement actually pays.
 *
 * A tile carries the placeholder because it cannot know which node it will be
 * laid into. Two columns answer it, and only twelve nodes use the first:
 * MapPage.BossRewardTreasureId names a doober outright, and everything else
 * falls to the tier's Treasure — which is a RewardCategory, not a constant,
 * so reading it as a doober name finds nothing and the chest never appears.
 */

test("a reward category resolves to its treasure doober", async () => {
  assert.equal((await treasureForCategory("COMMON_CHEST")).Id, 30100);
  assert.equal((await treasureForCategory("UNCOMMON_CHEST")).Id, 30101);
  assert.equal((await treasureForCategory("RARE_CHEST")).Id, 30102);
  assert.equal((await treasureForCategory("LEGENDARY_CHEST")).Id, 30103);
});

test("an unknown or missing category resolves to nothing", async () => {
  assert.equal(await treasureForCategory("NOT_A_CATEGORY"), null);
  assert.equal(await treasureForCategory(undefined), null);
});

test("a boss node names its chest outright", async () => {
  const node = await mapNode(50009); // Icewater Caverns Boss
  assert.equal(node.BossRewardTreasureId, 30101);
  assert.equal((await dooberById(node.BossRewardTreasureId)).Constant, "SILVER_CHEST");
});

/**
 * The other ninety-four nodes report BossRewardTreasureId 0, which is why
 * every generated dungeon's chests used to be skipped as unresolvable.
 */
test("an ordinary dungeon takes its chest from its tier", async () => {
  const node = await mapNode(50008); // Icewater Caverns 1-3
  assert.ok(!node.BossRewardTreasureId, "it names no chest of its own");

  const tier = await coliseumTier(node.TierRank);
  const treasure = await treasureForCategory(tier.Treasure);

  assert.ok(treasure, "but its tier does");
  assert.equal(treasure.DooberType, "TREASURE");
  assert.equal(treasure.Constant, "SILVER_CHEST");
});

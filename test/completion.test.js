import test from "node:test";
import assert from "node:assert/strict";
import { repairActiveAvatarProgress } from "../src/accounts.js";
import { setMapNodeBit, awardDungeonCompletion } from "../src/socket/rewards.js";

/**
 * Finishing a dungeon has to leave a mark, or the player replays the first one
 * for ever. The amounts come from MapPage and never from the client: the
 * shipped tables zero the chest's own drop values precisely so this cannot be
 * forged from outside.
 */

// Utf8BitArray reads bit i from byte i>>3, counting down from the top of the
// byte — so the very first node is 0x80, not 0x01.
test("the progress mask matches how the client reads it", () => {
  const getBit = (mask, index) =>
    (mask.charCodeAt(index >> 3) & (1 << (7 - (index % 8)))) !== 0;

  const first = setMapNodeBit("", 0);
  assert.equal(first.charCodeAt(0), 0x80);
  assert.equal(getBit(first, 0), true);

  const both = setMapNodeBit(first, 9);
  assert.equal(getBit(both, 0), true, "earlier nodes survive");
  assert.equal(getBit(both, 9), true);
  assert.equal(getBit(both, 8), false);
  assert.equal(both.length, 2, "the mask grows a byte at a time");
});

const session = (overrides = {}) => ({
  id: 1,
  dungeonAccount: { basic_currency: 100, basic_keys: 0, completed_dungeons: 0 },
  dungeonAvatar: { experience: 500 },
  mapPage: {
    Name: "Proving Grounds",
    // A trophy is for a boss; the eighty-five ordinary dungeons pay none.
    NodeType: "BOSS",
    BitIndex: 0,
    TotalEnemyCoin: 750,
    CompletionXPBonus: 55,
    BasicKeys: 1,
  },
  persistDungeonAccount: async () => {},
  ...overrides,
});

test("completing a node pays it out and records the bit", async () => {
  const target = session();
  const paid = await awardDungeonCompletion(target);

  // Gold and experience are not credited here — they lie on the floor as the
  // chest's drop and are picked up.
  assert.deepEqual(paid, {
    gold: 0,
    experience: 0,
    basicKeys: 1,
    trophies: 1,
    firstClear: true,
  });
  assert.equal(target.dungeonAccount.basic_currency, 100, "untouched by completion");
  assert.equal(target.dungeonAccount.basic_keys, 1);
  assert.equal(target.dungeonAccount.completed_dungeons, 1);
  assert.equal(target.dungeonAccount.completed_mapnode_mask.charCodeAt(0), 0x80);
  assert.equal(target.dungeonAvatar.completed_mapnode_mask.charCodeAt(0), 0x80);
  assert.equal(target.dungeonAvatar.experience, 500, "untouched by completion");
});

test("legacy account progress unlocks the active avatar when every hero is empty", () => {
  const account = {
    active_avatar: 2,
    completed_mapnode_mask: String.fromCharCode(0x80),
    account_avatars: [
      { id: 1, completed_mapnode_mask: "" },
      { id: 2, completed_mapnode_mask: "" },
    ],
  };

  assert.equal(repairActiveAvatarProgress(account), true);
  assert.equal(account.account_avatars[0].completed_mapnode_mask, "");
  assert.equal(account.account_avatars[1].completed_mapnode_mask.charCodeAt(0), 0x80);
  assert.equal(repairActiveAvatarProgress(account), false, "the one-time repair is idempotent");
});

test("progress from a different hero is never copied to the active avatar", () => {
  const account = {
    active_avatar: 2,
    completed_mapnode_mask: String.fromCharCode(0x80),
    account_avatars: [
      { id: 1, completed_mapnode_mask: String.fromCharCode(0x80) },
      { id: 2, completed_mapnode_mask: "" },
    ],
  };

  assert.equal(repairActiveAvatarProgress(account), false);
  assert.equal(account.account_avatars[1].completed_mapnode_mask, "");
});

test("a dungeon pays once, however often the victory is reached", async () => {
  const target = session();
  await awardDungeonCompletion(target);
  assert.equal(await awardDungeonCompletion(target), null);
  assert.equal(target.dungeonAccount.basic_currency, 100, "and no second payment");
});

test("an unknown node pays nothing rather than guessing", async () => {
  const target = session({ mapPage: null });
  assert.equal(await awardDungeonCompletion(target), null);
  assert.equal(target.dungeonAccount.basic_currency, 100);
});

/**
 * Beating a node again still pays what makes farming worthwhile, but the
 * trophy and the keys are for beating it, and are handed over once. The mask is
 * the record, so it has to be read before it is written.
 */
test("a replay pays gold and experience but no trophy or keys", async () => {
  const target = session();

  const first = await awardDungeonCompletion(target);
  assert.equal(first.trophies, 1);
  assert.equal(first.basicKeys, 1);
  assert.equal(target.dungeonAccount.trophies, 1);

  // A second run of the same node, on the account the first one left behind.
  const again = session({
    dungeonAccount: target.dungeonAccount,
    dungeonAvatar: { experience: 0 },
  });
  const replay = await awardDungeonCompletion(again);

  assert.equal(replay.firstClear, false);
  assert.equal(replay.trophies, 0, "the trophy is not handed out twice");
  assert.equal(replay.basicKeys, 0);
  assert.equal(replay.gold, 0, "the chest pays the gold, not this");
  assert.equal(replay.experience, 0);
  assert.equal(target.dungeonAccount.trophies, 1);
  assert.equal(target.dungeonAccount.basic_keys, 1);
  assert.equal(target.dungeonAccount.basic_currency, 100);
  assert.equal(
    again.dungeonAvatar.completed_mapnode_mask.charCodeAt(0),
    0x80,
    "a legacy replay restores this hero's missing node bit without paying twice"
  );
});

/**
 * A treasure picked up off the floor is a *claim* on a chest, and the summary
 * screen shows both sides of it. A captured run reported a GOLD_CHEST collected
 * as 30102 with its reward as 60003 — the doober id and the chest id for the
 * same thing, the two tables running in step.
 *
 * The account is deliberately untouched here: the chest arrives when the player
 * keeps it on the report. Measured — across the official captures every
 * increase in `account_chests` follows a TakeChest or an OpenChest, and a run
 * that collected four treasures and kept one moved the account by one.
 */
test("collecting a treasure records the chest it stands for", async () => {
  const { awardTreasureChest } = await import("../src/socket/rewards.js");
  const target = session();
  target.dungeonAccount.id = 1000000005;

  assert.equal(await awardTreasureChest(target, 30102), 60003, "gold chest is a rare chest");
  assert.equal(await awardTreasureChest(target, 30100), 60001, "and wooden is common");

  assert.deepEqual(
    target.dungeonTreasures.map((treasure) => treasure.chestId),
    [60003, 60001]
  );
  assert.deepEqual(
    target.dungeonAccount.account_chests ?? [],
    [],
    "and nothing reaches the account until the report screen"
  );
});

test("a doober that is not a treasure earns nothing", async () => {
  const { awardTreasureChest } = await import("../src/socket/rewards.js");
  const target = session();

  assert.equal(await awardTreasureChest(target, 30001), null, "a coin is not a chest");
  assert.equal(await awardTreasureChest(target, 30199), null);
  assert.equal(target.dungeonAccount.account_chests, undefined);
});

/**
 * Trophies come from twelve nodes, not a hundred and six. They are the ones the
 * map calls BOSS — Proving Grounds, the Knight Fortress and Dark Barrows
 * bosses, Prisoner's Keep and the rest — while the eighty-five ordinary
 * dungeons and the nine Infinites pay none.
 */
test("an ordinary dungeon pays no trophy, however new it is", async () => {
  const target = session({
    mapPage: {
      Name: "Knight Fortress 1-1",
      NodeType: "DUNGEON",
      BitIndex: 4,
      TotalEnemyCoin: 600,
      CompletionXPBonus: 110,
      BasicKeys: 1,
    },
  });

  const paid = await awardDungeonCompletion(target);

  assert.equal(paid.firstClear, true, "it is still the first time through");
  assert.equal(paid.trophies, 0, "and it still pays no trophy");
  assert.equal(paid.basicKeys, 1, "the keys are a different question");
  assert.equal(target.dungeonAccount.trophies ?? 0, 0);
});

/**
 * A chest on the floor has to say it is one.
 *
 * `awardTreasureChest` is keyed off the tracked doober's `treasure` field, and
 * the boss-reward path has always set it. The tiles' own reward placements did
 * not, so a player walked over a chest, watched it disappear, and finished the
 * run with nothing — which is how this was reported from play.
 */
test("a treasure placed by the tiles is marked as one, so collecting it pays", async () => {
  const { trackDoober } = await import("../src/socket/pickups.js");
  const { awardTreasureChest } = await import("../src/socket/rewards.js");

  const session = {
    id: 91,
    doobers: new Map(),
    dungeonAccount: { id: 5, account_chests: [] },
    dungeonAvatar: { id: 1 },
    queueAccountSave() {},
  };

  // What buildCollectables now tracks for a placed chest.
  trackDoober(session, 900, { x: 0, y: 0, constant: "TREASURE_WOODEN", treasure: 30100 });
  const tracked = session.doobers.get(900);

  assert.equal(tracked.treasure, 30100, "the pickup knows it is a chest");
  assert.equal(await awardTreasureChest(session, tracked.treasure), 60001);
  assert.equal(
    session.dungeonTreasures.length,
    1,
    "and the run is owed it, which is what the report screen offers"
  );
});

/**
 * Why the floor builder must not ask `dooberForConstant` about a reward spot.
 *
 * That helper falls back to reading an unmatched constant as a *DooberType* and
 * picking one of that type at random — how FOOD and FOOD_BUFF resolve. All six
 * chests and boxes share DooberType TREASURE, and no doober is *named*
 * TREASURE, so a tile spot called TREASURE fell straight into that fallback and
 * rolled a uniform one-in-six, map node ignored.
 *
 * Reported from play as a legendary chest on a floor that cannot pay one. The
 * recording agrees: node 50004 spawned a DRAGON_CHEST and node 50003 two
 * ROYAL_ITEM_BOX, while the RANDOM_REWARD spots on the same floors — a name
 * nothing shares — correctly paid the uncommon their tier allows. Only node
 * 50083 authorises a legendary anywhere in the game.
 */
test("TREASURE resolves to a random chest, which is what makes it a trap", async () => {
  const { dooberForConstant } = await import("../src/gamemaster.js");

  const legendary = await dooberForConstant("TREASURE", () => 0.55);
  assert.equal(legendary.Constant, "DRAGON_CHEST", "the roll reaches the legendary");

  const box = await dooberForConstant("TREASURE", () => 0.99);
  assert.equal(box.Constant, "ROYAL_ITEM_BOX");
});

test("so both reward placeholders are answered by the map node instead", async () => {
  const { isRewardPlaceholder } = await import("../src/socket/dungeon.js");

  assert.equal(isRewardPlaceholder("TREASURE"), true);
  assert.equal(isRewardPlaceholder("RANDOM_REWARD"), true);
  // Anything that names a real row still resolves the ordinary way.
  assert.equal(isRewardPlaceholder("GOLD_MEDIUM"), false);
});

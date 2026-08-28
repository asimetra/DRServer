import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * These exercise the registered handlers rather than the modules behind them.
 *
 * That gap is not theoretical: a handler once returned a two-element array
 * where the client reads six, and the game closed on the daily-reward screen
 * while every unit test stayed green. Another time a bad import left the server
 * unable to start at all, again with a green suite.
 */
process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-handlers-"));

const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");

const ACCOUNT = 1000000005;

const freshAccount = async (overrides = {}) => {
  const account = await loadAccount(ACCOUNT);
  Object.assign(account, overrides);
  await saveAccount(account);
  return account;
};

test("every handler the client calls is registered", async () => {
  // Falling through to the permissive stub is silent, so the ones that matter
  // are asserted explicitly.
  for (const [service, method] of [
    ["account", "token"],
    ["account", "OpenChest"],
    ["account", "AlterAttribute"],
    ["store", "AskAboutDailyReward"],
    ["store", "RequestRedeemDailyRewards"],
    ["store", "PurchaseOffer"],
    ["store", "SellWeapon"],
    ["avatarmanager", "equipItemOnAvatar"],
    ["avatarmanager", "unequipItemOffAvatar"],
    ["avatarrecord", "setActiveAvatar"],
  ]) {
    const { hasHandler } = await import("../src/rpc.js");
    assert.ok(hasHandler(service, method), `${service}/${method} is not registered`);
  }
});

test("option changes replace one account attribute and survive the next login", async () => {
  await freshAccount({ account_attributes: [] });

  await dispatch("account", "AlterAttribute", [
    ACCOUNT,
    "token",
    "optionsMusicVolume",
    "0.4",
  ]);
  await dispatch("account", "AlterAttribute", [
    ACCOUNT,
    "token",
    "optionsMusicVolume",
    "0.2",
  ]);

  const reloaded = await loadAccount(ACCOUNT);
  const music = reloaded.account_attributes.filter(
    ({ name }) => name === "optionsMusicVolume"
  );
  assert.equal(music.length, 1, "changing an option updates rather than duplicates it");
  assert.equal(music[0].value, "0.2");
  assert.equal(
    reloaded.account_attributes.find(({ name }) => name === "optionsGraphicsQuality")?.value,
    "high",
    "missing preferences receive the server default"
  );
});

test("the daily reward redeem answers with the six elements the client reads", async () => {
  await freshAccount({ basic_currency: 1000, last_reward_date: null });

  const result = await dispatch("store", "RequestRedeemDailyRewards", [ACCOUNT, "token", 0, false, {}]);

  assert.equal(result.length, 6, "UIDailyRewards indexes up to [5]");
  assert.equal(result[0].length, 3, "one offer behind each box");
  assert.equal(typeof result[1], "object", "the account");
  assert.equal(typeof result[2], "number", "seconds until the next reward");
  assert.equal(typeof result[3], "boolean");
  assert.equal(result[4].length, 5, "the refreshed status array");
  assert.equal(typeof result[5], "number");
});

/**
 * Gems the picked box itself contains, which are not the login bonus and are
 * credited on top of it. Some of the daily offers hold 5, 25, 50 or 100, so a
 * test that assumes the bonus is the only change fails whenever the roll lands
 * on one of those — which it did, about one run in five.
 */
const gemsInside = async (offerId) => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  return gm.raw.OfferDetails.filter((row) => row.OfferId === Number(offerId)).reduce(
    (total, row) => total + Number(row.Gems ?? 0),
    0
  );
};

// Gems, not gold: across four captured redeems the account's gold never moved
// while its gems went up once and down five per replay.
test("a replay costs gems, and is refused without them", async () => {
  const before = await freshAccount({ premium_currency: 100, basic_currency: 1000 });

  const replay = await dispatch("store", "RequestRedeemDailyRewards", [ACCOUNT, "token", 0, true, {}]);
  const after = await loadAccount(ACCOUNT);
  // Three of the twenty-nine daily offers hold gems, so the box it re-rolled
  // may have paid some back. None of them hold coins, which is why gold is
  // still a flat assertion.
  const fromBox = await gemsInside(replay[0][0]);
  assert.equal(
    after.premium_currency,
    before.premium_currency - 5 + fromBox,
    "the replay is charged in gems"
  );
  assert.equal(after.basic_currency, before.basic_currency, "gold is untouched");

  await freshAccount({ premium_currency: 2 });
  await assert.rejects(
    () => dispatch("store", "RequestRedeemDailyRewards", [ACCOUNT, "token", 0, true, {}]),
    /replay costs/
  );
  const broke = await loadAccount(ACCOUNT);
  assert.equal(broke.premium_currency, 2, "a refused replay costs nothing");
});

// The first spin of the day pays the login bonus; a paid replay only re-rolls.
test("the first redeem of the day pays gems, a replay does not", async () => {
  await freshAccount({ premium_currency: 100, concurrent_days: 1, last_reward_date: null });

  const first = await dispatch("store", "RequestRedeemDailyRewards", [ACCOUNT, "token", 0, false, {}]);
  const afterFirst = await loadAccount(ACCOUNT);
  assert.ok(first[5] > 0, "the response reports the login bonus");
  // Box zero is the one picked, and first[0] is what was behind all three.
  const fromBox = await gemsInside(first[0][0]);
  assert.equal(
    afterFirst.premium_currency,
    100 + first[5] + fromBox,
    "the bonus and whatever the box held, both"
  );

  const replay = await dispatch("store", "RequestRedeemDailyRewards", [ACCOUNT, "token", 0, true, {}]);
  assert.equal(replay[5], 0, "a replay pays no bonus");
  const replayBox = await gemsInside(replay[0][0]);
  assert.equal(
    (await loadAccount(ACCOUNT)).premium_currency,
    afterFirst.premium_currency - 5 + replayBox,
    "only the replay fee, and the box it re-rolled"
  );
});

test("the reward screen is offered again only once the countdown runs out", async () => {
  await freshAccount({ last_reward_date: null });
  const claimable = await dispatch("store", "AskAboutDailyReward", [ACCOUNT]);
  assert.equal(claimable[3], 0, "zero means the boxes are shown");

  await dispatch("store", "RequestRedeemDailyRewards", [ACCOUNT, "token", 0, false, {}]);
  const claimed = await dispatch("store", "AskAboutDailyReward", [ACCOUNT]);
  assert.ok(claimed[3] > 0, "and a countdown hides them");
  assert.ok(claimed[3] <= 24 * 60 * 60, "which is at most a day");
});

/**
 * The reward scales with how many heroes the account has, and the streak stops
 * counting at three. Both come from captures: an account with two avatars on
 * its first day reported [1, 2] and paid 5 × 2, while one with six avatars on
 * its sixth day reported [3, 6].
 */
test("the daily payout is the streak tier times the hero count", async () => {
  const avatars = (count) =>
    Array.from({ length: count }, (_, index) => ({ id: index + 1, avatar_id: 101 + index }));

  await freshAccount({ premium_currency: 0, concurrent_days: 1, last_reward_date: null, account_avatars: avatars(2) });
  const [day1] = [await dispatch("store", "AskAboutDailyReward", [ACCOUNT])];
  assert.deepEqual([day1[0], day1[1]], [1, 2], "day one, two heroes");

  const first = await dispatch("store", "RequestRedeemDailyRewards", [ACCOUNT, "token", 0, false, {}]);
  assert.equal(first[5], 10, "5 for day one, doubled by two heroes");

  await freshAccount({ concurrent_days: 6, account_avatars: avatars(6) });
  const long = await dispatch("store", "AskAboutDailyReward", [ACCOUNT]);
  assert.deepEqual([long[0], long[1]], [3, 6], "the streak caps at three");
});

/**
 * A consumable is moved, not copied: equipping takes the stack out of the bag
 * and onto the hero, unequipping puts it back. Slots are zero-based on the wire
 * and one-based in the field names.
 */
test("equipping a consumable moves the stack onto the hero and back", async () => {
  await freshAccount({
    account_avatars: [{ id: 1, avatar_id: 101, consumable1_id: 0, consumable1_count: 0 }],
    account_stackables: [{ id: 5, account_id: ACCOUNT, stack_id: 70000, count: 3 }],
  });

  await dispatch("avatarmanager", "equipConsumableOnAvatar", [ACCOUNT, 1, 70000, 0, false, "t"]);
  const equipped = await loadAccount(ACCOUNT);
  assert.equal(equipped.account_avatars[0].consumable1_id, 70000);
  assert.equal(equipped.account_avatars[0].consumable1_count, 3, "the whole stack moves");
  assert.equal(equipped.account_stackables.length, 0, "and leaves the bag");

  await dispatch("avatarmanager", "unequipConsumableOffAvatar", [ACCOUNT, 1, 70000, 0, "t"]);
  const returned = await loadAccount(ACCOUNT);
  assert.equal(returned.account_avatars[0].consumable1_id, 0);
  assert.equal(returned.account_stackables[0].count, 3, "and comes back intact");
});

test("a hero walks with one pet at a time", async () => {
  await freshAccount({
    account_avatars: [{ id: 1, avatar_id: 101 }],
    account_pets: [
      { id: 91, account_id: ACCOUNT, npc_id: 3303, equipped_hero: null },
      { id: 92, account_id: ACCOUNT, npc_id: 3304, equipped_hero: null },
    ],
  });

  await dispatch("avatarmanager", "equipPetOnAvatar", [ACCOUNT, 1, 91, "t"]);
  await dispatch("avatarmanager", "equipPetOnAvatar", [ACCOUNT, 1, 92, "t"]);

  const swapped = await loadAccount(ACCOUNT);
  const following = swapped.account_pets.filter((pet) => pet.equipped_hero === 1);
  assert.equal(following.length, 1, "the first pet steps aside");
  assert.equal(following[0].id, 92);

  await dispatch("avatarmanager", "unEquipPet", [ACCOUNT, 92, "t"]);
  const none = await loadAccount(ACCOUNT);
  assert.equal(none.account_pets.every((pet) => pet.equipped_hero === null), true);
});

/**
 * Abandoning a chest and selling a potion are the two inventory buttons that
 * throw something away. Both looked dead in game for the same two reasons: the
 * row survived the call, and the response left out the list the client redraws
 * the slots from.
 */
test("abandoning a chest removes it and reports the chest list back", async () => {
  await freshAccount({
    account_chests: [
      { id: 71, account_id: ACCOUNT, chest_id: 60004 },
      { id: 72, account_id: ACCOUNT, chest_id: 60001 },
    ],
  });

  const result = await dispatch("account", "DropChest", [ACCOUNT, 71, "token"]);

  assert.ok(Array.isArray(result.account_chests), "the client rebuilds its slots from this");
  assert.deepEqual(result.account_chests.map((chest) => chest.id), [72]);
  assert.equal((await loadAccount(ACCOUNT)).account_chests.length, 1, "and it stays gone");

  await assert.rejects(() => dispatch("account", "DropChest", [ACCOUNT, 71, "token"]));
});

// The third parameter is the validation token, not a quantity. Reading it as a
// count sold a single potion out of the stack and left the rest in the bag,
// which is what "abandoning does nothing" looked like.
test("abandoning a potion takes the whole stack", async () => {
  await freshAccount({
    basic_currency: 500,
    account_stackables: [
      { id: 5, account_id: ACCOUNT, stack_id: 70000, count: 7 },
      { id: 6, account_id: ACCOUNT, stack_id: 70002, count: 1 },
    ],
  });

  const result = await dispatch("store", "SellStackable", [ACCOUNT, 5, "token"]);

  assert.deepEqual(result.account_stackables.map((row) => row.id), [6], "no remainder is left");
  assert.equal(result.basic_currency, 500, "and a potion is worth no gold");
});

/**
 * Training. The client sends the hero's whole build as four absolute totals, so
 * the request is a claim about what the account is entitled to and every part
 * of it is checked here. None of these rejections is visible to a player using
 * the real screen — they are the shapes a modified client would send.
 */
const trainee = (experience, placed = {}) =>
  freshAccount({
    active_avatar: 1,
    account_avatars: [
      {
        id: 1,
        account_id: ACCOUNT,
        avatar_id: 101, // Berserker
        experience,
        statupgrade1: 0,
        statupgrade2: 0,
        statupgrade3: 0,
        statupgrade4: 0,
        ...placed,
      },
    ],
  });

const train = (...slots) => dispatch("avatarrecord", "updateAvatarSlots", ["token", ACCOUNT, 1, ...slots]);

// Two points a level, and the ladder tops out at 100.
test("a hero may spend exactly the points its level earned", async () => {
  await trainee(0); // level 1
  await assert.rejects(() => train(3, 0, 0, 0), /having earned 2/);

  await train(2, 0, 0, 0);
  const spent = (await loadAccount(ACCOUNT)).account_avatars[0];
  assert.equal(spent.statupgrade1, 2, "the two it did earn go through");

  await trainee(9_999_999); // level 100
  await train(75, 75, 50, 0);
  assert.equal((await loadAccount(ACCOUNT)).account_avatars[0].statupgrade2, 75);
  await assert.rejects(() => train(75, 75, 51, 0), /having earned 200/);
});

test("no single stat passes 75, however many points are spare", async () => {
  await trainee(9_999_999);
  await assert.rejects(() => train(76, 0, 0, 0), /over the cap of 75/);
});

// A negative would mint points to spend elsewhere, and a fraction would slip
// past a naive sum check.
test("points are whole and never negative", async () => {
  await trainee(9_999_999);
  for (const bad of [-1, 2.5, NaN, null, undefined, "abc"]) {
    await assert.rejects(() => train(bad, 0, 0, 0), /whole number of points/);
  }
});

// Lowering a stat is a free respec: the points come back without the 20 gems.
test("a stat cannot be lowered without paying for a retrain", async () => {
  await trainee(9_999_999, { statupgrade1: 40 });
  await assert.rejects(() => train(39, 1, 0, 0), /needs a retrain/);
  assert.equal((await loadAccount(ACCOUNT)).account_avatars[0].statupgrade1, 40);
});

test("training answers with the avatar list the screen redraws from", async () => {
  await trainee(9_999_999);
  const result = await train(10, 0, 0, 0);
  assert.ok(Array.isArray(result.account_avatars));
  assert.equal(result.account_avatars[0].statupgrade1, 10);
});

test("a hero on another account cannot be trained", async () => {
  await trainee(9_999_999);
  await assert.rejects(() => dispatch("avatarrecord", "updateAvatarSlots", ["t", ACCOUNT, 999, 1, 0, 0, 0]));
});

/**
 * Retrain is sold as offer 51303, and it is the only offer with no OfferDetails
 * rows — the reset is not something the tables can describe, so the server has
 * to apply it. Twenty gems, and afterwards the points are free to move again.
 */
test("retraining costs gems and gives the points back", async () => {
  await trainee(9_999_999, { statupgrade1: 60, statupgrade2: 20 });
  await freshAccount({ premium_currency: 100 });

  const result = await dispatch("store", "PurchaseOffer", [ACCOUNT, 0, 51303, "token", {}]);

  assert.equal(result.premium_currency, 80, "twenty gems");
  const avatar = result.account_avatars[0];
  assert.deepEqual(
    [avatar.statupgrade1, avatar.statupgrade2, avatar.statupgrade3, avatar.statupgrade4],
    [0, 0, 0, 0]
  );

  // And the freed points can be placed somewhere else, which the monotonic
  // check would have blocked had the retrain not zeroed them first.
  await train(0, 0, 75, 0);
  assert.equal((await loadAccount(ACCOUNT)).account_avatars[0].statupgrade3, 75);
});

test("retraining a hero with nothing placed is refused, not charged", async () => {
  await trainee(9_999_999);
  await freshAccount({ premium_currency: 100 });

  await assert.rejects(() => dispatch("store", "PurchaseOffer", [ACCOUNT, 0, 51303, "token", {}]));
  assert.equal((await loadAccount(ACCOUNT)).premium_currency, 100, "a refused retrain is free");
});

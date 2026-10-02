import assert from "node:assert/strict";
import test from "node:test";

import { config, configProblems, loadServerConfig } from "../src/config.js";

/**
 * The amounts this server decided for itself, as settings.
 *
 * Most of what the game pays and allows is in its own tables. A handful of
 * numbers are not — nothing authors what a day's reward is worth, how many
 * weapons an account may list, how long before the same friend can be gifted
 * again — and they sat in the source as constants, where the only way to run a
 * server with a different one was to edit it. Each is a setting now, with the
 * value it always had as the default, and one that cannot be read falls back to
 * that rather than to nothing.
 */

/** Runs `body` with some settings changed and puts them back whatever happens. */
const withSettings = (changes, body) => {
  const usual = Object.fromEntries(Object.keys(changes).map((key) => [key, config[key]]));
  Object.assign(config, changes);
  try {
    return body();
  } finally {
    Object.assign(config, usual);
  }
};

test("left alone, every amount is the one the server always used", () => {
  const loaded = loadServerConfig({});

  assert.deepEqual(loaded.dailyRewardTiers, [5, 10, 15]);
  assert.equal(loaded.dailyReplayCost, 5);
  assert.equal(loaded.marketSlotsPerHero, 5);
  assert.equal(loaded.marketPriceCeilingMultiple, 50);
  assert.equal(loaded.marketMinCeiling, 1000);
  assert.equal(loaded.giftCooldownHours, 24);
  assert.equal(loaded.globalChatLineSeconds, 2);
  assert.equal(loaded.globalChatBurst, 3);
  assert.equal(loaded.healthBombReviveShare, 0.4);
  assert.equal(loaded.pickupUsableShare, 0.5);
  assert.equal(loaded.pickupScrapShare, 0.25);
});

test("each amount is read from the environment", () => {
  const loaded = loadServerConfig({
    ODS_DAILY_REWARD_TIERS: "10, 20, 40",
    ODS_DAILY_REPLAY_COST: "8",
    ODS_MARKET_SLOTS_PER_HERO: "3",
    ODS_MARKET_PRICE_CEILING_MULTIPLE: "20",
    ODS_MARKET_MIN_CEILING: "500",
    ODS_GIFT_COOLDOWN_HOURS: "12",
    ODS_GLOBAL_CHAT_LINE_SECONDS: "5",
    ODS_GLOBAL_CHAT_BURST: "1",
    ODS_HEALTH_BOMB_REVIVE_SHARE: "0.75",
    ODS_PICKUP_USABLE_SHARE: "0.8",
    ODS_PICKUP_SCRAP_SHARE: "0.1",
  });

  assert.deepEqual(loaded.dailyRewardTiers, [10, 20, 40]);
  assert.equal(loaded.dailyReplayCost, 8);
  assert.equal(loaded.marketSlotsPerHero, 3);
  assert.equal(loaded.marketPriceCeilingMultiple, 20);
  assert.equal(loaded.marketMinCeiling, 500);
  assert.equal(loaded.giftCooldownHours, 12);
  assert.equal(loaded.globalChatLineSeconds, 5);
  assert.equal(loaded.globalChatBurst, 1);
  assert.equal(loaded.healthBombReviveShare, 0.75);
  assert.equal(loaded.pickupUsableShare, 0.8);
  assert.equal(loaded.pickupScrapShare, 0.1);
});

/**
 * The reward screen has three labels and reads three numbers off the list, so
 * a list of any other length is not one it can show.
 */
test("a daily reward list that is not three amounts is not used", () => {
  for (const given of ["5,10", "5,10,15,20", "5,ten,15", "5,-1,15", ""]) {
    assert.deepEqual(
      loadServerConfig({ ODS_DAILY_REWARD_TIERS: given }).dailyRewardTiers,
      [5, 10, 15],
      JSON.stringify(given)
    );
  }
  assert.deepEqual(loadServerConfig({ ODS_DAILY_REWARD_TIERS: "0,0,0" }).dailyRewardTiers, [0, 0, 0], "nothing is an amount");
});

/**
 * Falling back is right — a reward list is no reason not to start — but doing
 * it silently is how somebody runs for a week believing they doubled the
 * reward. The server says so when it starts.
 */
test("a daily reward list that is not used is said at startup", () => {
  const { refusals, warnings } = configProblems({ ODS_DAILY_REWARD_TIERS: "5,10" });

  assert.deepEqual(refusals, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ODS_DAILY_REWARD_TIERS/);
  assert.match(warnings[0], /5,10,15/, "and what is being used instead");
  assert.deepEqual(configProblems({ ODS_DAILY_REWARD_TIERS: "10,20,40" }).warnings, []);
  assert.deepEqual(configProblems({ ODS_DAILY_REWARD_TIERS: "" }).warnings, [], "assigned nothing is the default");
});

test("an amount that cannot be read, or cannot be meant, is held to what makes sense", () => {
  const loaded = loadServerConfig({
    ODS_DAILY_REPLAY_COST: "-3",
    ODS_MARKET_SLOTS_PER_HERO: "0",
    ODS_MARKET_PRICE_CEILING_MULTIPLE: "many",
    ODS_MARKET_MIN_CEILING: "-1",
    ODS_GIFT_COOLDOWN_HOURS: "-5",
    ODS_GLOBAL_CHAT_LINE_SECONDS: "soon",
    ODS_GLOBAL_CHAT_BURST: "0",
    ODS_HEALTH_BOMB_REVIVE_SHARE: "4",
    ODS_PICKUP_USABLE_SHARE: "half",
    ODS_PICKUP_SCRAP_SHARE: "-0.5",
  });

  assert.equal(loaded.dailyReplayCost, 0, "a replay cannot pay the player");
  assert.equal(loaded.marketSlotsPerHero, 1, "an account can always list something");
  assert.equal(loaded.marketPriceCeilingMultiple, 50);
  assert.equal(loaded.marketMinCeiling, 0);
  assert.equal(loaded.giftCooldownHours, 0, "no cooldown at all");
  assert.equal(loaded.globalChatLineSeconds, 2);
  assert.equal(loaded.globalChatBurst, 1, "a line can always be said");
  assert.equal(loaded.healthBombReviveShare, 1, "a share stops at the whole bar");
  assert.equal(loaded.pickupUsableShare, 0.5);
  assert.equal(loaded.pickupScrapShare, 0);
});

test("a fraction of an hour is a gift cooldown, and of a second a chat interval", () => {
  const loaded = loadServerConfig({ ODS_GIFT_COOLDOWN_HOURS: "0.5", ODS_GLOBAL_CHAT_LINE_SECONDS: "0.5" });

  assert.equal(loaded.giftCooldownHours, 0.5);
  assert.equal(loaded.globalChatLineSeconds, 0.5);
});

test("the market's ceiling and slots follow their settings", async () => {
  const { ceilingFor, slotsFor } = await import("../src/market-rules.js");
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const { weaponSaleValue } = await import("../src/store.js");
  const gm = await loadGameMaster();
  const weapon = { rarity: 1, requiredlevel: 100, modifier1: 0, modifier2: 0 };
  const shop = weaponSaleValue(gm, weapon);
  const roster = { account_avatars: [{}, {}] };

  assert.equal(ceilingFor(gm, weapon), Math.max(1000, shop * 50));
  assert.equal(slotsFor(roster), 10);

  withSettings({ marketPriceCeilingMultiple: 2, marketMinCeiling: 0, marketSlotsPerHero: 3 }, () => {
    assert.equal(ceilingFor(gm, weapon), shop * 2);
    assert.equal(slotsFor(roster), 6);
  });
  withSettings({ marketPriceCeilingMultiple: 2, marketMinCeiling: 1_000_000 }, () => {
    assert.equal(ceilingFor(gm, weapon), 1_000_000, "the floor under the ceiling still holds");
  });
});

test("the global channel's allowance follows its settings", async () => {
  const { admitGlobalLine, forgetGlobalAllowances } = await import("../src/socket/global-chat.js");
  forgetGlobalAllowances();

  withSettings({ globalChatBurst: 1, globalChatLineSeconds: 10 }, () => {
    const at = 5_000_000;
    assert.deepEqual([0, 1].map(() => admitGlobalLine(41, at)), [true, false], "one line at once");
    assert.equal(admitGlobalLine(41, at + 9_999), false);
    assert.equal(admitGlobalLine(41, at + 10_000), true, "and the next ten seconds later");
  });
  forgetGlobalAllowances();
});

test("what food is worth walking over follows its settings", async () => {
  const { collectNearby } = await import("../src/socket/pickups.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  /** A hero at `share` of its health standing on food that offers `offered` of the bar. */
  const taken = (share, offered) => {
    const session = {
      id: 71,
      heroDoid: 500,
      heroManaPoints: 100,
      maxHeroManaPoints: 100,
      objects: new Map([[900, CLID.DistributedDooberGameObject]]),
      doobers: new Map([[900, { x: 1000, y: 1000, constant: "TEST_FOOD", hpPercentage: offered, mpPercentage: 0 }]]),
      actors: new Map([[500, { hitPoints: Math.round(1000 * share), maxHitPoints: 1000 }]]),
      send: () => {},
    };
    return collectNearby(session, { x: 1000, y: 1000 });
  };

  assert.equal(taken(0.8, 0.75), 0, "as shipped, a steak at eighty is waste");
  assert.equal(taken(0.97, 0.2), 1, "and a sausage is a scrap");

  withSettings({ pickupUsableShare: 0.2 }, () => {
    assert.equal(taken(0.8, 0.75), 1, "a lighter hand takes the steak");
  });
  withSettings({ pickupScrapShare: 0.1 }, () => {
    assert.equal(taken(0.97, 0.2), 0, "a sausage that is no longer a scrap has to be worth it");
    assert.equal(taken(0.85, 0.2), 1);
  });
});

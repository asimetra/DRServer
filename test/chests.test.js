import test from "node:test";
import assert from "node:assert/strict";
import { openChest, ChestError, NOTHING_AWARDED } from "../src/chests.js";
import { loadGameMaster } from "../src/gamemaster.js";

const LEGENDARY_CHEST = 60004; // its drop table is a weapon with probability 1
const BERSERKER = 101;
const GHOST_SAMURAI = 106;

const accountWith = (heroId, overrides = {}) => ({
  id: 1000000005,
  buckets_weapon: 50,
  legendary_keys: 99,
  rare_keys: 99,
  uncommon_keys: 99,
  basic_keys: 99,
  account_items: [],
  account_avatars: [{ id: 1, avatar_id: heroId, experience: 0 }],
  account_chests: [{ id: 9, account_id: 1000000005, chest_id: LEGENDARY_CHEST }],
  ...overrides,
});

let nextId = 0;
const ids = async () => ++nextId;

const open = (account, options = {}) =>
  openChest({ account, chestInstanceId: 9, heroInstanceId: 1, nextId: ids, ...options });

const masteryOf = (gm, heroId) =>
  new Set(
    Object.entries(gm.heroById.get(heroId))
      .filter(([key, value]) => key.endsWith("_TYPE") && value)
      .map(([key]) => key)
  );

test("awards a weapon and consumes the chest", async () => {
  const account = accountWith(BERSERKER);
  const reward = await open(account);

  assert.equal(reward.OfferId, null, "weapon rewards carry no offer");
  assert.equal(account.account_chests.length, 0, "the chest is spent");
  assert.equal(account.account_items.length, 1);
  assert.deepEqual(account.account_items[0], reward.NewWeaponDetails);
  assert.equal(reward.NewWeaponDetails.id, reward.WeaponId);
});

test("the award arrives unequipped and flagged as new", async () => {
  const item = (await open(accountWith(BERSERKER))).NewWeaponDetails;

  assert.equal(item.is_new, 1, "is_new is how the client spots the award");
  assert.equal(item.avatar_id, null);
  assert.equal(item.avatar_slot, null);
});

// The reason the request carries a hero at all: pick a Berserker and no bow
// can drop.
test("only rolls weapons the hero can wield", async () => {
  const gm = await loadGameMaster();

  for (const heroId of [BERSERKER, GHOST_SAMURAI]) {
    const allowed = masteryOf(gm, heroId);

    for (let attempt = 0; attempt < 100; attempt++) {
      const item = (await open(accountWith(heroId))).NewWeaponDetails;
      const weapon = gm.raw.WeaponItem.find((entry) => entry.Id === item.item_id);
      assert.ok(
        allowed.has(weapon.Mastertype),
        `${weapon.Constant} (${weapon.Mastertype}) is not usable by hero ${heroId}`
      );
    }
  }
});

test("modifiers follow the rarity table", async () => {
  const gm = await loadGameMaster();
  const rarityByType = new Map(gm.raw.Rarity.map((row) => [row.Type, row]));
  const legendary = rarityByType.get("LEGENDARY");
  const modifiers = new Map(gm.raw.Modifiers.map((row) => [row.Id, row]));

  for (let attempt = 0; attempt < 50; attempt++) {
    const item = (await open(accountWith(BERSERKER))).NewWeaponDetails;
    const rolled = [item.modifier1, item.modifier2].filter(Boolean).map((id) => modifiers.get(id));

    assert.equal(rolled.length, legendary.NumberOfModifiers);
    const types = new Set(rolled.map((modifier) => modifier.MODIFIER_TYPE));
    assert.equal(types.size, rolled.length, "modifier types are distinct");

    for (const modifier of rolled) {
      assert.ok(
        modifier.MODIFIER_LEVEL >= legendary.MinModifierLevel &&
          modifier.MODIFIER_LEVEL <= legendary.MaxModifierLevel,
        `modifier level ${modifier.MODIFIER_LEVEL} is outside the rarity's range`
      );
    }
  }
});

test("refuses when weapon storage is full", async () => {
  const account = accountWith(BERSERKER, { buckets_weapon: 1, account_items: [{ id: 1 }] });

  await assert.rejects(() => open(account), (error) => {
    assert.ok(error instanceof ChestError);
    assert.equal(error.code, NOTHING_AWARDED, "the live server's code for a refused award");
    return true;
  });

  assert.equal(account.account_chests.length, 1, "a refused open keeps the chest");
});

test("refuses a chest the account does not hold", async () => {
  const account = accountWith(BERSERKER, { account_chests: [] });
  await assert.rejects(() => open(account), { code: NOTHING_AWARDED });
});

test("spends a key of the chest's rarity, and only on success", async () => {
  const account = accountWith(BERSERKER, { legendary_keys: 2 });
  await open(account);
  assert.equal(account.legendary_keys, 1, "the key is spent with the chest");

  const broke = accountWith(BERSERKER, { legendary_keys: 0 });
  await assert.rejects(() => open(broke), { code: NOTHING_AWARDED });
  assert.equal(broke.legendary_keys, 0, "a refused open costs nothing");
  assert.equal(broke.account_chests.length, 1, "and keeps the chest");
});

// A legendary weapon shows three modifiers: two from the rarity plus one drawn
// from the separate legendary table, which the rarity row flags.
test("legendary rarity adds a legendary modifier", async () => {
  const gm = await loadGameMaster();
  const legendaryIds = new Set(gm.raw.LegendaryModifiers.map((row) => row.Id));

  for (let attempt = 0; attempt < 25; attempt++) {
    const item = (await open(accountWith(BERSERKER))).NewWeaponDetails;
    assert.ok(
      legendaryIds.has(item.legendarymodifier),
      `${item.legendarymodifier} is not a legendary modifier`
    );
  }
});

/**
 * Each WeaponItem row declares, column by column, which modifier types it can
 * take. Rolling outside that set is how a weapon ends up with a modifier it has
 * no business carrying.
 *
 * Asked of the weapon row rather than of a list kept here. This test used to
 * hold its own copy of the seven columns `chests.js` read, so when the real list
 * grew to the twenty-two the data authors, the test failed a roll that was
 * correct — it was checking a duplicate rather than the rule. A column named
 * after the modifier type is the game's own statement, and there is exactly one
 * type whose column is spelled differently.
 */
const COLUMN_FOR_TYPE = (type) =>
  type === "CHARGE_REDUC" ? "CHARGE_TIME_REDUCTION" : type;

test("modifiers stay within the types the weapon accepts", async () => {
  const gm = await loadGameMaster();
  const modifiers = new Map(gm.raw.Modifiers.map((row) => [row.Id, row]));
  const seen = new Set();

  for (let attempt = 0; attempt < 150; attempt++) {
    const item = (await open(accountWith(BERSERKER))).NewWeaponDetails;
    const weapon = gm.raw.WeaponItem.find((entry) => entry.Id === item.item_id);

    for (const id of [item.modifier1, item.modifier2].filter(Boolean)) {
      const modifier = modifiers.get(id);
      seen.add(modifier.MODIFIER_TYPE);
      assert.equal(
        weapon[COLUMN_FOR_TYPE(modifier.MODIFIER_TYPE)],
        true,
        `${weapon.Constant} cannot carry ${modifier.Constant} (${modifier.MODIFIER_TYPE})`
      );
    }
  }

  /**
   * And that the roll reaches past the seven types it used to be stuck on.
   * Twelve of the nineteen types the official puts on real items were
   * unreachable here, and they are forty-two per cent of its modifier slots.
   */
  assert.ok(seen.size > 7, `only ${seen.size} distinct types came up in 150 chests`);
});

// Declaring a modifier type is also what separates a current player weapon from
// enemy gear and retired HERO_LEGACY_* pieces.
test("never awards enemy or legacy weapons", async () => {
  const gm = await loadGameMaster();

  for (let attempt = 0; attempt < 100; attempt++) {
    const item = (await open(accountWith(BERSERKER))).NewWeaponDetails;
    const weapon = gm.raw.WeaponItem.find((entry) => entry.Id === item.item_id);

    assert.ok(weapon.Constant.startsWith("HERO_"), `${weapon.Constant} is not a hero weapon`);
    assert.ok(!weapon.Constant.includes("LEGACY"), `${weapon.Constant} is retired`);
  }
});

/**
 * The budget is for weapons the player is carrying around, not for the one in
 * their hands. The client's own count is `unequippedWeaponCount`, and its
 * `isEquipped` is `avatarId != 0` — so a weapon on an avatar takes no slot.
 *
 * Counting them here refused an open the client's screen said there was room
 * for. On the largest local account that was seventeen slots of daylight.
 */
test("a weapon in use does not fill the storage it is not sitting in", async () => {
  const account = accountWith(BERSERKER, {
    buckets_weapon: 1,
    account_items: [{ id: 1, avatar_id: 1 }],
  });

  const reward = await open(account);

  assert.ok(reward.WeaponId, "the open goes through");
  assert.equal(account.account_chests.length, 0, "and the chest is spent");
});

/**
 * Opening does not make the account any fuller. The chest goes and a weapon
 * arrives, so by the client's count — which includes chests — the number on the
 * screen does not move at all.
 *
 * Which is why chests are deliberately absent from this gate. Counting them
 * would leave a player whose storage is full *of chests* unable to open any of
 * them: the things filling the account would be the reason it could not be
 * emptied.
 */
test("chests are not what stops a chest being opened", async () => {
  const account = accountWith(BERSERKER, {
    buckets_weapon: 1,
    account_items: [],
    account_chests: [
      { id: 9, account_id: 1000000005, chest_id: LEGENDARY_CHEST },
      { id: 10, account_id: 1000000005, chest_id: LEGENDARY_CHEST },
      { id: 11, account_id: 1000000005, chest_id: LEGENDARY_CHEST },
    ],
  });

  const reward = await open(account);

  assert.ok(reward.WeaponId, "a full-of-chests account can still open one");
  assert.equal(account.account_chests.length, 2, "the opened one is gone");
  assert.equal(account.account_items.length, 1, "and its weapon took the freed slot");
});

/**
 * The offer branch.
 *
 * `ChestDropRates` spends columns `id_0` and `id_1` on "generate a weapon";
 * anything else is a real offer, and for treasure chests those offers are the
 * ladder's own rungs — a common chest can pay an uncommon key, an uncommon
 * chest a rare one, a rare chest a legendary one. Legendary chests are the one
 * rarity with no offer at all, which is what gives the reading away: there is
 * no rung above them.
 *
 * The distributions are authored in key order, so a `random` near the top of
 * the range lands on the tail deterministically.
 */
const COMMON_CHEST = 60001;
const RARE_CHEST = 60003;

const withChest = (chestId) => ({
  account_chests: [{ id: 9, account_id: 1000000005, chest_id: chestId }],
});

test("a chest that rolls an offer hands the offer over", async () => {
  const account = accountWith(BERSERKER, withChest(COMMON_CHEST));

  const reward = await open(account, { random: () => 0.97 });

  assert.equal(reward.OfferId, 51205, "the offer is named, for the reveal popup");
  assert.equal(reward.WeaponId, null, "and no weapon was generated");
  assert.equal(account.account_items.length, 0);
});

/**
 * A common chest is opened with a basic key and pays an uncommon one, so the
 * whole transaction is a rung up rather than a windfall.
 */
test("the offer's contents land on the account", async () => {
  const account = accountWith(BERSERKER, withChest(COMMON_CHEST));

  await open(account, { random: () => 0.97 });

  assert.equal(account.uncommon_keys, 100, "the key the offer grants");
  assert.equal(account.basic_keys, 98, "the key the chest cost");
  assert.deepEqual(account.account_chests, [], "and the chest is spent");
});

test("gem offers pay premium currency", async () => {
  const account = accountWith(BERSERKER, withChest(RARE_CHEST));

  const reward = await open(account, { random: () => 0.999 });

  assert.equal(reward.OfferId, 51253);
  assert.equal(account.premium_currency, 100);
});

/**
 * The refusal has to leave both halves alone. Spending the key and then failing
 * to grant would be worse than the refusal this replaced.
 */
test("an offer cannot be won without the key the chest costs", async () => {
  const account = accountWith(BERSERKER, { ...withChest(COMMON_CHEST), basic_keys: 0 });

  await assert.rejects(
    () => open(account, { random: () => 0.97 }),
    (error) => error.code === NOTHING_AWARDED
  );
  assert.equal(account.uncommon_keys, 99, "nothing was granted");
  assert.equal(account.account_chests.length, 1, "and the chest is still there");
});

/**
 * The branch that used to refuse everything: a weapon roll must still be a
 * weapon roll.
 */
test("a weapon roll is untouched by the offer path", async () => {
  const account = accountWith(BERSERKER, withChest(COMMON_CHEST));

  const reward = await open(account, { random: () => 0.01 });

  assert.ok(reward.WeaponId, "still a weapon");
  assert.equal(reward.OfferId, null);
  assert.equal(account.account_items.length, 1);
});

/**
 * A chest rolls the award's level around the opener's, ±2, and that spread has
 * a ceiling: the client refuses to equip an item whose `requiredLevel` is above
 * the hero's level (`DBInventoryInfo.canAvatarEquipThisItem`), and the Leveling
 * table stops at 100. Unclamped, the +2 handed a level-100 player a legendary
 * they could never hold — the roll's best outcomes were the ones it wasted.
 *
 * The official server does not produce them. Across 509 item rows on a captured
 * account the levels run 98, 99 and 100 and stop; not one is above.
 */
test("an award is never rolled past a level the hero can reach", async () => {
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(BERSERKER);
  const { maxLevel, experienceForLevel } = await import("../src/progression.js");
  const cap = maxLevel(gm, hero);

  for (const level of [cap, cap - 1]) {
    const seen = new Set();
    for (let round = 0; round < 200; round++) {
      const account = accountWith(BERSERKER, {
        account_avatars: [
          { id: 1, avatar_id: BERSERKER, experience: experienceForLevel(gm, hero, level) },
        ],
        account_chests: [{ id: 9, account_id: 1000000005, chest_id: LEGENDARY_CHEST }],
      });
      await open(account);
      for (const item of account.account_items) seen.add(item.requiredlevel);
    }

    const highest = Math.max(...seen);
    assert.ok(highest <= cap, `a hero at ${level} was awarded level ${highest}, past the ${cap} cap`);
    assert.ok(seen.has(cap), `and the cap itself is still reachable from ${level}`);
  }
});

/** Below the cap the spread is untouched — this clamps a ceiling, not the roll. */
test("the ±2 spread survives everywhere it fits", async () => {
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(BERSERKER);
  const { experienceForLevel } = await import("../src/progression.js");

  const seen = new Set();
  for (let round = 0; round < 300; round++) {
    const account = accountWith(BERSERKER, {
      account_avatars: [
        { id: 1, avatar_id: BERSERKER, experience: experienceForLevel(gm, hero, 50) },
      ],
      account_chests: [{ id: 9, account_id: 1000000005, chest_id: LEGENDARY_CHEST }],
    });
    await open(account);
    for (const item of account.account_items) seen.add(item.requiredlevel);
  }

  assert.deepEqual([...seen].sort((a, b) => a - b), [48, 49, 50, 51, 52]);
});

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
 */
const MODIFIER_COLUMNS = {
  DAMAGE: "DAMAGE",
  POISON: "POISON",
  CRIT_CHANCE: "CRIT_CHANCE",
  CRIT_DAMAGE: "CRIT_DAMAGE",
  ATKSPD: "ATKSPD",
  MANA_COST: "MANA_COST",
  CHARGE_TIME_REDUCTION: "CHARGE_REDUC",
};

const acceptedTypes = (weapon) =>
  new Set(
    Object.entries(MODIFIER_COLUMNS)
      .filter(([column]) => weapon[column])
      .map(([, type]) => type)
  );

test("modifiers stay within the types the weapon accepts", async () => {
  const gm = await loadGameMaster();
  const modifiers = new Map(gm.raw.Modifiers.map((row) => [row.Id, row]));

  for (let attempt = 0; attempt < 150; attempt++) {
    const item = (await open(accountWith(BERSERKER))).NewWeaponDetails;
    const weapon = gm.raw.WeaponItem.find((entry) => entry.Id === item.item_id);
    const allowed = acceptedTypes(weapon);

    for (const id of [item.modifier1, item.modifier2].filter(Boolean)) {
      const modifier = modifiers.get(id);
      assert.ok(
        allowed.has(modifier.MODIFIER_TYPE),
        `${weapon.Constant} cannot carry ${modifier.Constant} (${modifier.MODIFIER_TYPE})`
      );
    }
  }
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

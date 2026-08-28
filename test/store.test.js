import test from "node:test";
import assert from "node:assert/strict";
import { purchaseOffer, weaponSaleValue, stackableSaleValue, StoreError, REFUSED } from "../src/store.js";
import { loadGameMaster } from "../src/gamemaster.js";

const COMMON_KEY_COIN = 51201; // 1000 BASIC, grants one basic key
const RECRUIT_SWORD = 57537; // 1040 BASIC, grants a fixed weapon

let nextId = 0;
const ids = async () => ++nextId;

const account = (overrides = {}) => ({
  id: 1000000005,
  basic_currency: 100000,
  premium_currency: 100,
  basic_keys: 0,
  buckets_weapon: 50,
  account_items: [],
  account_stackables: [],
  ...overrides,
});

const buy = (target, offerId) => purchaseOffer({ account: target, offerId, nextId: ids });

test("charges the price from GameMaster, not the request", async () => {
  const gm = await loadGameMaster();
  const offer = gm.raw.Offers.find((row) => row.Id === COMMON_KEY_COIN);
  const target = account();

  const { touched } = await buy(target, COMMON_KEY_COIN);

  assert.equal(target.basic_currency, 100000 - offer.Price);
  assert.equal(target.basic_keys, 1, "the key is granted");
  assert.deepEqual(touched, [], "a key purchase changes no list");
});

test("a purchased weapon carries the stats the offer declares", async () => {
  const gm = await loadGameMaster();
  const detail = gm.raw.OfferDetails.find((row) => row.OfferId === RECRUIT_SWORD);
  const target = account();

  const { touched } = await buy(target, RECRUIT_SWORD);
  const [item] = target.account_items;

  assert.deepEqual(touched, ["account_items"]);
  assert.equal(item.item_id, detail.WeaponId);
  // Bought gear is not rolled: power and level come straight from the offer.
  assert.equal(item.power, detail.WeaponPower);
  assert.equal(item.requiredlevel, detail.Level);
  assert.equal(item.is_new, 1);
  assert.equal(item.avatar_id, null, "arrives unequipped");
});

// The client sends an offer id and nothing else, so these are the ways a
// modified one could try to get something for free.
test("refuses an offer that does not exist", async () => {
  await assert.rejects(() => buy(account(), 999999), (error) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, REFUSED);
    return true;
  });
});

test("refuses an offer the account cannot afford", async () => {
  const target = account({ basic_currency: 10 });

  await assert.rejects(() => buy(target, COMMON_KEY_COIN), { code: REFUSED });
  assert.equal(target.basic_currency, 10, "a refused purchase costs nothing");
  assert.equal(target.basic_keys, 0, "and grants nothing");
});

test("refuses offers priced in real money", async () => {
  const gm = await loadGameMaster();
  const paid = gm.raw.Offers.find(
    (row) => row.CurrencyType && !["BASIC", "PREMIUM"].includes(row.CurrencyType)
  );

  await assert.rejects(() => buy(account(), paid.Id), { code: REFUSED });
});

test("refuses a weapon when storage is full", async () => {
  const target = account({ buckets_weapon: 0 });

  await assert.rejects(() => buy(target, RECRUIT_SWORD), { code: REFUSED });
  assert.equal(target.basic_currency, 100000, "nothing is charged");
});

const RANGER = 51011; // 150 PREMIUM, grants hero 102

// A hero purchase that grants nothing is worse than a refusal: the shop takes
// the payment and the client then tries to draw a hero the account lacks.
test("buying a hero adds the avatar", async () => {
  const target = account({
    premium_currency: 1000,
    account_avatars: [{ id: 1, avatar_id: 101, skin_type: 151 }],
  });

  const { touched } = await buy(target, RANGER);
  const added = target.account_avatars.find((avatar) => avatar.avatar_id === 102);

  assert.deepEqual(touched.sort(), ["account_avatars", "account_items"]);
  assert.ok(added, "the hero is on the account");
  assert.equal(added.skin_type, 152, "on its default skin");
  assert.equal(added.experience, 0);
  assert.equal(target.premium_currency, 850);
});

// The capture shows a bought hero arriving with two weapons already in hand.
test("a bought hero arrives with two equipped starter weapons", async () => {
  const target = account({
    premium_currency: 1000,
    account_avatars: [{ id: 1, avatar_id: 101, skin_type: 151 }],
  });

  await buy(target, RANGER);
  const added = target.account_avatars.find((avatar) => avatar.avatar_id === 102);
  const starters = target.account_items.filter((item) => item.avatar_id === added.id);

  assert.equal(starters.length, 2);
  assert.deepEqual(starters.map((item) => item.avatar_slot).sort(), [0, 1]);
  assert.ok(starters.every((item) => item.requiredlevel === 1 && item.rarity === 1));
});

// Charging for a hero the account already owns is the shape of bug a player
// notices as gems draining for nothing.
test("refuses a hero the account already owns, without charging", async () => {
  const target = account({
    premium_currency: 1000,
    account_avatars: [{ id: 1, avatar_id: 101, skin_type: 151 }],
  });

  await buy(target, RANGER);
  const afterFirst = target.premium_currency;

  await assert.rejects(() => buy(target, RANGER), { code: REFUSED });

  const rangers = target.account_avatars.filter((avatar) => avatar.avatar_id === 102);
  assert.equal(rangers.length, 1, "not duplicated");
  assert.equal(target.premium_currency, afterFirst, "and not charged again");
});

/**
 * A client can name any offer id, and a modified one — or a data snapshot newer
 * than ours — may point at a hero we have no row for. Handing over an avatar the
 * rest of the server cannot resolve would corrupt the account rather than fail
 * the request.
 */
test("refuses an offer granting a hero this server does not know", async () => {
  const gm = await loadGameMaster();
  const offer = gm.raw.Offers.find((row) => row.CurrencyType === "PREMIUM" && row.Price > 0);
  const details = gm.raw.OfferDetails.filter((row) => row.OfferId === offer.Id);

  // Point an existing offer at a hero id that is not in the table.
  const original = details.map((row) => row.HeroId);
  details.forEach((row) => { row.HeroId = 999; });

  try {
    const target = account({ premium_currency: 100000 });
    await assert.rejects(() => buy(target, offer.Id), { code: REFUSED });
    assert.equal(target.premium_currency, 100000, "and is not charged");
  } finally {
    details.forEach((row, index) => { row.HeroId = original[index]; });
  }
});

/**
 * The item card works its own price out before the player clicks sell, so a
 * server that pays anything else is a number changing under their eyes. These
 * pin the formula to ItemInfo.get_sellCoins.
 */
test("a weapon sells for the share of the rarity's key price the client shows", async () => {
  const gm = await loadGameMaster();
  const rarity = gm.raw.Rarity.find((row) => row.Type === "LEGENDARY");
  const keyOffer = gm.raw.Offers.find((row) => row.Id === rarity.KeyOfferId);
  const base = keyOffer.CoinOfferId
    ? gm.raw.Offers.find((row) => row.Id === keyOffer.CoinOfferId).Price
    : keyOffer.Price;

  // A level-0 weapon with no modifiers sits exactly on the rarity's floor.
  const floor = weaponSaleValue(gm, { rarity: rarity.Id, requiredlevel: 0, power: 999 });
  assert.equal(floor, Math.round(rarity.MinSellPercent * base));

  // Power is not an input: the client never reads it when pricing a sale.
  assert.equal(weaponSaleValue(gm, { rarity: rarity.Id, requiredlevel: 0, power: 1 }), floor);
});

test("level and modifiers slide the price towards the rarity's ceiling", async () => {
  const gm = await loadGameMaster();
  const rarity = gm.raw.Rarity.find((row) => row.Type === "RARE");
  const strong = gm.raw.Modifiers.filter((row) => row.MODIFIER_LEVEL === rarity.MaxModifierLevel);

  const plain = weaponSaleValue(gm, { rarity: rarity.Id, requiredlevel: 1 });
  const levelled = weaponSaleValue(gm, { rarity: rarity.Id, requiredlevel: 100 });
  // A rarity only ever rolls NumberOfModifiers of them, and the weights are
  // scaled for exactly that many.
  const rolled = Object.fromEntries(
    strong.slice(0, rarity.NumberOfModifiers).map((row, index) => [`modifier${index + 1}`, row.Id])
  );
  const modded = weaponSaleValue(gm, { rarity: rarity.Id, requiredlevel: 100, ...rolled });

  assert.ok(levelled > plain, "a higher level is worth more");
  assert.ok(modded > levelled, "and so are modifiers");

  // Worked through by hand rather than asserted loosely. Note the percentages
  // are not a hard ceiling: the modifier term divides by NumberOfModifiers * 3,
  // which assumes level-3 modifiers, so a rarity allowing level 4 overshoots.
  // The client has no clamp either, and matching it is the point.
  const base = 20000; // the rare key's coin price
  const slide =
    1 * rarity.LevelWeight +
    ((rarity.NumberOfModifiers * rarity.MaxModifierLevel) / (rarity.NumberOfModifiers * 3)) *
      rarity.ModifierWeight;
  const expected = Math.round(
    ((rarity.MaxSellPercent - rarity.MinSellPercent) * slide + rarity.MinSellPercent) * base
  );
  assert.equal(modded, expected);
});

// The legendary modifier lives in its own field on the client and is left out
// of the sum, so it must not move the price here either.
test("the legendary modifier does not change the price", async () => {
  const gm = await loadGameMaster();
  const rarity = gm.raw.Rarity.find((row) => row.Type === "LEGENDARY");
  const item = { rarity: rarity.Id, requiredlevel: 40, modifier1: gm.raw.Modifiers[0].Id };

  assert.equal(
    weaponSaleValue(gm, { ...item, legendarymodifier: gm.raw.LegendaryModifiers[0].Id }),
    weaponSaleValue(gm, item)
  );
});

/**
 * Every stackable in the table has SellCoins 0. Potions are abandoned, not
 * sold, and paying gold for one would be inventing an income the game has no
 * source for.
 */
test("potions pay nothing, because none of them has a sale price", async () => {
  const gm = await loadGameMaster();
  assert.ok(gm.raw.Stackables.length > 0);
  for (const row of gm.raw.Stackables) {
    assert.equal(stackableSaleValue(gm, row.Id, 99), 0, `${row.Constant} pays gold`);
  }
});

/**
 * Two sales recorded against the live official server, replayed here. These are
 * the only evidence that the formula is the real one rather than a plausible
 * one, so they are pinned exactly — a change that moves either number by a
 * single coin is a change in behaviour the player would see.
 */
test("matches the payouts the official server gave", async () => {
  const gm = await loadGameMaster();

  for (const { label, paid, item } of [
    {
      label: "legendary, level 98, two level-5 modifiers",
      paid: 36617,
      item: { rarity: 4, requiredlevel: 98, power: 718, modifier1: 70125, modifier2: 70005 },
    },
    {
      label: "common, level 4, unmodified",
      paid: 152,
      item: { rarity: 1, requiredlevel: 4, power: 12, modifier1: 0, modifier2: 0 },
    },
  ]) {
    assert.equal(weaponSaleValue(gm, item), paid, label);
  }
});

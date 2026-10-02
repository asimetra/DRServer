import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The three free-gift offers (StoreServicesController.GIFT_OFFERS) are
 * rationed by the gift cooldown and shown only on the gift page. Sold through
 * store/PurchaseOffer they were free and unlimited — a revive bomb included.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-store-free-gifts-"));
const { loadAccount } = await import("../src/accounts.js");
const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");

test("a free-gift offer cannot be bought for oneself, over and over", async () => {
  const id = 1_000_000_601;
  const before = await loadAccount(id);
  const gold = before.basic_currency;
  const bombs = () => (before.account_stackables ?? []).filter((row) => row.stack_id === 60001).reduce((s, r) => s + r.count, 0);
  let bought = 0;
  for (let i = 0; i < 20; i += 1) {
    try {
      await dispatch("store", "PurchaseOffer", [id, "", 51301, ""], id);
      bought += 1;
    } catch {}
  }
  const after = await loadAccount(id);
  const count = (after.account_stackables ?? []).filter((row) => row.stack_id === 60001).reduce((s, r) => s + r.count, 0);
  assert.equal(bought, 0, "Health Bomb (Free Gift) bought directly");
  assert.equal(count, bombs(), "and none arrived");
  assert.equal(after.basic_currency, gold);
});

/**
 * Every store reply is the account's header, and the header was every field
 * that is not a list — so the account's own restriction and anti-cheat record
 * went to the client with each purchase, which the account-details route was
 * careful to leave out. A player watching their replies could read their own
 * strike count.
 */
test("a store reply carries none of the server's own records about the account", async () => {
  const { saveAccount } = await import("../src/accounts.js");
  const id = 1_000_000_602;
  const account = await loadAccount(id);
  account.basic_currency = 1_000_000;
  account.sanctions = { strikes: 2, level: 1 };
  account.restriction = null;
  account.market_barred = false;
  await saveAccount(account);

  const reply = await dispatch("store", "PurchaseOffer", [id, "", 51201, ""], id);
  assert.equal(reply.basic_keys, (account.basic_keys ?? 0) + 1, "the purchase went through");
  for (const field of ["sanctions", "restriction", "market_barred", "market_listings"]) {
    assert.equal(field in reply, false, `${field} is the server's own`);
  }
});

/**
 * A chest sold in the shop is bought and opened in one go: the client's chest
 * offer (UIChestOffer) buys it and straight away shows the reveal, reading the
 * loot from `customResult.purchasedChestResults` in the purchase's answer.
 * The price is the opening — no key is asked for or spent — and the chest does
 * not stay behind in the account.
 */
test("a chest bought in the shop opens at once, with no key", async () => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const { saveAccount } = await import("../src/accounts.js");
  const gm = await loadGameMaster();
  const CHEST_OFFER = 99_990_002;
  gm.raw.Offers.push({ Release: "L", Id: CHEST_OFFER, Price: 50000, Name: "Rare Chest", CurrencyType: "BASIC", Tab: "CHEST", Location: "STORE" });
  gm.raw.OfferDetails.push({ Release: "L", OfferId: CHEST_OFFER, Name: "Rare Chest", ChestId: 60003 });
  try {
    const id = 1_000_000_603;
    const account = await loadAccount(id);
    account.basic_currency = 1_000_000;
    account.rare_keys = 0;
    account.account_chests = [];
    await saveAccount(account);
    const hero = account.account_avatars[0].id;

    const reply = await dispatch("store", "PurchaseOffer", [id, hero, CHEST_OFFER, ""], id);
    const loot = reply.customResult?.purchasedChestResults;
    assert.ok(loot, "the reveal's loot is in the answer");
    assert.ok(loot.WeaponId || loot.OfferId, "and it is something");
    if (loot.WeaponId) {
      assert.ok(reply.account_items.some((item) => item.id === loot.WeaponId), "the weapon is in the inventory the answer carries");
    }

    const after = await loadAccount(id);
    assert.deepEqual(after.account_chests, [], "no chest left behind");
    assert.equal(after.rare_keys ?? 0, 0, "no key spent, none needed");
    assert.equal(after.basic_currency, 1_000_000 - 50000);
  } finally {
    gm.raw.Offers = gm.raw.Offers.filter((row) => row.Id !== CHEST_OFFER);
    gm.raw.OfferDetails = gm.raw.OfferDetails.filter((row) => row.OfferId !== CHEST_OFFER);
  }
});

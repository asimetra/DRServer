import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Weapons moving between two accounts in one write, on either backend.
 *
 * On PostgreSQL a weapon's id is a global key, so the order of the write
 * mattered: a trade the second party gave something in failed on the
 * duplicate key, and a bought weapon could not be listed again while its
 * seller had not yet claimed. Run with ODS_STORAGE=postgres and
 * ODS_DATABASE_URL to exercise the database.
 */
process.env.ODS_DATA_DIR ??= await fs.mkdtemp(path.join(os.tmpdir(), "dr-two-account-moves-"));
const { loadAccount, saveAccount, createAccount, closeAccountStorage } = await import("../src/accounts.js");
const { settleTrade } = await import("../src/trade.js");
const { listForSale, buyListing } = await import("../src/market.js");
test.after(() => closeAccountStorage());

const base = 1_000_700_000 + (Date.now() % 100_000) * 10;
const account = async (id, itemId) => {
  const fresh = await loadAccount(id);
  fresh.basic_currency = 1000;
  fresh.account_items = [...fresh.account_items,
    { id: itemId, account_id: id, avatar_id: null, avatar_slot: null, is_new: 0, item_id: 15001, power: 7, rarity: 2, requiredlevel: 1, modifier1: 0, modifier2: 0, legendarymodifier: 0 }];
  await saveAccount(fresh);
  return id;
};

test("a trade where the second party gives a weapon goes through", async () => {
  const first = await account(base + 1, base + 101);
  const second = await account(base + 2, base + 102);
  await settleTrade({ parties: [
    { accountId: first, items: [], gold: 10 },
    { accountId: second, items: [base + 102], gold: 0 },
  ] });
  assert.ok((await loadAccount(first)).account_items.some((row) => Number(row.id) === base + 102));
});

test("a trade where the first party gives a weapon goes through", async () => {
  const first = await account(base + 3, base + 103);
  const second = await account(base + 4, base + 104);
  await settleTrade({ parties: [
    { accountId: first, items: [base + 103], gold: 0 },
    { accountId: second, items: [], gold: 10 },
  ] });
  assert.ok((await loadAccount(second)).account_items.some((row) => Number(row.id) === base + 103));
});

test("a bought weapon can be listed again before its seller claims", async () => {
  const seller = await account(base + 5, base + 105);
  const buyer = await account(base + 6, base + 106);
  await listForSale({ sellerId: seller, itemId: base + 105, price: 100 });
  await buyListing({ listingId: base + 105, buyerId: buyer });
  await listForSale({ sellerId: buyer, itemId: base + 105, price: 100 });
  assert.ok((await loadAccount(buyer)).market_listings.some((row) => Number(row.id) === base + 105));
});

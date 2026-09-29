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
// These tests buy what they have just listed; the wait before a listing goes
// up has tests of its own (market.test.js).
process.env.ODS_MARKET_LISTING_DELAY_SECONDS = "0";
const { loadAccount, saveAccount, createAccount, closeAccountStorage } = await import("../src/accounts.js");
const { settleTrade } = await import("../src/trade.js");
const { listForSale, buyListing, cancelListing } = await import("../src/market.js");
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

/**
 * A weapon can come back to its seller — bought back — and go up again before
 * the first sale is claimed, leaving two listings under its id on one account.
 * The open one is the one a buyer or the seller means.
 */
test("a weapon back with its seller and listed again can be withdrawn, and bought", async () => {
  const weapon = base + 200;
  const seller = await account(base + 21, weapon);
  const buyer = await account(base + 22, base + 221);
  const third = await account(base + 23, base + 231);
  await listForSale({ sellerId: seller, itemId: weapon, price: 100 });
  await buyListing({ listingId: weapon, buyerId: buyer });
  await listForSale({ sellerId: buyer, itemId: weapon, price: 100 });
  await buyListing({ listingId: weapon, buyerId: seller });
  await listForSale({ sellerId: seller, itemId: weapon, price: 100 });
  const states = (await loadAccount(seller)).market_listings
    .filter((row) => Number(row.id) === weapon)
    .map((row) => (row.sold_to ? "sold" : "open"));
  assert.deepEqual(states.sort(), ["open", "sold"]);

  await cancelListing({ listingId: weapon, sellerId: seller });
  await listForSale({ sellerId: seller, itemId: weapon, price: 100 });
  await buyListing({ listingId: weapon, buyerId: third });
  const owned = (await loadAccount(third)).account_items.some((row) => Number(row.id) === weapon);
  assert.equal(owned, true, "withdrawn, put up again, and sold");
});

/**
 * Sold listings written before they had a table of their own sit among the
 * open ones, where the weapon's id still blocks its buyer from listing it
 * again. Startup moves them across; PostgreSQL only.
 */
test("sold listings from before their own table are moved out of the way", {
  skip: process.env.ODS_STORAGE !== "postgres" && "PostgreSQL only",
}, async () => {
  const { default: pg } = await import("pg");
  const { moveSoldListingsOut } = await import("../src/storage/postgres.js");
  const weapon = base + 300;
  const seller = await account(base + 31, weapon);
  const buyer = await account(base + 32, base + 321);
  await listForSale({ sellerId: seller, itemId: weapon, price: 100 });
  await buyListing({ listingId: weapon, buyerId: buyer });

  const client = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
  await client.connect();
  try {
    // As a server before the table wrote it: the sold row among the open ones.
    await client.query(
      `INSERT INTO market_listings SELECT id, account_id, item_id, price, listed_at, sold_to, sold_at, tax,
         proceeds, power, requiredlevel, rarity, modifier1, modifier2, legendarymodifier, created
         FROM market_sold_listings WHERE account_id = $1`,
      [seller]
    );
    await client.query("DELETE FROM market_sold_listings WHERE account_id = $1", [seller]);
    await assert.rejects(
      listForSale({ sellerId: buyer, itemId: weapon, price: 100 }),
      /market_listings_pkey/,
      "the old row still blocks it"
    );

    assert.equal(await moveSoldListingsOut(client), 1);
    assert.equal(await moveSoldListingsOut(client), 0, "and a second run finds nothing");
  } finally {
    await client.end();
  }
  await listForSale({ sellerId: buyer, itemId: weapon, price: 100 });
  const sellerRows = (await loadAccount(seller)).market_listings.filter((row) => Number(row.id) === weapon);
  assert.deepEqual(sellerRows.map((row) => row.sold_to), [buyer], "the seller is still owed");
});

/**
 * An older server still running on the same database writes a sold listing
 * back among the open ones — it has never heard of the other table. The sale
 * is then in both, and must still be paid once, and moved without doubling.
 */
test("a sale written in both tables is read, moved and paid once", {
  skip: process.env.ODS_STORAGE !== "postgres" && "PostgreSQL only",
}, async () => {
  const { default: pg } = await import("pg");
  const { moveSoldListingsOut } = await import("../src/storage/postgres.js");
  const { claimProceeds } = await import("../src/market.js");
  const weapon = base + 400;
  const seller = await account(base + 41, weapon);
  const buyer = await account(base + 42, base + 421);
  await listForSale({ sellerId: seller, itemId: weapon, price: 100 });
  await buyListing({ listingId: weapon, buyerId: buyer });

  const client = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
  await client.connect();
  try {
    // The older server's save: the sold row among the open ones, again.
    await client.query(
      `INSERT INTO market_listings SELECT id, account_id, item_id, price, listed_at, sold_to, sold_at, tax,
         proceeds, power, requiredlevel, rarity, modifier1, modifier2, legendarymodifier, created
         FROM market_sold_listings WHERE account_id = $1`,
      [seller]
    );
    const sold = (await loadAccount(seller)).market_listings.filter((row) => row.sold_to);
    assert.equal(sold.length, 1, "one sale, read once");

    await moveSoldListingsOut(client);
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM market_sold_listings WHERE account_id = $1",
      [seller]
    );
    assert.equal(rows[0].n, 1, "and moved without a second copy");
  } finally {
    await client.end();
  }
  const before = (await loadAccount(seller)).basic_currency;
  const claimed = await claimProceeds({ sellerId: seller });
  assert.equal(claimed.gold - before, claimed.claimed);
  assert.equal(claimed.listings.length, 1, "paid for once");
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-market-test-"));
process.env.ODS_DATA_DIR = dataDir;

const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { holdAccount, releaseAccount, forgetHeldAccounts } = await import(
  "../src/account-registry.js"
);
const { listForSale, buyListing, cancelListing, claimProceeds, browse, stallFor } =
  await import("../src/market.js");

test.after(async () => {
  delete process.env.ODS_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

test.afterEach(() => forgetHeldAccounts());

let nextId = 1;
const anId = () => 1_000_000 + nextId++;

/** An account on disk, with a bag and some gold. */
const anAccount = async ({ id = anId(), gold = 1000, items = [] } = {}) => {
  const account = {
    id,
    name: `Player${id}`,
    basic_currency: gold,
    premium_currency: 0,
    buckets_weapon: 50,
    buckets_other: 15,
    account_items: items.map((item) => ({
      account_id: id,
      avatar_id: null,
      avatar_slot: null,
      is_new: 0,
      item_id: 15001,
      power: 7,
      rarity: 2,
      ...item,
    })),
    account_avatars: [],
    account_stackables: [],
    account_chests: [],
    account_pets: [],
    account_skins: [],
    account_attributes: [],
  };
  await saveAccount(account);
  return account;
};

const weapon = (id, over = {}) => ({ id, ...over });

/**
 * The whole point of holding a listing on the account.
 *
 * A listed weapon must not be in `account_items`, because that list is what the
 * client is sent as the bag — left there it would still be shown, equipped and
 * sold to the shop, and this server does not change the client.
 */
test("a listed weapon leaves the bag", async () => {
  const seller = await anAccount({ items: [weapon(7001)] });

  await listForSale({ sellerId: seller.id, itemId: 7001, price: 250 });

  const after = await loadAccount(seller.id);
  assert.equal(after.account_items.length, 0, "not in the bag");
  assert.equal(after.market_listings.length, 1, "in the market");
  assert.equal(after.market_listings[0].price, 250);
  assert.equal(after.market_listings[0].sold_to, null);
});

/**
 * The id travels with the weapon. It is the identity of that instance — the
 * same number the protocol uses as its object id — so what the buyer receives
 * is the weapon that was put up rather than a copy of it.
 */
test("the buyer receives the very weapon, and pays for it", async () => {
  const seller = await anAccount({ gold: 0, items: [weapon(7002, { power: 42 })] });
  const buyer = await anAccount({ gold: 900 });

  await listForSale({ sellerId: seller.id, itemId: 7002, price: 300 });
  const sale = await buyListing({ listingId: 7002, buyerId: buyer.id });

  assert.equal(sale.price, 300);

  const buyerAfter = await loadAccount(buyer.id);
  assert.equal(buyerAfter.basic_currency, 600, "the gold left the buyer");
  assert.deepEqual(
    buyerAfter.account_items.map((item) => [item.id, item.power, item.is_new]),
    [[7002, 42, 1]],
    "the same instance, badged new in its new bag"
  );

  const sellerAfter = await loadAccount(seller.id);
  assert.equal(sellerAfter.basic_currency, 0, "and has not arrived unannounced");
  assert.equal(sellerAfter.market_listings[0].sold_to, buyer.id);
});

test("the proceeds are claimed, once", async () => {
  const seller = await anAccount({ gold: 50, items: [weapon(7003), weapon(7004)] });
  const buyer = await anAccount({ gold: 5000 });

  await listForSale({ sellerId: seller.id, itemId: 7003, price: 300 });
  await listForSale({ sellerId: seller.id, itemId: 7004, price: 120 });
  await buyListing({ listingId: 7003, buyerId: buyer.id });
  await buyListing({ listingId: 7004, buyerId: buyer.id });

  const claim = await claimProceeds({ sellerId: seller.id });
  assert.equal(claim.claimed, 420, "both sales at once");
  assert.equal(claim.gold, 470);

  const again = await claimProceeds({ sellerId: seller.id });
  assert.equal(again.claimed, 0, "there is nothing left to collect");
  assert.equal((await loadAccount(seller.id)).basic_currency, 470);
});

test("a withdrawn listing comes back to the bag", async () => {
  const seller = await anAccount({ items: [weapon(7005)] });

  await listForSale({ sellerId: seller.id, itemId: 7005, price: 999 });
  await cancelListing({ listingId: 7005, sellerId: seller.id });

  const after = await loadAccount(seller.id);
  assert.deepEqual(after.account_items.map((item) => item.id), [7005]);
  assert.equal(after.market_listings.length, 0);
});

/**
 * A sale is not a withdrawal. The weapon is somebody else's and the gold is
 * owed — taking the listing down would have to take the weapon back off them.
 */
test("a sold listing cannot be withdrawn", async () => {
  const seller = await anAccount({ items: [weapon(7006)] });
  const buyer = await anAccount({ gold: 500 });

  await listForSale({ sellerId: seller.id, itemId: 7006, price: 100 });
  await buyListing({ listingId: 7006, buyerId: buyer.id });

  await assert.rejects(
    () => cancelListing({ listingId: 7006, sellerId: seller.id }),
    (error) => error.reason === "already_sold"
  );
});

/**
 * Two buyers reaching for one listing.
 *
 * Both get past the first look, because the first look is outside the lock. The
 * look that decides is the one inside it, and only one of them finds the
 * listing unsold — so the weapon is delivered once and charged for once.
 */
test("only one of two buyers gets the weapon", async () => {
  const seller = await anAccount({ items: [weapon(7007)] });
  const first = await anAccount({ gold: 500 });
  const second = await anAccount({ gold: 500 });

  await listForSale({ sellerId: seller.id, itemId: 7007, price: 200 });

  const results = await Promise.allSettled([
    buyListing({ listingId: 7007, buyerId: first.id }),
    buyListing({ listingId: 7007, buyerId: second.id }),
  ]);

  const won = results.filter((one) => one.status === "fulfilled");
  const lost = results.filter((one) => one.status === "rejected");
  assert.equal(won.length, 1, "one sale");
  assert.equal(lost.length, 1, "one refusal");
  assert.equal(lost[0].reason.reason, "gone");

  const [a, b] = [await loadAccount(first.id), await loadAccount(second.id)];
  assert.equal(a.account_items.length + b.account_items.length, 1, "delivered once");
  assert.equal(Number(a.basic_currency) + Number(b.basic_currency), 800, "charged once");
});

test("a listing cannot be bought without the gold for it", async () => {
  const seller = await anAccount({ items: [weapon(7008)] });
  const buyer = await anAccount({ gold: 99 });

  await listForSale({ sellerId: seller.id, itemId: 7008, price: 100 });

  await assert.rejects(
    () => buyListing({ listingId: 7008, buyerId: buyer.id }),
    (error) => error.reason === "not_enough_gold"
  );
  assert.equal((await loadAccount(buyer.id)).basic_currency, 99, "and is not charged");
});

test("nobody buys their own listing", async () => {
  const seller = await anAccount({ gold: 5000, items: [weapon(7009)] });
  await listForSale({ sellerId: seller.id, itemId: 7009, price: 100 });

  await assert.rejects(
    () => buyListing({ listingId: 7009, buyerId: seller.id }),
    (error) => error.reason === "own_listing"
  );
});

/**
 * The same refusal the trade settle gives, for the same reason: the hero's
 * statistics were worked out from what it is holding.
 */
test("an equipped weapon is refused rather than taken off", async () => {
  const seller = await anAccount({ items: [weapon(7010, { avatar_id: 5, avatar_slot: 1 })] });

  await assert.rejects(
    () => listForSale({ sellerId: seller.id, itemId: 7010, price: 100 }),
    (error) => error.reason === "equipped"
  );
});

test("a weapon somebody does not hold cannot be listed", async () => {
  const seller = await anAccount({ items: [weapon(7011)] });

  await assert.rejects(
    () => listForSale({ sellerId: seller.id, itemId: 7012, price: 100 }),
    (error) => error.reason === "not_owned"
  );
});

test("a price has to be gold, whole and positive", async () => {
  const seller = await anAccount({ items: [weapon(7013)] });

  for (const price of [0, -5, 1.5, "free", null, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      () => listForSale({ sellerId: seller.id, itemId: 7013, price }),
      (error) => error.reason === "bad_price",
      `${price} is not a price`
    );
  }
});

/**
 * Nobody rearranges their bag mid-run — the same rule the trade settle has, and
 * for the same reason: the weapons are in a run that is still going.
 */
test("a player in a dungeon does not list or withdraw", async () => {
  const seller = await anAccount({ items: [weapon(7014)] });
  holdAccount(await loadAccount(seller.id));

  await assert.rejects(
    () => listForSale({ sellerId: seller.id, itemId: 7014, price: 100 }),
    (error) => error.reason === "in_dungeon"
  );
  releaseAccount(seller.id);
});

/**
 * But a seller who is playing does not make their listing unbuyable.
 *
 * Their weapon is in the market rather than in their hand, so a sale takes
 * nothing they are using — and refusing here would close the market exactly
 * when its sellers are most likely to be online.
 */
test("a sale goes through while the seller is in a dungeon", async () => {
  const seller = await anAccount({ items: [weapon(7015)] });
  const buyer = await anAccount({ gold: 500 });

  await listForSale({ sellerId: seller.id, itemId: 7015, price: 150 });
  holdAccount(await loadAccount(seller.id));

  const sale = await buyListing({ listingId: 7015, buyerId: buyer.id });
  assert.equal(sale.price, 150);
  releaseAccount(seller.id);

  assert.equal((await loadAccount(seller.id)).market_listings[0].sold_to, buyer.id);
});

test("a full bag refuses a purchase rather than losing the weapon", async () => {
  const seller = await anAccount({ items: [weapon(7016)] });
  const buyer = await anAccount({
    gold: 500,
    items: Array.from({ length: 3 }, (_, index) => weapon(7100 + index)),
  });

  // The bag is what the client counts, and this one is full at three.
  const account = await loadAccount(buyer.id);
  account.buckets_weapon = 3;
  await saveAccount(account);

  await listForSale({ sellerId: seller.id, itemId: 7016, price: 100 });
  await assert.rejects(
    () => buyListing({ listingId: 7016, buyerId: buyer.id }),
    (error) => error.reason === "no_room"
  );

  assert.equal((await loadAccount(buyer.id)).basic_currency, 500, "and is not charged");
  assert.equal((await loadAccount(seller.id)).market_listings[0].sold_to, null, "still up");
});

test("the market shows what is up, and a stall shows what is owed", async () => {
  const seller = await anAccount({ items: [weapon(7017), weapon(7018)] });
  const buyer = await anAccount({ gold: 5000 });

  await listForSale({ sellerId: seller.id, itemId: 7017, price: 400 });
  await listForSale({ sellerId: seller.id, itemId: 7018, price: 500 });
  await buyListing({ listingId: 7017, buyerId: buyer.id });

  const up = await browse({ limit: 200 });
  const mine = up.filter((listing) => listing.seller_id === seller.id);
  assert.deepEqual(mine.map((listing) => listing.id), [7018], "a sold one is not still on sale");
  assert.equal(mine[0].seller_name, seller.name);

  const stall = await stallFor(seller.id);
  assert.deepEqual(stall.listed.map((listing) => listing.id), [7018]);
  assert.deepEqual(stall.sold.map((listing) => listing.id), [7017]);
  assert.equal(stall.owed, 400);
});

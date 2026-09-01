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

  /* Asked of `shareOf` rather than written out, so this says "both sales, after
     the tax" and not "420" — a rate the operator changes must not need a test
     rewritten to agree with it. */
  const { shareOf } = await import("../src/market-rules.js");
  const owed = shareOf(300).proceeds + shareOf(120).proceeds;

  const claim = await claimProceeds({ sellerId: seller.id });
  assert.equal(claim.claimed, owed, "both sales at once");
  assert.equal(claim.gold, 50 + owed);

  const again = await claimProceeds({ sellerId: seller.id });
  assert.equal(again.claimed, 0, "there is nothing left to collect");
  assert.equal((await loadAccount(seller.id)).basic_currency, 50 + owed);
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

  const { shareOf } = await import("../src/market-rules.js");
  const stall = await stallFor(seller.id);
  assert.deepEqual(stall.listed.map((listing) => listing.id), [7018]);
  assert.deepEqual(stall.sold.map((listing) => listing.id), [7017]);
  assert.equal(stall.owed, shareOf(400).proceeds, "what is owed is after the tax");
});

test("browse cache is invalidated by list and sale mutations", async () => {
  const seller = await anAccount({ items: [weapon(7020), weapon(7021)] });
  const buyer = await anAccount({ gold: 5000 });

  await listForSale({ sellerId: seller.id, itemId: 7020, price: 100 });
  assert.ok((await browse({ limit: 200 })).some((listing) => listing.id === 7020));

  await listForSale({ sellerId: seller.id, itemId: 7021, price: 200 });
  const afterList = await browse({ limit: 200 });
  assert.ok(afterList.some((listing) => listing.id === 7021), "a new listing bypasses the old snapshot");

  await buyListing({ listingId: 7020, buyerId: buyer.id });
  const afterBuy = await browse({ limit: 200 });
  assert.ok(!afterBuy.some((listing) => listing.id === 7020), "a sold listing leaves immediately");
});

/* ---------------------------------------------------------- market rules - */

/**
 * Slots scale with the roster, because the account that exists to receive gold
 * is a fresh one with a single starting hero.
 */
test("listings are capped, and the cap follows the roster", async () => {
  const { SLOTS_PER_HERO } = await import("../src/market-rules.js");
  const seller = await anAccount({
    items: Array.from({ length: SLOTS_PER_HERO + 1 }, (_, index) => weapon(7300 + index)),
  });
  const account = await loadAccount(seller.id);
  account.account_avatars = [{ id: 1, avatar_id: 101 }];
  await saveAccount(account);

  for (let index = 0; index < SLOTS_PER_HERO; index++) {
    await listForSale({ sellerId: seller.id, itemId: 7300 + index, price: 100 });
  }
  await assert.rejects(
    () => listForSale({ sellerId: seller.id, itemId: 7300 + SLOTS_PER_HERO, price: 100 }),
    (error) => error.reason === "no_slots"
  );

  // A second hero buys another five.
  const grown = await loadAccount(seller.id);
  grown.account_avatars.push({ id: 2, avatar_id: 102 });
  await saveAccount(grown);
  const listed = await listForSale({ sellerId: seller.id, itemId: 7300 + SLOTS_PER_HERO, price: 100 });
  assert.equal(listed.id, 7300 + SLOTS_PER_HERO);
});

/**
 * The ceiling is what the shop would pay times a generous multiple. It is loose
 * where honest trade happens and tight where laundering does, because the shop
 * value is a rarity ladder — see market-rules.js.
 */
test("a price above the ceiling is refused, and an honest one is not", async () => {
  const seller = await anAccount({ items: [weapon(7400, { rarity: 1, requiredlevel: 1 })] });

  await assert.rejects(
    () => listForSale({ sellerId: seller.id, itemId: 7400, price: 1_000_000 }),
    (error) => error.reason === "over_ceiling",
    "a common weapon is not a way to hand over a million"
  );

  const listed = await listForSale({ sellerId: seller.id, itemId: 7400, price: 5000 });
  assert.equal(listed.price, 5000);
});

test("the ceiling rises with rarity, so an elite weapon is not blocked", async () => {
  const { ceilingFor } = await import("../src/market-rules.js");
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();

  const ceilings = [1, 2, 3, 4].map((rarity) =>
    ceilingFor(gm, { rarity, requiredlevel: 100, modifier1: 0, modifier2: 0 })
  );
  for (let index = 1; index < ceilings.length; index++) {
    assert.ok(ceilings[index] > ceilings[index - 1] * 3, `rarity ${index + 1} is far above ${index}`);
  }
  assert.ok(ceilings[3] > 1_000_000, "a legendary may be asked more than anybody here holds");
});

/**
 * The tax is settled at the sale rather than at the claim: a rate changed later
 * must not reprice gold somebody has already earned.
 */
test("the market keeps its cut, and the seller is owed the rest", async () => {
  const { shareOf } = await import("../src/market-rules.js");
  const seller = await anAccount({ gold: 0, items: [weapon(7500)] });
  const buyer = await anAccount({ gold: 5000 });

  await listForSale({ sellerId: seller.id, itemId: 7500, price: 1000 });
  await buyListing({ listingId: 7500, buyerId: buyer.id });

  const { tax, proceeds } = shareOf(1000);
  assert.equal(tax + proceeds, 1000, "the two add back to the price");
  assert.ok(tax > 0);

  const stall = await stallFor(seller.id);
  assert.equal(stall.owed, proceeds, "owed is after tax");

  const claim = await claimProceeds({ sellerId: seller.id });
  assert.equal(claim.claimed, proceeds);
  assert.equal((await loadAccount(seller.id)).basic_currency, proceeds);
  assert.equal((await loadAccount(buyer.id)).basic_currency, 4000, "the buyer pays the full price");
});

/** A mule is as useful to somebody moving gold as a seller is, so both go. */
test("a barred account neither lists nor buys", async () => {
  const seller = await anAccount({ items: [weapon(7600)] });
  const barred = await anAccount({ gold: 5000, items: [weapon(7601)] });

  const account = await loadAccount(barred.id);
  account.market_barred = true;
  await saveAccount(account);

  await assert.rejects(
    () => listForSale({ sellerId: barred.id, itemId: 7601, price: 100 }),
    (error) => error.reason === "barred"
  );

  await listForSale({ sellerId: seller.id, itemId: 7600, price: 100 });
  await assert.rejects(
    () => buyListing({ listingId: 7600, buyerId: barred.id }),
    (error) => error.reason === "barred"
  );
});

/* --------------------------------------------------------- sales history - */

/**
 * A listing is deleted at the claim, so without a history a completed sale
 * leaves nothing behind — and a sale is the one thing here that moves value
 * between two people.
 */
test("a completed sale is written down, and survives the claim", async () => {
  const { salesFor } = await import("../src/market-history.js");
  const seller = await anAccount({ gold: 0, items: [weapon(7700, { rarity: 2, power: 21 })] });
  const buyer = await anAccount({ gold: 5000 });

  await listForSale({ sellerId: seller.id, itemId: 7700, price: 900 });
  await buyListing({ listingId: 7700, buyerId: buyer.id });
  await claimProceeds({ sellerId: seller.id });

  // The listing is gone from the account, which is the whole point of the file.
  assert.deepEqual((await loadAccount(seller.id)).market_listings, []);

  const [sale] = await salesFor(seller.id);
  assert.equal(sale.listing_id, 7700);
  assert.equal(sale.seller_id, seller.id);
  assert.equal(sale.buyer_id, buyer.id);
  assert.equal(sale.price, 900);
  assert.equal(sale.tax + sale.proceeds, 900, "the split is recorded, and adds back");
  assert.equal(sale.rarity, 2, "and what was sold, not a pointer to it");
  assert.equal(sale.power, 21);
});

/**
 * Both sides. The question a profile is opened to ask is what somebody has been
 * doing in the market, and half an answer invites the wrong conclusion.
 */
test("a history is both what somebody sold and what they bought", async () => {
  const { salesFor } = await import("../src/market-history.js");
  const one = await anAccount({ gold: 5000, items: [weapon(7710)] });
  const two = await anAccount({ gold: 5000, items: [weapon(7711)] });

  await listForSale({ sellerId: one.id, itemId: 7710, price: 100 });
  await buyListing({ listingId: 7710, buyerId: two.id });
  await listForSale({ sellerId: two.id, itemId: 7711, price: 200 });
  await buyListing({ listingId: 7711, buyerId: one.id });

  const mine = await salesFor(one.id);
  assert.equal(mine.length, 2, "one sale each way");
  assert.deepEqual(
    mine.map((sale) => (sale.seller_id === one.id ? "sold" : "bought")).sort(),
    ["bought", "sold"]
  );
});

/**
 * The name each side held at the time, so a row is readable a year later after
 * somebody has been renamed or has stopped playing.
 */
test("a sale remembers what both were called", async () => {
  const { salesFor } = await import("../src/market-history.js");
  const seller = await anAccount({ items: [weapon(7720)] });
  const buyer = await anAccount({ gold: 5000 });

  await listForSale({ sellerId: seller.id, itemId: 7720, price: 150 });
  await buyListing({ listingId: 7720, buyerId: buyer.id });

  const [sale] = await salesFor(seller.id);
  assert.equal(sale.seller_name, seller.name);
  assert.equal(sale.buyer_name, buyer.name);
});

/** Somebody who has done nothing has an empty history, not a failure. */
test("an account with no market history reads as none", async () => {
  const { salesFor } = await import("../src/market-history.js");
  const quiet = await anAccount({});
  assert.deepEqual(await salesFor(quiet.id), []);
});

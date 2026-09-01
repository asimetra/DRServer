import {
  listAccountIds,
  loadAccount,
  saveAccount,
  saveAccounts,
  withAccountLock,
  withTwoAccountLocks,
} from "./accounts.js";
import { heldAccount } from "./account-registry.js";
import { occupiedSlots, storageLimit } from "./inventory-space.js";
import { loadGameMaster } from "./gamemaster.js";
import { ceilingFor, isBarred, shareOf, slotsFor } from "./market-rules.js";
import { recordSale, saleRecord } from "./market-history.js";
import { info } from "./log.js";

/**
 * A market, rather than a trade.
 *
 * One player puts a weapon up at a price and walks away; anybody may buy it;
 * the seller collects the gold when they next look. Nobody has to be online at
 * the same time as anybody else, which is the whole difference from a two-sided
 * negotiation and the reason a market is worth having on a server whose players
 * are not all awake at once.
 *
 * Where a listed weapon lives is the only hard part, and it decides everything
 * else. It cannot stay in `account_items`: that list is what the client is sent
 * as the player's bag, so a listed weapon would still be shown, still be
 * equippable, and still be sellable to the shop — and this server does not
 * change the client. So a listing holds the weapon itself, and the weapon is
 * off the account for as long as it is up.
 *
 * That is a move between two places, and a move is where things get lost. It is
 * made safe by keeping both places inside the same account: `market_listings`
 * is a child of the account exactly as `account_items` is, so listing a weapon
 * is one account write rather than an account write and a market write with a
 * crash-shaped gap between them. Every operation here is a single save:
 *
 *   list    account_items -> market_listings          one account
 *   buy     market_listings -> the buyer's items,     two accounts, one write
 *           and the gold the other way
 *   cancel  market_listings -> account_items          one account
 *   claim   the proceeds of sold listings -> gold     one account
 *
 * `saveAccounts` already writes several accounts as one transaction, and the
 * registry already means a seller who is mid-dungeon is the same object this
 * mutates. Nothing new had to be made atomic.
 */

export class MarketRefused extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "MarketRefused";
    this.reason = reason;
  }
}

const refuse = (reason, message) => new MarketRefused(reason, message);

const accountIdOf = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffff_ffff) {
    throw refuse("bad_account", `${value} is not an account id`);
  }
  return id;
};

/**
 * A price is gold, whole and positive.
 *
 * Nothing is free: a listing at nothing is far more likely to be a slip of the
 * hand than a gift, and there is already a way to hand somebody a weapon.
 */
const MAX_PRICE = 2_000_000_000;

const priceOf = (value) => {
  const price = Number(value);
  if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) {
    throw refuse("bad_price", `${value} is not a price in gold`);
  }
  return price;
};

const listingIdOf = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw refuse("bad_listing", `${value} is not a listing`);
  }
  return id;
};

/** Nobody rearranges their bag mid-run; the same rule the trade settle has. */
const refuseIfPlaying = (id) => {
  if (heldAccount(id)) throw refuse("in_dungeon", `account ${id} is in a dungeon`);
};

const listingsOf = (account) => (account.market_listings ??= []);

const openListings = (account) =>
  listingsOf(account).filter((listing) => !listing.sold_to);

const soldListings = (account) =>
  listingsOf(account).filter((listing) => Boolean(listing.sold_to));

const BROWSE_CACHE_MS = 2000;
let browseCache = null;
const invalidateBrowse = () => {
  browseCache = null;
};

/**
 * What a listing carries of the weapon.
 *
 * The columns a weapon is, minus the three that describe where it was: a listed
 * weapon is in nobody's hand, so `avatar_id` and `avatar_slot` have no meaning,
 * and `is_new` is a badge for the bag it lands in rather than a property of the
 * object.
 *
 * The id is the listing's id. A weapon's id is the identity of that instance —
 * the same number the protocol uses as its object id — so the listing is
 * identified by the thing it holds, and the buyer receives the very weapon that
 * was put up rather than a copy of it.
 */
const asListing = (item, price) => ({
  id: Number(item.id),
  item_id: item.item_id,
  price,
  listed_at: new Date().toISOString(),
  sold_to: null,
  sold_at: null,
  power: item.power ?? null,
  requiredlevel: item.requiredlevel ?? null,
  rarity: item.rarity ?? null,
  modifier1: item.modifier1 ?? null,
  modifier2: item.modifier2 ?? null,
  legendarymodifier: item.legendarymodifier ?? null,
  created: item.created ?? null,
});

/** The weapon again, on its way into somebody's bag. */
const asItem = (listing, accountId) => ({
  id: Number(listing.id),
  account_id: accountId,
  item_id: listing.item_id,
  power: listing.power ?? null,
  avatar_id: null,
  avatar_slot: null,
  is_new: 1,
  requiredlevel: listing.requiredlevel ?? null,
  rarity: listing.rarity ?? null,
  modifier1: listing.modifier1 ?? null,
  modifier2: listing.modifier2 ?? null,
  legendarymodifier: listing.legendarymodifier ?? null,
  created: listing.created ?? null,
});

/** What the market shows about a listing, with who is asking. */
const asView = (listing, sellerId, sellerName) => ({
  id: Number(listing.id),
  seller_id: sellerId,
  seller_name: sellerName ?? null,
  item_id: listing.item_id,
  price: Number(listing.price),
  listed_at: listing.listed_at,
  power: listing.power ?? null,
  rarity: listing.rarity ?? null,
  requiredlevel: listing.requiredlevel ?? null,
  modifier1: listing.modifier1 ?? null,
  modifier2: listing.modifier2 ?? null,
  legendarymodifier: listing.legendarymodifier ?? null,
});

/**
 * Room for one more weapon.
 *
 * Counted the way the client counts and the trade settle counts, so a bag that
 * is full here is a bag the player sees as full.
 */
const refuseIfNoRoom = (account) => {
  const after = occupiedSlots(account) + 1;
  if (after > storageLimit(account)) {
    throw refuse("no_room", `account ${account.id} would hold ${after} of ${storageLimit(account)} slots`);
  }
};

/**
 * Puts a weapon up.
 *
 * The weapon leaves the bag in the same write that creates the listing, so
 * there is no moment at which it is in both places or in neither.
 */
export const listForSale = async ({ sellerId, itemId, price } = {}) => {
  const seller = accountIdOf(sellerId);
  const asking = priceOf(price);
  const wanted = listingIdOf(itemId);

  refuseIfPlaying(seller);

  return withAccountLock(seller, async () => {
    // Checked again inside the lock: a run can begin between the first look and
    // here, and this is the one that decides.
    refuseIfPlaying(seller);

    const account = await loadAccount(seller);
    if (isBarred(account)) throw refuse("barred", `account ${seller} may not use the market`);

    const item = (account.account_items ?? []).find((row) => Number(row.id) === wanted);
    if (!item) throw refuse("not_owned", `account ${seller} does not hold item ${wanted}`);

    /* The same refusal the trade settle gives, for the same reason: the hero's
       statistics were worked out from what it is holding, and a weapon that
       vanished out of a hand is a surprise where "unequip it first" is a
       sentence. */
    if (Number(item.avatar_id ?? 0)) {
      throw refuse("equipped", `item ${wanted} is equipped — unequip it first`);
    }

    /* Slots scale with the roster, because the account that exists to receive
       gold is a fresh one with a single hero. Counted inside the lock, so two
       listings racing cannot both find the last slot free. */
    const slots = slotsFor(account);
    if (openListings(account).length >= slots) {
      throw refuse("no_slots", `account ${seller} already has ${slots} listings up`);
    }

    /* A ceiling of what the shop would pay, times a generous multiple. It is
       loose where honest trade happens and tight where laundering does — see
       market-rules.js for the measurements behind the number. */
    const ceiling = ceilingFor(await loadGameMaster(), item);
    if (asking > ceiling) {
      throw refuse("over_ceiling", `${asking} is above the ${ceiling} ceiling for this weapon`);
    }

    account.account_items.splice(account.account_items.indexOf(item), 1);
    listingsOf(account).push(asListing(item, asking));
    await saveAccount(account);
    invalidateBrowse();

    info(`market: ${seller} listed item ${wanted} at ${asking} gold`);
    return asView(listingsOf(account).find((row) => Number(row.id) === wanted), seller, account.name);
  });
};

/**
 * Finds which account is holding a listing.
 *
 * A scan of the population, which is what this server's population makes
 * reasonable — the data directory is the population, and it is small. An index
 * would be faster and would be one more thing that can disagree with the
 * accounts; when a scan stops being cheap enough, that is the moment to measure
 * and add one.
 */
const sellerHolding = async (listingId) => {
  for (const id of await listAccountIds()) {
    const account = await loadAccount(id);
    const listing = listingsOf(account).find((row) => Number(row.id) === listingId);
    if (listing && !listing.sold_to) return id;
  }
  return null;
};

/**
 * Buys one.
 *
 * The seller is not asked whether they are in a dungeon. Their weapon is in the
 * market rather than in their hand, so a sale takes nothing they are using —
 * and refusing while they play would make every listing unbuyable exactly when
 * its owner is most likely to be online.
 */
export const buyListing = async ({ listingId, buyerId } = {}) => {
  const wanted = listingIdOf(listingId);
  const buyer = accountIdOf(buyerId);

  refuseIfPlaying(buyer);

  const seller = await sellerHolding(wanted);
  if (seller === null) throw refuse("gone", `listing ${wanted} is no longer up`);
  if (seller === buyer) throw refuse("own_listing", "you cannot buy your own listing");

  return withTwoAccountLocks(seller, buyer, async () => {
    refuseIfPlaying(buyer);

    const sellerAccount = await loadAccount(seller);
    const buyerAccount = await loadAccount(buyer);
    if (isBarred(buyerAccount)) throw refuse("barred", `account ${buyer} may not use the market`);

    /* Looked up again inside the lock, which is the look that decides: two
       buyers reaching for the same listing both got past the check above, and
       only the one that gets here first finds it unsold. */
    const listing = listingsOf(sellerAccount).find((row) => Number(row.id) === wanted);
    if (!listing || listing.sold_to) throw refuse("gone", `listing ${wanted} is no longer up`);

    const price = Number(listing.price);
    if (price > Number(buyerAccount.basic_currency ?? 0)) {
      throw refuse("not_enough_gold", `account ${buyer} does not have ${price} gold`);
    }
    refuseIfNoRoom(buyerAccount);

    buyerAccount.basic_currency = Number(buyerAccount.basic_currency ?? 0) - price;
    buyerAccount.account_items.push(asItem(listing, buyer));

    /* The listing stays on the seller, sold. That is where the proceeds live
       until they are claimed: gold that appeared in the bag unannounced would
       be gold the client is showing without having been told why. */
    listing.sold_to = buyer;
    listing.sold_at = new Date().toISOString();
    /* The tax is settled here rather than at the claim, so what is owed is
       fixed at the moment of the sale. A rate changed later must not quietly
       reprice gold somebody has already earned. */
    const { tax, proceeds } = shareOf(price);
    listing.tax = tax;
    listing.proceeds = proceeds;

    await saveAccounts([sellerAccount, buyerAccount]);
    invalidateBrowse();

    /*
     * The permanent record, written after the money has moved and never before
     * it. A listing is deleted at the claim, so without this a completed sale
     * leaves nothing behind — and a sale is the one thing here that moves value
     * between two people, which is exactly what a history is for.
     *
     * Not awaited into the result: it cannot fail the sale, because the sale is
     * already durable and undoing it because the paperwork failed would be the
     * worse outcome. `recordSale` logs its own failures.
     */
    await recordSale(
      saleRecord({
        listing,
        sellerId: seller,
        sellerName: sellerAccount.name,
        buyerId: buyer,
        buyerName: buyerAccount.name,
      })
    );

    /* Written down because this is the one thing here that moves value between
       two people, and "it was not me" is the complaint an operator cannot
       answer from the account rows alone — they only show where things ended. */
    info(`market: ${buyer} bought item ${wanted} from ${seller} for ${price} gold`);

    return {
      listing: wanted,
      item_id: listing.item_id,
      price,
      seller_id: seller,
      buyer_id: buyer,
      gold: Number(buyerAccount.basic_currency),
    };
  });
};

/**
 * Takes one back down.
 *
 * Only while it is still up. A sold listing is not cancellable — the weapon is
 * somebody else's and the gold is owed; that is a claim, not a withdrawal.
 */
export const cancelListing = async ({ listingId, sellerId } = {}) => {
  const wanted = listingIdOf(listingId);
  const seller = accountIdOf(sellerId);

  refuseIfPlaying(seller);

  return withAccountLock(seller, async () => {
    refuseIfPlaying(seller);

    const account = await loadAccount(seller);
    const listing = listingsOf(account).find((row) => Number(row.id) === wanted);
    if (!listing) throw refuse("gone", `account ${seller} has no listing ${wanted}`);
    if (listing.sold_to) throw refuse("already_sold", `listing ${wanted} has sold — claim it instead`);

    refuseIfNoRoom(account);

    account.market_listings = listingsOf(account).filter((row) => row !== listing);
    account.account_items.push(asItem(listing, seller));
    await saveAccount(account);
    invalidateBrowse();

    info(`market: ${seller} withdrew item ${wanted}`);
    return { listing: wanted, item_id: listing.item_id };
  });
};

/**
 * Collects what has sold.
 *
 * Everything at once rather than one listing at a time: the seller's question
 * is "what am I owed", not "what did each of these go for", and one write is
 * one write.
 */
export const claimProceeds = async ({ sellerId } = {}) => {
  const seller = accountIdOf(sellerId);

  refuseIfPlaying(seller);

  return withAccountLock(seller, async () => {
    refuseIfPlaying(seller);

    const account = await loadAccount(seller);
    const sold = soldListings(account);
    if (!sold.length) return { claimed: 0, gold: Number(account.basic_currency ?? 0), listings: [] };

    /* `?? price` is for listings sold before the tax existed: they were owed
       the whole price and still are. */
    const total = sold.reduce((sum, listing) => sum + Number(listing.proceeds ?? listing.price), 0);
    account.basic_currency = Number(account.basic_currency ?? 0) + total;
    account.market_listings = listingsOf(account).filter((row) => !row.sold_to);
    await saveAccount(account);

    info(`market: ${seller} claimed ${total} gold from ${sold.length} sold listings`);
    return {
      claimed: total,
      gold: Number(account.basic_currency),
      listings: sold.map((listing) => ({
        id: Number(listing.id),
        item_id: listing.item_id,
        price: Number(listing.price),
        tax: Number(listing.tax ?? 0),
        proceeds: Number(listing.proceeds ?? listing.price),
        sold_to: listing.sold_to,
        sold_at: listing.sold_at,
      })),
    };
  });
};

/** Everything that is up, newest first, before a caller chooses a page. */
export const browseAll = async () => {
  if (browseCache && Date.now() - browseCache.at < BROWSE_CACHE_MS) {
    return browseCache.rows;
  }
  const found = [];

  for (const id of await listAccountIds()) {
    const account = await loadAccount(id);
    for (const listing of openListings(account)) {
      found.push(asView(listing, id, account.name));
    }
  }

  const rows = found.sort((a, b) => String(b.listed_at).localeCompare(String(a.listed_at)));
  browseCache = { at: Date.now(), rows };
  return rows;
};

/** Backward-compatible bounded view for callers that only need the newest rows. */
export const browse = async ({ limit = 50 } = {}) => {
  const size = Math.max(1, Math.min(200, Number(limit) || 50));
  return (await browseAll()).slice(0, size);
};

/** One seller's own: what is still up, and what is waiting to be collected. */
export const stallFor = async (sellerId) => {
  const seller = accountIdOf(sellerId);
  const account = await loadAccount(seller);

  return {
    account_id: seller,
    listed: openListings(account).map((listing) => asView(listing, seller, account.name)),
    sold: soldListings(account).map((listing) => ({
      id: Number(listing.id),
      item_id: listing.item_id,
      price: Number(listing.price),
      tax: Number(listing.tax ?? 0),
      proceeds: Number(listing.proceeds ?? listing.price),
      sold_at: listing.sold_at,
    })),
    owed: soldListings(account).reduce(
      (sum, listing) => sum + Number(listing.proceeds ?? listing.price),
      0
    ),
  };
};

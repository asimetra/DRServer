import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { warn } from "./log.js";

/**
 * What the market has actually done, kept for good.
 *
 * The listings themselves are not a history and cannot be made into one. A
 * listing lives on the seller's account so that putting a weapon up is a single
 * atomic write, and the price of that arrangement is that every account save
 * rewrites all of its listings — so a list that grew for the life of the server
 * would make saving an account slower every week. They stay bounded: open, then
 * sold, then gone at the claim.
 *
 * This is where they go instead. Append-only, one row per completed sale, off
 * the account write path entirely — the same shape and the same reasoning as
 * `dungeon-runs.jsonl` next door, and for the same reason: a record that is
 * read rarely and written once should not be carried by the thing that is
 * written constantly.
 *
 * It is written at the sale rather than at the claim. A seller who never
 * collects is exactly the seller worth having a record of, and waiting for them
 * to press a button before writing one down would be leaving the gap open for
 * whoever most wants it left open.
 */

const usingDatabase = () => config.storage === "postgres";

let database = null;
const db = async () => {
  database ??= await import("./storage/postgres.js");
  return database;
};

const SALES_FILE = "market-sales.jsonl";
const file = (name) => path.join(config.dataDir, name);

/**
 * What a sale is, once it has happened.
 *
 * Both sides by id *and* by the name each held at the time. The id is what
 * makes two rows the same person; the name is what makes a row readable a year
 * later, after somebody has been renamed or has stopped playing. Storing only
 * the id would mean a page of history could not be drawn without loading every
 * account it mentions.
 *
 * The weapon is described rather than referenced. The item itself has moved on
 * — it is in the buyer's bag and may since have been sold to the shop — so
 * pointing at it would be pointing at something that changes. What was sold is
 * a fact about the moment.
 */
export const saleRecord = ({ listing, sellerId, sellerName, buyerId, buyerName }) => ({
  listing_id: Number(listing.id),
  at: listing.sold_at ?? new Date().toISOString(),
  seller_id: Number(sellerId),
  seller_name: sellerName ?? null,
  buyer_id: Number(buyerId),
  buyer_name: buyerName ?? null,
  item_id: listing.item_id,
  rarity: listing.rarity ?? null,
  power: listing.power ?? null,
  requiredlevel: listing.requiredlevel ?? null,
  price: Number(listing.price),
  tax: Number(listing.tax ?? 0),
  proceeds: Number(listing.proceeds ?? listing.price),
  listed_at: listing.listed_at ?? null,
});

/**
 * Writes one down.
 *
 * A failure is logged and dropped rather than thrown, the way a run record is:
 * the sale itself is already durable — the gold moved and the weapon moved on
 * their own transaction — and undoing a completed sale because the paperwork
 * failed would be the worse of the two outcomes. It is logged loudly because a
 * missing row here is a missing piece of evidence.
 */
export const recordSale = async (sale) => {
  try {
    if (usingDatabase()) {
      await (await db()).recordSale(sale);
      return true;
    }
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.appendFile(file(SALES_FILE), `${JSON.stringify(sale)}\n`, "utf8");
    return true;
  } catch (problem) {
    warn(`market: could not record the sale of listing ${sale?.listing_id}: ${problem.message}`);
    return false;
  }
};

/**
 * What one account has bought and sold, newest first.
 *
 * Both sides of it, because the question somebody opens a profile to ask is
 * "what has this person been doing in the market", and half an answer invites
 * the wrong conclusion — a player who only ever buys looks very different from
 * one who only ever sells, and you cannot see either from one side alone.
 */
export const salesFor = async (accountId, { limit = 50 } = {}) => {
  const id = Number(accountId);
  const size = Math.max(1, Math.min(200, Number(limit) || 50));

  if (usingDatabase()) return (await db()).salesFor(id, size);

  let text;
  try {
    text = await fs.readFile(file(SALES_FILE), "utf8");
  } catch (problem) {
    if (problem.code !== "ENOENT") warn(`market: could not read the sales history: ${problem.message}`);
    return [];
  }

  const mine = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const sale = JSON.parse(line);
      if (sale.seller_id === id || sale.buyer_id === id) mine.push(sale);
    } catch {
      // One unreadable line is not a reason to lose the rest of the history.
    }
  }

  /* Read whole and sorted rather than walked backwards from the end. The file
     is in the order sales happened, which is very nearly time order but not
     guaranteed to be — the same mistake `runsSince` made once. */
  return mine.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, size);
};

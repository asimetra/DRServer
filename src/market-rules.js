import { config } from "./config.js";
import { weaponSaleValue } from "./store.js";

/**
 * What the market will not let somebody do.
 *
 * A market between players is a way to move gold, and that is what it is for —
 * but it is also the way somebody moves gold to an alt or to a buyer outside
 * the game, by listing a worthless weapon at an enormous price and buying it
 * themselves. None of these rules stop that outright. What they do is make it
 * slow, lossy and visible, which is as far as a rule can get: a determined pair
 * of accounts can always meet in a dungeon.
 *
 * The numbers below come from measuring this server rather than from a feel for
 * what sounds strict.
 */

/**
 * A ceiling of so many times what the game shop would pay.
 *
 * `weaponSaleValue` turned out to be a rarity ladder rather than a measure of
 * how good a roll is: across the whole modifier range the best legendary is
 * worth about 1.3x the worst one, while a legendary is worth 200x a common.
 * That is exactly the shape this rule wants.
 *
 *   common     shop 151      ceiling 7,550
 *   uncommon   shop 801      ceiling 40,050
 *   rare       shop 5,005    ceiling 250,250
 *   legendary  shop 30,025   ceiling 1,501,250
 *
 * The median account on this server holds 1,000 gold. So the ceiling on a
 * genuinely elite weapon is far above anything anybody can pay, and no honest
 * sale is refused — while somebody trying to hand over a million on a junk
 * weapon needs a hundred and thirty sales to do it, against a listing cap and a
 * tax. The rule bites where the laundering is and nowhere else.
 */
export const PRICE_CEILING_MULTIPLE = 50;

/**
 * And a floor under the ceiling, so a weapon the shop values at nothing is
 * still worth something here. Nothing in the weapon rarities values at zero
 * today; this is for the row that does not exist yet.
 */
export const MIN_CEILING = 1_000;

/**
 * Slots to list in, per hero owned.
 *
 * Per hero rather than flat, because the account that exists to receive gold is
 * a fresh one — it has a single starting hero and no reason to acquire more, so
 * scaling with the roster is the cheapest thing that separates a player from a
 * mule. A new account gets five, which is enough to sell what a bag holds; a
 * full roster of six gets thirty.
 */
export const SLOTS_PER_HERO = 5;

/**
 * What the market keeps of a sale.
 *
 * A tax is the ordinary reason a market has one — gold leaves the economy
 * rather than only moving around it — and it is also what makes laundering
 * lossy. Ten per cent compounds: moving gold through ten sales leaves two
 * thirds of it.
 */
export const TAX_RATE = 0.1;

/** The most a weapon may be asked for, given what the shop would pay for it. */
export const ceilingFor = (gm, item) =>
  Math.max(MIN_CEILING, weaponSaleValue(gm, item) * PRICE_CEILING_MULTIPLE);

/** How many listings this account may have up at once. */
export const slotsFor = (account) =>
  Math.max(1, (account?.account_avatars ?? []).length) * SLOTS_PER_HERO;

/**
 * What the seller is owed when a listing sells, and what the market keeps.
 *
 * Rounded so the two always add back to the price — a rounding that loses a
 * coin somewhere is a rounding somebody eventually notices.
 */
export const shareOf = (price) => {
  const tax = Math.round(Number(price) * (config.marketTaxRate ?? TAX_RATE));
  return { tax, proceeds: Number(price) - tax };
};

/**
 * Whether this account may take part at all.
 *
 * Its own column rather than a bit in `account_flags`. That field is
 * transcribed from captures and goes to the client, and this server does not
 * know which bits the client reads — writing meaning into one would be
 * guessing at somebody else's format. `market_barred` is the server's own, and
 * is stripped from the account payload the way `market_listings` is.
 *
 * Listing and buying are both refused, because a mule is as useful to somebody
 * moving gold as a seller is.
 */
export const isBarred = (account) => Boolean(account?.market_barred);

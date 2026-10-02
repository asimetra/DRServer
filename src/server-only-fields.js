/**
 * The account's fields that are this server's own records, never the client's.
 *
 * `market_listings` is a child of the account so that listing a weapon is one
 * atomic write; the market bar, the restriction and the anti-cheat record
 * (restrictions.js, sanctions.js) are decisions about the player. The client was
 * never told any of them exists and parses its replies with code this server
 * does not change — and a player reading their own replies should not find
 * their strike count there.
 */
export const SERVER_ONLY_FIELDS = new Set(["market_listings", "market_barred", "restriction", "sanctions"]);

/** The account as the client may see it: everything else, as it is. */
export const forTheClient = (account) =>
  Object.fromEntries(Object.entries(account).filter(([field]) => !SERVER_ONLY_FIELDS.has(field)));

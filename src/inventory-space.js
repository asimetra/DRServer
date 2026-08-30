/**
 * How full weapon storage is, by the client's arithmetic rather than ours.
 *
 * The client is the authority here for the plain reason that it is the thing
 * the player reads, and the thing we cannot change. Its count is
 * `unequippedWeaponCount` — unequipped weapons plus held chests, against
 * `buckets_weapon`. The server had its own count, all items against the same
 * budget, and the two disagreed in both directions at once: the server counted
 * equipped weapons the client does not, and skipped the chests the client does.
 *
 * Measured across the local accounts, every one of them disagreed. The largest
 * had a budget of 80 with the server counting 45 and the client 28 — seventeen
 * equipped weapons of daylight, in which the player is shown room the server
 * would refuse to use.
 *
 * Nothing here decides *which* count a given gate wants; that depends on what
 * the operation does to occupancy, and the two callers differ. See each.
 */

/** Equipped is `avatarId != 0` on the client, and that is the whole test. */
export const unequippedWeapons = (account) =>
  (account?.account_items ?? []).filter((item) => !Number(item?.avatar_id ?? 0)).length;

export const heldChests = (account) => (account?.account_chests ?? []).length;

/** What the client draws as used: the two of them together. */
export const occupiedSlots = (account) => unequippedWeapons(account) + heldChests(account);

export const storageLimit = (account) => Number(account?.buckets_weapon ?? 0);

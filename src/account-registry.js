/**
 * One account object per account, for as long as somebody is playing it.
 *
 * The server reads accounts in two very different rhythms. A socket session
 * loads one when the dungeon starts and keeps it for the length of the run,
 * mutating it as gold, experience and chests arrive. Every JSON-RPC, meanwhile,
 * reads its own copy, changes one thing and writes the whole account back.
 *
 * Two copies of one row, and whichever saves last wins. That is not a
 * hypothetical: from a captured session, a player opened a chest on the report
 * screen, was dropped into the inventory by the reveal popup — still inside the
 * dungeon — equipped the weapon and dropped a spare chest over JSON-RPC, and
 * then left. The teardown wrote the copy the session had loaded at dungeon
 * *entry* and undid both.
 *
 * A registry is the smaller half of the answer. While a session holds an
 * account, `loadAccount` hands out that same object instead of re-reading the
 * file, so an RPC's change is not a change to a different copy — it is a change
 * to the one the session is already holding, and saving either of them writes
 * both. `withAccountLock` remains the other half: it stops two writers
 * interleaving, and this stops them diverging.
 *
 * Held by count rather than by flag, because the same account legitimately
 * arrives twice — a party member's session and the seed's, or a second login
 * displacing the first while the old socket is still draining. The entry lives
 * until the last holder lets go, and no longer: this is a registry of who is
 * playing, not a cache, and an account nobody holds must be read from storage
 * so an edit made outside the server is not ignored.
 */

const held = new Map();

/** The live object for this account, or null when nobody is holding one. */
export const heldAccount = (id) => held.get(Number(id))?.account ?? null;

/**
 * Takes a hold on an account, returning the object every holder shares.
 *
 * A second holder gets the object already in play rather than the one it
 * arrived with — that is the whole point, and the caller is expected to use the
 * return value rather than what it passed in.
 */
export const holdAccount = (account) => {
  const key = Number(account?.id);
  if (!Number.isFinite(key)) return account;

  const entry = held.get(key);
  if (entry) {
    entry.holders += 1;
    return entry.account;
  }
  held.set(key, { account, holders: 1 });
  return account;
};

/** Lets go. The object stays reachable until the last holder has released it. */
export const releaseAccount = (id) => {
  const key = Number(id);
  const entry = held.get(key);
  if (!entry) return false;

  entry.holders -= 1;
  if (entry.holders > 0) return false;
  held.delete(key);
  return true;
};

/** Test seam: nothing in the server clears the whole registry. */
export const forgetHeldAccounts = () => held.clear();

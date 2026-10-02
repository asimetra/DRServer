/**
 * Deleting an account, when its player asks.
 *
 * A hosted server whose website keeps e-mail addresses has to be able to. What
 * goes is the account and every row of it (accounts.js deleteStoredAccount),
 * its standings and run history (leaderboard.js), and its name from the market
 * history, whose sales stay because they are the other side's history too.
 *
 * Nobody may be holding it while it goes. A dungeon writes its account when the
 * run ends, and a write after the deletion would put the rows back — so this
 * waits for the account to be let go, under its lock, for as long as it is
 * given, and reports false rather than deleting under somebody. The caller has
 * revoked its tokens and disconnected it first (internal.js): the server makes
 * an account the first time a valid token arrives for one, so a token left good
 * would bring this one back, empty.
 */
import { AccountLeasedError, accountWritesSettled, deleteStoredAccount, withAccountLock } from "./accounts.js";
import { heldAccount } from "./account-registry.js";
import { forgetAccountRuns } from "./leaderboard.js";
import { anonymiseSales } from "./market-history.js";

/** True once it is gone; false if somebody was still playing it when the time ran out. */
export const deleteAccount = async (accountId, { waitMs = 15_000, pollMs = 250 } = {}) => {
  const id = Number(accountId);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (!heldAccount(id)) {
      try {
        const gone = await withAccountLock(id, async () => {
          if (heldAccount(id)) return false;
          await accountWritesSettled(id);
          await deleteStoredAccount(id);
          return true;
        });
        if (gone) break;
      } catch (problem) {
        // In a dungeon on a match worker: not ours to delete yet.
        if (!(problem instanceof AccountLeasedError)) throw problem;
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  await forgetAccountRuns(id);
  await anonymiseSales(id);
  return true;
};

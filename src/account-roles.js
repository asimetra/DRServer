/**
 * Giving an account a rank from the admin pages, rather than by editing its
 * `admin_flags` by hand (socket/roles.js says where the rank is kept).
 *
 * An account operation, so that one in a dungeon on a match worker is changed
 * there, on its live object: its chat commands read the rank off that object,
 * and a copy changed here would be written over by the end of its run.
 */
import { defineAccountOperation } from "./account-operations.js";
import { loadAccount, saveAccount, withAccountLock } from "./accounts.js";
import { roleName, roleOf, withRole } from "./socket/roles.js";

/** Sets the rank; answers what it was and what it is, by name. */
export const setAccountRole = defineAccountOperation("account.role", async (accountId, rank) =>
  withAccountLock(accountId, async () => {
    const account = await loadAccount(accountId);
    const was = roleOf(account);
    account.admin_flags = Number(withRole(account.admin_flags, rank));
    await saveAccount(account);
    return { was: roleName(was), role: roleName(rank) };
  })
);

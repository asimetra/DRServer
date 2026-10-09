/**
 * Who may open the browser client, when the host asks that somebody decide.
 *
 * A host who wants to choose who plays in the browser turns on
 * `ODS_WEB_CLIENT_APPROVAL`: then an account asks, and a helper or an admin
 * says yes or no. Signing up, and playing with the desktop client, are
 * untouched.
 *
 * The answer is a field of the account:
 *
 *   { state: "pending" | "approved" | "denied", requested_at, by, at }
 *
 * `by` and `at` are who decided, and when; absent while it waits. No field is
 * an account that has never asked. A denied one may not ask again until a
 * helper changes their mind: asking is a button, and a no that can be undone
 * by pressing it again is not one.
 */
import { defineAccountOperation } from "./account-operations.js";
import {
  listAccountIds,
  loadAccount,
  loadAccountForScan,
  loadExistingAccount,
  saveAccount,
  withAccountLock,
} from "./accounts.js";
import { config } from "./config.js";

export const WEB_CLIENT_STATES = Object.freeze(["pending", "approved", "denied"]);

/** The account's standing, or null for one that has never asked. */
export const webClientAccessOf = (account) => {
  const access = account?.web_client;
  if (!access || typeof access !== "object" || !WEB_CLIENT_STATES.includes(access.state)) return null;
  return access;
};

/**
 * Whether this account may be given a Play link. Everybody may while the host
 * has not asked for approval; an admin or a helper always may, being the ones
 * who give it.
 */
export const mayOpenWebClient = (account, { trusted = false } = {}) =>
  !config.webClientApproval || trusted || webClientAccessOf(account)?.state === "approved";

/**
 * Asks, for an account that has not been answered yet. One already waiting or
 * already approved is left as it is, and so is one that was turned down.
 */
export const requestWebClient = defineAccountOperation("account.web-client.request", async (accountId, now = Date.now()) =>
  withAccountLock(accountId, async () => {
    const account = await loadAccount(accountId);
    const current = webClientAccessOf(account);
    if (current) return current;
    account.web_client = { state: "pending", requested_at: new Date(now).toISOString() };
    await saveAccount(account);
    return account.web_client;
  })
);

/** Says yes or no, by `by`; the time it was asked is kept, when it was. */
export const decideWebClient = defineAccountOperation(
  "account.web-client.decide",
  async (accountId, state, by, now = Date.now()) =>
    withAccountLock(accountId, async () => {
      const account = await loadAccount(accountId);
      const asked = webClientAccessOf(account)?.requested_at ?? null;
      account.web_client = {
        state,
        ...(asked ? { requested_at: asked } : {}),
        by: Number(by),
        at: new Date(now).toISOString(),
      };
      await saveAccount(account);
      return account.web_client;
    })
);

/** The most one listing returns. */
export const MAX_WEB_CLIENT_LISTED = 200;

/**
 * The accounts in one state, the longest waiting or most recently decided
 * first: a query on PostgreSQL, a scan of the population on files.
 */
export const listWebClientAccess = async (state) => {
  if (config.storage === "postgres") {
    return (await import("./storage/postgres.js")).webClientAccounts(state, MAX_WEB_CLIENT_LISTED);
  }
  const found = [];
  for (const id of await listAccountIds()) {
    const account = await loadAccountForScan(id, loadExistingAccount);
    const access = webClientAccessOf(account);
    if (access?.state === state) found.push({ account_id: Number(id), name: account.name ?? null, access });
  }
  return found.sort(byWaitOrDecision(state)).slice(0, MAX_WEB_CLIENT_LISTED);
};

const byWaitOrDecision = (state) =>
  state === "pending"
    ? (a, b) => String(a.access.requested_at).localeCompare(String(b.access.requested_at))
    : (a, b) => String(b.access.at).localeCompare(String(a.access.at));

/**
 * A restricted account: one that may sign in and keep what it has, and may not
 * do the things that touch other players.
 *
 * The client has no idea of such a thing. Nothing in it shows a suspension, a
 * date or a reason, and a refused login is only "error" — so the account is
 * not refused at the door. It is refused, by the server, what it may not do:
 * enter a dungeon (the client says the game is not enterable), list or buy on
 * the market, speak on the global channel. Its listings drop out of sight and
 * reach, and it may still take its own weapons back down and collect what sold
 * before. It is off the leaderboards for as long as it lasts; its runs are
 * kept, and come back when it ends. Gifts and trades are left alone.
 *
 * The restriction is a field of the account:
 *
 *   { until: ISO time, or null for indefinitely, reason, by, at }
 *
 * set and lifted through the internal API (see internal.js), which is how the
 * website both does it and tells the player why and until when. One whose
 * `until` has passed is over; nothing has to come along and clear it.
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
import { recordAdminAction } from "./admin-actions.js";
import { info, warn } from "./log.js";
import { escalate } from "./sanctions.js";

export const MAX_REASON_LENGTH = 500;

/** The account the server acts as, in `by` and in the action log, when nobody else did. */
export const SERVER_ACTOR = 0;

/** The account's restriction while it is in force, or null. */
export const restrictionOf = (account, now = Date.now()) => {
  const restriction = account?.restriction;
  if (!restriction || typeof restriction !== "object") return null;
  if (restriction.until === null || restriction.until === undefined) return restriction;
  const ends = Date.parse(restriction.until);
  // An end that cannot be read is not a reason to let somebody off.
  if (Number.isNaN(ends)) return restriction;
  return ends > now ? restriction : null;
};

export const isRestricted = (account, now = Date.now()) => restrictionOf(account, now) !== null;

export class RestrictionInvalid extends Error {
  constructor(message) {
    super(message);
    this.name = "RestrictionInvalid";
  }
}

/**
 * What the website asked for, as the field that is stored, or why not. `by` is
 * the admin's account, which the internal API has already checked is one.
 */
export const restrictionFrom = ({ reason, until } = {}, by = null, now = Date.now()) => {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new RestrictionInvalid("a restriction needs a reason");
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new RestrictionInvalid(`a reason is at most ${MAX_REASON_LENGTH} characters`);
  }
  let ends = null;
  if (until !== undefined && until !== null) {
    const at = typeof until === "string" ? Date.parse(until) : NaN;
    if (Number.isNaN(at)) throw new RestrictionInvalid('"until" must be a time such as 2026-10-12T00:00:00Z, or null');
    if (at <= now) throw new RestrictionInvalid('"until" has already passed');
    ends = new Date(at).toISOString();
  }
  return { until: ends, reason: reason.trim(), by: by ?? null, at: new Date(now).toISOString() };
};

/**
 * The accounts restricted now, the most recently restricted first: a query on
 * PostgreSQL, a scan of the population on files, which is small there.
 */
export const listRestrictions = async () => {
  if (config.storage === "postgres") return (await import("./storage/postgres.js")).restrictedAccounts();
  const found = [];
  for (const id of await listAccountIds()) {
    const account = await loadAccountForScan(id, loadExistingAccount);
    const restriction = restrictionOf(account);
    if (restriction) found.push({ account_id: Number(id), name: account.name ?? null, restriction });
  }
  return found.sort((a, b) => String(b.restriction.at).localeCompare(String(a.restriction.at)));
};

/**
 * Sets an account's restriction, or lifts it with null.
 *
 * An account operation, so that one in a dungeon on a match worker is changed
 * there, on its live object, rather than on a copy here that its run would
 * write over.
 */
export const setRestriction = defineAccountOperation("account.restrict", async (accountId, restriction) =>
  withAccountLock(accountId, async () => {
    const account = await loadAccount(accountId);
    account.restriction = restriction;
    await saveAccount(account);
    return restriction;
  })
);

/**
 * Restricts an account whose session was ended for cheating: one rung up the
 * ladder (sanctions.js), and restricted until that rung is over — unless it is
 * restricted for longer already, by an admin or an earlier rung, which stands.
 * The ladder's record is kept on the account as `sanctions`, never sent to the
 * client.
 */
export const sanctionAccount = defineAccountOperation("account.sanction", async (accountId, rule, now = Date.now()) =>
  withAccountLock(accountId, async () => {
    const account = await loadAccount(accountId);
    const { record, hours } = escalate(account.sanctions, now);
    account.sanctions = record;
    const current = restrictionOf(account, now);
    const outlasts = current && (current.until === null || Date.parse(current.until) >= record.until);
    if (!outlasts) {
      account.restriction = {
        until: new Date(record.until).toISOString(),
        reason: `anti-cheat: ${rule}`,
        by: SERVER_ACTOR,
        at: new Date(now).toISOString(),
      };
    }
    await saveAccount(account);
    return { step: record.step, hours, until: account.restriction?.until ?? null, kept: Boolean(outlasts) };
  })
);

const sanctionsUnderWay = new Set();

/**
 * Called when a session is ended for a pattern. Not awaited by the caller — the
 * session ends whatever happens here — but kept track of, so a test or a
 * shutdown can wait for it.
 */
export const sanctionForSession = (accountId, rule) => {
  if (config.authEnabled === false || !accountId) return;
  const work = (async () => {
    try {
      const outcome = await sanctionAccount(Number(accountId), rule);
      info(
        `anti-cheat: account ${accountId} restricted ${outcome.kept ? "already for longer" : `for ${outcome.hours}h`}` +
          ` (rung ${outcome.step}) for ${rule}`
      );
      await recordAdminAction({
        actor: SERVER_ACTOR,
        action: "restriction.auto",
        target: Number(accountId),
        detail: { rule, step: outcome.step, hours: outcome.hours, until: outcome.until },
      });
    } catch (problem) {
      warn(`anti-cheat: could not restrict account ${accountId} for ${rule}: ${problem.message}`);
    }
  })();
  sanctionsUnderWay.add(work);
  work.finally(() => sanctionsUnderWay.delete(work));
};

export const waitForSanctions = async () => {
  while (sanctionsUnderWay.size) await Promise.allSettled([...sanctionsUnderWay]);
};


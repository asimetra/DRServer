import { createHash, randomBytes } from "node:crypto";

/**
 * One-time codes that open the browser client signed in.
 *
 * The website's Play button sends the player to the client's page with a code
 * after "#". The page trades it at POST /launch for a session token, and the
 * code is spent by that. A link left in the browser's history, pasted into a
 * chat or caught on a screen share is worth nothing a minute later, where the
 * session token it used to carry opened the account for six hours.
 *
 * Kept in this process only: a code lives for a minute, and a restart in that
 * minute costs a click on Play. Held as digests, so the table holds nothing a
 * reader of this process's memory could trade.
 */

export const LAUNCH_CODE_TTL_MS = 60_000;

/** Enough for every player pressing Play in the same minute, and a ceiling. */
const MAX_OUTSTANDING = 10_000;

const SHAPE = /^[0-9a-f]{64}$/;

const outstanding = new Map();

const digest = (code) => createHash("sha256").update(code).digest("hex");

const sweep = (now) => {
  for (const [key, entry] of outstanding) {
    if (entry.expiresAt <= now) outstanding.delete(key);
  }
};

/** A fresh code for `accountId`, and when it lapses. */
export const createLaunchCode = (accountId, now = Date.now()) => {
  sweep(now);
  if (outstanding.size >= MAX_OUTSTANDING) {
    // The oldest first: Map keeps insertion order.
    outstanding.delete(outstanding.keys().next().value);
  }
  const code = randomBytes(32).toString("hex");
  const expiresAt = now + LAUNCH_CODE_TTL_MS;
  outstanding.set(digest(code), { accountId: Number(accountId), expiresAt });
  return { code, expires: new Date(expiresAt).toISOString() };
};

/** The account a code was made for, spending it; null for anything else. */
export const redeemLaunchCode = (code, now = Date.now()) => {
  if (typeof code !== "string" || !SHAPE.test(code)) return null;
  const key = digest(code);
  const entry = outstanding.get(key);
  outstanding.delete(key);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.accountId;
};

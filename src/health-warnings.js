import fs from "node:fs/promises";
import { SESSION_TTL_SECONDS } from "./auth.js";

/**
 * Things worth saying before they become a failure.
 *
 * A health check answers "can people play". These answer "will they still be
 * able to next week": the server is well, and somebody should be told anyway.
 * Each returns a sentence or null, and is kept free of the server's own state
 * so it can be tested on numbers.
 */

const GB = 1024 ** 3;

/** Little left by share, or by size on a disk small enough for the share to flatter. */
const DISK_WARN_SHARE = 0.05;
const DISK_WARN_BYTES = GB / 4;

export const diskWarning = (directory, { freeBytes, totalBytes }) => {
  if (!(totalBytes > 0)) return null;
  const share = freeBytes / totalBytes;
  if (share >= DISK_WARN_SHARE && freeBytes >= DISK_WARN_BYTES) return null;
  return `${Math.round(share * 100)}% free (${(freeBytes / GB).toFixed(1)} GB) on ${directory}`;
};

/** How full the filesystem under `directory` is, as the kernel reports it. */
export const diskSpace = async (directory) => {
  const stats = await fs.statfs(directory);
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
};

/** How far ahead an expiring token is mentioned. */
export const TOKEN_WARN_DAYS = 14;

/**
 * Tokens the server has seen that are about to run out.
 *
 * The server keeps no list of the tokens it issued — it only verifies — so the
 * ones it can speak for are the ones in use right now. A browser session's
 * token lasts six hours by design and is renewed by the page that holds it;
 * anything that short-lived is that, and is left out.
 */
export const tokenWarning = (sessions, nowSeconds = Math.floor(Date.now() / 1000)) => {
  const soon = sessions
    .map(({ accountId, tokenExpiry }) => ({ accountId, left: Number(tokenExpiry) - nowSeconds }))
    .filter(({ left }) => left > SESSION_TTL_SECONDS && left <= TOKEN_WARN_DAYS * 86400)
    .sort((a, b) => a.left - b.left);
  if (!soon.length) return null;
  const named = soon
    .slice(0, 5)
    .map(({ accountId, left }) =>
      left < 86400
        ? `account ${accountId} in under a day`
        : `account ${accountId} in ${Math.floor(left / 86400)} days`
    )
    .join(", ");
  const more = soon.length > 5 ? `, and ${soon.length - 5} more` : "";
  return (
    `${soon.length} online player${soon.length === 1 ? "'s token expires" : "s' tokens expire"} ` +
    `within ${TOKEN_WARN_DAYS} days: ${named}${more}`
  );
};

/** Some slots down while others carry on. None left at all is a failure, said elsewhere. */
export const workerWarning = (slots) => {
  if (!slots?.length) return null;
  const down = slots.filter((slot) => !slot.alive).map((slot) => slot.index);
  if (!down.length || down.length === slots.length) return null;
  return `match worker${down.length === 1 ? "" : "s"} ${down.join(", ")} ${down.length === 1 ? "is" : "are"} down`;
};

/** Past this, the lateness of the loop every dungeon runs on is felt. */
const LOOP_WARN_MS = 250;

export const loopWarning = (p99Ms) =>
  p99Ms > LOOP_WARN_MS
    ? `timers are firing ${Math.round(p99Ms)} ms late (p99 over the last minute): players will feel this as lag`
    : null;

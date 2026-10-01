import { isMainThread, parentPort } from "node:worker_threads";

/**
 * How often the things that go wrong go wrong.
 *
 * Each of these was a line in the log and nothing else, so "has anybody been
 * refused today" meant reading the log — and nobody reads a log that is fine.
 * A number that was zero yesterday is noticed. They are totals since the
 * server started, shown on the status route; a monitor that wants a rate
 * subtracts.
 *
 * Listed here so that every one of them is reported from the start, at zero:
 * a counter that only appears once it is non-zero cannot be watched for.
 */
const KNOWN = [
  "auth_refused", // a token that was missing, expired, revoked or forged
  "database_connections_lost",
  "http_errors", // a request that ended in this server's own failure
  "http_rate_limited",
  "packets_failed", // a game packet whose handler threw
  "saves_failed", // a dungeon save that did not reach storage
  "sockets_refused", // a connection turned away at the limit
  "timer_failures",
  "unhandled_rejections",
  "worker_restarts",
];

const totals = new Map();

/**
 * In a match worker the dungeon's failed saves and timers happen in another
 * thread from the one that is asked. They are batched and sent across, so the
 * one total is the whole server's.
 */
let pending = null;
const forward = () => {
  const counts = Object.fromEntries(pending);
  pending = null;
  parentPort?.postMessage({ t: "count", counts });
};

export const count = (name, by = 1) => {
  if (isMainThread) {
    totals.set(name, (totals.get(name) ?? 0) + by);
    return;
  }
  if (!pending) {
    pending = new Map();
    // A microtask rather than a timer: a worker that is about to stop still sends.
    queueMicrotask(forward);
  }
  pending.set(name, (pending.get(name) ?? 0) + by);
};

/** Adds what a match worker counted. */
export const absorb = (counts) => {
  for (const [name, by] of Object.entries(counts ?? {})) {
    if (Number.isSafeInteger(by) && by > 0) totals.set(name, (totals.get(name) ?? 0) + by);
  }
};

export const counters = () => {
  const all = Object.fromEntries(KNOWN.map((name) => [name, 0]));
  for (const [name, total] of totals) all[name] = total;
  return Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
};

/** Exists for tests. */
export const resetCounters = () => totals.clear();

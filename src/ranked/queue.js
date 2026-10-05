/**
 * Who is waiting for a ranked race, and who gets paired with whom.
 *
 * Only players an entry adapter vouches are *ready* — able to start a race
 * this moment — are paired (docs/ranked.md, "Only players who can start now
 * are paired"), so a pairing never waits on somebody who is not there.
 *
 * The policy is for a small server, five to twenty players: a narrow rating
 * window that opens to anybody after a minute and a half, longest waiting
 * first, and no immediate rematch while somebody else is waiting.
 */

const s = (seconds) => seconds * 1000;

/** How far apart two ratings may be, by how long somebody has waited. */
export const ratingWindow = (waitedMs) => {
  if (waitedMs < s(30)) return 150;
  if (waitedMs < s(60)) return 300;
  if (waitedMs < s(90)) return 600;
  return Infinity;
};

/** Cancelling a pairing or forfeiting: a minute, doubling each time in a row, up to half an hour. */
const COOLDOWN_BASE_MS = s(60);
const COOLDOWN_CEILING_MS = s(30 * 60);

class RankedQueue {
  constructor({ window = ratingWindow } = {}) {
    this.window = window;
    /** accountId -> { accountId, rating, joinedAt, ready } */
    this.entries = new Map();
    /** accountId -> the last opponent they were paired with */
    this.lastOpponents = new Map();
    /** accountId -> { streak, until } */
    this.cooldowns = new Map();
  }

  get size() {
    return this.entries.size;
  }

  entry(accountId) {
    return this.entries.get(accountId) ?? null;
  }

  /**
   * In the queue, or told why not. Joining again keeps the place in line and
   * takes the newer rating. A new entry starts unready: an adapter says when.
   */
  join({ accountId, rating, at }) {
    const cooldown = this.cooldowns.get(accountId);
    if (cooldown && at < cooldown.until) return { ok: false, reason: "cooldown", until: cooldown.until };
    const existing = this.entries.get(accountId);
    if (existing) {
      existing.rating = rating;
      return { ok: true, entry: existing };
    }
    const entry = { accountId, rating, joinedAt: at, ready: false };
    this.entries.set(accountId, entry);
    return { ok: true, entry };
  }

  leave(accountId) {
    return this.entries.delete(accountId);
  }

  setReady(accountId, ready) {
    const entry = this.entries.get(accountId);
    if (entry) entry.ready = Boolean(ready);
    return Boolean(entry);
  }

  rememberOpponents(first, second) {
    this.lastOpponents.set(first, second);
    this.lastOpponents.set(second, first);
  }

  /** Cancelled a pairing, or forfeited: the next join waits, longer each time in a row. */
  penalise(accountId, at) {
    const streak = (this.cooldowns.get(accountId)?.streak ?? 0) + 1;
    const length = Math.min(COOLDOWN_CEILING_MS, COOLDOWN_BASE_MS * 2 ** (streak - 1));
    this.cooldowns.set(accountId, { streak, until: at + length });
  }

  /** A race played out properly ends the run of penalties. */
  forgive(accountId) {
    this.cooldowns.delete(accountId);
  }

  counts() {
    let ready = 0;
    for (const entry of this.entries.values()) if (entry.ready) ready += 1;
    return { waiting: this.entries.size, ready };
  }

  /**
   * Every pair that can be made now, taken out of the queue. Longest waiting
   * first, each with the closest rating in reach.
   */
  pairUp(at) {
    const ready = [...this.entries.values()]
      .filter((entry) => entry.ready)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    const onlyTwo = ready.length === 2;
    const taken = new Set();
    const pairs = [];

    for (const first of ready) {
      if (taken.has(first.accountId)) continue;
      let best = null;
      for (const second of ready) {
        if (second === first || taken.has(second.accountId)) continue;
        if (!onlyTwo && this.lastOpponents.get(first.accountId) === second.accountId) continue;
        const reach = Math.max(this.window(at - first.joinedAt), this.window(at - second.joinedAt));
        const gap = Math.abs(first.rating - second.rating);
        if (gap > reach) continue;
        if (!best || gap < best.gap) best = { entry: second, gap };
      }
      if (!best) continue;
      taken.add(first.accountId);
      taken.add(best.entry.accountId);
      pairs.push([first, best.entry]);
    }

    for (const [first, second] of pairs) {
      this.entries.delete(first.accountId);
      this.entries.delete(second.accountId);
    }
    return pairs;
  }
}

export const createQueue = (options) => new RankedQueue(options);

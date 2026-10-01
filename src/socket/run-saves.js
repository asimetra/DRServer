import { isMainThread, parentPort } from "node:worker_threads";
import { error, info } from "../log.js";
import { count } from "../metrics.js";

/**
 * Every dungeon save still on its way to storage, and what becomes of one that
 * does not get there.
 *
 * A run announces its saves on `session.rewardSavePromise`, and for as long as
 * the session is in the dungeon that is the place to look. Leaving is where it
 * stops being: the teardown runs synchronously, starts the settle, and deletes
 * the field along with everything else the run owned. So the saves are also
 * kept here, by account, and forgotten only when they have landed.
 *
 * A save that failed used to be a line in the log. The run's copy of the
 * account was then let go when the player walked out, the next read came from
 * storage, and whatever storage had not taken was gone — gold and experience
 * the client had already shown. Now the account stays the one in play until it
 * is written: a failed save is tried again, with a wait that grows, for as long
 * as the server runs. Reads meanwhile get the live object, so nothing is lost
 * and nothing is shown stale; what the player notices is nothing at all.
 */

/** Waits between retries, the last one repeating. */
const DEFAULT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
let delays = DEFAULT_DELAYS;

/** Saves under way or waiting to be retried, by account. */
const inFlight = new Map();
/** Accounts whose last save failed and is being tried again. */
const retrying = new Map();
/** The same count from each match worker, where dungeons run in other threads. */
const unsavedElsewhere = new Map();
/** Set at shutdown: one more attempt each, at once, and then no more. */
let closing = false;

/** Exists for tests, which cannot wait out seconds. */
export const configureRunSaves = ({ delays: next } = {}) => {
  delays = next?.length ? next : DEFAULT_DELAYS;
};

const track = (accountId, landed) => {
  const saves = inFlight.get(accountId) ?? new Set();
  inFlight.set(accountId, saves);
  saves.add(landed);
  const forget = () => {
    saves.delete(landed);
    if (!saves.size && inFlight.get(accountId) === saves) inFlight.delete(accountId);
  };
  landed.then(forget, forget);
};

/** Tells the main thread how many accounts this worker is still trying to save. */
const announce = () => {
  if (!isMainThread) parentPort?.postMessage({ t: "unsaved", count: retrying.size });
};

/** A wait that ends early when the retry is no longer needed, or at shutdown. */
const pause = (entry, ms) =>
  new Promise((resolve) => {
    // Does not keep the process alive by itself: a server that is stopping ends
    // the wait through finishRunSaves, and nothing else should have to.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    entry.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

const retry = (accountId, save, problem) => {
  count("saves_failed");
  const waiting = retrying.get(accountId);
  if (waiting) {
    // Already being retried: the newest save is the one worth repeating.
    waiting.save = save;
    return waiting.landed;
  }

  error(
    `account ${accountId}: dungeon save failed (${problem?.message ?? problem}); ` +
      "the account stays in memory and the save is retried"
  );
  const entry = { save, written: false, wake: null, landed: null };
  entry.landed = (async () => {
    for (let attempt = 0; !entry.written; attempt += 1) {
      if (!closing) await pause(entry, delays[Math.min(attempt, delays.length - 1)]);
      if (entry.written) break;
      try {
        await entry.save();
        info(`account ${accountId}: dungeon save landed after ${attempt + 1} retr${attempt ? "ies" : "y"}`);
        break;
      } catch (again) {
        count("saves_failed");
        if (closing) {
          error(
            `account ${accountId}: dungeon save could not be written before shutdown ` +
              `(${again?.message ?? again}); what changed since its last successful save is lost`
          );
          break;
        }
      }
    }
    retrying.delete(accountId);
    announce();
  })();
  retrying.set(accountId, entry);
  announce();
  return entry.landed;
};

/** A save that landed wrote the whole account, so a retry has nothing left to do. */
const written = (accountId) => {
  const waiting = retrying.get(accountId);
  if (!waiting) return undefined;
  waiting.written = true;
  waiting.wake?.();
  return waiting.landed;
};

/**
 * Follows one save to the end. `attempt` is the save as the caller made it —
 * still theirs to await, and still rejecting if it fails, so an exit does not
 * wait on storage that is away. `save` is how to try again.
 */
export const followRunSave = (accountId, attempt, save) => {
  const id = Number(accountId);
  track(
    id,
    attempt.then(
      () => written(id),
      (problem) => retry(id, save, problem)
    )
  );
  return attempt;
};

/** Whether anything for this account is on its way to storage or waiting to be. */
export const hasRunSaves = (accountId) => inFlight.has(Number(accountId));

/** Resolves once the account is written down. */
export const whenRunSaved = async (accountId) => {
  const id = Number(accountId);
  while (inFlight.has(id)) await Promise.allSettled([...inFlight.get(id)]);
};

/**
 * How many accounts have a save that has not reached storage, across threads.
 * Non-zero means storage is refusing writes right now, whatever a probe says.
 */
export const runSavesFailing = () =>
  retrying.size + [...unsavedElsewhere.values()].reduce((sum, each) => sum + each, 0);

/** What a match worker reported; zero when it has caught up, or gone. */
export const noteUnsavedElsewhere = (source, unsaved) => {
  if (unsaved > 0) unsavedElsewhere.set(source, unsaved);
  else unsavedElsewhere.delete(source);
};

/** Waits until no dungeon save is in flight, including any queued meanwhile. */
export const waitForRunSaves = async () => {
  while (inFlight.size) {
    await Promise.allSettled([...inFlight.values()].flatMap((saves) => [...saves]));
  }
};

/**
 * For a server that is stopping: every waiting save gets one more attempt, now
 * rather than after its backoff, and one that still fails is given up on — said
 * plainly in the log, because that is progress a player will not find again.
 */
export const finishRunSaves = async () => {
  closing = true;
  for (const waiting of retrying.values()) waiting.wake?.();
  await waitForRunSaves();
};

/** Exists for tests: a module that has "stopped" and is used again. */
export const resumeRunSaves = () => {
  closing = false;
};

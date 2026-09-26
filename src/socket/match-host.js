import { acquireAccount, loadAccount, nextObjectId, saveAccount } from "../accounts.js";
import { releaseAccount } from "../account-registry.js";
import { recordRuns } from "../leaderboard.js";
import { dungeonMatches } from "./matches.js";
import { setPresenceLocation } from "./presence.js";
import { sayGlobally } from "./global-chat.js";

/**
 * Everything a running match asks of the server around it.
 *
 * A match is otherwise closed over its own state: its floor, its actors, its
 * timers and the frames it sends. These are the only places it reaches out —
 * to the account store, the match registry, presence, the leaderboards, the
 * global chat channel, and a door that leads into another match. Routing them through one object is what
 * lets a match run somewhere other than the thread that owns those things: the
 * local host below calls straight through, and a worker installs a host that
 * turns each call into a message to the main thread.
 *
 * Only side effects belong here. Pure helpers (`rankable`, frame builders)
 * stay ordinary imports, because computing them in a worker changes nothing.
 */
export const localMatchHost = Object.freeze({
  kind: "local",
  /** Takes the account for the length of a run; see account-registry.js. */
  acquireAccount: (accountId) => acquireAccount(accountId),
  releaseAccount: (accountId) => releaseAccount(accountId),
  loadAccount: (accountId) => loadAccount(accountId),
  saveAccount: (account) => saveAccount(account),
  nextObjectId: (account) => nextObjectId(account),
  setPresenceLocation: (session, mapNodeId) => setPresenceLocation(session, mapNodeId),
  matchFinished: (match) => dungeonMatches.finish(match),
  recordRuns: (runs) => recordRuns(runs),
  /** Everyone on a floor anywhere hears it, which is further than one match reaches. */
  sayGlobally: (speaker, text) => sayGlobally(speaker, text),
  /**
   * A door is a new entry, which is the matchmaker's business, not the
   * match's. Imported when first used: doors.js reaches back into the dungeon
   * runtime, and a static import here would close that cycle at load time.
   */
  walkThrough: async (session, destination) => {
    const { walkThrough } = await import("./doors.js");
    return walkThrough(session, destination);
  },
  /**
   * Back to town without having asked: an exit on the player's behalf, which
   * the client takes as its own — RunState goes home on ClientExitComplete
   * whoever started it. Not awaited by the caller; the exit answers itself.
   */
  sendHome: async (session) => {
    const { transitionsOf } = await import("./session-transitions.js");
    // Still on the floor that asked — a worker's route generation does the
    // same. One who has left since is not sent anywhere.
    const connection = session.member ?? session;
    if (session.world && connection.world !== session.world) return false;
    transitionsOf(session).requestExit();
    return true;
  },
});

let host = localMatchHost;

/** The host this thread's matches talk to. */
export const matchHost = () => host;

/**
 * Replaces the host for this thread, returning the previous one. A worker does
 * this once at start-up; tests use it to watch what a match asks for.
 */
export const installMatchHost = (next) => {
  const required = Object.keys(localMatchHost).filter((key) => key !== "kind");
  const missing = required.filter((key) => typeof next?.[key] !== "function");
  if (missing.length) throw new Error(`match host is missing ${missing.join(", ")}`);
  const previous = host;
  host = next;
  return previous;
};

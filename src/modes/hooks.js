/**
 * Where a game mode plugs into the dungeon runtime.
 *
 * The runtime calls `modeHooks.<name>(...)` at a fixed set of points and
 * nothing else of any mode's; a mode installs its answers under its own name
 * (`installModeHooks("ranked", answers)`) and more than one may be installed
 * at once. With nothing installed every call is the no-op in NOTHING, which
 * leaves the runtime doing exactly what it did before any mode existed.
 *
 * How several modes' answers are put together is each hook's own rule, in
 * COMBINE: a chain for what every mode may rewrite in turn (an entry request,
 * the friend list), the first answer for what one run has one of (its plan,
 * its rules), every mode agreeing for what any may hold (a floor completing),
 * any mode for a yes-or-no, and every mode told for what is only news. A mode
 * is asked about sessions that are not its own and answers for those with the
 * default, which is why the defaults are what they are.
 *
 * A mode's fault must never become a dungeon fault: an answer that throws or
 * rejects is logged and replaced by the default.
 */
import { warn } from "../log.js";

const NOTHING = Object.freeze({
  /** ClientRequestEntry: the request to admit instead, or the same one. */
  routeEntry: (connection, request) => request,
  /** Whether this account may enter `mode` at all: `{ ok }`, or `{ ok: false, reason }`. */
  entryAllowed: async () => ({ ok: true }),
  /** The rules a mode plays by, by name (socket/run-rules.js), or null for one this does not know. */
  modeRules: () => null,
  /** The player asks to call their race off; true when they are in one. */
  drawOffered: () => false,
  /** The run's floor plan, or null for the node's own. */
  planFor: async () => null,
  /** The client has built a floor and asked for its hero. */
  heroRequested: () => {},
  /** A floor is about to complete; false holds it (a lobby that must not end). */
  floorCompleting: () => true,
  /** The run is lost. */
  runFailed: () => {},
  /** The player is out of the dungeon: `left` it, or `dropped` by the connection. */
  runLeft: () => {},
  /** Idle marked or cleared. */
  idle: () => {},
  /** Whether this session is somewhere idling is fine (a lobby). */
  idlingAllowed: () => false,
  /** What this session's run pays and counts for (socket/run-rules.js), or null for the game's own. */
  runRules: () => null,
  /** The friend list as the client will get it. */
  friendList: (rows) => rows,
  /** A player logged in to the game socket. */
  loggedIn: () => {},
  /** An id that is the server's own (MATCHMAKER), never a player's. */
  isSystemAccount: () => false,
  /**
   * The hero's own stream, as the runtime accepts it — called on every
   * position, so cheap: `{ type: "moved", position }`, `{ type: "turned",
   * heading }`, `{ type: "swung", choreography }` (the attack as its peers are
   * sent it), `{ type: "swingStopped" }`, `{ type: "said", line }` (after the
   * room heard it). What a mode mirrors, records or watches comes from here.
   */
  heroEvent: () => {},
  /**
   * The end-of-run report's rows as this recipient will see them (summary.js):
   * the recipient's own first, then their party, each `{ id, name, skinType,
   * ... }`. Returned as they are, renamed, or with a row added for somebody
   * who was not in this run, marked `transient: true` — the report gives it a
   * player object of its own and takes it away once drawn, so the client greys
   * it as a leaver's. `reportOf(context, won)` builds a row for any run.
   */
  reportRows: (recipient, rows) => rows,
});

/**
 * How the installed modes' answers become one. `chain` hands each mode the
 * last one's answer; `first` takes the first that is not the default; `all`
 * is true only if every mode says so; `any` is true if one does; `each` tells
 * every mode and answers nothing; `named` asks only the mode the first
 * argument names.
 */
const COMBINE = Object.freeze({
  routeEntry: "chain",
  friendList: "chain",
  entryAllowed: "named",
  modeRules: "named",
  planFor: "first",
  runRules: "first",
  reportRows: "chain",
  floorCompleting: "all",
  idlingAllowed: "any",
  isSystemAccount: "any",
  drawOffered: "any",
  heroRequested: "each",
  runFailed: "each",
  runLeft: "each",
  idle: "each",
  loggedIn: "each",
  heroEvent: "each",
});

/** mode name -> its guarded answers */
const modes = new Map();

const guarded = (mode, name, answer) => (...args) => {
  const fallback = () => NOTHING[name](...args);
  const failed = (problem) => {
    warn(`mode ${mode}: hook ${name} failed: ${problem?.stack ?? problem}`);
    return fallback();
  };
  try {
    const result = answer(...args);
    return typeof result?.then === "function" ? result.catch(failed) : result;
  } catch (problem) {
    return failed(problem);
  }
};

const isPromise = (value) => typeof value?.then === "function";

/** `first`: an answer that is not the default's, which for these hooks is null. */
const firstOf = (name, args) => {
  for (const answers of modes.values()) {
    const result = answers[name]?.(...args);
    if (isPromise(result)) {
      // planFor is async: the rest are asked in turn once this one has answered.
      return result.then((value) => value ?? firstAsync(name, args, answers));
    }
    if (result != null) return result;
  }
  return NOTHING[name](...args);
};
const firstAsync = async (name, args, after) => {
  let passed = false;
  for (const [, answers] of modes) {
    if (!passed) {
      passed = answers === after;
      continue;
    }
    const value = await answers[name]?.(...args);
    if (value != null) return value;
  }
  return NOTHING[name](...args);
};

const dispatch = (name) => {
  const how = COMBINE[name];
  return (...args) => {
    if (!modes.size) return NOTHING[name](...args);
    switch (how) {
      case "chain": {
        let value = args[0];
        for (const answers of modes.values()) value = answers[name]?.(value, ...args.slice(1)) ?? value;
        return value;
      }
      case "named": {
        const answers = modes.get(args[args.length - 1]);
        return answers?.[name] ? answers[name](...args) : NOTHING[name](...args);
      }
      case "first":
        return firstOf(name, args);
      case "all": {
        for (const answers of modes.values()) if (answers[name]?.(...args) === false) return false;
        return true;
      }
      case "any": {
        for (const answers of modes.values()) if (answers[name]?.(...args) === true) return true;
        return false;
      }
      default:
        for (const answers of modes.values()) answers[name]?.(...args);
        return undefined;
    }
  };
};

/** The hooks the runtime calls: one function per name in NOTHING, built once. */
export const modeHooks = Object.freeze(
  Object.fromEntries(Object.keys(NOTHING).map((name) => [name, dispatch(name)]))
);

/** The names a mode may answer, for whoever writes one. */
export const MODE_HOOK_NAMES = Object.freeze(Object.keys(NOTHING));

/**
 * Installs a mode's answers under its name; returns a function that takes
 * them out again. An answer under a name the runtime never asks is a mistake
 * in the mode, and is said so.
 */
export const installModeHooks = (mode, hooks) => {
  if (typeof mode !== "string" || !mode) throw new Error("a mode installs its hooks under a name");
  const answers = {};
  for (const [name, answer] of Object.entries(hooks ?? {})) {
    if (!(name in NOTHING)) {
      warn(`mode ${mode}: "${name}" is not a hook the runtime calls; it is ignored`);
      continue;
    }
    if (typeof answer === "function") answers[name] = guarded(mode, name, answer);
  }
  modes.set(mode, answers);
  return () => {
    if (modes.get(mode) === answers) modes.delete(mode);
  };
};

/** Whether a mode has its answers installed on this thread. */
export const modeInstalled = (mode) => modes.has(mode);

/** The modes installed, by name. */
export const modesInstalled = () => [...modes.keys()];

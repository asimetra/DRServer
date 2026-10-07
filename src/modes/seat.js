/**
 * The seat: the one match worker that runs every run of a `together` mode
 * (run-rules.js), and what the main thread knows of it.
 *
 * A together mode lives there — ranked's queue and races, all its runs — and
 * the main thread only answers on connections: entry, the friend list. So the
 * main thread asks two things of the seat, for any such mode alike:
 *
 *   seatRuns(mode)   is the mode running there now? Said by the seat worker
 *                    as it is ready (which modes it installed), false again
 *                    when it exits, until its replacement says.
 *   seatSaid(mode)   the latest a mode said from there (`tellMain`): ranked's
 *                    count of players waiting, for MATCHMAKER's name.
 *
 * Without match workers this thread is the seat: `seatRuns` is whether the
 * mode is installed here, and `tellMain` is heard here at once. A mode reads
 * both the same way wherever it runs.
 */
import { config } from "../config.js";
import { warn } from "../log.js";
import { modeInstalled } from "./hooks.js";
import { SEAT_WORKER, rulesOfMode } from "../socket/run-rules.js";

/** The modes registered as together (modes/index.js), whatever their rules say. */
const declaredTogether = new Set();

/** The registry says a mode's runs are together. */
export const declareTogether = (mode) => {
  if (typeof mode === "string" && mode) declaredTogether.add(mode);
};

/**
 * Whether a mode's runs are all on the seat: by its registration or by its run
 * rules, either one. Read this way by the pool and by admission, so a mode
 * that says it in one place and not the other is still kept on its seat —
 * started there only, and routed there only — rather than its runs going to
 * workers it never started on.
 */
export const isTogether = (mode) => Boolean(mode) && (declaredTogether.has(mode) || rulesOfMode(mode).together === true);

/** The modes the seat worker said it runs; empty until it is ready, and when it is gone. */
let running = new Set();
/** mode -> the latest it said from the seat. */
const said = new Map();
/** mode -> who on this thread hears what it says from any thread (onTold). */
const listeners = new Map();
/** How a worker reaches the main thread; null on the main thread, or with no workers. */
let post = null;

const workersOn = () => config.matchWorkerCount > 0;

/** Whether `mode` is running on the seat now. */
export const seatRuns = (mode) => (workersOn() ? running.has(mode) : modeInstalled(mode));

/** What `mode` last said from the seat, or undefined. */
export const seatSaid = (mode) => said.get(mode);

/**
 * From a mode to its main half: small data (structured-cloned across), from
 * any thread. What the seat says is also kept as the mode's latest (seatSaid);
 * whatever any worker says reaches `onTold` listeners. Heard here at once with
 * no workers. This is how a command said in a dungeon — the only place the
 * stock client can chat — reaches the thread that routes the next entry.
 */
export const tellMain = (mode, data) => {
  if (post) post({ t: "mode", mode, data });
  else noteModeTold(mode, data, SEAT_WORKER);
};

/**
 * The main thread hears what `mode` says from any thread: `listen(data, from)`,
 * `from` the worker's index (SEAT_WORKER without workers), so what each worker
 * counts can be added up. Returns a function that stops it.
 */
export const onTold = (mode, listen) => {
  let set = listeners.get(mode);
  if (!set) listeners.set(mode, (set = new Set()));
  set.add(listen);
  return () => set.delete(listen);
};

// --- The plumbing: the pool and the worker thread call these ------------------------

/** The main thread: the seat worker is ready and runs these modes, or is gone ([]). */
export const noteSeatModes = (names) => {
  running = new Set(Array.isArray(names) ? names.filter((name) => typeof name === "string") : []);
  // What a mode said from a seat that no longer runs it is not true any more.
  for (const mode of [...said.keys()]) if (!running.has(mode)) said.delete(mode);
};

/**
 * The main thread: `mode` said this from worker `from` (SEAT_WORKER without
 * workers). Kept as its latest only from the seat, which is the only worker a
 * together mode runs on; told to every listener whoever said it.
 */
export const noteModeTold = (mode, data, from) => {
  if (typeof mode !== "string") return;
  if (from === SEAT_WORKER) said.set(mode, data);
  for (const listen of listeners.get(mode) ?? []) {
    try {
      listen(data, from);
    } catch (problem) {
      warn(`mode ${mode}: what it said was not heard: ${problem?.stack ?? problem}`);
    }
  }
};

/** A worker thread: how its modes reach the main thread. */
export const installSeatPost = (send) => {
  post = send;
  return () => {
    if (post === send) post = null;
  };
};

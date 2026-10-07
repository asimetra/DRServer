/**
 * The modes this server runs, started together on whichever thread this is
 * (src/modes/README.md, "Where it runs"): the ones it ships, and any a
 * deployment registers before the server starts (registerMode).
 *
 *   local   no match workers: every mode, all of it, here.
 *   main    match workers on: each mode's connection half (entry, the friend
 *           list, chat in town).
 *   worker  inside a match worker: each mode's run half. A mode that must hold
 *           both players of one run in one thread has a seat — ranked's is
 *           `RANKED_WORKER` — and starts there only; a mode whose runs are
 *           anybody's starts on every worker.
 *
 * Each is off unless its setting asks for it (ODS_RANKED, ODS_ONELIFE,
 * ODS_DELVE), read by the mode itself (modes/settings.js), and
 * answers a no-op stop when off. The stop ends them in reverse, and must run
 * before connections close: ranked's voids the races still under way.
 *
 * A mode that fails to start is that mode off, said in the log, on every
 * thread alike: the game and the other modes go on. Without match workers that
 * used to be the whole server refusing to start, for one mode's records it
 * could not read.
 */
import { startRanked } from "./ranked/setup.js";
import { RANKED_MODE } from "./ranked/hooks.js";
import { ONE_LIFE_MODE, startOneLife } from "./one-life/index.js";
import delve from "./delve/index.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEAT_WORKER } from "../socket/run-rules.js";
import { declareTogether } from "./seat.js";
import { config } from "../config.js";
import { error, warn } from "../log.js";

/**
 * Every mode as `{ name, together, start }`. `start({ where })` installs the
 * mode on this thread and answers its stop — a no-op stop when its setting
 * leaves it off. `together` says its runs are all on the seat (run-rules.js),
 * so on a match worker it starts on the seat only; it must agree with what
 * its run rules say.
 */
const MODES = [
  { name: ONE_LIFE_MODE, together: false, start: startOneLife },
  { name: RANKED_MODE, together: true, start: startRanked },
  { name: delve.name, together: delve.together, start: delve.start },
];
for (const mode of MODES) if (mode.together) declareTogether(mode.name);

/** Whether startModes has run on this thread: a mode registered after it would never start. */
let started = false;

const MODE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Adds a mode to those the server runs: before startModes, on every thread
 * (the main one and each worker import the same module that calls this). A
 * name already taken is refused, as is one that is not a safe name.
 */
export const registerMode = ({ name, together = false, start } = {}) => {
  if (typeof name !== "string" || !MODE_NAME.test(name)) {
    throw new Error(`a mode's name is lower-case words and dashes, not ${JSON.stringify(name)}`);
  }
  if (typeof start !== "function") throw new Error(`mode ${name} has no start`);
  if (MODES.some((mode) => mode.name === name)) throw new Error(`there is a mode named ${name} already`);
  if (started) warn(`mode ${name} was registered after the modes started on this thread; it will not run`);
  MODES.push(Object.freeze({ name, together: together === true, start }));
  if (together === true) declareTogether(name);
};

/**
 * The deployment's own modes (config.modes, ODS_MODES), imported once on each
 * thread before its modes start: the main thread and every match worker run
 * this same function, which is how a mode registered here is registered in all
 * of them. A module default-exports `{ name, together, start }`, or calls
 * registerMode itself as it is imported. One that fails to load is that mode
 * missing, in the log; the rest go on.
 */
let loading = null;
const loadConfiguredModes = () =>
  (loading ??= (async () => {
    for (const entry of config.modes ?? []) {
      try {
        const url = /^file:/.test(entry) ? entry : pathToFileURL(path.resolve(entry)).href;
        const module = await import(url);
        const descriptor = module.default;
        if (descriptor && typeof descriptor === "object" && !MODES.some((mode) => mode.name === descriptor.name)) {
          registerMode(descriptor);
        }
      } catch (problem) {
        error(`mode module ${entry} did not load: ${problem?.stack ?? problem}`);
      }
    }
  })());

/** The modes the server runs, by name and whether their runs are together: for whoever asks. */
export const registeredModes = () => MODES.map(({ name, together }) => ({ name, together }));

/** One mode's start, its failure kept to itself: a no-op stop for a mode that is off. */
const startOne = async (name, start) => {
  try {
    const stop = await start();
    return typeof stop === "function" ? stop : async () => {};
  } catch (problem) {
    error(`mode ${name} did not start, and is off: ${problem?.stack ?? problem}`);
    return async () => {};
  }
};

export const startModes = async ({ where, workerIndex = null } = {}) => {
  // The server's own start says nothing: the main thread with workers, else the only one.
  const here = where ?? (config.matchWorkerCount > 0 ? "main" : "local");
  await loadConfiguredModes();
  started = true;
  const stops = [];
  for (const mode of MODES) {
    // A together mode's runs are all on the seat: on any other worker it has nothing to run.
    if (here === "worker" && mode.together && workerIndex !== SEAT_WORKER) continue;
    stops.push(await startOne(mode.name, () => mode.start({ where: here })));
  }
  return async () => {
    for (const stop of stops.reverse()) {
      // Each stop on its own: one failing must not keep the others running.
      try {
        await stop();
      } catch (problem) {
        error(`a mode did not stop cleanly: ${problem?.stack ?? problem}`);
      }
    }
    // With match workers on, the together modes live on the seat and stop
    // there, before any connection closes — for every such mode, not only
    // ranked: a run that drops first would be decided against its player.
    if (here === "main" && MODES.some((mode) => mode.together)) {
      try {
        const { activeMatchWorkerPool } = await import("../socket/match-worker-service.js");
        await activeMatchWorkerPool()?.stopSeatModes();
      } catch (problem) {
        error(`the seat's modes did not stop: ${problem?.stack ?? problem}`);
      }
    }
  };
};

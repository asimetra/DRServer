/**
 * The modes this server ships, started together on whichever thread this is
 * (src/modes/README.md, "Where it runs"):
 *
 *   local   no match workers: every mode, all of it, here.
 *   main    match workers on: each mode's connection half (entry, the friend
 *           list, chat in town).
 *   worker  inside a match worker: each mode's run half. A mode that must hold
 *           both players of one run in one thread has a seat — ranked's is
 *           `RANKED_WORKER` — and starts there only; a mode whose runs are
 *           anybody's starts on every worker.
 *
 * Each is off unless its setting asks for it (ODS_RANKED, ODS_ONELIFE), and
 * answers a no-op stop when off. The stop ends them in reverse, and must run
 * before connections close: ranked's voids the races still under way.
 */
import { startRanked } from "../ranked/setup.js";
import { RANKED_WORKER } from "../ranked/remote.js";
import { startOneLife } from "./one-life/index.js";

export const startModes = async ({ where, workerIndex = null, ...rankedPorts } = {}) => {
  const stops = [];
  const rankedHere = where !== "worker" || workerIndex === RANKED_WORKER;
  stops.push(await startOneLife(where ? { where } : {}));
  if (rankedHere) stops.push(await startRanked(where ? { where, ...rankedPorts } : {}));
  return async () => {
    for (const stop of stops.reverse()) await stop();
  };
};

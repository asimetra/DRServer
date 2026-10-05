/**
 * Ranked with match workers on: the queue, the races and every ranked run live
 * on one worker, and this is what the main thread keeps of it.
 *
 * One worker, because a race starts by ending two lobby floors together and
 * moving both runs on (stock-client/adapter.js, `start`): both racers have to
 * be in the thread that does it. The pool sends every ranked run there
 * (match-worker-pool.js, `workerFor`), and the main thread answers only what
 * happens on a connection — entry, the friend list, logging in — with the
 * waiting count the worker reports.
 */

/** The worker that runs ranked. */
export const RANKED_WORKER = 0;

let waiting = 0;
let started = false;

/**
 * Whether ranked came up on its worker, as that worker said when it was ready;
 * false again when it exits, until its replacement says. While it is false the
 * main thread lists no MATCHMAKER and routes no JOIN (setup.js, startOnMain):
 * an entry routed ranked to a worker without ranked would be built as an
 * ordinary run of the lobby node, past the map's unlock check.
 */
export const noteRankedStarted = (up) => {
  started = up === true;
};

export const rankedStarted = () => started;

/** The worker's count of players waiting, for MATCHMAKER's name on the friend list. */
export const noteRankedWaiting = (count) => {
  waiting = Math.max(0, Math.trunc(Number(count)) || 0);
};

export const rankedWaiting = () => waiting;

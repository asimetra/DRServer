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

import { SEAT_WORKER } from "../run-rules.js";
import { seatRuns, seatSaid, tellMain } from "../seat.js";
import { RANKED_MODE } from "./hooks.js";

/** The worker that runs ranked: the seat of the modes whose runs are together (run-rules.js). */
export const RANKED_WORKER = SEAT_WORKER;

/**
 * Whether ranked runs on the seat now (modes/seat.js): while it does not, the
 * main thread lists no MATCHMAKER and routes no JOIN (setup.js, startOnMain),
 * and admission refuses a ranked entry in any case.
 */
export const rankedStarted = () => seatRuns(RANKED_MODE);

/** The seat's count of players waiting, for MATCHMAKER's name on the friend list. */
export const rankedWaiting = () => Math.max(0, Math.trunc(Number(seatSaid(RANKED_MODE)?.waiting)) || 0);

/** On the seat: the count, told to the main thread as it changes. */
export const tellRankedWaiting = (waiting) => tellMain(RANKED_MODE, { waiting });

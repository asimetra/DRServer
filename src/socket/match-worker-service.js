import { config } from "../config.js";
import { info } from "../log.js";
import { installMatchExecutor } from "./match-runtime.js";
import { MatchWorkerPool, installWorkerPool } from "./match-worker-pool.js";
import { MAIN_THREAD_CONNECTIONS, WORKER_THREAD_CONNECTIONS } from "../storage/connections.js";

let pool = null;
let restore = null;

/**
 * Starts the match workers, if any are configured, and routes every new match
 * to them. Called by the executable only — never as an import side effect, so
 * tests and tools keep the single-thread server unless they ask.
 */
export const startMatchWorkers = async (count = config.matchWorkerCount) => {
  if (pool || !(count > 0)) return pool;
  if (count !== config.matchWorkerCount) {
    // The main thread's doid lane is fixed when the socket module loads.
    throw new Error(`match workers: asked for ${count} but the doid lanes were laid out for ${config.matchWorkerCount}`);
  }
  pool = new MatchWorkerPool({ size: count, hangTimeoutMs: config.matchWorkerHangMs });
  restore = installWorkerPool(pool, { installExecutor: installMatchExecutor });
  try {
    await pool.ready;
  } catch (problem) {
    // Asked for and not there: say so and stop, rather than run in one thread
    // without anybody having chosen that.
    await closeMatchWorkers();
    throw new Error(`match workers failed to start: ${problem.message}`);
  }
  info(
    `match workers: ${count} thread(s) running matches` +
      (config.storage === "postgres"
        ? `; up to ${MAIN_THREAD_CONNECTIONS + count * WORKER_THREAD_CONNECTIONS} database connections`
        : "")
  );
  return pool;
};

export const activeMatchWorkerPool = () => pool;

/** Lets every worker finish its leaves and account writes, then stops them. */
export const closeMatchWorkers = async () => {
  if (!pool) return false;
  const closing = pool;
  pool = null;
  try {
    return await closing.close();
  } finally {
    restore?.();
    restore = null;
  }
};

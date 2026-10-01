import { readFileSync } from "node:fs";
import { error, info, warn } from "./log.js";
import { count } from "./metrics.js";

/**
 * How long a listener is given to finish what it already accepted.
 *
 * `close()` stops new connections and then waits for the open ones to end by
 * themselves. One client that sent half a request and went quiet never does,
 * and the whole shutdown waited behind it: the storage lock held, the process
 * alive, until whatever had asked it to stop killed it instead.
 */
const LISTENER_GRACE_MS = 2_000;

/** Longest a whole shutdown may take before the process ends regardless. */
export const SHUTDOWN_TIMEOUT_MS = 25_000;

/** How long a finished shutdown waits for the event loop to empty by itself. */
const EXIT_DRAIN_MS = 3_000;

/**
 * Whether this process inherited "ignore" for the hangup signal, which is how
 * `nohup` and a detached shell job say the server should outlive its terminal.
 * Node cannot be asked; on Linux the kernel can. Elsewhere it is unknown and
 * taken to be no.
 */
const hangupIsIgnored = () => {
  try {
    const mask = /^SigIgn:\s*([0-9a-f]+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
    // SIGHUP is signal 1: the lowest bit.
    return mask ? (BigInt(`0x${mask}`) & 1n) === 1n : false;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const closeListener = (server) =>
  new Promise((resolve, reject) => {
    if (!server || server.listening === false) {
      resolve();
      return;
    }
    server.close((problem) => {
      if (problem?.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else if (problem) reject(problem);
      else resolve();
    });
  });

/**
 * Coordinates one graceful stop. Calling it twice returns the same operation.
 * Listener closure starts first so no new work can arrive while live dungeon
 * accounts are settled and the account store drains.
 */
export const createGracefulShutdown = ({
  servers,
  sessions,
  waitForWrites,
  closeServices,
  releaseProcessLock,
  closeStorage,
  listenerGraceMs = LISTENER_GRACE_MS,
} = {}) => {
  let stopping = null;

  const shutdown = (reason = "shutdown") => {
    if (stopping) return stopping;
    stopping = (async () => {
      info(`shutdown: ${reason}; refusing new connections`);
      const listening = (servers?.() ?? []).filter(Boolean);
      const listenerClosures = Promise.allSettled(listening.map((server) => closeListener(server)));

      const live = sessions?.() ?? [];
      for (const session of live) {
        try {
          session.close?.("server shutting down", { flush: true });
        } catch (problem) {
          warn(`shutdown: could not close session ${session.id}: ${problem.message}`);
        }
      }

      const settlements = live
        .map((session) => session.rewardSavePromise)
        .filter(Boolean);
      const settled = await Promise.allSettled(settlements);
      for (const result of settled) {
        if (result.status === "rejected") {
          warn(`shutdown: dungeon account save failed: ${result.reason?.message ?? result.reason}`);
        }
      }

      /**
       * Requests already being answered may still write an account, so the
       * listeners are waited for before the writes are — but only for so long.
       * After the grace, what is still open is cut: a request that has not
       * finished by then is not one the flush below should wait behind.
       */
      const closed = await Promise.race([listenerClosures, sleep(listenerGraceMs)]);
      if (!closed) {
        warn(
          `shutdown: connections still open after ${listenerGraceMs}ms; closing them`
        );
        for (const server of listening) server.closeAllConnections?.();
      }
      for (const result of closed ?? []) {
        if (result.status === "rejected") {
          warn(`shutdown: listener close failed: ${result.reason?.message ?? result.reason}`);
        }
      }
      let finalizationFailure = null;
      const finalize = async (label, work) => {
        try {
          await work?.();
        } catch (problem) {
          finalizationFailure ??= problem;
          warn(`shutdown: ${label} failed: ${problem.message ?? problem}`);
        }
      };
      // A failed flush is reported to the caller, but it must not strand the
      // process lock or storage pool and leave this otherwise-closed process
      // alive forever.
      await finalize("service close", closeServices);
      await finalize("persistent write flush", waitForWrites);
      await finalize("process-lock release", releaseProcessLock);
      await finalize("storage close", closeStorage);
      if (finalizationFailure) throw finalizationFailure;
      info("shutdown: listeners closed and account writes settled");
    })();
    return stopping;
  };
  /** Whether a stop is under way, for a health check to stop saying "well". */
  shutdown.inProgress = () => stopping !== null;
  return shutdown;
};

/**
 * Installs the only process-global lifecycle handlers in the executable.
 *
 * Three ways a stop can be asked for, and one way it is forced:
 *
 *   SIGTERM, SIGINT, SIGHUP   a supervisor, Ctrl-C, or the terminal the server
 *                             was started in going away. All three mean stop;
 *                             the last used to end the process on the spot,
 *                             with nothing saved and the storage lock left
 *                             behind, for anybody running it over ssh.
 *   uncaughtException         the process is in a state nobody planned for.
 *                             Whatever can still be written is written, and
 *                             the exit is non-zero so a supervisor restarts it.
 *
 * Every one of them goes through the same idempotent shutdown, and the process
 * is ended explicitly when that finishes — a socket still mid-handshake keeps
 * the event loop alive, and "done" should not depend on a stranger hanging up.
 * A shutdown that has not finished by the deadline is abandoned: by then the
 * supervisor is about to do the same thing with less to say about it.
 */
export const installProcessHandlers = ({
  processObject = process,
  shutdown,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  drainMs = EXIT_DRAIN_MS,
  sighupIgnored = hangupIsIgnored(),
}) => {
  let deadline = null;
  let ending = false;
  let failed = false;

  /**
   * Ends the process once the shutdown has, without cutting off what is still
   * finishing. The exit code is set and the event loop is left to empty — a
   * run record or a capture file still being written keeps it alive for the
   * moment that takes. What can hold it open for no good reason, a socket
   * still mid-handshake, gets `drainMs` and no longer.
   */
  const finish = (code) => {
    processObject.exitCode = code;
    const last = setTimeout(() => processObject.exit?.(code), drainMs);
    last.unref?.();
  };

  const stop = (reason, { failure = false } = {}) => {
    if (failure) {
      failed = true;
      processObject.exitCode = 1;
    }
    deadline ??= setTimeout(() => {
      error(`shutdown: not finished after ${timeoutMs}ms; exiting anyway`);
      processObject.exit?.(1);
    }, timeoutMs);
    deadline.unref?.();

    const running = Promise.resolve().then(() => shutdown(reason));
    // Every signal joins the one shutdown; only the first decides the exit.
    if (ending) {
      running.catch(() => undefined);
      return;
    }
    ending = true;
    void running.then(
      () => finish(failed ? 1 : processObject.exitCode ?? 0),
      (problem) => {
        error(`shutdown failed: ${problem.stack ?? problem}`);
        finish(1);
      }
    );
  };

  const onSigterm = () => stop("SIGTERM");
  const onSigint = () => stop("SIGINT");
  const onSighup = () => stop("SIGHUP");
  const onUnhandledRejection = (reason) => {
    count("unhandled_rejections");
    error(`unhandled promise rejection: ${reason?.stack ?? reason}`);
  };
  const onUncaughtException = (problem) => {
    error(`uncaught exception: ${problem?.stack ?? problem}`);
    // More of them while stopping change nothing: the shutdown already under
    // way goes on flushing what it can, and the deadline bounds it. Exiting on
    // the second one threw away the writes the first had started saving.
    stop("uncaught exception", { failure: true });
  };

  processObject.on("SIGTERM", onSigterm);
  processObject.on("SIGINT", onSigint);
  /**
   * Unless the server was started to outlive its terminal. `nohup` works by
   * having the signal ignored before the program starts, and installing a
   * handler undoes that: the server would stop on the very hangup it was
   * launched to survive.
   */
  if (!sighupIgnored) processObject.on("SIGHUP", onSighup);
  processObject.on("unhandledRejection", onUnhandledRejection);
  processObject.on("uncaughtException", onUncaughtException);

  const dispose = () => {
    clearTimeout(deadline);
    processObject.off("SIGTERM", onSigterm);
    processObject.off("SIGINT", onSigint);
    processObject.off("SIGHUP", onSighup);
    processObject.off("unhandledRejection", onUnhandledRejection);
    processObject.off("uncaughtException", onUncaughtException);
  };
  // For a stop the server decides on by itself, under the same deadline.
  dispose.stop = stop;
  return dispose;
};

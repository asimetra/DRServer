import { error, info, warn } from "./log.js";

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
  releaseProcessLock,
  closeStorage,
} = {}) => {
  let stopping = null;

  return (reason = "shutdown") => {
    if (stopping) return stopping;
    stopping = (async () => {
      info(`shutdown: ${reason}; refusing new connections`);
      const listenerClosures = (servers?.() ?? [])
        .filter(Boolean)
        .map((server) => closeListener(server));

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

      const listeners = await Promise.allSettled(listenerClosures);
      for (const result of listeners) {
        if (result.status === "rejected") {
          warn(`shutdown: listener close failed: ${result.reason?.message ?? result.reason}`);
        }
      }
      await waitForWrites?.();
      await releaseProcessLock?.();
      await closeStorage?.();
      info("shutdown: listeners closed and account writes settled");
    })();
    return stopping;
  };
};

/** Installs the only process-global lifecycle handlers in the executable. */
export const installProcessHandlers = ({ processObject = process, shutdown }) => {
  const onSigterm = () => {
    void shutdown("SIGTERM").catch((problem) => {
      error(`shutdown failed: ${problem.stack ?? problem}`);
      processObject.exitCode = 1;
    });
  };
  const onSigint = () => {
    void shutdown("SIGINT").catch((problem) => {
      error(`shutdown failed: ${problem.stack ?? problem}`);
      processObject.exitCode = 1;
    });
  };
  const onUnhandledRejection = (reason) => {
    error(`unhandled promise rejection: ${reason?.stack ?? reason}`);
  };

  processObject.once("SIGTERM", onSigterm);
  processObject.once("SIGINT", onSigint);
  processObject.on("unhandledRejection", onUnhandledRejection);

  return () => {
    processObject.off("SIGTERM", onSigterm);
    processObject.off("SIGINT", onSigint);
    processObject.off("unhandledRejection", onUnhandledRejection);
  };
};

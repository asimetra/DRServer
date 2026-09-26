import "./rpc-handlers.js";
import { start as startWebServices } from "./http.js";
import { activeSocketSessions, start as startGameSocket } from "./socket/index.js";
import { start as startInternalApi } from "./internal.js";
import { config } from "./config.js";
import { closeAccountStorage, waitForAccountWrites } from "./accounts.js";
import { purgeLegacyExperienceBoard, seedStandings } from "./leaderboard.js";
import {
  checkCompatibilityData,
  ensureSafeTransport,
  checkDatabaseSchema,
  ensureTokenSecret,
  reportAuth,
  reportContentOverride,
} from "./preflight.js";
import { error, info } from "./log.js";
import { createGracefulShutdown, installProcessHandlers } from "./shutdown.js";
import { acquireProcessLock } from "./process-lock.js";
import { closeMatchWorkers, startMatchWorkers } from "./socket/match-worker-service.js";

info("Open Dungeon Server — web services + game socket");
if (config.permissive) {
  info("permissive mode: unknown RPC methods answer [] and are logged as TODO");
}

checkCompatibilityData();
reportContentOverride();
await checkDatabaseSchema();
const releaseProcessLock = await acquireProcessLock();
ensureTokenSecret();
reportAuth();
/**
 * Before anything records a run: the experience board changed what it ranks,
 * so the standings kept under its old meaning go, and the figure the board
 * ranks now is lifted out of the accounts — which have held it all along.
 * Both are safe to meet on every boot.
 */
await purgeLegacyExperienceBoard();
await seedStandings();
ensureSafeTransport();
await startMatchWorkers();

const listeners = [startWebServices(), startInternalApi(), startGameSocket()];
const shutdown = createGracefulShutdown({
  servers: () => listeners,
  sessions: activeSocketSessions,
  waitForWrites: waitForAccountWrites,
  closeServices: closeMatchWorkers,
  releaseProcessLock,
  closeStorage: closeAccountStorage,
});
installProcessHandlers({ shutdown });
for (const listener of listeners.filter(Boolean)) {
  listener.on("error", (problem) => {
    error(`listener failed: ${problem.stack ?? problem}`);
    process.exitCode = 1;
    void shutdown("listener failure").catch((shutdownProblem) => {
      error(`shutdown failed: ${shutdownProblem.stack ?? shutdownProblem}`);
    });
  });
}

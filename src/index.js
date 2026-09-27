import path from "node:path";
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
  moveLegacyData,
  ensureTokenSecret,
  reportAuth,
  reportContentOverride,
} from "./preflight.js";
import { error, info } from "./log.js";
import { createGracefulShutdown, installProcessHandlers } from "./shutdown.js";
import { acquireProcessLock } from "./process-lock.js";
import { keepDeclarationsIn, readyContentPacks } from "./content-packs.js";
import { closeMatchWorkers, startMatchWorkers } from "./socket/match-worker-service.js";

info("Open Dungeon Server — web services + game socket");
if (config.permissive) {
  info("permissive mode: unknown RPC methods answer [] and are logged as TODO");
}

checkCompatibilityData();
reportContentOverride();
await checkDatabaseSchema();
const releaseProcessLock = await acquireProcessLock();
// Only once the storage is ours: an older server still running on it would
// write moved rows straight back (see moveLegacyData).
await moveLegacyData();
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
// Which skins and summons to withhold from clients that lack them; each worker
// reads the same file for itself.
await readyContentPacks();
// What each account's client said it has, kept across restarts: the first
// thing a launching client asks for is its own account, before it says.
keepDeclarationsIn(path.join(config.dataDir, "content-declarations.json"));
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

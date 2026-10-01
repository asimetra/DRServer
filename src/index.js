import path from "node:path";
import "./rpc-handlers.js";
import { start as startWebServices } from "./http.js";
import { activeSocketSessions, start as startGameSocket } from "./socket/index.js";
import { internalApiProblem, start as startInternalApi } from "./internal.js";
import { config, configProblems } from "./config.js";
import { closeAccountStorage, waitForAccountWrites } from "./accounts.js";
import { purgeLegacyExperienceBoard, seedStandings, waitForRunRecords } from "./leaderboard.js";
import {
  StartupRefusal,
  checkCompatibilityData,
  ensureSafeTransport,
  checkDatabaseSchema,
  moveLegacyData,
  ensureTokenSecret,
  reportAuth,
  reportContentOverride,
  reportUnreadEnvFile,
} from "./preflight.js";
import { error, info, warn } from "./log.js";
import { createGracefulShutdown, installProcessHandlers } from "./shutdown.js";
import {
  ProcessLockHeldError,
  acquireProcessLock,
  initializeProcessStorage,
} from "./process-lock.js";
import { flushDeclarations, keepDeclarationsIn, readyContentPacks } from "./content-packs.js";
import { closeMatchWorkers, startMatchWorkers } from "./socket/match-worker-service.js";
import { waitForRunSaves } from "./socket/run-saves.js";

info("Open Dungeon Server — web services + game socket");
if (config.permissive) {
  info("permissive mode: unknown RPC methods answer [] and are logged as TODO");
}

reportUnreadEnvFile();
checkCompatibilityData();
reportContentOverride();

/**
 * A start that cannot go on: the claim on the storage is given back, the reason
 * is said once, and the process ends.
 *
 * Everything from here to the listeners used to throw straight out of the
 * module. Two things followed from that. A refusal the operator could fix by
 * reading it arrived underneath a source excerpt and a stack, and whatever had
 * been claimed by then stayed claimed — the storage lock outlived the process,
 * and in a container, where the next start has the same process id, the server
 * then refused its own leftover lock for good.
 *
 * Exiting outright is safe here and only here: no listener has accepted
 * anything, and nothing below writes an account.
 */
let releaseProcessLock = null;
let stopServer = null;
const refuseToStart = async (problem) => {
  await releaseProcessLock?.().catch(() => undefined);
  const forTheOperator =
    problem instanceof StartupRefusal || problem instanceof ProcessLockHeldError;
  error(`startup: ${forTheOperator ? problem.message : problem?.stack ?? problem}`);
  process.exit(1);
};

let listeners = [];
try {
  /**
   * What the settings alone can be refused for, before anything is claimed or
   * written. These ran after the lock, the signing secret and — on PostgreSQL —
   * the schema migration, so a server that was never going to start had
   * already changed the deployment it was refusing to serve.
   */
  const { refusals, warnings } = configProblems();
  for (const warning of warnings) warn(`config: ${warning}`);
  if (refusals.length) throw new StartupRefusal(refusals.join("\n  also: "));
  ensureSafeTransport();
  const internalProblem = internalApiProblem();
  if (internalProblem) throw new StartupRefusal(internalProblem);

  releaseProcessLock = await acquireProcessLock({
    /**
     * The lock was taken away and could not be had back — the database
     * connection that was the lock, or a lock file that now names somebody
     * else: another server may be writing these accounts. Stopping is the only
     * safe answer, and a non-zero exit so that a supervisor starts this one
     * again — where it will either get the lock or be told who has it.
     */
    onLost: (problem) => {
      error(`storage: this server no longer holds its storage lock (${problem.message})`);
      if (stopServer) stopServer("storage lock lost", { failure: true });
      else process.exit(1);
    },
  });
  if (!(await checkDatabaseSchema())) {
    throw new StartupRefusal(
      "database schema check failed; refusing to start with unsafe persistence"
    );
  }
  // Only once the storage is ours: an older server still running on it would
  // write moved rows straight back (see moveLegacyData).
  await moveLegacyData();
  // The schema and legacy rows are now current, so the shared id sequence can
  // be raised once before any match worker starts allocating from it.
  await initializeProcessStorage();
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
  // Which skins and summons to withhold from clients that lack them; each worker
  // reads the same file for itself.
  await readyContentPacks();
  // What each account's client said it has, kept across restarts: the first
  // thing a launching client asks for is its own account, before it says.
  keepDeclarationsIn(path.join(config.dataDir, "content-declarations.json"));
  await startMatchWorkers();

  listeners = [startWebServices(), startInternalApi(), startGameSocket()];
} catch (problem) {
  await refuseToStart(problem);
}

const waitForPersistentWrites = async () => {
  // First, because a dungeon save still chained behind another has not reached
  // the account store yet and would not be seen by the wait below.
  await waitForRunSaves();
  await waitForRunRecords();
  const [, declarationsFlushed] = await Promise.all([
    waitForAccountWrites(),
    flushDeclarations(),
  ]);
  if (!declarationsFlushed) {
    throw new Error("content declarations could not be persisted during shutdown");
  }
};
const shutdown = createGracefulShutdown({
  servers: () => listeners,
  sessions: activeSocketSessions,
  waitForWrites: waitForPersistentWrites,
  closeServices: closeMatchWorkers,
  releaseProcessLock,
  closeStorage: closeAccountStorage,
});
stopServer = installProcessHandlers({ shutdown }).stop;
for (const listener of listeners.filter(Boolean)) {
  listener.on("error", (problem) => {
    error(`listener failed: ${problem.stack ?? problem}`);
    // Through the same stop as a signal, so it is under the same deadline.
    stopServer("listener failure", { failure: true });
  });
}

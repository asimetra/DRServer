import "./rpc-handlers.js";
import { start as startWebServices } from "./http.js";
import { start as startGameSocket } from "./socket/index.js";
import { start as startInternalApi } from "./internal.js";
import { config } from "./config.js";
import { purgeLegacyExperienceBoard, seedStandings } from "./leaderboard.js";
import {
  checkCompatibilityData,
  ensureSafeTransport,
  checkDatabaseSchema,
  ensureTokenSecret,
  reportAuth,
  reportContentOverride,
} from "./preflight.js";
import { info } from "./log.js";

info("Open Dungeon Server — web services + game socket");
if (config.permissive) {
  info("permissive mode: unknown RPC methods answer [] and are logged as TODO");
}

checkCompatibilityData();
reportContentOverride();
ensureTokenSecret();
reportAuth();
await checkDatabaseSchema();
/**
 * Before anything records a run: the experience board changed what it ranks,
 * so the standings kept under its old meaning go, and the figure the board
 * ranks now is lifted out of the accounts — which have held it all along.
 * Both are safe to meet on every boot.
 */
await purgeLegacyExperienceBoard();
await seedStandings();
ensureSafeTransport();

startWebServices();
startInternalApi();
startGameSocket();

import "./rpc-handlers.js";
import { start as startWebServices } from "./http.js";
import { start as startGameSocket } from "./socket/index.js";
import { start as startInternalApi } from "./internal.js";
import { config } from "./config.js";
import { purgeLegacyExperienceBoard } from "./leaderboard.js";
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
 * and the standings kept under its old meaning go. Deleting the dead key is
 * safe on every boot — the old name is never written again.
 */
await purgeLegacyExperienceBoard();
ensureSafeTransport();

startWebServices();
startInternalApi();
startGameSocket();

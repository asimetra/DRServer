import "./rpc-handlers.js";
import { start as startWebServices } from "./http.js";
import { start as startGameSocket } from "./socket/index.js";
import { config } from "./config.js";
import {
  checkCompatibilityData,
  ensureSafeTransport,
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
ensureSafeTransport();

startWebServices();
startGameSocket();

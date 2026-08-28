import { config, publicBaseUrl } from "./config.js";
import { loadAccount } from "./accounts.js";
import { dispatch } from "./rpc.js";
import { info } from "./log.js";
import { serveContent } from "./content.js";

const json = (body, status = 200) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * GET /game-status/service-discovery
 * config/ServiceDiscoveryLoader.hx requires webServicesUrl, gameSocketAddress
 * and gameSocketPort; it aborts with Logger.fatal if any is missing.
 * DBFacade derives /rpc/, /api/ and /steam/ roots from webServicesUrl.
 */
const serviceDiscovery = () =>
  json({
    webServicesUrl: publicBaseUrl(),
    gameSocketAddress: config.publicHost,
    gameSocketPort: config.gameSocketPort,
    gameSocketFallbackPort: 0,
  });

/** GET /game-status — online player count (uI/map/PlayerActivityCount.hx). */
const gameStatus = () => json({ players: 1 });

/**
 * GET /api/dbAccountInfo/accountdetails
 * Headers: X-Account-Id, X-Validation-Token.
 * Consumed by DBAccountInfo.parseResponse; a non-2xx answer shows the user an
 * error popup and halts login.
 */
const accountDetails = async (req) => {
  const accountId = Number.parseInt(req.headers["x-account-id"] ?? "", 10);
  if (!Number.isFinite(accountId) || accountId === 0) {
    return json({ error: "missing or invalid X-Account-Id" }, 400);
  }
  const account = await loadAccount(accountId);
  info(`api: served account details for ${accountId}`);
  return json(account);
};

/**
 * POST /rpc/<service>/<method> — JSON-RPC 2.0 envelope in and out.
 */
const rpcCall = async (req, [service, method]) => {
  const id = req.json?.id ?? null;
  try {
    const result = await dispatch(service, method, req.json?.params);
    return json({ jsonrpc: "2.0", id, result });
  } catch (err) {
    return json({
      jsonrpc: "2.0",
      id,
      error: { code: -1, message: err.message },
    });
  }
};

/**
 * Routes are matched in order. `pattern` segments starting with ":" capture.
 */
export const routes = [
  { method: "GET", pattern: "/game-status/service-discovery", handler: serviceDiscovery },
  { method: "GET", pattern: "/game-status", handler: gameStatus },
  { method: "GET", pattern: "/api/dbAccountInfo/accountdetails", handler: accountDetails },
  { method: "POST", pattern: "/rpc/:service/:method", handler: rpcCall },
  /**
   * Whatever this server chooses to hand the client, under one prefix so that
   * everything it does not hand over keeps loading from the player's own copy.
   * Takes the whole remaining path because asset paths nest arbitrarily.
   */
  { method: "GET", pattern: "/content/*", handler: (req, captures) => serveContent(config, captures, req) },
];

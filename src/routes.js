import { config, publicBaseUrl } from "./config.js";
import { loadAccount } from "./accounts.js";
import { dispatch } from "./rpc.js";
import { info, warn } from "./log.js";
import { serveContent } from "./content.js";
import { tokenProblem } from "./auth.js";

const json = (body, status = 200) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Who this caller is, proved — or the refusal to send back.
 *
 * `JSONRPCService` sets `X-Account-Id` and `X-Validation-Token` once and sends
 * them on every POST, so this is the one place that has to look. It could not
 * be done from `params`: the token sits second on most calls, third on a chest
 * open, sixth on a gift and first on a skin change.
 *
 * Returns null to mean "carry on", which keeps the callers to one line.
 */
const accountIdOf = (req) => {
  const raw = req.headers?.["x-account-id"];
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const accountId = Number(raw);
  return Number.isSafeInteger(accountId) && accountId <= 0xffff_ffff ? accountId : null;
};

export const callerOf = (req) =>
  config.authEnabled === false ? null : accountIdOf(req);

export const authorise = (req) => {
  if (config.authEnabled === false) return null;

  const accountId = callerOf(req);
  const token = req.headers?.["x-validation-token"];
  const problem =
    accountId === null ? "no account id" : tokenProblem(accountId, token);
  if (problem === null) return null;

  // Which of the three it was, because "invalid" answered a client sending
  // nonsense, a token that ran out last week and one signed under an older
  // secret all alike, and those want three different answers from an operator.
  warn(`api: refused account ${req.headers?.["x-account-id"] ?? "?"} — ${problem}`);
  return json({ error: "invalid account or validation token" }, 401);
};

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
  const refusal = authorise(req);
  if (refusal) return refusal;

  const accountId = accountIdOf(req);
  if (accountId === null) {
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
  const refusal = authorise(req);
  if (refusal) return refusal;

  const id = req.json?.id ?? null;
  try {
    const result = await dispatch(service, method, req.json?.params, callerOf(req));
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

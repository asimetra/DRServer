import { config, publicBaseUrl } from "./config.js";
import { AccountLeasedError, loadAccount, saveAccount, withAccountLock } from "./accounts.js";
import { dispatch } from "./rpc.js";
import { info, warn } from "./log.js";
import { serveContent } from "./content.js";
import { tokenProblem } from "./auth.js";
import { count } from "./metrics.js";
import { gameStatusFor } from "./game-status.js";
import { declare, declaredView, jsonFor, viewForOwnAccount, viewFromDemographics } from "./content-packs.js";
import { sessionHolding } from "./socket/presence.js";

const json = (body, status = 200) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The same, with every skin named in it in terms this client said it can draw. */
const jsonAs = (view, body, status = 200) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: jsonFor(body, view),
});

/**
 * The calls that carry the client's Demographics, and where, as a real client
 * sends them. The daily reward is asked a moment after login, the friend list
 * soon after, and the lists before those are answered from what was declared
 * last (content-packs.js).
 */
const DECLARING = new Map([
  ["store/AskAboutDailyReward", 2],
  ["leaderboard/getFriendData", 1],
  ["store/PurchaseOffer", 4],
]);

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
  count("auth_refused");
  return json({ error: "invalid account or validation token" }, 401);
};

/** The live socket proved by the same credential as this HTTP request. */
const sessionForRequest = (accountId, req) => {
  const session = sessionHolding(accountId);
  if (!session) return null;
  if (config.authEnabled === false) return session;
  return session.token === req.headers?.["x-validation-token"] ? session : null;
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
    gameSocketAddress: config.publicSocketHost,
    gameSocketPort: config.publicSocketPort,
    gameSocketFallbackPort: 0,
  });

/** GET /game-status — how busy each dungeon is, for the world map (game-status.js). */
const gameStatus = async () => json(await gameStatusFor());

/** Midnight UTC today, which is all of a login the official keeps. */
const today = () => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
};

/**
 * The account, with `last_login` moved to today if this is the day's first
 * launch.
 *
 * Nothing in the client reads the field, which is how it came to be written at
 * creation and never again. The official moves it to the current date, and it
 * is what whoever looks after a server reaches for to tell an account that left
 * months ago from one that was on last night.
 *
 * By the day, as the official's is, so a launch is a write once and a read
 * every other time. The write takes the account's lock like any other change —
 * a launch that lands while a purchase is settling must not save a copy read
 * from before it. An account in a dungeon on a match worker cannot be locked
 * from here; it is plainly in use, so it is answered as it stands and stamped
 * by its next launch.
 */
const accountAtLaunch = async (accountId) => {
  const stamp = today();
  const account = await loadAccount(accountId);
  if (account.last_login === stamp) return account;
  try {
    return await withAccountLock(accountId, async () => {
      const current = await loadAccount(accountId);
      if (current.last_login !== stamp) {
        current.last_login = stamp;
        await saveAccount(current);
      }
      return current;
    });
  } catch (problem) {
    if (!(problem instanceof AccountLeasedError)) throw problem;
    return account;
  }
};

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
  const account = await accountAtLaunch(accountId);
  info(`api: served account details for ${accountId}`);
  /*
   * The market is this server's, not the client's. `market_listings` is a child
   * of the account so that listing a weapon is one atomic write, but the client
   * was never told such a thing exists and this response is parsed by code this
   * server does not change — so it is left out rather than sent and hoped over.
   * So are the server's own market bar and restriction (restrictions.js).
   */
  const { market_listings, market_barred, restriction, ...forTheClient } = account;
  // The first question a launching client asks, before it has said what it
  // has: answered in its last declaration, until this launch confirms it.
  const view = viewForOwnAccount(accountId, {
    connected: Boolean(sessionForRequest(accountId, req)),
  });
  return jsonAs(view, forTheClient);
};

/**
 * POST /rpc/<service>/<method> — JSON-RPC 2.0 envelope in and out.
 */
const rpcCall = async (req, [service, method]) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const id = req.json?.id ?? null;
  const accountId = accountIdOf(req);
  const declaredAt = DECLARING.get(`${service}/${method}`);
  if (declaredAt !== undefined && accountId !== null) {
    const view = viewFromDemographics(req.json?.params?.[declaredAt]);
    if (view) {
      declare(accountId, view);
      // This declaration normally arrives just after socket login. Keep the
      // live connection in the same view as its HTTP answers immediately;
      // dungeon entry will repeat it, but the town/store flow must not wait.
      const session = sessionForRequest(accountId, req);
      if (session) session.contentView = view;
    }
  }
  try {
    const result = await dispatch(service, method, req.json?.params, callerOf(req));
    return jsonAs(declaredView(accountId), { jsonrpc: "2.0", id, result });
  } catch (err) {
    return json({
      jsonrpc: "2.0",
      id,
      error: {
        code: Number.isSafeInteger(Number(err.code)) ? Number(err.code) : -1,
        message: err.message,
      },
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

import http from "node:http";
import { config } from "./config.js";
import { routes } from "./routes.js";
import { error, info, truncate, unimplemented, warn } from "./log.js";

/**
 * What one request may weigh.
 *
 * The body was read before the route was found, so before anything asked who
 * was calling, and nothing bounded it: a client that never stopped sending
 * held as much of this server's memory as it cared to. Across 1872 recorded
 * requests the median body is 154 bytes and the largest ever sent is 775, from
 * `getAllMapnodeScores` — the 75KB payloads in the same recordings are this
 * server's own answers, which this does not govern. 64KB leaves eighty times
 * the room anything real has ever asked for.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * How many requests one address may make in ten seconds.
 *
 * The busiest second a recorded client ever had held 20 requests and its
 * busiest ten seconds held 64. Players share an address whenever they sit
 * behind the same router, so this is five of them at once at their busiest:
 * high enough that nobody playing will meet it, low enough that a flood will.
 */
export const RATE_WINDOW_MS = 10_000;
export const RATE_LIMIT = 320;

const rates = new Map();

/** Forgets every counted address. Exists for tests. */
export const resetRates = () => rates.clear();

export const withinRate = (address, now = Date.now()) => {
  const seen = rates.get(address);
  if (!seen || now - seen.since >= RATE_WINDOW_MS) {
    /**
     * Swept while somebody is asking rather than on a timer, so an idle server
     * holds no work and the table cannot grow while nothing is happening.
     */
    if (rates.size > 10_000) {
      for (const [key, entry] of rates) {
        if (now - entry.since >= RATE_WINDOW_MS) rates.delete(key);
      }
    }
    rates.set(address, { since: now, count: 1 });
    return true;
  }

  seen.count += 1;
  return seen.count <= RATE_LIMIT;
};

export class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}

export const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        /**
         * What has been collected goes back immediately — holding it is the
         * cost being refused. The socket is left to the caller, which answers
         * 413 and only then hangs up; tearing it down here means the sender is
         * told nothing and sees the connection die.
         */
        over = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/**
 * Matches a path against a route pattern, returning captures or null.
 *
 * A trailing `*` takes everything left and joins it back into one capture.
 * Asset paths are why: `Resources/Levels/castle/tiles.json` is four segments
 * and the route serving it cannot know how many to expect.
 *
 * Splitting on "/" and dropping the empty pieces means the capture never
 * contains an empty segment, so `a//../b` cannot smuggle a level up through
 * this. The file server resolves and re-checks anyway.
 */
const match = (pattern, pathname) => {
  const wanted = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);

  if (wanted.at(-1) === "*") {
    const fixed = wanted.slice(0, -1);
    if (actual.length < fixed.length) return null;
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i] !== actual[i]) return null;
    }
    return [actual.slice(fixed.length).map(decodeURIComponent).join("/")];
  }

  if (wanted.length !== actual.length) return null;

  const captures = [];
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i].startsWith(":")) captures.push(decodeURIComponent(actual[i]));
    else if (wanted[i] !== actual[i]) return null;
  }
  return captures;
};

const findRoute = (routeTable, method, pathname) => {
  for (const route of routeTable) {
    if (route.method !== method) continue;
    const captures = match(route.pattern, pathname);
    if (captures) return { route, captures };
  }
  return null;
};

const refuse = (res, status, message) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
};

const handle = async (req, res, { routeTable, rateLimited }) => {
  const url = new URL(req.url, "http://localhost");

  /**
   * Both of these come before the body is read, which is the whole point:
   * everything below this line costs memory, and until now the cost was paid
   * for anybody who asked, including for paths that do not exist.
   */
  const address = req.socket?.remoteAddress ?? "unknown";
  if (rateLimited && !withinRate(address)) {
    warn(`rate limit: ${address} on ${req.method} ${url.pathname}`);
    req.destroy();
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (!(err instanceof BodyTooLarge)) throw err;
    warn(`oversized body from ${address} on ${req.method} ${url.pathname}`);
    if (!res.headersSent) refuse(res, 413, "request body too large");
    // Told first, then hung up, so a sender still streaming stops costing a
    // socket without being left to guess why.
    res.on("finish", () => req.destroy());
    return;
  }

  info(`${req.method} ${url.pathname}${body ? ` body=${truncate(body)}` : ""}`);

  const found = findRoute(routeTable, req.method, url.pathname);
  if (!found) {
    unimplemented(`${req.method} ${url.pathname}`, body ? `body=${truncate(body)}` : "");
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not implemented" }));
    return;
  }

  const request = { headers: req.headers, query: url.searchParams, body, json: null };
  if (body) {
    try {
      request.json = JSON.parse(body);
    } catch {
      // Not every request is JSON; handlers that need it check for null.
    }
  }

  const result = await found.route.handler(request, found.captures);
  res.writeHead(result.status, result.headers);
  res.end(result.body);
  info(`  -> ${result.status} ${truncate(result.body)}`);
};

/**
 * One HTTP listener over one route table.
 *
 * Taken apart from `start` so the internal API can be a second listener on a
 * port of its own rather than a prefix on this one. Everything either of them
 * wants — the body limit, the JSON parse, the failure that must not take the
 * process down — is here and is not worth having twice.
 *
 * `rateLimited` is the one thing they disagree about. The player-facing limit
 * is calibrated per address against what a game client does, and a web front
 * end is a single address making every call there is; measuring it against a
 * budget meant for one player would refuse it under ordinary load.
 */
export const listen = ({ routeTable, host, port, rateLimited = true, onReady }) => {
  const server = http.createServer((req, res) => {
    handle(req, res, { routeTable, rateLimited }).catch((err) => {
      error(`unhandled failure on ${req.method} ${req.url}: ${err.stack ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });

  server.listen(port, host, onReady);
  return server;
};

export const start = () =>
  listen({
    routeTable: routes,
    host: config.host,
    port: config.port,
    onReady: () => {
      info(`web services listening on http://${config.host}:${config.port}`);
      info(`advertising webServicesUrl http://${config.publicHost}:${config.port}`);
      info(`advertising game socket ${config.publicHost}:${config.gameSocketPort}`);
    },
  });

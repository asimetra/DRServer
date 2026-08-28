import http from "node:http";
import { config } from "./config.js";
import { routes } from "./routes.js";
import { error, info, truncate, unimplemented } from "./log.js";

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
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

const findRoute = (method, pathname) => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const captures = match(route.pattern, pathname);
    if (captures) return { route, captures };
  }
  return null;
};

const handle = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const body = await readBody(req);

  info(`${req.method} ${url.pathname}${body ? ` body=${truncate(body)}` : ""}`);

  const found = findRoute(req.method, url.pathname);
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

export const start = () => {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      error(`unhandled failure on ${req.method} ${req.url}: ${err.stack ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });

  server.listen(config.port, config.host, () => {
    info(`web services listening on http://${config.host}:${config.port}`);
    info(`advertising webServicesUrl http://${config.publicHost}:${config.port}`);
    info(`advertising game socket ${config.publicHost}:${config.gameSocketPort}`);
  });

  return server;
};

/**
 * The browser build of the client, served under /play/.
 *
 * Kept apart from `/content/` (content.js) because it is a different kind of
 * thing: a whole game, 230 MB across ~450 bundles, where `/content/` is a few
 * overrides read once and held in memory. So the bundles are streamed from
 * disk and never held (only compressed text is, below), and all of it skips
 * the per-address request budget and the request log,
 * which are sized for a player's API calls — one page load asks for more files
 * than that budget allows in ten seconds.
 *
 * The containment rule is content.js's: resolve, then require the result (and
 * its real path, through any symlink) to be inside the root.
 *
 * Every file carries a validator (size and modification time), and a browser
 * that already holds it gets a 304: without that, "no-cache" meant downloading
 * the whole 75 MB of a first floor again on every visit. Text goes gzipped to a
 * browser that asks — the script is 10 MB and 1.3 MB compressed, the rules
 * table 5.7 MB — compressed once per build and kept; bundles are jpg and png
 * already and go as they are.
 */
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const gzip = promisify(zlib.gzip);

export const WEB_CLIENT_PREFIX = "/play";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE = new Set([".html", ".js", ".json", ".txt", ".xml", ".svg"]);
/**
 * path -> { stamp, body }: the gzipped text, until the file changes.
 *
 * `body` is the promise of it, held from the first request on: after a
 * rebuild everybody asks for the 10 MB script at once, and each would
 * otherwise read and compress a copy of its own. A failure is not kept.
 */
const compressed = new Map();

const gzipped = (file, stamp, handle) => {
  const held = compressed.get(file);
  if (held?.stamp === stamp) {
    void handle.close().catch(() => undefined);
    return held.body;
  }
  const entry = { stamp, body: null };
  entry.body = fs.promises
    .readFile(handle)
    .then((raw) => gzip(raw))
    .catch((problem) => {
      if (compressed.get(file) === entry) compressed.delete(file);
      throw problem;
    })
    .finally(() => handle.close().catch(() => undefined));
  compressed.set(file, entry);
  return entry.body;
};

const containedBy = (root, target) =>
  target === root || target.startsWith(root + path.sep);

const insideRoot = (root, rest) => {
  const base = path.resolve(root);
  const wanted = path.resolve(base, rest);
  if (!containedBy(base, wanted)) return null;
  return wanted;
};

export const isWebClientPath = (pathname) =>
  pathname === WEB_CLIENT_PREFIX || pathname.startsWith(`${WEB_CLIENT_PREFIX}/`);

const notFound = (res) => {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
};

/** Answers a GET or HEAD under /play/ from `root`. */
export const serveWebClient = async (req, res, pathname, root) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  // The page loads its files relative to itself, so it has to be /play/, not /play.
  if (pathname === WEB_CLIENT_PREFIX) {
    res.writeHead(301, { Location: `${WEB_CLIENT_PREFIX}/` });
    res.end();
    return;
  }

  let rest;
  try {
    rest = decodeURIComponent(pathname.slice(WEB_CLIENT_PREFIX.length + 1));
  } catch {
    notFound(res);
    return;
  }
  if (rest === "" || rest.endsWith("/")) rest += "index.html";

  let canonicalRoot;
  try {
    canonicalRoot = await fs.promises.realpath(root);
  } catch {
    notFound(res);
    return;
  }
  const file = insideRoot(canonicalRoot, rest);
  if (!file) {
    notFound(res);
    return;
  }
  let canonicalFile;
  let handle;
  let stat;
  try {
    canonicalFile = await fs.promises.realpath(file);
    if (!containedBy(canonicalRoot, canonicalFile)) throw new Error("outside web root");
    handle = await fs.promises.open(
      canonicalFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    if (process.platform === "linux") {
      // Validate what was actually opened, not a pathname that can be swapped
      // between realpath/stat and the later read.
      try {
        const opened = await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
        if (!containedBy(canonicalRoot, opened)) throw new Error("opened outside web root");
      } catch (problem) {
        if (problem.message === "opened outside web root") throw problem;
        // A Linux sandbox may not mount /proc. O_NOFOLLOW still protects the
        // final component and the canonical target is used below.
      }
    }
    stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
  } catch {
    await handle?.close().catch(() => undefined);
    notFound(res);
    return;
  }

  const extension = path.extname(canonicalFile).toLowerCase();
  const stamp = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
  const etag = `"${stamp}"`;
  const shared = {
    // Revalidated rather than trusted, so a rebuilt page, script or pack is
    // picked up on the next visit; unchanged, the answer is a 304 and no body.
    "Cache-Control": "no-cache",
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
    Vary: "Accept-Encoding",
  };
  const offered = req.headers["if-none-match"];
  const since = Date.parse(req.headers["if-modified-since"] ?? "");
  const unchanged = offered
    ? offered.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)
    : Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) <= Math.floor(since / 1000);
  if (unchanged) {
    await handle.close().catch(() => undefined);
    res.writeHead(304, shared);
    res.end();
    return;
  }

  const type = TYPES[extension] ?? "application/octet-stream";
  if (COMPRESSIBLE.has(extension) && /\bgzip\b/i.test(req.headers["accept-encoding"] ?? "")) {
    let body;
    try {
      body = await gzipped(canonicalFile, stamp, handle);
    } catch {
      notFound(res);
      return;
    }
    res.writeHead(200, { ...shared, "Content-Type": type, "Content-Encoding": "gzip", "Content-Length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  res.writeHead(200, { ...shared, "Content-Type": type, "Content-Length": String(stat.size) });
  if (req.method === "HEAD") {
    await handle.close().catch(() => undefined);
    res.end();
    return;
  }
  const stream = handle.createReadStream({ autoClose: true });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
};

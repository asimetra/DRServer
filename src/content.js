/**
 * Files this server hands to the client, and only those.
 *
 * The client builds every asset path as `download_root + path` and fetches it
 * with a URLRequest, so pointing one path at this server is how a floor gets a
 * tile library the player does not have on disk. It is deliberately not a
 * mirror of the game's Resources folder: anything not overridden should keep
 * loading from the player's own copy, because that is the difference between
 * shipping a lobby and shipping the game again.
 *
 * A directory served on request is a directory served on *any* request, so the
 * only thing here with real teeth is the containment check.
 */
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { config } from "./config.js";

const gzip = promisify(zlib.gzip);

const TYPES = {
  ".json": "application/json",
  ".swf": "application/x-shockwave-flash",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The absolute path a request names, or null if that is not inside the root.
 *
 * Resolved and then compared rather than scanned for "..", because scanning is
 * a guess at every spelling of the same thing — `%2e%2e`, `....//`, an absolute
 * path, a symlink — and resolution is the answer to all of them at once. The
 * separator on the end of the root matters: without it `/srv/content-other`
 * passes a prefix test against `/srv/content`.
 */
const insideRoot = (root, rest) => {
  const base = path.resolve(root);
  const wanted = path.resolve(base, rest);
  if (wanted !== base && !wanted.startsWith(base + path.sep)) return null;
  return wanted;
};

const missing = { status: 404, headers: { "Content-Type": "application/json" }, body: "{}" };

/**
 * Whether this server holds its own copy of an asset.
 *
 * This is the whole override rule, and it is deliberately not a list: putting a
 * file in the content directory *is* how you override it, and taking it out is
 * how you stop. Nothing has to be registered, and the two can never disagree.
 *
 * Without it the rewrite is all-or-nothing. Pointing the client at this server
 * for one tile library sent it here for every sprite sheet and sound bank too —
 * forty-odd files it would have found on its own disk, each one now a request
 * this server has to answer or the floor does not draw.
 *
 * Cached because it is asked once per asset per floor load and the answer only
 * changes when somebody puts a file there, which is a restart in practice.
 */
const held = new Map();

export const isOverridden = (assetPath) => {
  const root = String(config.contentDir ?? "");
  const rest = String(assetPath ?? "");
  if (!root || !rest) return false;

  const key = `${root}|${rest}`;
  if (held.has(key)) return held.get(key);

  const file = insideRoot(root, rest);
  const answer = Boolean(file) && fs.existsSync(file) && fs.statSync(file).isFile();
  held.set(key, answer);
  return answer;
};

/** Only for tests, and for anyone adding files to a running server. */
export const forgetOverrides = () => held.clear();

export const serveContent = async ({ contentDir } = config, captures = [], request = null) => {
  const root = String(contentDir ?? "");
  const rest = String(captures[0] ?? "");
  if (!root || !rest) return missing;

  // Compressed only for a client that said it would understand it. The game's
  // own loader is a Flash URLRequest and may well not, so this is asked rather
  // than assumed — sending gzip to a client that did not ask is not an
  // optimisation, it is corruption.
  const wantsGzip = /\bgzip\b/i.test(String(request?.headers?.["accept-encoding"] ?? ""));

  let decoded;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // A path that is not valid percent-encoding names no file.
    return missing;
  }

  const file = insideRoot(root, decoded);
  if (!file) return missing;

  try {
    // Follows symlinks, so a link planted inside the root that points out of it
    // is caught by the same containment check as a "..".
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return missing;
    if (!insideRoot(root, await fs.promises.realpath(file))) return missing;

    const { body, encoding } = await bodyOf(file, stat, wantsGzip);
    return {
      status: 200,
      headers: {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(body.length),
        ...(encoding ? { "Content-Encoding": encoding } : {}),
      },
      body,
    };
  } catch {
    return missing;
  }
};

/**
 * The bytes to send, read once and kept.
 *
 * Every client asks for the same file, so reading it per request is the wrong
 * shape at any scale worth having: the rules table is four megabytes, and a
 * thousand players launching after an update — which is exactly when they all
 * launch — would put four gigabytes of identical buffers in flight. Bandwidth
 * was never the constraint. This was.
 *
 * Compressed once for the same reason, and it is worth a great deal here: the
 * rules table is JSON and goes from 4.0 MB to 248 KB, seventeen to one. The
 * client's own URLs are version-keyed (`?v=` from `Facade.fileVersion`), so it
 * was built expecting to be cached; this is the same idea one hop earlier, for
 * a client we cannot assume caches anything.
 *
 * Keyed on size and mtime so replacing a file takes effect without a restart —
 * which matters, because editing one and reloading the game is the whole
 * authoring loop.
 */
const bodies = new Map();

const bodyOf = async (file, stat, wantsGzip) => {
  const key = `${file}|${stat.size}|${stat.mtimeMs}|${wantsGzip ? "gzip" : "raw"}`;
  const kept = bodies.get(key);
  if (kept) return kept;

  const raw = await fs.promises.readFile(file);
  // Below a few kilobytes the header costs more than the saving.
  const worth =
    wantsGzip && raw.length > 4096 && COMPRESSIBLE.has(path.extname(file).toLowerCase());
  const entry = worth
    ? { body: await gzip(raw), encoding: "gzip" }
    : { body: raw, encoding: null };

  // One file changing should not strand every other one in memory.
  for (const other of bodies.keys()) {
    if (other.startsWith(`${file}|`)) bodies.delete(other);
  }
  bodies.set(key, entry);
  return entry;
};

/** SWF and audio are already compressed; gzipping them buys nothing. */
const COMPRESSIBLE = new Set([".json", ".xml", ".txt"]);

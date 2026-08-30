/**
 * Says at startup what would otherwise be found out by a player.
 *
 * The server binds its ports and reports itself healthy with no compatibility
 * data at all, because nothing reads that data until somebody enters a floor.
 * So a fresh install looks like it worked, and the first thing that goes wrong
 * goes wrong for a person who is already playing — an `ENOENT` in the log, a
 * client stuck on a loading screen, and nothing connecting the two to the
 * install step that was skipped.
 *
 * This does not refuse to start. Running the web services alone is a legitimate
 * thing to do, and a server that will not boot is a worse failure than one that
 * says clearly what it cannot do yet.
 *
 * The manifest is the single source of truth for what is required, the same
 * list tools/sync-game-data.js imports and verifies. Existence only: checksums
 * are `npm run check:data`'s job, and thirty-eight stats are not worth turning
 * into thirty-eight reads on every boot.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { info, warn } from "./log.js";
import { generateSecret } from "./auth.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(serverRoot, "game-data", "manifest.json");

/** Where the manifest's `Resources/...` source path lands locally. */
const localPathFor = (entry) =>
  path.resolve(config.resourcesDir, String(entry.source).replace(/^Resources[\\/]/, ""));

export const checkCompatibilityData = () => {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (problem) {
    warn(`compatibility manifest unreadable (${problem.message}); data check skipped`);
    return { required: 0, missing: 0 };
  }

  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const missing = entries.filter((entry) => !fs.existsSync(localPathFor(entry)));

  if (!missing.length) {
    info(`compatibility data present (${entries.length} files)`);
    return { required: entries.length, missing: 0 };
  }

  warn(`compatibility data incomplete: ${missing.length} of ${entries.length} files missing`);
  warn(`  looked in ${config.resourcesDir}`);
  for (const entry of missing.slice(0, 3)) warn(`  missing ${entry.source}`);
  if (missing.length > 3) warn(`  ...and ${missing.length - 3} more`);
  warn("  dungeons will fail to load until this is imported from your own client:");
  warn("  npm run sync:data -- --source /path/to/your/client");

  return { required: entries.length, missing: missing.length };
};

/**
 * Whether this server is supplying game data of its own, and at what address.
 *
 * Worth a line because the feature is invisible from the outside: it needs a
 * matching pair of keys in the *client's* configuration, and if either side is
 * unset the floors simply come off the player's disk with nothing said. An
 * operator who has set one and not the other has no other way to find out.
 */
export const reportContentOverride = () => {
  if (!config.contentBaseUrl || !config.contentDir) {
    info("content override off; clients load all game data from their own disk");
    return false;
  }

  let files = 0;
  const count = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) count(path.join(directory, entry.name));
      else files += 1;
    }
  };
  try {
    count(config.contentDir);
  } catch {
    warn(`content directory unreadable: ${config.contentDir}`);
    return false;
  }

  info(`serving ${files} content files at ${config.contentBaseUrl}`);
  info('  clients need download_root "" and a matching gameMasterPath');
  return true;
};

/**
 * The signing secret, made once and kept.
 *
 * An operator should not have to invent a key before the server will start, and
 * a key that changes on restart would sign every player out — which is exactly
 * what the previous in-memory token table did, unnoticed, because nothing ever
 * checked a token. So it is written beside the account data on first run and
 * read back afterwards. `ODS_TOKEN_SECRET` overrides it and is the right answer
 * for more than one machine.
 */
export const ensureTokenSecret = () => {
  if (config.tokenSecret) return config.tokenSecret;

  const file = path.join(config.dataDir, "token-secret");
  try {
    config.tokenSecret = fs.readFileSync(file, "utf8").trim();
    if (config.tokenSecret) return config.tokenSecret;
  } catch {
    // First run, or it was removed; either way one is made below.
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  config.tokenSecret = generateSecret();
  fs.writeFileSync(file, `${config.tokenSecret}\n`, { mode: 0o600 });
  info(`auth: wrote a new signing secret to ${file}`);
  return config.tokenSecret;
};

/** Says plainly whether this server checks who is calling. */
export const reportAuth = () => {
  if (config.authEnabled === false) {
    warn("auth is OFF — any client may claim any account id on this server");
    return false;
  }
  info("auth on; issue a player's first token with: node tools/token.js <accountId>");
  return true;
};

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

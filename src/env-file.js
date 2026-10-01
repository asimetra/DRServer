import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Reading a `.env`, without the side effect of having read it.
 *
 * load-env.js applies the repository's file to this process the moment it is
 * imported, which is what a tool wants and what a test must not get. The work
 * itself is here, on a file and an environment that are both handed in.
 */

/** Settings that name a file or directory, under either prefix. */
const PATH_SETTINGS = [
  "DATA_DIR",
  "RESOURCES_DIR",
  "CONTENT_DIR",
  "CAPTURE_DIR",
  "WEB_CLIENT_DIR",
  "CONFIG_FILE",
  "ACCOUNT_TEMPLATE",
  "FLOOR_CATALOG",
  "CONTENT_PACKS",
].flatMap((name) => [`ODS_${name}`, `DR_${name}`]);

const read = (file) => {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch (problem) {
    if (problem.code === "ENOENT") return null;
    throw problem;
  }
};

/**
 * Fills `environment` from the file, leaving alone whatever is already set:
 * `ODS_DATA_DIR=/tmp/x node tools/grant.js` still means /tmp/x.
 *
 * A relative path that comes *from the file* is resolved against the file's
 * own directory. The file sits beside package.json, and `npm start` runs from
 * there, so `ODS_DATA_DIR=data` has always meant the repository's `data/` to
 * the server. A tool run from anywhere else resolved the same line against
 * wherever it was run — an empty store with a lock of its own, written to and
 * reported as a success. A relative path given in the environment is the
 * caller's own and keeps meaning what the caller's shell means by it.
 */
export const applyEnvFile = (file, environment = process.env) => {
  const settings = read(file);
  if (!settings) return false;
  const root = path.dirname(file);
  for (const [key, value] of Object.entries(settings)) {
    if (key in environment) continue;
    environment[key] =
      PATH_SETTINGS.includes(key) && value && !path.isAbsolute(value)
        ? path.resolve(root, value)
        : value;
  }
  return true;
};

/** What the file sets that this environment does not have at all. */
export const unreadEnvSettings = (file, environment = process.env) =>
  Object.keys(read(file) ?? {}).filter((key) => !(key in environment));

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The commit a checkout is on, read from `.git` rather than by running git:
 * the server has no business depending on a program being installed in order
 * to say what it is. Null in a source archive, where there is no `.git`.
 */
const commitOf = (root) => {
  try {
    const gitDir = path.join(root, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 7) || null;
    const ref = head.slice(4).trim();
    try {
      return fs.readFileSync(path.join(gitDir, ref), "utf8").trim().slice(0, 7) || null;
    } catch {
      // A ref with no file of its own lives in packed-refs.
      const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
      const line = packed.split("\n").find((entry) => entry.endsWith(` ${ref}`));
      return line ? line.slice(0, 7) : null;
    }
  } catch {
    return null;
  }
};

let cached = null;

/**
 * Which build this is. Asked for by the startup banner and the status route,
 * because "is the fix deployed" should be answerable without shell access to
 * the checkout. `ODS_BUILD_COMMIT` is for an image built without its `.git`.
 */
export const buildInfo = () => {
  if (cached) return cached;
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8")).version;
  } catch {
    // Left as unknown: a server that cannot read its own manifest still runs.
  }
  const stated = process.env.ODS_BUILD_COMMIT ?? process.env.DR_BUILD_COMMIT;
  cached = Object.freeze({ version, commit: stated || commitOf(serverRoot) });
  return cached;
};

export const describeBuild = () => {
  const { version, commit } = buildInfo();
  return commit ? `${version} (${commit})` : version;
};

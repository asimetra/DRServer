#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = process.env.ODS_PUBLIC_RELEASE_ROOT
  ? path.resolve(process.env.ODS_PUBLIC_RELEASE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const insensitiveEre = (text) =>
  [...text].map((character) => {
    if (/[a-z]/i.test(character)) return `[${character.toLowerCase()}${character.toUpperCase()}]`;
    return /[\\.^$*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
  }).join("");

const legacyProduct = ["Dungeon", "Rampage"].join(" ");
const legacyRepository = ["Dungeon", "Rampage"].join("-");
const privateWorktree = ["DR", "Haxe"].join("");
const localHome = ["", "home", "simetra", ""].join("/");

const forbiddenDirectories = new Set([
  ".claude",
  ".git",
  ".kilo",
  ".kilocode",
  ".omx",
  "content",
  "data",
  "local-data",
  "logs",
  "logs-fresh",
  "node_modules",
]);
const forbiddenExtensions = new Set([
  ".core",
  ".dll",
  ".dylib",
  ".exe",
  ".jsonl",
  ".ndll",
  ".so",
  ".swf",
]);
const forbiddenPrefixes = [
  "game-data/Resources/",
];
/**
 * Where the game may be named.
 *
 * The README has to say which game this server is compatible with, or nobody
 * arriving at the repository can tell what it is for. That is one sentence in
 * one file, and it is the only exception: source, tools and every other
 * document keep to the server's own name. The README is still read for
 * everything else — a token or a local path pasted into it fails like anywhere.
 */
const namesTheGame = new Set(["README.md"]);

const forbiddenText = [
  {
    pattern: new RegExp(legacyProduct, "gi"),
    label: "legacy product name",
    history: ["--extended-regexp", "-G", insensitiveEre(legacyProduct)],
    allowedIn: namesTheGame,
  },
  {
    pattern: new RegExp(legacyRepository, "gi"),
    label: "legacy repository name",
    history: ["--extended-regexp", "-G", insensitiveEre(legacyRepository)],
    allowedIn: namesTheGame,
  },
  {
    pattern: new RegExp(privateWorktree, "g"),
    label: "private client-worktree name",
    history: ["-S", privateWorktree],
  },
  {
    pattern: new RegExp(localHome, "g"),
    label: "developer-local absolute path",
    history: ["-S", localHome],
  },
  /**
   * A validation token, by the shape only a real one has: an expiry and a
   * whole 64-character signature. The documented example keeps its signature
   * cut short so that an example stays an example. A bare run of hex is
   * deliberately not matched — lockfiles and fixtures are full of them, and a
   * check that cries wolf is a check somebody turns off.
   */
  {
    pattern: /(?<!\d)\d{9,}:[0-9a-f]{64}(?![0-9a-f])/g,
    label: "validation token",
    history: ["--extended-regexp", "-G", "[0-9]{9,}:[0-9a-f]{64}"],
  },
];

const files = [];
let publicPaths = null;
try {
  const { stdout } = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, maxBuffer: 256 * 1024 * 1024 }
  );
  publicPaths = new Set(stdout.split("\0").filter(Boolean));
} catch {
  // A source archive has no index; in that case its filesystem is the release.
}
const walk = async (directory, relative = "") => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!relative && forbiddenDirectories.has(entry.name)) continue;
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (nextRelative === "tools/client-patches") continue;
    if (forbiddenPrefixes.some((prefix) => nextRelative.startsWith(prefix))) {
      failures.push(`${nextRelative}: forbidden redistribution path`);
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, nextRelative);
    else if (entry.isFile() && (!publicPaths || publicPaths.has(nextRelative))) {
      files.push({ full, relative: nextRelative });
    }
  }
};

await walk(root);

for (const file of files) {
  const extension = path.extname(file.relative).toLowerCase();
  if (forbiddenExtensions.has(extension)) {
    failures.push(`${file.relative}: forbidden binary/capture extension`);
    continue;
  }
  const stat = await fs.stat(file.full);
  if (stat.size > 2 * 1024 * 1024) {
    failures.push(`${file.relative}: unexpectedly large public file (${stat.size} bytes)`);
    continue;
  }
  const data = await fs.readFile(file.full);
  if (data.includes(0)) continue;
  const text = data.toString("utf8");
  for (const rule of forbiddenText) {
    if (rule.allowedIn?.has(file.relative)) continue;
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) failures.push(`${file.relative}: contains ${rule.label}`);
  }
}

for (const required of ["LICENSE", "NOTICE.md", "README.md", "game-data/manifest.json"]) {
  try {
    await fs.access(path.join(root, required));
  } catch {
    failures.push(`${required}: required public-release file is missing`);
  }
}

/**
 * The same rules, applied to every path this repository has ever recorded.
 *
 * A working tree can be spotless while the history behind it is not, and the
 * history is the thing that gets pushed. Deleting a file removes it from the
 * next commit, not from the ones before it, so a check that only walks the
 * checkout answers a question nobody was asking.
 *
 * `--all` is deliberate rather than `HEAD`: it reaches every branch, tag, remote
 * ref and — the case that actually happened here — the detached HEAD of a stale
 * worktree, which kept 238 commits of pre-sanitisation history alive in the
 * object store while every visible ref was clean. Anything reachable is
 * something a push could carry.
 */
const historyPaths = async () => {
  const { stdout } = await run("git", ["rev-list", "--objects", "--all"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at !== -1) seen.add(line.slice(at + 1));
  }
  return seen;
};

/** Paths of reachable historical blobs whose diffs introduced forbidden text. */
const historyText = async () => {
  const found = new Map();
  for (const rule of forbiddenText) {
    const { stdout } = await run(
      "git",
      ["log", "--all", "--format=", "--name-only", "--diff-filter=AM", ...rule.history],
      { cwd: root, maxBuffer: 256 * 1024 * 1024 }
    );
    for (const recordedPath of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      if (rule.allowedIn?.has(recordedPath)) continue;
      const labels = found.get(recordedPath) ?? new Set();
      labels.add(rule.label);
      found.set(recordedPath, labels);
    }
  }
  return found;
};

try {
  await run("git", ["rev-parse", "--git-dir"], { cwd: root });
} catch {
  console.log("No Git repository here; history check skipped.");
}

try {
  const recorded = await historyPaths();
  const offenders = new Set();
  for (const recordedPath of recorded) {
    if (forbiddenPrefixes.some((prefix) => recordedPath.startsWith(prefix))) {
      offenders.add(recordedPath.split("/").slice(0, 2).join("/"));
      continue;
    }
    const first = recordedPath.split("/")[0];
    if (recordedPath.includes("/") && forbiddenDirectories.has(first) && first !== ".git") {
      offenders.add(first);
      continue;
    }
    if (forbiddenExtensions.has(path.extname(recordedPath).toLowerCase())) {
      offenders.add(recordedPath);
      continue;
    }
    /**
     * A deployment's own settings, which is where its secrets collect. The
     * ignore rules keep one out of a commit; this is what notices when they
     * were added late, or overridden, or the file was force-added anyway. The
     * tracked example is exempt because placeholders are the point of it.
     */
    const name = path.basename(recordedPath);
    if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") {
      offenders.add(recordedPath);
    }
  }

  if (offenders.size) {
    for (const offender of [...offenders].sort().slice(0, 20)) {
      failures.push(`git history still records ${offender}`);
    }
    if (offenders.size > 20) {
      failures.push(`git history: ${offenders.size - 20} further recorded paths not listed`);
    }
    failures.push(
      "history is not publishable: prune stale worktrees (git worktree prune), " +
        "drop old refs, then garbage-collect (git gc --prune=now)"
    );
  }

  const historicalText = await historyText();
  for (const [recordedPath, labels] of historicalText) {
    failures.push(
      `git history blob ${recordedPath}: contains ${[...labels].sort().join(", ")}`
    );
  }
} catch (problem) {
  failures.push(`git history could not be verified: ${problem.message}`);
}

if (failures.length) {
  for (const failure of failures.sort()) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Public-release check passed (${files.length} files).`);
}

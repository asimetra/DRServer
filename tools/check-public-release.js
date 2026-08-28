#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const forbiddenDirectories = new Set([
  ".git",
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
const forbiddenText = [
  { pattern: new RegExp(["Dungeon", "Rampage"].join(" "), "gi"), label: "legacy product name" },
  { pattern: new RegExp(["Dungeon", "Rampage"].join("-"), "gi"), label: "legacy repository name" },
  { pattern: new RegExp(["DR", "Haxe"].join(""), "g"), label: "private client-worktree name" },
  { pattern: new RegExp(["", "home", "simetra", ""].join("/"), "g"), label: "developer-local absolute path" },
];

const files = [];
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
    else if (entry.isFile()) files.push({ full, relative: nextRelative });
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
} catch (problem) {
  failures.push(`git history could not be verified: ${problem.message}`);
}

if (failures.length) {
  for (const failure of failures.sort()) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Public-release check passed (${files.length} files).`);
}

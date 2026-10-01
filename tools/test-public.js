#!/usr/bin/env node
/**
 * The part of the suite that runs without the operator's own compatibility
 * data.
 *
 * Cloning this repository gives you server code and no game data, because the
 * game data is not ours to ship. Running `npm test` in that state fails several
 * hundred assertions, which reads as a broken project rather than as an
 * unconfigured one — a bad first minute for somebody who has done nothing
 * wrong.
 *
 * The split is decided by running, not by a list. A list would be wrong the
 * moment somebody adds a test: measured against this suite, classifying files
 * by what they import missed thirteen data-dependent files and wrongly accused
 * two others. So each file is run, and a failure is only forgiven when the
 * reason is a missing file *inside the compatibility-data directory*. Anything
 * else is a real failure and is reported as one.
 *
 * When the data is present this delegates to the ordinary runner, because then
 * there is nothing to skip and the full suite is the honest one.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const configDir = path.join(root, "config");
const defaults = JSON.parse(fs.readFileSync(path.join(configDir, "server.defaults.json"), "utf8"));

/**
 * Resolved the way src/config.js resolves it: paths in server.defaults.json are
 * relative to the config directory, not to the repository root. Resolving from
 * the root instead lands one level too high, and then nothing is ever
 * recognised as compatibility data.
 */
const resourcesDir = path.resolve(
  configDir,
  process.env.ODS_RESOURCES_DIR ??
    process.env.DR_RESOURCES_DIR ??
    defaults.resourcesDir ??
    "../local-data/Resources"
);

const hasData = () => {
  try {
    return fs.readdirSync(resourcesDir).length > 0;
  } catch {
    return false;
  }
};

const testFiles = fs
  .readdirSync(path.join(root, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("test", name));

if (hasData()) {
  console.log("Compatibility data present; running the full suite.");
  // Delegate to the ordinary runner so full and public use the same explicit
  // test-file discovery and per-file storage isolation.
  const full = spawnSync(process.execPath, [path.join(root, "tools", "run-tests.js")], {
    cwd: root,
    stdio: "inherit",
  });
  process.exit(full.status ?? 1);
}

console.log(`No compatibility data in ${path.relative(root, resourcesDir)}`);
console.log("Running the data-free subset. Import your own data to run everything:");
console.log("  npm run sync:data -- --source /path/to/your/client\n");

/**
 * Whether a failure is only the absence of data.
 *
 * Matched against the configured directory rather than against the word ENOENT,
 * so a genuine missing-file bug somewhere else in the server still fails.
 */
const onlyMissingData = (output) => {
  const missing = [...output.matchAll(/ENOENT: no such file or directory, ('|")?open('|")? '([^']+)'/g)];
  if (!missing.length) return false;
  return missing.every((match) => path.resolve(match[3]).startsWith(resourcesDir));
};

/**
 * How long one file may run before it is stopped and judged on what it said.
 *
 * A test waiting for something that missing data will never deliver does not
 * fail, it waits — and this runner waited with it, for as long as anybody let
 * it. On a fresh clone that was the whole suite stuck on its forty-second
 * file, and a CI job with nothing to report until the platform killed it.
 */
const FILE_TIMEOUT_MS = Number(process.env.ODS_TEST_FILE_TIMEOUT_MS) || 60_000;

/** The file being run, so that interrupting this runner stops it too. */
let running = null;
const stopGroup = (child) => {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};
// A child in a group of its own no longer hears the terminal's Ctrl-C.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (running) stopGroup(running);
    process.exit(130);
  });
}

const runOne = (file) =>
  new Promise((resolve) => {
    // The same per-file account directory the full runner gives each file, so
    // this one does not write test accounts into a developer's own `data/`.
    const child = spawn(
      process.execPath,
      ["--import", path.join(root, "tools", "test-environment.js"), "--test", file],
      // Its own process group: the file runs in a child of this child, and
      // stopping only the runner would leave the stuck one holding the pipes.
      { cwd: root, detached: process.platform !== "win32" }
    );
    let output = "";
    let timedOut = false;
    running = child;
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child);
    }, FILE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      running = null;
      if (timedOut) output += `\n${file}: stopped after ${FILE_TIMEOUT_MS}ms without finishing\n`;
      resolve({ file, code: timedOut ? 1 : code, output });
    });
  });

const passed = [];
const skipped = [];
const failed = [];

for (const file of testFiles) {
  const result = await runOne(file);
  if (result.code === 0) {
    passed.push(file);
    process.stdout.write(".");
  } else if (onlyMissingData(result.output)) {
    skipped.push(file);
    process.stdout.write("s");
  } else {
    failed.push(result);
    process.stdout.write("F");
  }
}

console.log("\n");
for (const result of failed) {
  console.error(`\nFAIL ${result.file}`);
  console.error(result.output.split("\n").slice(-40).join("\n"));
}

console.log(`passed  ${passed.length}`);
console.log(`skipped ${skipped.length} (need locally imported compatibility data)`);
console.log(`failed  ${failed.length}`);

process.exit(failed.length ? 1 : 0);

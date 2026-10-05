#!/usr/bin/env node
/**
 * The tests a change can reach, and nothing else.
 *
 * `npm run test:changed` runs the test files that import — directly or
 * through other files — what the working tree changes, against HEAD. That is
 * a few files for most edits, where the whole suite is two hundred and takes
 * minutes; a change to something everything imports (src/config.js) honestly
 * reaches nearly all of it, and the list says so.
 *
 * Reach is read from the files, not guessed: static `import`/`export ... from`
 * and a bare `import "..."`, dynamic `import("...")`, and
 * `new URL("...", import.meta.url)` — which is how
 * a module reads a config file or a page, and how a test reads a fixture. A
 * few reads the code does by joined path are listed in KNOWN_READS. Nothing
 * else counts: a file named only in prose is not a dependency.
 *
 *   node tools/related-tests.js            the working tree against HEAD
 *   node tools/related-tests.js --base X   ...and the commits since X
 *   node tools/related-tests.js --direct   only the tests that import a changed
 *                                          file themselves: the first thing to
 *                                          run, not the last
 *   node tools/related-tests.js --list     name them, run nothing
 *   node tools/related-tests.js a.js b.js  for these files, changed or not
 *
 * The rest of the arguments after `--` go to the test runner. A file deep in
 * the runtime (socket/combat.js) is reached by half the suite through the
 * server's entry point, and that is the truth; `--direct` is the short answer
 * while editing, the full reach is the answer before a commit.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Reads the code does by a joined path rather than a specifier the scan would see. */
export const KNOWN_READS = Object.freeze({
  "config/server.defaults.json": ["src/config.js"],
});

/** A change to one of these reaches every test: the runner, or everything's environment. */
export const REACHES_EVERYTHING = Object.freeze([
  "package.json",
  "tools/run-tests.js",
  "tools/test-environment.js",
]);

const SCANNED = ["src", "test", "tools", "config"];
const SPECIFIER = /(?:^|\s)(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, out);
    } else if (/\.(m?js|json)$/.test(entry.name)) out.push(full);
  }
  return out;
};

/** What `file` references, as root-relative paths; a specifier that is not a relative path is not ours. */
export const referencesOf = (root, file, source) => {
  const out = new Set();
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!specifier?.startsWith(".")) continue;
    const target = path.relative(root, path.resolve(path.dirname(path.join(root, file)), specifier));
    if (!target.startsWith("..")) out.add(target.split(path.sep).join("/"));
  }
  return [...out];
};

/** `{ file: [files that reference it] }` over the scanned directories. */
export const reverseGraph = (root = ROOT) => {
  const graph = new Map();
  const note = (target, by) => {
    if (!graph.has(target)) graph.set(target, new Set());
    graph.get(target).add(by);
  };
  for (const dir of SCANNED) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const absolute of walk(full)) {
      const file = path.relative(root, absolute).split(path.sep).join("/");
      if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
      for (const target of referencesOf(root, file, fs.readFileSync(absolute, "utf8"))) note(target, file);
    }
  }
  for (const [target, readers] of Object.entries(KNOWN_READS)) for (const by of readers) note(target, by);
  return graph;
};

export const isTestFile = (file) => /^test\/[^/]+\.test\.js$/.test(file);

/**
 * The test files reached from `changed`, as `{ tests, everything }`:
 * `everything` names the changed file, if any, that reaches the whole suite.
 */
export const relatedTests = ({ changed, graph, allTests, direct = false }) => {
  const everything = changed.find((file) => REACHES_EVERYTHING.includes(file)) ?? null;
  if (everything) return { tests: [...allTests].sort(), everything };
  if (direct) {
    const tests = new Set(changed.filter(isTestFile));
    for (const file of changed) for (const by of graph.get(file) ?? []) if (isTestFile(by)) tests.add(by);
    return { tests: [...tests].sort(), everything: null };
  }
  const seen = new Set();
  const queue = [...changed];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const by of graph.get(file) ?? []) queue.push(by);
  }
  return { tests: [...seen].filter(isTestFile).sort(), everything: null };
};

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

/** The working tree's changes against `base` (HEAD by default), untracked files included. */
export const changedFiles = (base = "HEAD") => {
  const tracked = git("diff", "--name-only", base);
  const untracked = git("ls-files", "--others", "--exclude-standard");
  return [...new Set([...tracked, ...untracked])].filter((file) => fs.existsSync(path.join(ROOT, file)));
};

const main = () => {
  const args = process.argv.slice(2);
  const forwarded = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  const list = own.includes("--list");
  const direct = own.includes("--direct");
  const baseAt = own.indexOf("--base");
  const base = baseAt >= 0 ? own[baseAt + 1] : "HEAD";
  const named = own.filter((arg, i) => !arg.startsWith("--") && own[i - 1] !== "--base");

  const changed = named.length ? named.map((file) => path.relative(ROOT, path.resolve(file)).split(path.sep).join("/")) : changedFiles(base);
  if (!changed.length) {
    console.log("related-tests: nothing changed");
    return;
  }
  const allTests = fs.readdirSync(path.join(ROOT, "test")).filter((name) => name.endsWith(".test.js")).map((name) => `test/${name}`);
  const { tests, everything } = relatedTests({ changed, graph: reverseGraph(ROOT), allTests, direct });

  console.log(`related-tests: ${changed.length} changed file(s)${named.length ? "" : ` against ${base}`}`);
  if (everything) console.log(`related-tests: ${everything} reaches every test; this is the whole suite`);
  if (!tests.length) {
    console.log("related-tests: no test reaches these files" + (changed.some((f) => /\.(js|json)$/.test(f)) ? " — if that is a surprise, the reference may be one the scan cannot see (see KNOWN_READS)" : ""));
    return;
  }
  console.log(`related-tests: ${tests.length} of ${allTests.length} test file(s)${direct ? ", direct" : ""}` + (everything ? "" : `:\n  ${tests.join("\n  ")}`));
  if (list) return;

  const child = spawn(process.execPath, [path.join(ROOT, "tools", "run-tests.js"), ...forwarded, ...tests], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

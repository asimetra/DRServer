/**
 * What the two equivalence harnesses share: a second copy of the server to
 * compare against, a clock that only moves when told, and a random that
 * repeats.
 *
 * `tools/ai-sim.js` and `tools/route-lockstep.js` exist to say whether a
 * change to the monster AI or the route search changed behaviour. That
 * question has two sides, so each needs a *base* — the tree before the change
 * — loaded next to the working tree and asked the same things. A base given
 * as a git ref is unpacked with `git archive` into a directory of its own,
 * and the directories the repository does not track but the server reads
 * (`local-data`, `content`, `node_modules`, the local floor catalogues) are
 * linked into it, so its own `src/config.js` resolves its own paths and both
 * copies read the same game data. Rewriting the config import with `sed`, as
 * the first versions of these harnesses did, is what this replaces.
 *
 * The clock is the other half. Trap timers, generator waits, death blasts and
 * the AI's own attack delays all go through `setTimeout` and `Date.now`, and
 * a run that depends on when the machine happened to schedule them cannot be
 * compared with anything. With the globals swapped for a queue the harness
 * drains itself, a run is a pure function of its seed: the same floor, the
 * same hero, the same timers in the same order, every time.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The checkout these tools belong to, which is the candidate unless told otherwise. */
export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const argument = (name, fallback = null, argv = process.argv) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1] ?? fallback;
};

export const flag = (name, argv = process.argv) => argv.includes(`--${name}`);

/** A comma-separated list, or the fallback list when the flag is absent. */
export const listArgument = (name, fallback, argv = process.argv) => {
  const value = argument(name, null, argv);
  if (value === null) return fallback;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

/**
 * mulberry32, with a count of how often it was asked. The count is part of a
 * run's digest: two builds that draw a different number of randoms have
 * already parted, even when what they drew has not shown yet.
 */
export const seededRandom = (seed) => {
  let state = seed >>> 0;
  const random = () => {
    random.calls += 1;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  random.calls = 0;
  return random;
};

/** Loads a module from a root by its path inside the tree. */
export const importFrom = (root, relative) => import(pathToFileURL(path.join(root, relative)).href);

/**
 * What a checkout holds that the repository does not: the player's game data,
 * the content a deployment serves, the installed dependencies and the floor
 * catalogues a developer is trying out. An unpacked base gets links to the
 * working tree's copies, so the two read the same files.
 */
const UNTRACKED_INPUTS = ["local-data", "content", "node_modules", "game-data/Resources", "config/content-packs.json"];

const linkUntrackedInputs = (from, into) => {
  const link = (relative) => {
    const source = path.join(from, relative);
    const target = path.join(into, relative);
    if (!existsSync(source) || existsSync(target)) return;
    symlinkSync(realpathSync(source), target);
  };
  for (const relative of UNTRACKED_INPUTS) link(relative);
  for (const name of readdirSync(path.join(from, "config"))) {
    if (/^floors\..+\.json$/.test(name)) link(path.join("config", name));
  }
};

const isCheckout = (dir) => existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "src", "socket"));

/**
 * A root to load the server from: a checkout's directory, or a git ref of the
 * tool's own repository unpacked into a temporary directory. `cleanup` removes
 * what was unpacked and nothing else.
 */
export const resolveRoot = (spec, { from = TOOL_ROOT } = {}) => {
  const asPath = path.resolve(spec);
  if (isCheckout(asPath)) return { dir: asPath, label: asPath === from ? "working tree" : asPath, cleanup: () => {} };

  const revision = spawnSync("git", ["-C", from, "rev-parse", "--short", "--verify", `${spec}^{commit}`], { encoding: "utf8" });
  if (revision.status !== 0) {
    throw new Error(`${spec} is neither a checkout nor a git ref of ${from}: ${revision.stderr.trim()}`);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "ods-root-"));
  const archive = spawnSync("git", ["-C", from, "archive", "--format=tar", spec], { maxBuffer: 1 << 30 });
  if (archive.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git archive ${spec} failed: ${archive.stderr.toString().trim()}`);
  }
  const unpack = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  if (unpack.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`unpacking ${spec} failed: ${unpack.stderr.toString().trim()}`);
  }
  linkUntrackedInputs(from, dir);
  return {
    dir,
    label: `${spec} (${revision.stdout.trim()})`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/**
 * A copy of a root with one or more deliberate edits to `src/`, for proving
 * that a harness still notices a change. Everything but `src` is linked, so
 * the copy reads the same data; `src` is copied whole and edited in place.
 * Each edit must match exactly once, or the mutant would not be the one asked
 * for.
 */
export const mutantRoot = (from, mutations) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ods-mutant-"));
  for (const entry of readdirSync(from)) {
    if (entry === "src" || entry.startsWith(".")) continue;
    symlinkSync(realpathSync(path.join(from, entry)), path.join(dir, entry));
  }
  cpSync(path.join(from, "src"), path.join(dir, "src"), { recursive: true });
  for (const { file, from: before, to } of mutations) {
    const target = path.join(dir, file);
    const text = readFileSync(target, "utf8");
    const occurrences = text.split(before).length - 1;
    if (occurrences !== 1) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`${file}: expected ${JSON.stringify(before)} exactly once, found it ${occurrences} times`);
    }
    writeFileSync(target, text.replace(before, to));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * The timer globals, `Date.now` and `performance.now`, replaced by a queue
 * that advances only through `advance`. Timers due at the same instant run in
 * the order they were set; an interval is put back before its callback runs,
 * as Node does. Handles answer `unref`/`ref` so lifecycle scopes and the
 * server's own `timer.unref?.()` calls keep working, and convert to their id
 * so `clearTimeout(Number(handle))` would too.
 *
 * Only the globals are replaced. `setImmediate` stays real and is what
 * `flush` waits on, which lets every promise a timer callback resolved run
 * to its end — a generator's wait, an attack's delayed landing — before the
 * next timer or the next tick, so the order of effects is the queue's order
 * and nothing else's.
 */
export const installVirtualClock = ({ start = 1_000_000 } = {}) => {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    dateNow: Date.now,
    performanceNow: performance.now,
  };
  const timers = new Map();
  let now = start;
  let sequence = 0;
  const handleFor = (id) => ({
    id,
    ref() { return this; },
    unref() { return this; },
    hasRef: () => false,
    refresh() { return this; },
    close() { timers.delete(id); },
    [Symbol.toPrimitive]: () => id,
  });
  const schedule = (callback, delay, args, every) => {
    if (typeof callback !== "function") throw new TypeError("timer callback must be a function");
    const id = ++sequence;
    const wait = every ? Math.max(1, Number(delay) || 1) : Math.max(0, Number(delay) || 0);
    timers.set(id, { id, at: now + wait, callback, args, every: every ? wait : 0 });
    return handleFor(id);
  };
  const cancel = (handle) => {
    if (handle === null || handle === undefined) return;
    timers.delete(typeof handle === "object" ? handle.id : Number(handle));
  };
  globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay, args, false);
  globalThis.setInterval = (callback, delay, ...args) => schedule(callback, delay, args, true);
  globalThis.clearTimeout = cancel;
  globalThis.clearInterval = cancel;
  Date.now = () => now;
  performance.now = () => now;

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const nextDue = () => {
    let next = null;
    for (const timer of timers.values()) {
      if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
    }
    return next;
  };

  const clock = {
    get now() {
      return now;
    },
    get pending() {
      return timers.size;
    },
    failures: 0,
    flush,
    /** Runs every timer due by `until`, in order, and leaves the clock there. */
    async advance(until) {
      for (let next = nextDue(); next && next.at <= until; next = nextDue()) {
        now = next.at;
        if (next.every) next.at = now + next.every;
        else timers.delete(next.id);
        try {
          await next.callback(...next.args);
        } catch (problem) {
          // Node would end the process on a bare timer's throw; counting it
          // keeps the run comparable and reports it at the end.
          clock.failures += 1;
          clock.lastFailure = problem;
        }
        await flush();
      }
      now = until;
    },
    uninstall() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
      Date.now = real.dateNow;
      performance.now = real.performanceNow;
      timers.clear();
    },
  };
  return clock;
};

/** Milliseconds of real time, whatever the virtual clock says. */
export const realNow = (() => {
  const dateNow = Date.now;
  return () => dateNow();
})();

/** A seed for one run, from the pieces that name it; the same pieces give the same seed. */
export const seedFor = (...parts) => {
  let hash = 2166136261;
  for (const character of parts.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

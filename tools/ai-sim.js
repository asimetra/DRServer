#!/usr/bin/env node
/**
 * Whether a change to the monster AI changed what the monsters do.
 *
 *   node tools/ai-sim.js --base master                      the working tree against master, quick
 *   node tools/ai-sim.js --base master --full               the whole matrix: 9 libraries x 3 seeds x 4000 ticks x 3 heroes
 *   node tools/ai-sim.js --base ../other-checkout --libraries nordic/caves --seeds 1,2 --ticks 2000
 *   node tools/ai-sim.js --base HEAD~1 --node 50070 --catalogue config/floors.scenario-test.json --hero walls
 *   node tools/ai-sim.js --digest-out run.txt               one root, its digest written down
 *   npm run sim:ai -- --base master
 *
 * A refactor of the AI is not a change of behaviour, and the only way to say
 * so about a loop with this many branches is to run it. Each run lays out a
 * real floor, puts a scripted hero on it, and ticks `tickNpcAi` on a clock
 * the harness moves itself, with `Math.random`, `session.random`, `Date.now`
 * and the timer globals pinned so the floor's trap timers, generators and
 * delayed hits fire in one order (tools/ai-sim-lib.js). Every tick is hashed
 * — NPC positions, headings, states, hit points, targets, every frame sent,
 * the number of randoms drawn — and the base and the candidate are compared
 * tick for tick. The first tick that differs is named, and the whole state
 * at it is fetched from both and diffed, so the report says which monster did
 * what differently rather than that something did.
 *
 * Three heroes stand in for the players the AI meets: `loadsim` walks at the
 * nearest monster through walls, as tools/load-sim.js does, and hits once a
 * second; `walls` keeps to the floor, which is how a player ends up where a
 * monster cannot follow and the route search works hardest; `walker` walks
 * and never hits, so the monsters it reaches live long enough to kite and
 * back off. `still` stands at the spawn; `script` follows a waypoint file.
 * Each library runs on the first map node of its own theme, so its tiles
 * hold the theme's monsters (tools/ai-sim-lib.js, THEME_NODES).
 *
 * Each root runs in a process of its own: a server loaded twice in one
 * process would share the pinned globals and the module caches, and the
 * second copy's timers would land in the first copy's queue. `--jobs` splits
 * the runs over that many processes per root.
 *
 * Exit status is the answer: 0 when every run agrees on every tick.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argument, flag, listArgument, realNow, resolveRoot, TOOL_ROOT } from "./equivalence-lib.js";
import { HERO_SCRIPTS, LIBRARIES, runWorker } from "./ai-sim-lib.js";

const self = fileURLToPath(import.meta.url);

const PRESETS = {
  quick: { libraries: LIBRARIES, seeds: [1], ticks: 800, heroes: ["loadsim", "walls", "walker"] },
  full: { libraries: LIBRARIES, seeds: [1, 2, 3], ticks: 4000, heroes: ["loadsim", "walls", "walker"] },
};

const usage = () => {
  console.error(
    [
      "usage: node tools/ai-sim.js --base <dir|git-ref> [--candidate <dir>] [--quick|--full]",
      "         [--libraries a/b,c/d] [--seeds 1,2] [--ticks N] [--hero loadsim|walls|walker|still|script]",
      "         [--floor <authored file>] [--node <map node> [--catalogue <floors.json>]] [--script <file>]",
      "         [--tile-count N] [--jobs N] [--explain N]",
      "       node tools/ai-sim.js --digest-out <file> [same selection]      one root, written down",
    ].join("\n")
  );
  process.exit(2);
};

/** The runs the arguments name, each with the seed and label the workers report under. */
const expandRuns = () => {
  const preset = flag("full") ? PRESETS.full : PRESETS.quick;
  const seeds = listArgument("seeds", preset.seeds.map(String)).map(Number);
  const ticks = Number(argument("ticks", preset.ticks));
  const heroes = argument("hero") ? [argument("hero")] : preset.heroes;
  const tileCount = Number(argument("tile-count", 24));
  const script = argument("script");
  const node = argument("node") ? Number(argument("node")) : null;
  const floor = argument("floor");
  for (const hero of heroes) if (!HERO_SCRIPTS.includes(hero)) usage();
  if (heroes.includes("script") && !script) usage();
  if (!Number.isInteger(ticks) || ticks <= 0 || seeds.some((seed) => !Number.isInteger(seed))) usage();

  const worlds = floor
    ? [{ floor, node, name: path.basename(floor, ".json") }]
    : node !== null
      ? [{ node, name: `node${node}` }]
      : listArgument("libraries", preset.libraries).map((library) => ({ library, tileCount, name: library }));
  const runs = [];
  for (const world of worlds) {
    for (const seed of seeds) {
      for (const hero of heroes) {
        const id = `${world.name.replace(/\//g, "-")}~s${seed}~${hero}`;
        runs.push({ ...world, seed, hero, ticks, script, id, label: `${world.name} seed ${seed} ${hero}` });
      }
    }
  }
  return runs;
};

/** Runs a worker on `root` over `runs`; resolves with its lines, keyed by run. */
const runWorkerProcess = (root, runs, { scratch, detail = null, catalogue = null }) =>
  new Promise((resolve, reject) => {
    const runsFile = path.join(scratch, `runs-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(runsFile, JSON.stringify(runs));
    const args = [self, "--worker", "--root", root, "--runs", runsFile];
    if (detail) args.push("--detail", detail);
    const env = {
      ...process.env,
      ODS_LOG_LEVEL: process.env.ODS_LOG_LEVEL ?? "silent",
      ODS_DATA_DIR: process.env.ODS_DATA_DIR ?? scratch,
      ODS_STORAGE: "file",
      ...(catalogue ? { ODS_FLOOR_CATALOG: path.resolve(catalogue) } : {}),
    };
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(runsFile, { force: true });
      const stderr = Buffer.concat(err).toString();
      if (code !== 0) {
        reject(new Error(`worker on ${root} exited ${code}:\n${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(out).toString().split("\n"));
    });
  });

/** The protocol lines of one root's workers, gathered per run. */
const collect = (lines) => {
  const byRun = new Map();
  const record = (run) => {
    let entry = byRun.get(run);
    if (!entry) {
      entry = { build: null, ticks: [], details: new Map(), end: null, label: "" };
      byRun.set(run, entry);
    }
    return entry;
  };
  for (const line of lines) {
    const kind = line[0];
    if (!"RBTDE".includes(kind) || line[1] !== " ") continue;
    const space = line.indexOf(" ", 2);
    const run = line.slice(2, space);
    const rest = line.slice(space + 1);
    const entry = record(run);
    if (kind === "R") entry.label = rest;
    else if (kind === "B") entry.build = rest;
    else if (kind === "T") entry.ticks.push(rest);
    else if (kind === "E") entry.end = rest;
    else if (kind === "D") {
      const at = rest.indexOf(" ");
      entry.details.set(Number(rest.slice(0, at)), JSON.parse(rest.slice(at + 1)));
    }
  }
  return byRun;
};

const runRoot = async (root, runs, jobs, options) => {
  const shares = Array.from({ length: Math.min(jobs, runs.length) }, () => []);
  runs.forEach((run, index) => shares[index % shares.length].push(run));
  const outputs = await Promise.all(shares.map((share) => runWorkerProcess(root, share, options)));
  return collect(outputs.flat());
};

/** The first tick on which two records of one run disagree, or null. */
const firstDifference = (a, b) => {
  if (a.build !== b.build) return { tick: -1, what: `build ${a.build} / ${b.build}` };
  const ticks = Math.max(a.ticks.length, b.ticks.length);
  for (let tick = 0; tick < ticks; tick++) {
    const left = a.ticks[tick];
    const right = b.ticks[tick];
    if (left === right) continue;
    const [, , leftFrames, leftRandom, leftSession] = (left ?? "- - - - -").split(" ");
    const [, , rightFrames, rightRandom, rightSession] = (right ?? "- - - - -").split(" ");
    return {
      tick,
      what: `frames ${leftFrames}/${rightFrames}, Math.random ${leftRandom}/${rightRandom}, session.random ${leftSession}/${rightSession}`,
    };
  }
  return null;
};

/** Two states of one tick, line by line: what one has that the other has not. */
const explain = (base, candidate, tick) => {
  const lines = [];
  if (!base || !candidate) return ["  (the state at that tick could not be fetched from both roots)"];
  if (base.hero.x !== candidate.hero.x || base.hero.y !== candidate.hero.y) {
    lines.push(`  hero ${base.hero.x.toFixed(3)},${base.hero.y.toFixed(3)} -> ${candidate.hero.x.toFixed(3)},${candidate.hero.y.toFixed(3)}`);
  }
  const actorsOf = (state) => new Map(state.actors.map((line) => [line.split(" ")[0], line]));
  const left = actorsOf(base);
  const right = actorsOf(candidate);
  let shown = 0;
  for (const doid of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(doid);
    const b = right.get(doid);
    if (a === b) continue;
    if (shown++ >= 12) {
      lines.push("  ...");
      break;
    }
    lines.push(`  base      ${a ?? "(absent)"}`);
    lines.push(`  candidate ${b ?? "(absent)"}`);
  }
  if (base.frames.join("|") !== candidate.frames.join("|")) {
    const count = Math.max(base.frames.length, candidate.frames.length);
    for (let index = 0, differing = 0; index < count && differing < 6; index++) {
      if (base.frames[index] === candidate.frames[index]) continue;
      differing++;
      lines.push(`  frame ${index}: ${base.frames[index] ?? "(none)"}  /  ${candidate.frames[index] ?? "(none)"}`);
    }
  }
  if (!lines.length) lines.push(`  random draws ${base.random.join("/")} -> ${candidate.random.join("/")}`);
  return lines;
};

const main = async () => {
  if (flag("worker")) {
    await runWorker({ root: argument("root"), runsFile: argument("runs"), detail: argument("detail") });
    return;
  }
  const baseSpec = argument("base");
  const digestOut = argument("digest-out");
  if (!baseSpec && !digestOut) usage();
  const runs = expandRuns();
  const jobs = Math.max(1, Number(argument("jobs", 2)));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ods-ai-sim-"));
  const options = { scratch, catalogue: argument("catalogue") };
  const candidate = resolveRoot(argument("candidate", TOOL_ROOT));
  const base = baseSpec ? resolveRoot(baseSpec) : null;
  const started = realNow();
  try {
    if (!base) {
      const results = await runRoot(candidate.dir, runs, jobs, options);
      const lines = [];
      let ticks = 0;
      for (const [run, entry] of results) {
        lines.push(`R ${run} ${entry.label}`, `B ${run} ${entry.build}`);
        entry.ticks.forEach((tick, index) => lines.push(`T ${run} ${index} ${tick}`));
        lines.push(`E ${run} ${entry.end}`);
        ticks += entry.ticks.length;
      }
      writeFileSync(digestOut, `${lines.join("\n")}\n`);
      console.log(`${candidate.label}: ${results.size} run(s), ${ticks} ticks, written to ${digestOut} in ${((realNow() - started) / 1000).toFixed(1)} s`);
      return;
    }

    console.log(`base ${base.label}; candidate ${candidate.label}; ${runs.length} run(s) of ${runs[0].ticks} ticks, ${jobs} job(s) per root`);
    const [baseResults, candidateResults] = await Promise.all([
      runRoot(base.dir, runs, jobs, options),
      runRoot(candidate.dir, runs, jobs, options),
    ]);
    const differing = [];
    let ticks = 0;
    let failures = 0;
    for (const run of new Set([...baseResults.keys(), ...candidateResults.keys()])) {
      const a = baseResults.get(run);
      const b = candidateResults.get(run);
      if (!a || !b) {
        differing.push({ run, tick: -1, what: `run only on ${a ? "the base" : "the candidate"}` });
        continue;
      }
      ticks += b.ticks.length;
      failures += Number(b.end?.split(" ")[2] ?? 0);
      const difference = firstDifference(a, b);
      const ms = Number(b.end?.split(" ")[1] ?? 0);
      if (difference) differing.push({ run, label: b.label, ...difference });
      console.log(`${b.label.padEnd(40)} ${difference ? `differs at tick ${difference.tick}: ${difference.what}` : "same"}  (${(ms / 1000).toFixed(1)} s)`);
    }
    console.log(
      `${runs.length} run(s), ${ticks} ticks in ${((realNow() - started) / 1000).toFixed(1)} s: ` +
        `${differing.length ? `${differing.length} differ` : "no difference"}` +
        (failures ? `; ${failures} timer callback(s) threw` : "")
    );
    const explainCount = Math.max(0, Number(argument("explain", 3)));
    for (const difference of differing.slice(0, explainCount)) {
      if (difference.tick < 0) continue;
      const run = runs.find((candidateRun) => difference.run === candidateRun.id || difference.run.startsWith(`${candidateRun.id}/`));
      if (!run) continue;
      const wanted = [Math.max(0, difference.tick - 1), difference.tick];
      const detail = { ...options, detail: wanted.join(",") };
      const [left, right] = await Promise.all([
        runWorkerProcess(base.dir, [run], detail).then(collect),
        runWorkerProcess(candidate.dir, [run], detail).then(collect),
      ]);
      console.log(`\n${difference.label}, tick ${difference.tick} (base, then candidate):`);
      for (const line of explain(left.get(difference.run)?.details.get(difference.tick), right.get(difference.run)?.details.get(difference.tick), difference.tick)) {
        console.log(line);
      }
    }
    process.exitCode = differing.length ? 1 : 0;
  } finally {
    base?.cleanup();
    candidate.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
};

main().catch((problem) => {
  console.error(problem.stack ?? problem);
  process.exit(2);
});

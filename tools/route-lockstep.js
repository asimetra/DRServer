#!/usr/bin/env node
/**
 * Whether a change to the route search changed any answer it gives.
 *
 *   node tools/route-lockstep.js --base master                 the working tree's navigation against master's, quick
 *   node tools/route-lockstep.js --base master --full          every floor, two seeds, a minute of each, 40 stress floors
 *   node tools/route-lockstep.js --base HEAD~1 --floors nordic/caves --modes mob --seconds 120 --audit 10
 *   node tools/route-lockstep.js --base ../other-checkout --candidate ../third-checkout
 *   npm run sim:routes -- --base master
 *
 * `src/socket/navigation.js` is pure: given the same colliders and the same
 * question it gives the same answer, and nothing it answers depends on the
 * clock or a random. So it can be checked the direct way — two copies, one
 * from each root, asked the same seeded workload in lockstep, every result
 * compared with `isDeepStrictEqual` and the revision counter after every
 * change (tools/route-lockstep-lib.js). The workload is a real floor's: its
 * own trigger toggles from its own timers, obstacles smashed and put back,
 * route searches from where monsters ask them, point and sight queries with
 * the odd inputs the server's callers pass, and the route memo asked again
 * and again from one spot. `searchRoute` is covered through the memo ops,
 * which fall back to `findPath` on a root that has no `route-memo.js`.
 *
 * `--audit N` is the second question, asked of the candidate alone: every N
 * searches, is every cell and link its route caches hold what a fresh
 * computation gives? A cache that forgets too little is right until a trap
 * toggles under it, and no lockstep against a base with the same fault would
 * notice; the recomputation does. With auditing on, each memo answer is also
 * held against a fresh search.
 *
 * Exit status is the answer: 0 when nothing mismatched and nothing was stale.
 */
import { isDeepStrictEqual } from "node:util";
import { argument, flag, listArgument, realNow, resolveRoot, seededRandom, TOOL_ROOT } from "./equivalence-lib.js";
import {
  apply,
  auditCaches,
  buildStressWorkload,
  buildWorkload,
  FLOORS,
  instantiate,
  loadNavigationRoot,
  MODES,
  recordFloorTrace,
  settlingOps,
  statesAgree,
  syntheticFloor,
} from "./route-lockstep-lib.js";

/**
 * The quick preset is for between steps of a change; the full one is for the
 * end of it. Both take every floor: a floor's rooms are what make a search
 * hard, and a preset that skips the ice caves skips the floor that found
 * the most.
 */
const PRESETS = {
  quick: { floors: FLOORS, seeds: [3], seconds: 60, modes: MODES, audit: 50, stress: 8 },
  full: { floors: FLOORS, seeds: [3, 5], seconds: 90, modes: MODES, audit: 25, stress: 40 },
};

// The floor builder's own log lines would drown the report; the result is the report.
process.env.ODS_LOG_LEVEL ??= "silent";

const usage = () => {
  console.error(
    "usage: node tools/route-lockstep.js --base <dir|git-ref> [--candidate <dir>] [--quick|--full]\n" +
      "         [--floors a/b,c/d] [--seeds 3,5] [--seconds N] [--modes chase,uniform,toggling,mob]\n" +
      "         [--scale N] [--audit N|0] [--stress N] [--stress-steps N] [--tile-count N] [--show N]"
  );
  process.exit(2);
};

const show = (value) => JSON.stringify(value)?.slice(0, 240);

/**
 * Replays one op list on both modules. Returns the counts, having printed the
 * first few mismatches; `audit` is how many searches between audits, 0 for none.
 */
const replay = (base, candidate, definition, ops, { audit, label, showLimit, counts }) => {
  const a = instantiate(base, definition);
  const b = instantiate(candidate, definition);
  const result = { mismatches: 0, memoStale: 0, auditRuns: 0, cells: 0, links: 0, stale: 0, skipped: 0, auditable: true };
  let searches = 0;
  const compare = (op, index) => {
    const left = apply(base, a, op);
    const right = apply(candidate, b, op);
    counts[op.op] = (counts[op.op] ?? 0) + 1;
    if (!isDeepStrictEqual(left, right) || !statesAgree(a, b)) {
      result.mismatches++;
      if (result.mismatches <= showLimit) {
        console.log(`MISMATCH ${label} op#${index} ${show(op)}`);
        console.log(`  base      rev ${a.navigation.revision}: ${show(left)}`);
        console.log(`  candidate rev ${b.navigation.revision}: ${show(right)}`);
      }
    }
    return right;
  };
  for (const [index, op] of ops.entries()) {
    const answer = compare(op, index);
    if (!audit) continue;
    if (op.op === "memo" && candidate.routeMemo && answer.value) {
      const fresh = candidate.navigation.findPath(b.navigation, op.start, op.goal, op.radius);
      if (!isDeepStrictEqual(fresh, answer.value)) result.memoStale++;
    }
    if (op.op !== "findPath" && op.op !== "memo") continue;
    if (++searches % audit) continue;
    for (const settle of settlingOps(b.navigation)) compare(settle, `${index}+settle`);
    const audited = auditCaches(candidate, b.navigation);
    if (!audited) {
      result.auditable = false;
      continue;
    }
    result.auditRuns++;
    result.cells += audited.cells;
    result.links += audited.links;
    result.stale += audited.stale;
    result.skipped += audited.skipped;
  }
  return result;
};

const auditSummary = (result, audit) => {
  if (!audit) return "";
  if (!result.auditable) return " audit n/a (no per-radius cache)";
  return ` audit ${result.auditRuns}x cells=${result.cells} links=${result.links} stale=${result.stale}${result.skipped ? ` (unsettled skipped ${result.skipped})` : ""}${result.memoStale ? ` memo-stale=${result.memoStale}` : ""}`;
};

const main = async () => {
  const baseSpec = argument("base");
  if (!baseSpec) usage();
  const preset = flag("full") ? PRESETS.full : PRESETS.quick;
  const floors = listArgument("floors", preset.floors);
  const seeds = listArgument("seeds", preset.seeds.map(String)).map(Number);
  const seconds = Number(argument("seconds", preset.seconds));
  const modes = listArgument("modes", preset.modes);
  const scale = Number(argument("scale", 4));
  const audit = Number(argument("audit", preset.audit));
  const stress = Number(argument("stress", preset.stress));
  const stressSteps = Number(argument("stress-steps", 400));
  const tileCount = Number(argument("tile-count", 24));
  const showLimit = Number(argument("show", 3));
  for (const mode of modes) if (!MODES.includes(mode)) usage();

  const base = resolveRoot(baseSpec);
  const candidate = resolveRoot(argument("candidate", TOOL_ROOT));
  const started = realNow();
  try {
    const [baseModule, candidateModule] = await Promise.all([loadNavigationRoot(base.dir), loadNavigationRoot(candidate.dir)]);
    console.log(
      `base ${base.label}${baseModule.routeMemo ? "" : " (no route-memo.js: memo ops answered by findPath)"}; candidate ${candidate.label}`
    );
    const counts = {};
    let mismatches = 0;
    let stale = 0;
    let ops = 0;
    for (const floor of floors) {
      for (const seed of seeds) {
        const trace = await recordFloorTrace(floor, { seed, tileCount, seconds });
        for (const mode of modes) {
          const label = `${floor} seed ${seed} ${mode}`;
          const workload = buildWorkload(trace, { seconds, mode, queryScale: scale, seed: 7 + seed });
          const result = replay(baseModule, candidateModule, trace.definition, workload, { audit, label, showLimit, counts });
          ops += workload.length;
          mismatches += result.mismatches;
          stale += result.stale + result.memoStale;
          console.log(
            `${label.padEnd(36)} ops=${workload.length} toggles=${trace.events.length} mismatches=${result.mismatches}${auditSummary(result, audit)}`
          );
        }
      }
    }
    for (let index = 0; index < stress; index++) {
      const random = seededRandom(100003 + index);
      const floor = syntheticFloor(random);
      const workload = buildStressWorkload(floor, random, stressSteps);
      const result = replay(baseModule, candidateModule, floor.definition, workload, { audit: audit ? 1 : 0, label: `stress ${index}`, showLimit, counts });
      ops += workload.length;
      mismatches += result.mismatches;
      stale += result.stale;
      if (result.mismatches || result.stale || index === stress - 1) {
        console.log(`stress floor ${index}`.padEnd(36) + ` ops=${workload.length} mismatches=${result.mismatches}${auditSummary(result, audit ? 1 : 0)}`);
      }
    }
    console.log(
      `${ops} ops in ${((realNow() - started) / 1000).toFixed(1)} s: ${mismatches} mismatch(es), ${stale} stale cache entr${stale === 1 ? "y" : "ies"} ` +
        JSON.stringify(counts)
    );
    process.exitCode = mismatches || stale ? 1 : 0;
  } finally {
    base.cleanup();
    candidate.cleanup();
  }
};

main().catch((problem) => {
  console.error(problem.stack ?? problem);
  process.exit(2);
});

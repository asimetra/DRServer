import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { mutantRoot, TOOL_ROOT } from "../tools/equivalence-lib.js";

const run = promisify(execFile);

/**
 * The two equivalence harnesses, checked for the two things a harness can
 * quietly stop doing: passing a tree against itself, and failing a tree
 * against one with a known change in it.
 *
 * A refactor of the AI or the route search is proven by these tools saying
 * "no difference" between the tree before it and the tree after. That answer
 * is only worth something while the tools still see differences — a harness
 * whose digest stopped covering a field, or whose workload stopped reaching a
 * branch, says "no difference" about everything. So each is also run against
 * a copy of the tree with one deliberate edit that a refactor could plausibly
 * make by mistake: the heap's tie-break flipped, so cells of equal cost pop
 * in the other order; the walk's acceleration ramp changed. Both must be
 * reported. The quick presets are what a developer runs between steps, so
 * they are what is checked here.
 */

const tool = (name) => fileURLToPath(new URL(`../tools/${name}`, import.meta.url));

const invoke = (name, args) =>
  run(process.execPath, [tool(name), ...args], {
    cwd: TOOL_ROOT,
    env: { ...process.env, ODS_LOG_LEVEL: "silent" },
    maxBuffer: 64 * 1024 * 1024,
  }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (problem) => ({ code: problem.code, stdout: problem.stdout ?? "", stderr: problem.stderr ?? "" })
  );

test("both harnesses pass a tree against itself and fail it against a changed one", async (t) => {
  // Without the compatibility data there is no floor to lay out. Failing on
  // the read, as the floor tests do, is what tools/test-public.js reads as
  // "skipped" rather than as a broken test.
  readFileSync(path.join(config.resourcesDir, "Levels", "DB_GameMaster.json"));

  const routeMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/navigation.js",
      from: "if (heapPriorities[parent] <= priority) break;",
      to: "if (heapPriorities[parent] < priority) break;",
    },
  ]);
  const aiMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/ai.js",
      from: "const NPC_WALK_ACCELERATION_SECONDS = 0.9;",
      to: "const NPC_WALK_ACCELERATION_SECONDS = 0.8;",
    },
  ]);
  t.after(() => {
    routeMutant.cleanup();
    aiMutant.cleanup();
  });

  // Independent processes, so they run side by side; each ai-sim keeps to one worker per root.
  const [routesSame, routesChanged, aiSame, aiChanged] = await Promise.all([
    invoke("route-lockstep.js", ["--base", TOOL_ROOT, "--quick"]),
    invoke("route-lockstep.js", ["--base", routeMutant.dir, "--quick"]),
    invoke("ai-sim.js", ["--base", TOOL_ROOT, "--quick", "--jobs", "1", "--explain", "0"]),
    invoke("ai-sim.js", ["--base", aiMutant.dir, "--quick", "--jobs", "1", "--explain", "1"]),
  ]);

  assert.equal(routesSame.code, 0, `route-lockstep against itself:\n${routesSame.stdout}${routesSame.stderr ?? ""}`);
  assert.match(routesSame.stdout, /: 0 mismatch\(es\), 0 stale cache entries/);

  assert.equal(routesChanged.code, 1, `route-lockstep against the heap mutant:\n${routesChanged.stdout}${routesChanged.stderr ?? ""}`);
  assert.match(routesChanged.stdout, /^MISMATCH .*"op":"(findPath|memo)"/m);
  assert.doesNotMatch(routesChanged.stdout, /: 0 mismatch\(es\)/);

  assert.equal(aiSame.code, 0, `ai-sim against itself:\n${aiSame.stdout}${aiSame.stderr ?? ""}`);
  assert.match(aiSame.stdout, /: no difference/);

  assert.equal(aiChanged.code, 1, `ai-sim against the acceleration mutant:\n${aiChanged.stdout}${aiChanged.stderr ?? ""}`);
  assert.match(aiChanged.stdout, /differs at tick \d+/);
  // The explanation names the monster that moved differently, not only the tick.
  assert.match(aiChanged.stdout, /^ {2}base {6}\d+ \S+ /m);
  assert.match(aiChanged.stdout, /^ {2}candidate \d+ \S+ /m);
});

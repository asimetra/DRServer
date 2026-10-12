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
 * in the other order; the walk's acceleration ramp changed; monsters' bodies
 * no longer holding a walk (npc-move.js), so a crowd walks into itself again;
 * a monster held short swinging its contact swings again (npc-act.js); a
 * broken secret wall leaving nothing instead of its broken half (npc-spawn.js);
 * a cell whose lattice misses no longer searched between its points
 * (pathfind.js); a pet going for the nearest monster whether or not it can
 * get at it (npc-targeting.js). Each must be reported; and a chaser that
 * stops walking its route must be counted frozen by the census
 * (tools/ai-sim-census.js), which a tree against itself never is. The quick presets are what a developer runs between steps, so
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
      file: "src/socket/pathfind.js",
      from: "if (heapPriorities[parent] <= priority) break;",
      to: "if (heapPriorities[parent] < priority) break;",
    },
  ]);
  const aiMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/behaviours/chase.js",
      from: "const NPC_WALK_ACCELERATION_SECONDS = 0.9;",
      to: "const NPC_WALK_ACCELERATION_SECONDS = 0.8;",
    },
  ]);
  const crowdMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/ai.js",
      from: "bodies: intent.throughBodies ? null : crowding.bodies,",
      to: "bodies: null,",
    },
  ]);
  const swingMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/npc-act.js",
      from: "const swingable = heldShort(turn) ? usable.filter((attack) => !isContactAttack(attack)) : usable;",
      to: "const swingable = usable;",
    },
  ]);
  const corpseMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/npc-spawn.js",
      from: "retireNavigationObject(session.navigation, recordId, { broken: npcIsPermCorpse(npc) });",
      to: "retireNavigationObject(session.navigation, recordId, { broken: false });",
    },
  ]);
  const anchorMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/pathfind.js",
      from: "const found = anchorBetween(navigation, centreX, centreY, cellSize, probeRadius, gathered);",
      to: "const found = null;",
    },
  ]);
  // A chaser that does not walk its route: it stands with nothing in its
  // way, which the census must call frozen (tools/ai-sim-census.js).
  const freezeMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/behaviours/chase.js",
      from: "if (!(route.waypoint && (distance > stopAt || !headsAtTarget))) return STILL;",
      to: "if (!(route.waypoint && headsAtTarget && distance > stopAt)) return STILL;",
    },
  ]);
  const petMutant = mutantRoot(TOOL_ROOT, [
    {
      file: "src/socket/npc-targeting.js",
      from: "    canGetAt(navigation, actor, candidate, reachOf(ai, contact(actor, candidate.actor)), withinTether);",
      to: "    true;",
    },
  ]);
  t.after(() => {
    freezeMutant.cleanup();
    petMutant.cleanup();
    anchorMutant.cleanup();
    routeMutant.cleanup();
    aiMutant.cleanup();
    crowdMutant.cleanup();
    swingMutant.cleanup();
    corpseMutant.cleanup();
  });

  // Independent processes, so they run side by side; each ai-sim keeps to one worker per root.
  const [routesSame, routesChanged, aiSame, aiChanged, crowdChanged, swingChanged, corpseChanged, anchorChanged, petChanged, frozenChanged] = await Promise.all([
    invoke("route-lockstep.js", ["--base", TOOL_ROOT, "--quick"]),
    invoke("route-lockstep.js", ["--base", routeMutant.dir, "--quick"]),
    // With the census: a tree against itself has no frozen chaser either.
    invoke("ai-sim.js", ["--base", TOOL_ROOT, "--quick", "--stats", "--jobs", "1", "--explain", "0"]),
    invoke("ai-sim.js", ["--base", aiMutant.dir, "--quick", "--jobs", "1", "--explain", "1"]),
    invoke("ai-sim.js", ["--base", crowdMutant.dir, "--quick", "--jobs", "1", "--explain", "0"]),
    invoke("ai-sim.js", ["--base", swingMutant.dir, "--quick", "--jobs", "1", "--explain", "0"]),
    invoke("ai-sim.js", ["--base", corpseMutant.dir, "--quick", "--scenarios", "smashing", "--jobs", "1", "--explain", "0"]),
    invoke("route-lockstep.js", ["--base", anchorMutant.dir, "--quick"]),
    invoke("ai-sim.js", ["--base", petMutant.dir, "--quick", "--scenarios", "pet-dragon", "--jobs", "1", "--explain", "0"]),
    invoke("ai-sim.js", ["--base", TOOL_ROOT, "--candidate", freezeMutant.dir, "--quick", "--libraries", "castle/catacombs", "--hero", "loadsim", "--stats", "--jobs", "1", "--explain", "0"]),
  ]);

  assert.equal(routesSame.code, 0, `route-lockstep against itself:\n${routesSame.stdout}${routesSame.stderr ?? ""}`);
  assert.match(routesSame.stdout, /: 0 mismatch\(es\), 0 stale cache entries/);

  assert.equal(routesChanged.code, 1, `route-lockstep against the heap mutant:\n${routesChanged.stdout}${routesChanged.stderr ?? ""}`);
  assert.match(routesChanged.stdout, /^MISMATCH .*"op":"(findPath|memo)"/m);
  assert.doesNotMatch(routesChanged.stdout, /: 0 mismatch\(es\)/);

  assert.equal(aiSame.code, 0, `ai-sim against itself:\n${aiSame.stdout}${aiSame.stderr ?? ""}`);
  assert.match(aiSame.stdout, /: no difference/);
  assert.doesNotMatch(aiSame.stdout, /FROZEN/);

  assert.equal(frozenChanged.code, 1, `ai-sim with the freeze mutant as candidate:\n${frozenChanged.stdout}${frozenChanged.stderr ?? ""}`);
  assert.match(frozenChanged.stdout, /^FROZEN: in the candidate/m);

  assert.equal(aiChanged.code, 1, `ai-sim against the acceleration mutant:\n${aiChanged.stdout}${aiChanged.stderr ?? ""}`);
  assert.match(aiChanged.stdout, /differs at tick \d+/);
  // The explanation names the monster that moved differently, not only the tick.
  assert.match(aiChanged.stdout, /^ {2}base {6}\d+ \S+ /m);
  assert.match(aiChanged.stdout, /^ {2}candidate \d+ \S+ /m);

  assert.equal(crowdChanged.code, 1, `ai-sim against the crowd mutant:\n${crowdChanged.stdout}${crowdChanged.stderr ?? ""}`);
  assert.match(crowdChanged.stdout, /differs at tick \d+/);

  assert.equal(swingChanged.code, 1, `ai-sim against the swing mutant:\n${swingChanged.stdout}${swingChanged.stderr ?? ""}`);
  assert.match(swingChanged.stdout, /differs at tick \d+/);

  assert.equal(corpseChanged.code, 1, `ai-sim against the corpse mutant:\n${corpseChanged.stdout}${corpseChanged.stderr ?? ""}`);
  assert.match(corpseChanged.stdout, /scenario\/smashing seed 1 smasher +differs at tick \d+/);

  assert.equal(petChanged.code, 1, `ai-sim against the pet mutant:\n${petChanged.stdout}${petChanged.stderr ?? ""}`);
  assert.match(petChanged.stdout, /scenario\/pet-dragon seed 1 \S+ +differs at tick \d+/);

  assert.equal(anchorChanged.code, 1, `route-lockstep against the anchor mutant:\n${anchorChanged.stdout}${anchorChanged.stderr ?? ""}`);
  assert.match(anchorChanged.stdout, /^MISMATCH .*"op":"findPath"/m);
});

#!/usr/bin/env node
/**
 * Whether monsters attack heroes they cannot route to, before and after a change.
 *
 *   node tools/gap-census.js --base master                    the working tree against master
 *   node tools/gap-census.js --base HEAD~1 --seeds 1 --per 4  fewer cases
 *   node tools/gap-census.js --base ../other --candidate ../third --show 12
 *
 * A hero in a slot between props, in a corner, past a closed door, on the far
 * side of a ledge: the route search cannot bring the monster's body to him,
 * and what the monster does instead — walk somewhere it can swing from, walk
 * straight at him and stand where the walk stops, stand behind a wall — is
 * the AI's answer for a whole class of places, not for one. One such place
 * fixed by a change is an anecdote. This samples the class.
 *
 * Every floor the AI harness runs (tools/ai-sim-lib.js: each tile library on
 * its theme's first map node, its props placed as obstacles) and the three
 * scenario-test floors, for each of five monster rows: KNIGHT_HALBERD,
 * KNIGHT, BRUTE, a marksman and an ice imp (whichever of a few names spawns).
 * A case is a hero put at random near a collider, his body clear, and the
 * monster's start 60 to 600 from him in a random direction, its body clear,
 * kept only if the monster cannot route to him: a flood of the start's
 * reachable region at the row's radius (10-unit lattice, a step taken when
 * the next point is clear and the line to it is, kept within 1000 of the
 * hero) has no point with a clear line at that radius to a hero the body
 * could stand at. Asked of each case:
 *
 *   opportunity  some flooded point is within the row's reach of him
 *                (body.js furthestReach) and passes the swing's sight test
 *                (npc-act.js victimInSight: his feet or his body point);
 *   straight     where the official's no-route walk ends (routing.js): at
 *                him in 10-unit steps along the scenery, stopping at the
 *                first step given back less than a tenth of itself;
 *   the AI       the monster alone on the floor, engaged, `tickNpcAi` at
 *                250 ms for 20 s, the hero still: whether and when it swings,
 *                where it ends, how far it walked, whether it went back and
 *                forth in the last 10 s (walked more than twice its net
 *                displacement plus 30).
 *
 * Nothing in choosing the cases asks the route search, and everything is
 * seeded, so the base and the candidate meet the same cases; each root runs
 * in a process of its own (tools/ai-sim.js says why). The report is a table
 * per row and the cases that got worse; the exit status is 0 unless a root
 * failed to run.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argument, flag, importFrom, listArgument, resolveRoot, seededRandom, TOOL_ROOT } from "./equivalence-lib.js";

const self = fileURLToPath(import.meta.url);

const LIBRARIES = [
  ["castle/arena", 50003],
  ["castle/catacombs", 50010],
  ["castle/prison", 50070],
  ["jungle/aztec", 50057],
  ["jungle/dino", 50036],
  ["jungle/tribal", 50015],
  ["nordic/caves", 50008],
  ["nordic/temple", 50044],
  ["nordic/village", 50033],
];
const SCENARIO_FLOORS = [
  "scenario-test/db_floor_GAPS_CASTLE_PRISON.json",
  "scenario-test/db_floor_GAPS_CASTLE_CATACOMBS.json",
  "scenario-test/db_floor_POCKET_NORDIC_CAVES.json",
];
const SCENARIO_NODE = 50070;
const ROWS = [["KNIGHT_HALBERD"], ["KNIGHT"], ["BRUTE"], ["KNIGHT_MARKSMAN", "SKELETON_ARCHER"], ["ICE_IMP", "BABY_YETI"]];
/** Rows that back off by design: their walks are not counted as going back and forth. */
const KITERS = new Set(["KNIGHT_MARKSMAN", "SKELETON_ARCHER", "ICE_IMP"]);
const HERO_RADIUS = 25.87;
const FLOOD_STEP = 10;
const FLOOD_LIMIT = 1000;
const TICKS = 80;
const TICK_MS = 250;
const FLOOR_DOID = 1002;
const HERO_DOID = 1003;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const usage = () => {
  console.error("usage: node tools/gap-census.js --base <dir|git-ref> [--candidate <dir>] [--seeds 1,2,3] [--per 8] [--show 8] [--keep <dir>]");
  process.exit(2);
};

// ---------------------------------------------------------------- one root

const loadModules = async (root) => {
  const [gamemaster, floors, navigation, dungeon, opcodes, ai, npcSpawn, body] = await Promise.all(
    ["src/gamemaster.js", "src/socket/floors.js", "src/socket/navigation.js", "src/socket/dungeon.js", "src/socket/opcodes.js", "src/socket/ai.js", "src/socket/npc-spawn.js", "src/socket/body.js"].map(
      (file) => importFrom(root, file)
    )
  );
  await navigation.loadNavigationLibrary();
  return { gm: await gamemaster.loadGameMaster(), floors, nav: navigation, dungeon, opcodes, ai, npcSpawn, body };
};

/** The floor with its props, the hero, and no monsters but the ones the census puts there. */
const buildWorld = async (modules, floor, mapNodeId, label) => {
  const session = {
    id: 900,
    dungeonActive: true,
    dungeonEpoch: 1,
    mapNodeId,
    heroDoid: HERO_DOID,
    floorDoid: FLOOR_DOID,
    floorIndex: 0,
    floorCount: 1,
    npcLevel: 1,
    floorPlan: { floors: [{ authored: label }], tier: null, npcLevel: 1 },
    heroPosition: { x: floor.spawn?.x ?? 0, y: floor.spawn?.y ?? 0 },
    heroSpawn: {
      doid: HERO_DOID, heroType: 101, skinType: 151, playerId: 1, screenName: "Census", experiencePoints: 0,
      slotPoints: [0, 0, 0, 0], weapons: [], consumables: [], hitPoints: 60000, manaPoints: 100,
      effectiveHitPoints: 60000, collisionRadius: 22, constant: "RANGER",
    },
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    dungeonBusterPoints: 0,
    objects: new Map([[FLOOR_DOID, modules.opcodes.CLID.DistributedDungeonFloor]]),
    actors: new Map(),
    allocateDoid: (() => {
      let next = 1100;
      return (clid) => {
        const doid = next++;
        session.objects.set(doid, clid);
        return doid;
      };
    })(),
    send: () => {},
  };
  await modules.dungeon.buildFloorWorld(session, { floor, floorDoid: FLOOR_DOID, isActive: () => true });
  for (const stop of ["stopAi", "stopTriggers", "stopTrapProjectiles", "stopAfkWatch", "stopManaRegen"]) session[stop]?.();
  session.stopAi = null;
  for (const [doid, actor] of [...session.actors]) if (actor.ai && actor.isEnemy) session.actors.delete(doid);
  return session;
};

/** The points a body of `radius` can walk to from `start`, near the hero. */
const flood = (nav, navigation, start, hero, radius) => {
  const seen = new Set(["0,0"]);
  const queue = [[0, 0, { ...start }]];
  for (let head = 0; head < queue.length; head++) {
    const [i, j, from] = queue[head];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const key = `${i + di},${j + dj}`;
        if ((!di && !dj) || seen.has(key)) continue;
        const to = { x: start.x + (i + di) * FLOOD_STEP, y: start.y + (j + dj) * FLOOD_STEP };
        if (distance(to, hero) > FLOOD_LIMIT) continue;
        seen.add(key);
        if (nav.isPositionBlocked(navigation, to, radius) || !nav.hasLineOfSight(navigation, from, to, radius)) continue;
        queue.push([i + di, j + dj, to]);
      }
    }
  }
  return queue.map((entry) => entry[2]);
};

/** The official's walk with no route: straight at the hero, sliding, until a step is given back less than a tenth. */
const straightWalk = (nav, navigation, start, hero, radius) => {
  let at = { ...start };
  for (let step = 0; step < 500; step++) {
    const left = distance(at, hero);
    if (left < 1) break;
    const length = Math.min(FLOOD_STEP, left);
    const next = nav.moveWithNavigation(navigation, at, { x: ((hero.x - at.x) / left) * length, y: ((hero.y - at.y) / left) * length }, radius);
    if (left - distance(next, hero) < length * 0.1) break;
    at = next;
  }
  return at;
};

/** Runs the monster on its own for 20 s and says what it did. */
const runCase = async (modules, session, context, constant, start, hero, seed) => {
  const heroActor = session.actors.get(HERO_DOID);
  heroActor.position = { ...hero };
  session.heroPosition = heroActor.position;
  const doid = await modules.npcSpawn.spawnNpc(context, constant, { ...start }, undefined, { returnDoid: true });
  const monster = session.actors.get(doid);
  Object.assign(monster.ai, { engaged: true, targetDoid: HERO_DOID, state: "chase" });
  session.random = seededRandom(seed);
  let swings = 0;
  session.send = (frame) => {
    if (frame.length >= 10 && frame.readUInt16LE(8) === 143 && frame.readUInt32LE(4) === doid) swings++;
  };
  const trail = [];
  let firstSwing = null;
  let now = 1_000_000;
  for (let tick = 0; tick < TICKS; tick++) {
    now += TICK_MS;
    await modules.ai.tickNpcAi(session, now, TICK_MS / 1000);
    trail.push({ x: monster.position.x, y: monster.position.y });
    if (swings && firstSwing === null) firstSwing = ((tick + 1) * TICK_MS) / 1000;
  }
  session.actors.delete(doid);
  session.send = () => {};
  let walked = 0;
  for (let i = 0; i < trail.length; i++) walked += distance(i ? trail[i - 1] : start, trail[i]);
  const tail = trail.slice(-TICKS / 2);
  let tailWalked = 0;
  for (let i = 1; i < tail.length; i++) tailWalked += distance(tail[i - 1], tail[i]);
  return { end: trail.at(-1), swings, firstSwing, walked, tailWalked, tailNet: distance(tail[0], trail.at(-1)) };
};

const round = (value) => Math.round(value * 10) / 10;

/** Every case of one floor, as records. */
const censusFloor = async (modules, floor, mapNodeId, label, seed, per) => {
  const { nav, body } = modules;
  const session = await buildWorld(modules, floor, mapNodeId, label);
  const navigation = session.navigation;
  const heroActor = session.actors.get(HERO_DOID);
  const random = seededRandom(seed * 7919 + label.length * 31);
  const colliders = [...navigation.staticColliders, ...[...navigation.obstacles.values()].flat()].filter((c) => Number.isFinite(c?.x));
  const context = { session, floorDoid: FLOOR_DOID, heroDoid: HERO_DOID, mapNodeId, gm: modules.gm, isActive: () => true };
  const records = [];
  for (const names of ROWS) {
    let constant = null;
    let probe = null;
    for (const name of names) {
      const doid = await modules.npcSpawn.spawnNpc(context, name, { x: -9999, y: -9999 }, undefined, { returnDoid: true });
      if (!doid) continue;
      constant = name;
      probe = session.actors.get(doid);
      session.actors.delete(doid);
      break;
    }
    if (!probe) continue;
    const radius = body.bodyRadius(probe);
    const reach = body.furthestReach(probe.ai.attacks ?? [{ range: probe.ai.attackRange ?? 0, projectile: probe.ai.projectile }], body.contact(probe, heroActor));
    let kept = 0;
    for (let attempt = 0; attempt < 400 && kept < per; attempt++) {
      const collider = colliders[Math.floor(random() * colliders.length)];
      const extent = (collider.type === "circle" ? collider.radius : Math.hypot(collider.halfWidth ?? 0, collider.halfHeight ?? 0)) + 60;
      const hero = { x: collider.x + (random() * 2 - 1) * extent, y: collider.y + (random() * 2 - 1) * extent };
      const angle = random() * Math.PI * 2;
      const away = 60 + random() * 540;
      const start = { x: hero.x + Math.cos(angle) * away, y: hero.y + Math.sin(angle) * away };
      if (nav.isPositionBlocked(navigation, hero, HERO_RADIUS) || nav.isPositionBlocked(navigation, start, radius)) continue;
      if (nav.hasLineOfSight(navigation, start, hero, radius)) continue;
      const region = flood(nav, navigation, start, hero, radius);
      if (region.length < 20) continue;
      const heroStands = !nav.isPositionBlocked(navigation, hero, radius);
      if (heroStands && region.some((p) => nav.hasLineOfSight(navigation, p, hero, radius))) continue;
      kept++;
      const bodyPoint = body.bodyPointOf(heroActor, hero);
      const sees = (p) =>
        nav.hasLineOfSight(navigation, p, hero, 0) || (bodyPoint && bodyPoint !== hero && nav.hasLineOfSight(navigation, p, bodyPoint, 0));
      const opportunities = region.filter((p) => distance(p, hero) <= reach && sees(p));
      const straight = straightWalk(nav, navigation, start, hero, radius);
      // The route the root's own search gives from the start: its length, and whether it ends short.
      const route = nav.findPath(navigation, start, hero, radius);
      let routeLength = 0;
      for (let i = 0; i < route.length; i++) routeLength += distance(i ? route[i - 1] : start, route[i]);
      const run = await runCase(modules, session, context, constant, start, hero, seed * 131 + records.length);
      records.push({
        floor: label,
        seed,
        row: constant,
        reach: round(reach),
        hero: { x: round(hero.x), y: round(hero.y) },
        start: { x: round(start.x), y: round(start.y) },
        opportunity: opportunities.length > 0,
        toOpportunity: opportunities.length ? round(Math.min(...opportunities.map((p) => distance(p, run.end)))) : null,
        straightAttacks: distance(straight, hero) <= reach && Boolean(sees(straight)),
        straightD: round(distance(straight, hero)),
        end: { x: round(run.end.x), y: round(run.end.y) },
        endD: round(distance(run.end, hero)),
        endSees: Boolean(sees(run.end)),
        swings: run.swings,
        firstSwing: run.firstSwing,
        walked: round(run.walked),
        route: route.length ? (route.endsShort ? "short" : "reaches") : "none",
        routeLength: round(routeLength),
        tailWalked: round(run.tailWalked),
        tailNet: round(run.tailNet),
      });
    }
  }
  return records;
};

const worker = async () => {
  const root = argument("root");
  const out = argument("out");
  const seeds = listArgument("seeds", ["1", "2", "3"]).map(Number);
  const per = Number(argument("per", 8));
  const modules = await loadModules(root);
  // Spawning and the floor's own logic draw on Math.random; one seed for the whole run.
  Math.random = seededRandom(20261011);
  const records = [];
  for (const [library, node] of LIBRARIES) {
    for (const seed of seeds) {
      const floor = await modules.floors.buildFloor(`Resources/Levels/${library}/tiles.json`, { tier: 10, tileCount: 24, seed });
      records.push(...(await censusFloor(modules, floor, node, library, seed, per)));
    }
  }
  for (const file of SCENARIO_FLOORS) {
    for (const seed of seeds) {
      records.push(...(await censusFloor(modules, await modules.floors.loadFloor(file), SCENARIO_NODE, file, seed, per)));
    }
  }
  writeFileSync(out, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  process.exit(0);
};

// ---------------------------------------------------------------- the report

const runRoot = (root, out) =>
  new Promise((resolve, reject) => {
    const args = [self, "--worker", "--root", root, "--out", out, "--seeds", listArgument("seeds", ["1", "2", "3"]).join(","), "--per", argument("per", "8")];
    const child = spawn(process.execPath, args, { env: { ...process.env, ODS_LOG_LEVEL: "silent" }, stdio: ["ignore", "ignore", "pipe"] });
    const err = [];
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`census on ${root} exited ${code}:\n${Buffer.concat(err).toString().trim()}`))));
  });

const quantile = (values, p) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
};
const percent = (count, of) => (of ? `${((100 * count) / of).toFixed(1)}%` : "-");
const shown = (value) => (value === null ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(2));
const backAndForth = (record) => !KITERS.has(record.row) && record.tailWalked > 2 * record.tailNet + 30;
const ratio = (record) => record.walked / Math.max(1, distance(record.hero, record.start));

const report = (base, candidate) => {
  if (base.length !== candidate.length || base.some((record, i) => record.hero.x !== candidate[i].hero.x || record.row !== candidate[i].row)) {
    throw new Error("the two roots did not meet the same cases");
  }
  const indices = base.map((_, i) => i);
  const rows = [...new Set(base.map((record) => record.row)), "all"];
  const table = rows.map((row) => {
    const all = indices.filter((i) => row === "all" || base[i].row === row);
    const opportunity = all.filter((i) => base[i].opportunity);
    const line = { row, cases: all.length, "with an opportunity": opportunity.length };
    for (const [name, set] of [["base", base], ["candidate", candidate]]) {
      const attacked = opportunity.filter((i) => set[i].swings > 0);
      line[`attacked ${name}`] = percent(attacked.length, opportunity.length);
      line[`1st swing p50 ${name}`] = shown(quantile(attacked.map((i) => set[i].firstSwing), 0.5));
      line[`out of sight ${name}`] = percent(opportunity.filter((i) => !set[i].endSees).length, opportunity.length);
      line[`back and forth ${name}`] = all.filter((i) => backAndForth(set[i])).length;
      line[`walk/straight p90 ${name}`] = shown(quantile(all.map((i) => ratio(set[i])), 0.9));
    }
    line["straight walk attacks"] = percent(opportunity.filter((i) => base[i].straightAttacks).length, opportunity.length);
    return line;
  });
  console.table(table);

  const pairs = indices.map((i) => [base[i], candidate[i]]);
  const describe = ([a, b]) =>
    `${a.row} ${a.floor} s${a.seed} hero (${a.hero.x},${a.hero.y}) start (${a.start.x},${a.start.y}): ` +
    `base ends ${a.endD} from him, ${a.endSees ? "in sight" : "out of sight"}, ${a.swings} swings, walked ${a.walked}; ` +
    `candidate ${b.endD}, ${b.endSees ? "in sight" : "out of sight"}, ${b.swings} swings, walked ${b.walked}`;
  const show = Number(argument("show", 8));
  const groups = [
    ["attacked in the base and not in the candidate", pairs.filter(([a, b]) => a.swings > 0 && b.swings === 0)],
    ["went back and forth in the candidate only", pairs.filter(([a, b]) => backAndForth(b) && !backAndForth(a))],
    ["walked 200 or more farther in the candidate without attacking more (kiters aside)", pairs.filter(([a, b]) => !KITERS.has(a.row) && b.walked > a.walked + 200 && b.swings <= a.swings)],
    ["attacked in the candidate and not in the base", pairs.filter(([a, b]) => a.swings === 0 && b.swings > 0)],
  ];
  for (const [name, list] of groups) {
    console.log(`${list.length} ${name}`);
    for (const pair of list.slice(0, show)) console.log(`  ${describe(pair)}`);
  }
  const gained = groups[3][1].map(([a, b]) => b.walked - a.walked);
  console.log(`extra walk of those that now attack: p50 ${shown(quantile(gained, 0.5))} p90 ${shown(quantile(gained, 0.9))} max ${shown(quantile(gained, 1))}`);
};

const main = async () => {
  if (flag("worker")) return worker();
  const baseSpec = argument("base");
  if (!baseSpec) usage();
  const base = resolveRoot(baseSpec);
  const candidate = resolveRoot(argument("candidate", TOOL_ROOT));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "gap-census-"));
  try {
    console.log(`base ${base.label}; candidate ${candidate.label}`);
    const files = [path.join(scratch, "base.jsonl"), path.join(scratch, "candidate.jsonl")];
    await Promise.all([runRoot(base.dir, files[0]), runRoot(candidate.dir, files[1])]);
    const [before, after] = files.map((file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)));
    report(before, after);
  } finally {
    const keep = argument("keep");
    if (keep) for (const name of ["base", "candidate"]) writeFileSync(path.join(keep, `${name}.jsonl`), readFileSync(path.join(scratch, `${name}.jsonl`)));
    rmSync(scratch, { recursive: true, force: true });
    base.cleanup();
    candidate.cleanup();
  }
};

main().catch((problem) => {
  console.error(problem.stack ?? problem);
  process.exit(2);
});

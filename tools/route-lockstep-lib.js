/**
 * The workload and the checks behind `tools/route-lockstep.js`.
 *
 * A navigation module is asked three kinds of thing: to change (a trigger
 * toggles, an obstacle is smashed or put back), to answer a point or line
 * question (blocked, sight, a step along a wall), and to search a route. The
 * workload here is a seeded list of all three over a real floor, with the
 * trigger toggles taken from the floor's own timers — recorded once by
 * building the floor on a virtual clock and letting its traps cycle — and the
 * questions placed where the game asks them: near a wandering player, near
 * the colliders that toggle, from a mob of monsters closing in. Two modules
 * replay the same list in lockstep and must give the same answers.
 *
 * The audit is the invariant the route cache rests on: every cell and link
 * it holds must equal what a fresh computation under the current colliders
 * gives. It is recomputed from scratch with the module's own point and sight
 * queries, so a forgotten forget shows as a stale entry rather than as a
 * wrong route three floors later.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { importFrom, installVirtualClock, seededRandom, TOOL_ROOT } from "./equivalence-lib.js";

export const FLOORS = [
  "castle/arena",
  "castle/catacombs",
  "castle/prison",
  "jungle/aztec",
  "jungle/dino",
  "jungle/tribal",
  "nordic/caves",
  "nordic/temple",
  "nordic/village",
];

/**
 * chase     searches from near a wandering player toward it, like a pursuit
 * uniform   searches between any two points of the floor
 * toggling  searches around the colliders that actually toggle, where cached answers go stale
 * mob       a dozen monsters of three sizes closing on the player, a third of
 *           them stuck and asking the same question again through the route memo
 * smash     the floor's props smashed one by one, every obstacle the build put
 *           in, with the searches and the point and sight questions asked onto
 *           and across the spots just smashed and the ones about to be
 */
export const MODES = ["chase", "uniform", "toggling", "mob", "smash"];

const RADII = [20, 22.5, 26, 30.8, 35, 42, 46, 52, 65];
const ODD_RADII = [undefined, null, 0, 0.5, -5, 1000];
const ODD_POINTS = [{ x: -0, y: -0 }, { x: -5000, y: 300 }, { x: 1e7, y: 1e7 }, { x: NaN, y: 10 }, { x: 450, y: -0 }];
const STEP_MS = 50;

export const loadNavigationRoot = async (root) => {
  const navigation = await importFrom(root, "src/socket/navigation.js");
  await navigation.loadNavigationLibrary();
  const routeMemo = existsSync(path.join(root, "src", "socket", "route-memo.js"))
    ? await importFrom(root, "src/socket/route-memo.js")
    : null;
  return { root, navigation, routeMemo };
};

/**
 * What a real floor does to its navigation over `seconds`: the obstacles the
 * build put in, the trigger states it started with, and every toggle its own
 * timers and logic gates produced, on a virtual clock. Built through the
 * tool's own checkout; the trace is data, and both modules replay it.
 */
export const recordFloorTrace = async (library, { seed = 3, tileCount = 24, seconds = 60 } = {}) => {
  const clock = installVirtualClock();
  const realRandom = Math.random;
  Math.random = seededRandom(seed * 7919 + 1);
  try {
    const { buildFloor } = await importFrom(TOOL_ROOT, "test/helpers/floor.js");
    const world = await buildFloor(library.endsWith(".json") ? library : `${library}/tiles.json`, { seed, tileCount });
    const { session, floor } = world;
    session.stopAi?.();
    session.stopTrapProjectiles?.();
    session.stopAfkWatch?.();
    session.stopManaRegen?.();
    const navigation = session.navigation;
    if (!(navigation?.triggerGroups instanceof Map) || !(navigation.obstacles instanceof Map)) {
      throw new Error(`${library}: the navigation state no longer exposes triggerGroups and obstacles; the trace recorder needs updating`);
    }
    const initialObstacles = [...navigation.obstacles.entries()];
    const initialTriggerStates = [...navigation.triggerGroups.entries()].map(([id, group]) => [id, group.on]);
    const events = [];
    for (const [id, group] of navigation.triggerGroups) {
      let value = group.on;
      Object.defineProperty(group, "on", {
        get: () => value,
        set: (next) => {
          value = next;
          events.push({ t: clock.now - 1_000_000, id, on: next });
        },
        enumerable: true,
        configurable: true,
      });
    }
    await clock.advance(clock.now + seconds * 1000);
    session.runScope?.dispose?.();
    return { library, seed, definition: floor.navigation, initialObstacles, initialTriggerStates, events };
  } finally {
    Math.random = realRandom;
    clock.uninstall();
  }
};

const boxCentre = (collider) => ({ x: collider.x, y: collider.y });

/** Builds the per-floor operation list once; every module replays the same list. */
export const buildWorkload = (trace, { seconds, seed = 7, mode = "chase", searchesPerSecond = 2.25, queryScale = 1 }) => {
  const random = seededRandom(seed ^ (trace.library.length * 7919));
  const pick = (list) => list[Math.floor(random() * list.length)];
  const ops = [];
  for (const [id, colliders] of trace.initialObstacles) ops.push({ t: 0, op: "add", id, colliders });
  for (const [id, on] of trace.initialTriggerStates) ops.push({ t: 0, op: "toggle", id, on });

  const { bounds } = trace.definition;
  const sample = () => ({
    x: bounds.minX + random() * (bounds.maxX - bounds.minX),
    y: bounds.minY + random() * (bounds.maxY - bounds.minY),
  });
  const cageOrigins = [];
  for (const [, group] of trace.definition.triggerColliders ?? []) {
    for (const collider of group.onColliders ?? []) cageOrigins.push(boxCentre(collider));
  }
  const toggling = new Set(trace.events.map((event) => event.id));
  const togglingPoints = [];
  for (const [id, group] of trace.definition.triggerColliders ?? []) {
    if (!toggling.has(id)) continue;
    for (const collider of [...(group.onColliders ?? []), ...(group.offColliders ?? [])]) togglingPoints.push(boxCentre(collider));
  }
  if (!togglingPoints.length) {
    togglingPoints.push(...cageOrigins, { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 });
  }

  const obstacleIds = trace.initialObstacles.map(([id]) => id);
  const removed = new Map(trace.initialObstacles);
  let nextObstacle = 900000;
  let event = 0;
  let player = sample();
  let paused = 0;
  const mobRadii = [0, 1, 2].map(() => pick(RADII));
  let mob = [];

  /** Ignored colliders are named by index, since each module holds its own objects. */
  const ignoredOf = () => {
    const roll = random();
    if (roll < 0.85) return null;
    if (roll < 0.9) return [];
    return Array.from({ length: 1 + Math.floor(random() * 5) }, () => Math.floor(random() * 400));
  };
  const oddPoint = () => (random() < 0.5 ? pick(ODD_POINTS) : { x: Math.round(sample().x), y: Math.round(sample().y) });

  /**
   * `smash`: every obstacle the build put in, in a seeded order, one at a time
   * over the run — the props a party breaks on its way through a floor. The
   * questions go where a smash changes the answer: onto the spot, across it,
   * from beside it, for the last few smashed and the next few to be.
   */
  const smashOrder = mode === "smash" ? [...obstacleIds] : [];
  for (let index = smashOrder.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [smashOrder[index], smashOrder[other]] = [smashOrder[other], smashOrder[index]];
  }
  const smashEvery = smashOrder.length ? Math.max(STEP_MS, Math.floor((seconds * 1000) / (smashOrder.length + 1) / STEP_MS) * STEP_MS) : 0;
  const spotOf = (id) => {
    const colliders = removed.get(id) ?? [];
    return colliders.length
      ? { x: colliders.reduce((sum, c) => sum + c.x, 0) / colliders.length, y: colliders.reduce((sum, c) => sum + c.y, 0) / colliders.length }
      : sample();
  };
  let smashed = 0;
  const smashSpot = () => pick(smashOrder.slice(Math.max(0, smashed - 4), smashed + 2).map(spotOf));

  for (let t = 0; t <= seconds * 1000; t += STEP_MS) {
    while (event < trace.events.length && trace.events[event].t <= t) {
      const { id, on } = trace.events[event++];
      ops.push({ t, op: "toggle", id, on });
    }
    if (paused > 0) paused--;
    else {
      player = { x: player.x + (random() - 0.5) * 120, y: player.y + (random() - 0.5) * 120 };
      if (mode === "mob" && random() < 0.02) paused = 20 + Math.floor(random() * 40);
    }
    if (player.x < bounds.minX || player.x > bounds.maxX || player.y < bounds.minY || player.y > bounds.maxY) player = sample();
    const near = (spread) => ({ x: player.x + (random() - 0.5) * spread, y: player.y + (random() - 0.5) * spread });
    const nearToggling = (spread) => {
      const at = pick(togglingPoints);
      return { x: at.x + (random() - 0.5) * spread, y: at.y + (random() - 0.5) * spread };
    };

    if (random() < 0.004 && obstacleIds.length) ops.push({ t, op: "remove", id: pick(obstacleIds) });
    if (random() < 0.003 && removed.size) {
      const back = pick([...removed.keys()]);
      const colliders = removed.get(back);
      ops.push({ t, op: "add", id: back, colliders: random() < 0.5 ? colliders : colliders.map((c) => ({ ...c })) });
    }
    if (random() < 0.002) {
      const at = near(800);
      ops.push({ t, op: "add", id: nextObstacle++, colliders: [{ type: "circle", x: at.x, y: at.y, radius: 20 + random() * 30 }] });
    }
    if (smashEvery && t > 0 && t % smashEvery === 0 && smashed < smashOrder.length) {
      ops.push({ t, op: "remove", id: smashOrder[smashed++] });
    }

    if (mode === "mob") {
      if (!mob.length || random() < 0.002) {
        mob = Array.from({ length: 12 }, (_, index) => ({ at: near(1800), radius: mobRadii[index % 3], stuck: index % 3 === 0 }));
      }
      for (const monster of mob) {
        if (monster.stuck) continue;
        const dx = player.x - monster.at.x;
        const dy = player.y - monster.at.y;
        const length = Math.hypot(dx, dy) || 1;
        monster.at = { x: monster.at.x + (dx / length) * 7.5 + (random() - 0.5) * 6, y: monster.at.y + (dy / length) * 7.5 + (random() - 0.5) * 6 };
      }
      // A stuck monster asks on the AI's beat, from where it stands, for where the player is.
      if (t % 250 === 0) {
        mob.forEach((monster, index) => {
          if (monster.stuck) ops.push({ t, op: "memo", owner: index, start: { ...monster.at }, goal: { ...player }, radius: monster.radius });
        });
      }
    }
    const searches = searchesPerSecond * queryScale * (STEP_MS / 1000);
    const budget = Math.floor(searches + (random() < searches % 1 ? 1 : 0));
    for (let i = 0; i < budget; i++) {
      if (mode === "mob") {
        const monster = pick(mob);
        ops.push({ t, op: "findPath", start: { ...monster.at }, goal: { ...player }, radius: monster.radius });
        continue;
      }
      if (smashOrder.length) {
        const spot = smashSpot();
        const start = { x: spot.x + (random() - 0.5) * 900, y: spot.y + (random() - 0.5) * 900 };
        const goal = random() < 0.5 ? spot : { x: 2 * spot.x - start.x, y: 2 * spot.y - start.y };
        ops.push({ t, op: "findPath", start, goal, radius: pick(RADII) });
        continue;
      }
      const radius = pick(RADII);
      const start = mode === "chase" ? near(2400) : mode === "toggling" ? nearToggling(900) : sample();
      const goal = mode === "chase" ? near(200) : mode === "toggling" ? nearToggling(900) : sample();
      ops.push({ t, op: "findPath", start, goal, radius });
    }
    for (let i = 0; i < Math.max(1, Math.round(queryScale)); i++) {
      const odd = random() < 0.03;
      const radius = odd ? pick(ODD_RADII) : pick(RADII);
      const spot = smashOrder.length && !odd ? smashSpot() : null;
      const from = odd ? oddPoint() : spot ? { x: spot.x + (random() - 0.5) * 300, y: spot.y + (random() - 0.5) * 300 } : near(1600);
      const kind = random();
      if (kind < 0.28) {
        const to = odd ? oddPoint() : spot ? { x: 2 * spot.x - from.x, y: 2 * spot.y - from.y } : near(1600);
        ops.push({ t, op: "los", from, to, radius, ignored: ignoredOf() });
      }
      else if (kind < 0.5) ops.push({ t, op: "blocked", point: from, radius, ignored: ignoredOf() });
      else if (kind < 0.72) {
        const angle = random() * Math.PI * 2;
        const length = random() * 60;
        ops.push({ t, op: "move", from, displacement: { x: Math.cos(angle) * length, y: Math.sin(angle) * length }, radius, ignored: ignoredOf() });
      } else if (kind < 0.84) {
        ops.push({ t, op: "nearestClear", origin: from, radius, towards: random() < 0.5 ? player : null, reachableFrom: random() < 0.5 ? player : null, reach: pick([undefined, 120, 240, 400]) });
      } else if (kind < 0.9) ops.push({ t, op: "onTile", point: from });
      else if (kind < 0.95) ops.push({ t, op: "segment", from, to: near(1600) });
      else if (cageOrigins.length) ops.push({ t, op: "cage", origin: pick(cageOrigins), radius, target: random() < 0.6 ? player : null });
    }
  }
  return ops;
};

/** Small cluttered floors where a cell's answer rests on an off-centre probe. */
export const syntheticFloor = (random) => {
  const size = 1200 + Math.floor(random() * 600);
  const shape = (scale) =>
    random() < 0.5
      ? { type: "circle", x: random() * size, y: random() * size, radius: 6 + random() * scale }
      : { type: "rectangle", x: random() * size, y: random() * size, halfWidth: 4 + random() * scale, halfHeight: 4 + random() * scale, angle: random() < 0.5 ? 0 : random() * Math.PI };
  const definition = {
    bounds: { minX: 0, minY: 0, maxX: size, maxY: size },
    staticColliders: Array.from({ length: 60 + Math.floor(random() * 120) }, () => shape(30)),
    triggerColliders: Array.from({ length: 12 }, (_, i) => [
      `g${i}`,
      { initialOn: random() < 0.5, onColliders: Array.from({ length: 1 + Math.floor(random() * 2) }, () => shape(25)), offColliders: random() < 0.4 ? [shape(15)] : [] },
    ]),
  };
  const point = () => ({ x: random() * size, y: random() * size });
  return { definition, shape, point };
};

/** The stress workload: toggles, obstacles and searches at radii up to more than a cell. */
export const buildStressWorkload = (floor, random, steps) => {
  const radii = [0, 5, 20, 26, 40, 65, 90];
  const ops = [];
  for (let step = 0; step < steps; step++) {
    const roll = random();
    if (roll < 0.35) ops.push({ op: "toggle", id: `g${Math.floor(random() * 12)}`, on: random() < 0.5 });
    else if (roll < 0.42) ops.push({ op: "add", id: `o${Math.floor(random() * 6)}`, colliders: [floor.shape(20)] });
    else if (roll < 0.47) ops.push({ op: "remove", id: `o${Math.floor(random() * 6)}` });
    else {
      const start = floor.point();
      const goal = random() < 0.6 ? { x: start.x + (random() - 0.5) * 600, y: start.y + (random() - 0.5) * 600 } : floor.point();
      ops.push({ op: "findPath", start, goal, radius: radii[Math.floor(random() * radii.length)] });
    }
  }
  return ops;
};

const optionsFor = (navigation, ignored) => {
  if (ignored === null || ignored === undefined) return undefined;
  if (!Array.isArray(navigation.colliders)) return {};
  return { ignoredColliders: new Set(ignored.map((index) => navigation.colliders[index]).filter(Boolean)) };
};

/** Runs one op on one module; throws are an answer too, compared by kind. */
export const apply = (module, state, op) => {
  const { navigation } = module;
  const nav = state.navigation;
  try {
    switch (op.op) {
      case "toggle":
        return { value: navigation.setNavigationTriggerState(nav, op.id, op.on) };
      case "add":
        return { value: navigation.addNavigationObstacle(nav, op.id, op.colliders) };
      case "remove":
        return { value: navigation.removeNavigationObstacle(nav, op.id) };
      case "findPath":
        return { value: navigation.findPath(nav, op.start, op.goal, op.radius) };
      case "memo": {
        if (!module.routeMemo) return { value: navigation.findPath(nav, op.start, op.goal, op.radius) };
        let owner = state.owners.get(op.owner);
        if (!owner) state.owners.set(op.owner, (owner = {}));
        return { value: module.routeMemo.searchRoute(owner, nav, op.start, op.goal, op.radius) };
      }
      case "los":
        return { value: navigation.hasLineOfSight(nav, op.from, op.to, op.radius, optionsFor(nav, op.ignored)) };
      case "blocked":
        return { value: navigation.isPositionBlocked(nav, op.point, op.radius, optionsFor(nav, op.ignored)) };
      case "move":
        return { value: navigation.moveWithNavigation(nav, op.from, op.displacement, op.radius, optionsFor(nav, op.ignored)) };
      case "nearestClear":
        return { value: navigation.nearestClearPosition(nav, op.origin, op.radius, { towards: op.towards, reachableFrom: op.reachableFrom, reach: op.reach }) };
      case "cage":
        return { value: navigation.findCageReleasePath(nav, op.origin, op.radius, op.target) };
      case "onTile":
        return { value: navigation.isOnAuthoredTile(nav, op.point) };
      case "segment":
        return { value: navigation.segmentStaysOnAuthoredTiles(nav, op.from, op.to) };
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  } catch (problem) {
    return { threw: problem?.constructor?.name ?? String(problem) };
  }
};

/**
 * Every cached cell and link of one module's route caches against a fresh
 * computation with the module's own geometry queries. Mirrors `findPath`'s
 * `stateOf` and `walkBetween`: the anchor offsets in their order, the probe
 * margin of 2, the straight step first and then either corner. Null when the
 * module keeps no cache of this shape, which is the case for the layout
 * before the per-radius caches and may be again after a split.
 */
const ANCHOR_OFFSETS = (() => {
  const steps = [-0.4, -0.2, 0, 0.2, 0.4];
  return steps.flatMap((dx) => steps.map((dy) => [dx, dy])).sort(([ax, ay], [bx, by]) => ax * ax + ay * ay - (bx * bx + by * by));
})();
const DIRECTIONS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

export const auditCaches = (module, nav) => {
  const caches = nav.pathfinding?.byRadius;
  if (!(caches instanceof Map)) return null;
  const { navigation } = module;
  const { bounds, cellSize } = nav;
  const result = { cells: 0, links: 0, stale: 0, skipped: 0 };
  for (const cache of caches.values()) {
    if (cache.pending?.size) {
      result.skipped++;
      continue;
    }
    const { columns, rows, radius } = cache;
    const fresh = (x, y) => {
      const centreX = bounds.minX + x * cellSize + cellSize / 2;
      const centreY = bounds.minY + y * cellSize + cellSize / 2;
      for (const [dx, dy] of ANCHOR_OFFSETS) {
        const point = { x: centreX + dx * cellSize, y: centreY + dy * cellSize };
        if (navigation.isPositionBlocked(nav, point, radius + 2)) continue;
        return dx === 0 && dy === 0 ? { state: 2, anchor: { x: centreX, y: centreY } } : { state: 3, anchor: point };
      }
      return { state: 1, anchor: null };
    };
    for (let key = 0; key < columns * rows; key++) {
      const x = key % columns;
      const y = Math.floor(key / columns);
      if (cache.state[key]) {
        result.cells++;
        const expected = fresh(x, y);
        const anchor = cache.state[key] === 3 ? cache.anchors.get(key) : null;
        if (expected.state !== cache.state[key] || (expected.state === 3 && !isDeepStrictEqual(expected.anchor, anchor))) result.stale++;
      }
      if (!cache.links[key]) continue;
      for (let direction = 0; direction < 8; direction++) {
        const known = (cache.links[key] >>> (direction * 2)) & 3;
        if (!known) continue;
        result.links++;
        const [dx, dy] = DIRECTIONS[direction];
        const a = fresh(x, y).anchor;
        const b = fresh(x + dx, y + dy).anchor;
        if (!a || !b) {
          result.stale++;
          continue;
        }
        let expected = 1;
        let via = null;
        if (navigation.hasLineOfSight(nav, a, b, radius)) expected = 2;
        else {
          for (const corner of [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]) {
            if (
              !navigation.isPositionBlocked(nav, corner, radius) &&
              navigation.hasLineOfSight(nav, a, corner, radius) &&
              navigation.hasLineOfSight(nav, corner, b, radius)
            ) {
              expected = 3;
              via = corner;
              break;
            }
          }
        }
        if (expected !== known || (known === 3 && !isDeepStrictEqual(cache.vias.get(key * 8 + direction)?.via, via))) result.stale++;
      }
    }
  }
  return result;
};

/**
 * The searches that bring every radius owing a forget up to date, so the
 * audit sees settled caches. Returned as ops, so both modules take them and
 * the answers are compared like any other.
 */
export const settlingOps = (nav) => {
  const ops = [];
  const caches = nav.pathfinding?.byRadius;
  if (!(caches instanceof Map)) return ops;
  const { bounds } = nav;
  for (const cache of caches.values()) {
    if (!cache.pending?.size) continue;
    ops.push({
      op: "findPath",
      start: { x: bounds.minX + 100, y: bounds.minY + 100 },
      goal: { x: bounds.maxX - 100, y: bounds.maxY - 100 },
      radius: cache.radius,
    });
  }
  return ops;
};

/** A new state for a module, with the per-owner route memos it will keep. */
export const instantiate = (module, definition) => ({
  navigation: module.navigation.createNavigationState(definition),
  owners: new Map(),
});

/** What the two states must agree on besides their answers. */
export const statesAgree = (a, b) =>
  a.navigation.revision === b.navigation.revision &&
  (!Array.isArray(a.navigation.colliders) || !Array.isArray(b.navigation.colliders) || a.navigation.colliders.length === b.navigation.colliders.length);

import assert from "node:assert/strict";
import test from "node:test";

import { loadFloor } from "../src/socket/floors.js";
import {
  addNavigationObstacle,
  createNavigationState,
  findCageReleasePath,
  findPath,
  hasLineOfSight,
  isOnAuthoredTile,
  isPositionBlocked,
  moveWithNavigation,
  removeNavigationObstacle,
  segmentStaysOnAuthoredTiles,
  setNavigationTriggerState,
} from "../src/socket/navigation.js";

const rectangle = (x, y, halfWidth, halfHeight, angle = 0) => ({
  type: "rectangle",
  x,
  y,
  halfWidth,
  halfHeight,
  angle,
});

test("movement stays on the tiles the generated floor actually laid", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2700, maxY: 1800 },
    tileSize: 900,
    tiles: [
      { x: 0, y: 0 },
      { x: 900, y: 0 },
      { x: 1800, y: 0 },
      { x: 1800, y: 900 },
    ],
  });

  assert.equal(isOnAuthoredTile(navigation, { x: 100, y: 100 }), true);
  assert.equal(isOnAuthoredTile(navigation, { x: 1000, y: 1000 }), false);
  assert.equal(
    segmentStaysOnAuthoredTiles(navigation, { x: 100, y: 100 }, { x: 1900, y: 100 }),
    true,
    "adjacent authored tiles form one continuous floor"
  );
  assert.equal(
    segmentStaysOnAuthoredTiles(navigation, { x: 100, y: 100 }, { x: 1900, y: 1000 }),
    false,
    "a diagonal shortcut cannot cross the missing centre tile"
  );

  const gap = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2700, maxY: 900 },
    tileSize: 900,
    tiles: [
      { x: 0, y: 0 },
      { x: 1800, y: 0 },
    ],
  });
  assert.equal(
    segmentStaysOnAuthoredTiles(gap, { x: 100, y: 100 }, { x: 1900, y: 100 }),
    false,
    "two valid endpoints do not make the absent tile between them valid"
  );
});

test("tutorial floor loads the same authored wall colliders as the client", async () => {
  const floor = await loadFloor("tutorial");
  assert.ok(floor.navigation.staticColliders.length >= 100);
  assert.ok(floor.navigation.triggerColliders.size >= 2);

  const navigation = createNavigationState(floor.navigation);
  // CASTLE_ARENA_WALL_A at tile 1800,5400 + local 750,270 has a
  // rectangle centered 45px above its visual origin.
  assert.equal(isPositionBlocked(navigation, { x: 2550, y: 5625 }, 1), true);
});

test("tutorial smashables retain their authored, transformed collision shapes", async () => {
  const floor = await loadFloor("tutorial");
  const barrel = floor.placements.npc.find(
    (placement) => placement.constant === "CASTLE_ARENA_SMASH_BARREL"
  );
  const woodenBox = floor.placements.npc.find(
    (placement) => placement.constant === "CASTLE_ARENA_SMASH_WOODENBOX"
  );

  assert.deepEqual(barrel.navigationColliders, [
    { type: "circle", x: 2130, y: 5916, radius: 27 },
  ]);
  assert.deepEqual(woodenBox.navigationColliders, [
    {
      type: "rectangle",
      x: 2370,
      y: 6174,
      halfWidth: 36.00000000000001,
      halfHeight: 36.00000000000001,
      angle: 0,
    },
  ]);
});

test("a smashable blocks movement until its navigation obstacle is removed", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
  });
  const obstacle = { type: "circle", x: 150, y: 150, radius: 30 };

  assert.equal(addNavigationObstacle(navigation, 42, [obstacle]), true);
  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 20), true);
  assert.equal(removeNavigationObstacle(navigation, 42), true);
  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 20), false);
});

test("A* routes around a wall instead of taking the blocked straight line", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    cellSize: 30,
    staticColliders: [rectangle(150, 150, 15, 90)],
  });
  const start = { x: 45, y: 150 };
  const goal = { x: 255, y: 150 };

  assert.equal(hasLineOfSight(navigation, start, goal, 10), false);
  const path = findPath(navigation, start, goal, 10);
  assert.ok(path.length >= 2, `expected a routed path, got ${JSON.stringify(path)}`);

  let previous = start;
  for (const waypoint of path) {
    assert.equal(hasLineOfSight(navigation, previous, waypoint, 10), true);
    previous = waypoint;
  }
  assert.ok(Math.hypot(previous.x - goal.x, previous.y - goal.y) < 50);
});

test("compressed A* paths keep the final corner needed by multi-wall routes", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 330, maxY: 330 },
    cellSize: 30,
    staticColliders: [
      rectangle(120, 105, 10, 75),
      rectangle(210, 195, 10, 75),
    ],
  });
  const start = { x: 30, y: 90 };
  const goal = { x: 300, y: 270 };
  const path = findPath(navigation, start, goal, 10);

  assert.ok(path.length >= 3, `expected both wall corners, got ${JSON.stringify(path)}`);
  let previous = start;
  for (const waypoint of path) {
    assert.equal(
      hasLineOfSight(navigation, previous, waypoint, 10),
      true,
      `invalid compressed segment ${JSON.stringify(previous)} -> ${JSON.stringify(waypoint)}`
    );
    previous = waypoint;
  }
});

test("A* searches beyond the legacy 20,000-node ceiling when a valid route exists", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 6000, maxY: 2000 },
    cellSize: 20,
    staticColliders: [rectangle(3000, 900, 10, 900)],
  });
  const start = { x: 100, y: 1000 };
  const goal = { x: 5900, y: 1000 };
  const path = findPath(navigation, start, goal, 2);

  assert.ok(path.length >= 2, `expected a route around the long wall, got ${JSON.stringify(path)}`);
  let previous = start;
  for (const waypoint of path) {
    assert.equal(hasLineOfSight(navigation, previous, waypoint, 2), true);
    previous = waypoint;
  }
});

test("swept movement cannot tunnel through a thin wall", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    staticColliders: [rectangle(150, 150, 5, 150)],
  });

  const result = moveWithNavigation(
    navigation,
    { x: 220, y: 150 },
    { x: -160, y: 0 },
    20
  );
  assert.ok(result.x >= 175, `actor crossed the wall and reached x=${result.x}`);
});

test("opening a triggerable swaps its closed and open navigation shapes", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    triggerColliders: new Map([
      [
        "gate",
        {
          initialOn: true,
          onColliders: [rectangle(150, 150, 80, 15)],
          offColliders: [rectangle(85, 150, 15, 15), rectangle(215, 150, 15, 15)],
        },
      ],
    ]),
  });

  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 10), true);
  assert.equal(setNavigationTriggerState(navigation, "gate", false), true);
  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 10), false);
});

test("generator release paths leave a rotated trigger enclosure through its local mouth", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    triggerColliders: new Map([
      [
        "jail",
        {
          initialOn: true,
          onColliders: [rectangle(300, 300, 30, 105, Math.PI / 2)],
          offColliders: [rectangle(300, 300, 30, 105, Math.PI / 2)],
        },
      ],
    ]),
  });
  const origin = { x: 300, y: 300 };
  const hero = { x: 530, y: 300 };
  const release = findCageReleasePath(navigation, origin, 20, hero);

  assert.ok(release, "expected a release point outside the rotated enclosure");
  assert.equal(isPositionBlocked(navigation, release.target, 20), false);
  assert.equal(hasLineOfSight(navigation, origin, release.target, 20), false);
  assert.equal(
    hasLineOfSight(navigation, origin, release.target, 20, release),
    true
  );
  assert.ok(
    release.target.x > origin.x,
    `expected the hero-facing side, got ${JSON.stringify(release.target)}`
  );
});

test("tutorial's proximity cage has a short collider-only release route", async () => {
  const floor = await loadFloor("tutorial");
  const navigation = createNavigationState(floor.navigation);
  // Placement ids carry the placed tile's instance prefix, so match the tile's
  // own id rather than the whole thing — see localId in floors.js.
  const generator = floor.placements.generator.find((placement) =>
    String(placement.id).endsWith(":6.1312238282537")
  );
  const hero = { x: 4080, y: 3900 };
  const radius = 35;

  const release = findCageReleasePath(navigation, generator, radius, hero);
  assert.ok(release, "expected a release path for the tutorial cage");
  assert.equal(isPositionBlocked(navigation, release.target, radius), false);
  assert.equal(
    hasLineOfSight(navigation, generator, release.target, radius, release),
    true
  );
  assert.ok(
    release.target.y > generator.y,
    `expected the room-facing cage mouth, got ${JSON.stringify(release.target)}`
  );
  assert.ok(
    Math.hypot(release.target.x - generator.x, release.target.y - generator.y) < 100,
    `release target is too far from the door: ${JSON.stringify(release.target)}`
  );
});

/**
 * The collider index must not answer for colliders it was not built from.
 *
 * Narrowing the set by spreading the navigation object and replacing
 * `colliders` is how callers ask what one part of the geometry alone would say
 * — the wall audit does exactly this to separate static walls from raised
 * triggers. That spread copies the index along with everything else, so an
 * index that trusted only itself would keep answering for the full floor and
 * report a hit on geometry the caller had just excluded. It did, and the audit
 * moved a hit from trigger to static without a line of it changing.
 */
test("narrowing the collider set is not answered from the whole-floor index", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    tiles: [{ x: 0, y: 0 }],
    tileSize: 900,
    staticColliders: [rectangle(200, 200, 50, 50)],
    triggerColliders: [
      ["gate", { initialOn: true, onColliders: [rectangle(600, 600, 50, 50)], offColliders: [] }],
    ],
  });

  const inTrigger = { x: 600, y: 600 };
  assert.equal(isPositionBlocked(navigation, inTrigger, 0), true, "the raised gate blocks");

  // The same question asked of the static geometry alone must say no, because
  // the gate is not part of it.
  const staticOnly = { ...navigation, colliders: navigation.staticColliders };
  assert.equal(
    isPositionBlocked(staticOnly, inTrigger, 0),
    false,
    "a narrowed set must not be answered from the full index"
  );

  // And the static collider is still found through the narrowed set.
  assert.equal(isPositionBlocked(staticOnly, { x: 200, y: 200 }, 0), true);
});

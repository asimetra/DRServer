import assert from "node:assert/strict";
import test from "node:test";

import { loadFloor, readPlacements } from "../src/socket/floors.js";
import {
  addNavigationObstacle,
  createNavigationState,
  findCageReleasePath,
  findPath,
  hasLineOfSight,
  isOnAuthoredTile,
  isPositionBlocked,
  loadNavigationLibrary,
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
    { type: "circle", x: 2130, y: 5916, radius: 27, facing: 0 },
  ]);
  assert.deepEqual(woodenBox.navigationColliders, [
    {
      type: "rectangle",
      x: 2370,
      y: 6174,
      halfWidth: 36.00000000000001,
      halfHeight: 36.00000000000001,
      angle: 0,
      facing: 0,
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

  const index = navigation.colliderIndex;
  const colliders = navigation.colliders;
  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 10), true);
  assert.equal(setNavigationTriggerState(navigation, "gate", false), true);
  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 10), false);
  assert.equal(navigation.colliderIndex, index, "trigger toggle rebuilt the whole spatial index");
  assert.equal(navigation.colliders, colliders, "trigger toggle replaced the collider array");
});

test("actor obstacles update only their own collider index entries", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    staticColliders: [rectangle(500, 500, 20, 20)],
  });
  const index = navigation.colliderIndex;
  const colliders = navigation.colliders;
  const obstacle = rectangle(150, 150, 30, 30);

  assert.equal(addNavigationObstacle(navigation, "box", [obstacle]), true);
  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 10), true);
  assert.equal(navigation.colliderIndex, index);
  assert.equal(navigation.colliders, colliders);

  assert.equal(removeNavigationObstacle(navigation, "box"), true);
  assert.equal(isPositionBlocked(navigation, { x: 150, y: 150 }, 10), false);
  assert.equal(isPositionBlocked(navigation, { x: 500, y: 500 }, 10), true);
  assert.equal(navigation.colliderIndex, index);
  assert.equal(navigation.colliders, colliders);
});

test("a cage lets its prisoners out of the front it faces, whatever angle its pieces sit at", () => {
  /**
   * An Aztec jail is three slanted boxes. Taking each box's own local front led
   * nowhere; the mouth is the cage object's front. Here the object is turned a
   * quarter, so its front faces -x, and its one piece sits at yet another angle.
   */
  const piece = { ...rectangle(300, 300, 60, 40, 2.5), facing: Math.PI / 2 };
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    triggerColliders: new Map([["jail", { initialOn: true, onColliders: [piece], offColliders: [piece] }]]),
  });
  const origin = { x: 300, y: 300 };
  // The player is off to the cage's right.
  const release = findCageReleasePath(navigation, origin, 20, { x: 530, y: 300 });

  assert.ok(release, "expected a way out");
  assert.equal(isPositionBlocked(navigation, release.target, 20), false);
  assert.equal(hasLineOfSight(navigation, origin, release.target, 20, release), true);
  assert.ok(release.target.x < origin.x && Math.abs(release.target.y - origin.y) < 1, `not out of its front: ${JSON.stringify(release.target)}`);
});

test("the mirrored Aztec jails let their prisoners out of the front too", async () => {
  // Their pieces are slanted boxes; the front is the object's, not a box's.
  await loadNavigationLibrary();
  const floor = await readPlacements("Resources/Levels/jungle/aztec/tiles.json", [
    { x: 0, y: 0, tileId: "1224.1335299112781" },
  ]);
  const navigation = createNavigationState(floor.navigation);
  const generator = floor.placements.generator.find((placement) => placement.id.endsWith("19.1335892533301"));
  const release = findCageReleasePath(navigation, generator, 35, null);
  assert.ok(release, "no way out of the mirrored Aztec jail");
  assert.ok(release.target.y > generator.y && Math.abs(release.target.x - generator.x) < 1, `not out of its front: ${JSON.stringify(release.target)}`);
});

test("offset Aztec jail mouths still provide a release after the preferred front", async () => {
  await loadNavigationLibrary();
  const cases = [
    ["360.1336411380154", "0:467.1337129318634"],
    ["74.1336164313583", "0:336.1337199659564"],
  ];

  for (const [tileId, generatorId] of cases) {
    const floor = await readPlacements("Resources/Levels/jungle/aztec/tiles.json", [
      { x: 0, y: 0, tileId },
    ]);
    const navigation = createNavigationState(floor.navigation);
    const generator = floor.placements.generator.find(({ id }) => id === generatorId);
    assert.ok(generator, `missing generator ${generatorId} on tile ${tileId}`);

    const release = findCageReleasePath(navigation, generator, 35, null);
    assert.ok(release, `no release for generator ${generatorId} on tile ${tileId}`);
    assert.equal(isPositionBlocked(navigation, release.target, 35), false);
    assert.equal(
      hasLineOfSight(navigation, generator, release.target, 35, release),
      true,
      `release for ${generatorId} crosses non-cage geometry`
    );
  }
});

test("the bridge-tile jail lets its knights out of the front, with the player on the bridge", async () => {
  /**
   * The Knight Fortress tile with a jail either side of a bridge. With the
   * player on the bridge, the side of the east jail was nearer them than its
   * front, so its wave walked out through that wall into the gap between the
   * jail and the water, and jammed there. The official releases 242 of 242
   * from these jails by the front.
   */
  await loadNavigationLibrary();
  const floor = await readPlacements("Resources/Levels/castle/arena/tiles.json", [
    { x: 0, y: 0, tileId: "145.1334089164200" },
  ]);
  const navigation = createNavigationState(floor.navigation);
  const bridge = { x: 480, y: 430 };
  const knight = 42;

  for (const generator of floor.placements.generator) {
    const release = findCageReleasePath(navigation, generator, knight, bridge);
    assert.ok(release, `no way out of the jail at ${generator.x}`);
    // Each jail's block spans 90 either side of its centre and ends at y 198.
    assert.ok(release.target.y >= 198 + knight, `not out of the front: ${JSON.stringify(release.target)}`);
    assert.ok(Math.abs(release.target.x - generator.x) <= 90, `off to one side: ${JSON.stringify(release.target)}`);
  }
});

test("a doorway a body fits through is found wherever it falls on the grid", () => {
  /**
   * A cell used to be open only if a body fit at its centre, so a gap was
   * found or not by where the grid happened to cut it: a knight's doorway with
   * 16 units to spare was found at 6 of 20 alignments.
   */
  const radius = 42;
  const width = 100;
  let found = 0;
  for (let shift = 0; shift < 60; shift += 3) {
    const from = 600 + shift;
    const navigation = createNavigationState({
      bounds: { minX: 0, minY: 0, maxX: 1500, maxY: 1200 },
      staticColliders: [
        rectangle(from / 2, 580, from / 2, 20),
        rectangle((from + width + 1500) / 2, 580, (1500 - from - width) / 2, 20),
      ],
    });
    const path = findPath(navigation, { x: 300, y: 300 }, { x: 1200, y: 900 }, radius);
    if (path.length) found += 1;
    for (const [index, point] of path.entries()) {
      const previous = index ? path[index - 1] : { x: 300, y: 300 };
      assert.equal(hasLineOfSight(navigation, previous, point, radius), true, `leg ${index} at shift ${shift} cuts a wall`);
    }
  }
  assert.equal(found, 20);
});

test("a route never runs between two clear centres through a thin board", () => {
  // A board standing between the centres of two neighbouring cells; both centres are clear of it.
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    staticColliders: [rectangle(360, 450, 30, 2, Math.PI / 2)],
  });
  const start = { x: 400, y: 450 };
  const path = findPath(navigation, start, { x: 290, y: 452 }, 10);
  assert.ok(path.length, "expected a way round the board");
  path.forEach((point, index) => {
    const previous = index ? path[index - 1] : start;
    assert.equal(hasLineOfSight(navigation, previous, point, 10), true, `leg ${index} goes through the board`);
  });
});

test("a step into something round slides round it", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    staticColliders: [{ type: "circle", x: 450, y: 450, radius: 40 }],
  });
  // A knight touching a statue's circle a little off its axis, walking straight at the player behind it.
  const from = { x: 460, y: 367 };
  const radius = 42;
  let position = from;
  for (let step = 0; step < 10; step++) position = moveWithNavigation(navigation, position, { x: 0, y: 18 }, radius);
  assert.ok(position.x > from.x + 20, `it stood against the statue at ${JSON.stringify(position)}`);
  assert.equal(isPositionBlocked(navigation, position, radius), false);
});

test("a body already in the scenery may step out of it, and only out", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    staticColliders: [rectangle(804, 108, 90, 90)],
  });
  // A knight 19 units into the bottom of a jail whose face is at y 198.
  const buried = { x: 773, y: 221 };
  const radius = 42;
  assert.equal(isPositionBlocked(navigation, buried, radius), true);

  const out = moveWithNavigation(navigation, buried, { x: 0, y: 18 }, radius);
  assert.ok(out.y > buried.y, "a step out of the jail is taken, though it ends still touching");
  assert.deepEqual(moveWithNavigation(navigation, buried, { x: 0, y: -18 }, radius), buried, "never deeper");
  assert.deepEqual(moveWithNavigation(navigation, buried, { x: 18, y: 0 }, radius), buried, "nor along the bars");

  const clear = { x: 773, y: 260 };
  const stopped = moveWithNavigation(navigation, clear, { x: 0, y: -40 }, radius);
  assert.equal(isPositionBlocked(navigation, stopped, radius), false, "and a body on open ground is not let in");
});

test("escaping one collider cannot spend that progress by entering another", () => {
  const first = rectangle(200, 200, 100, 100);
  const second = rectangle(220, 105, 100, 10, 0.1);
  const definition = { bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 } };
  const navigation = createNavigationState({ ...definition, staticColliders: [first, second] });
  const firstOnly = createNavigationState({ ...definition, staticColliders: [first] });
  const secondOnly = createNavigationState({ ...definition, staticColliders: [second] });
  const from = { x: 265, y: 130 };
  const radius = 10;

  assert.equal(isPositionBlocked(firstOnly, from, radius), true);
  assert.equal(isPositionBlocked(secondOnly, from, radius), false);
  const moved = moveWithNavigation(navigation, from, { x: 40, y: 0 }, radius);
  assert.equal(
    isPositionBlocked(secondOnly, moved, radius),
    false,
    `escape entered the neighbouring collider at ${JSON.stringify(moved)}`
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

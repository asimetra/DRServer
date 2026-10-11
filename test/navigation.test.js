import assert from "node:assert/strict";
import test from "node:test";

import { buildFloor as layOutFloor, loadFloor, readPlacements } from "../src/socket/floors.js";
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
  nearestClearPosition,
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

/**
 * A line of no width — what a monster asks before it swings — was asked every
 * 16 units, and a board thinner than that, or the corner of a thicker one,
 * fell between two samples. It is asked of every point now.
 */
test("a line of no width does not pass a board thinner than 16 units, or clip a corner", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 400, maxY: 500 },
    staticColliders: [
      // A castle prison board, 14 across.
      rectangle(200, 200, 200, 7),
      // A crate, 70 to 130 by 290 to 350, and a round post, for lines that only graze them.
      rectangle(100, 320, 30, 30),
      { type: "circle", x: 300, y: 320, radius: 20 },
    ],
  });
  /** Whether every 16 units of the line, as it used to be asked, is clear. */
  const samplesClear = (from, to) => {
    const samples = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 16);
    for (let at = 1; at <= samples; at++) {
      const point = { x: from.x + ((to.x - from.x) * at) / samples, y: from.y + ((to.y - from.y) * at) / samples };
      if (isPositionBlocked(navigation, point, 0)) return false;
    }
    return true;
  };
  const crossings = [
    // Through the board: samples at 207.1 and 192.8, either side of it.
    [{ x: 200, y: 250 }, { x: 200, y: 178.5 }],
    // 8.5 units off the crate's corner (130, 350): samples at x 123.0 and 133.6.
    [{ x: 70, y: 404 }, { x: 176, y: 298 }],
    // 1 unit inside the post, a chord of 12.5: samples at y 312 and 328.
    [{ x: 281, y: 232 }, { x: 281, y: 392 }],
  ];
  for (const [from, to] of crossings) {
    assert.equal(samplesClear(from, to), true, `the samples of ${JSON.stringify([from, to])} find it`);
    assert.equal(hasLineOfSight(navigation, from, to, 0), false, `seen through, ${JSON.stringify([from, to])}`);
    assert.equal(hasLineOfSight(navigation, to, from, 0), false, `seen through the other way, ${JSON.stringify([from, to])}`);
  }
  // Past the post's edge by a unit, and past the crate's corner, it sees.
  assert.equal(hasLineOfSight(navigation, { x: 279, y: 232 }, { x: 279, y: 392 }, 0), true);
  assert.equal(hasLineOfSight(navigation, { x: 70, y: 412 }, { x: 184, y: 298 }, 0), true);

  // The board left out is no board; a narrowed set of colliders without the index says the same.
  const [monster, feet] = crossings[0];
  const board = navigation.staticColliders[0];
  assert.equal(hasLineOfSight(navigation, monster, feet, 0, { ignoredColliders: new Set([board]) }), true);
  assert.equal(hasLineOfSight({ ...navigation, colliders: [board] }, monster, feet, 0), false);
  assert.equal(hasLineOfSight({ ...navigation, colliders: [] }, monster, feet, 0), true);
});

test("a line of no width meets a rectangle's edge at its end, not at its start, and keeps to laid tiles", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 100 },
    tileSize: 100,
    tiles: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
    staticColliders: [rectangle(50, 50, 10, 10)],
  });
  // Ending on the edge is ending in it, as the point test says; starting on it and leaving is not.
  assert.equal(isPositionBlocked(navigation, { x: 40, y: 80 }, 0), false);
  assert.equal(hasLineOfSight(navigation, { x: 20, y: 50 }, { x: 40, y: 50 }, 0), false);
  assert.equal(hasLineOfSight(navigation, { x: 40, y: 50 }, { x: 20, y: 50 }, 0), true);
  // The tile between the two laid ones is not laid; a line no longer than a sample step still crosses it.
  assert.equal(hasLineOfSight(navigation, { x: 95, y: 90 }, { x: 205, y: 90 }, 0), false);
  assert.equal(hasLineOfSight(navigation, { x: 5, y: 90 }, { x: 95, y: 90 }, 0), true);
  // A line with no length is its one point.
  assert.equal(hasLineOfSight(navigation, { x: 50, y: 50 }, { x: 50, y: 50 }, 0), false);
  assert.equal(hasLineOfSight(navigation, { x: 5, y: 5 }, { x: 5, y: 5 }, 0), true);
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

test("a body pushed out of a wall comes out on the side the room can see", () => {
  /**
   * A wall 20 thick across the whole floor, the body inside it and the player
   * below. The search walks +Y first, and +Y is clear one step out: the far
   * side of the wall, where nobody can reach it. The near side is one step out
   * too, two directions later.
   */
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    cellSize: 30,
    staticColliders: [rectangle(150, 150, 150, 10)],
  });
  const inWall = { x: 150, y: 150 };
  const player = { x: 150, y: 60 };
  assert.equal(isPositionBlocked(navigation, inWall, 0), true);
  assert.deepEqual(nearestClearPosition(navigation, inWall), { x: 150, y: 166 }, "the far side comes first");

  const seen = nearestClearPosition(navigation, inWall, 0, { reachableFrom: player });
  assert.deepEqual(seen, { x: 150, y: 134 });
  assert.equal(hasLineOfSight(navigation, seen, player, 0), true);

  // Nothing within reach can see a player behind a second wall: standable
  // ground is still better than none, and it is the same ground as before.
  const sealed = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    cellSize: 30,
    staticColliders: [rectangle(150, 150, 150, 10), rectangle(150, 40, 150, 10)],
  });
  assert.deepEqual(
    nearestClearPosition(sealed, inWall, 0, { reach: 48, reachableFrom: { x: 150, y: 10 } }),
    { x: 150, y: 166 }
  );

  // The caller's own test still holds in both passes.
  const rightOnly = (candidate) => candidate.x > 160;
  const seenRight = nearestClearPosition(navigation, inWall, 0, { reachableFrom: player, accept: rightOnly });
  assert.ok(seenRight.x > 160 && seenRight.y < 140, JSON.stringify(seenRight));
  assert.equal(hasLineOfSight(navigation, seenRight, player, 0), true);
  const anyRight = nearestClearPosition(sealed, inWall, 0, {
    reach: 48,
    reachableFrom: { x: 150, y: 10 },
    accept: rightOnly,
  });
  assert.ok(anyRight.x > 160 && anyRight.y > 160, JSON.stringify(anyRight));
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

/**
 * Two doorways in one wall, each with a gate, a trap far from both, and a box
 * that comes and goes: a floor whose colliders keep changing under the search.
 */
const gatedWall = (states) => ({
  bounds: { minX: 0, minY: 0, maxX: 1800, maxY: 1200 },
  staticColliders: [
    rectangle(600, 150, 15, 150),
    rectangle(600, 610, 15, 190),
    rectangle(600, 1060, 15, 140),
  ],
  triggerColliders: [
    ["north", { initialOn: states.north, onColliders: [rectangle(600, 360, 15, 60)], offColliders: [] }],
    [
      "south",
      {
        initialOn: states.south,
        onColliders: [rectangle(600, 860, 15, 60)],
        offColliders: [rectangle(560, 860, 10, 10)],
      },
    ],
    ["far", { initialOn: states.far, onColliders: [rectangle(1650, 1100, 40, 40)], offColliders: [] }],
  ],
});

test("a route after traps and boxes change is the route a fresh floor would find", () => {
  const states = { north: true, south: false, far: true };
  const box = [rectangle(300, 600, 40, 40)];
  const navigation = createNavigationState(gatedWall(states));
  let boxed = false;
  let seed = 11;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const routes = [
    [{ x: 200, y: 200 }, { x: 1400, y: 600 }],
    [{ x: 200, y: 1000 }, { x: 1700, y: 150 }],
    [{ x: 1500, y: 1000 }, { x: 100, y: 600 }],
  ];

  for (let step = 0; step < 60; step++) {
    const roll = random();
    if (roll < 0.75) {
      const id = ["north", "south", "far"][Math.floor(random() * 3)];
      states[id] = !states[id];
      setNavigationTriggerState(navigation, id, states[id]);
    } else if (boxed) {
      removeNavigationObstacle(navigation, "box");
      boxed = false;
    } else {
      addNavigationObstacle(navigation, "box", box);
      boxed = true;
    }

    const fresh = createNavigationState(gatedWall(states));
    if (boxed) addNavigationObstacle(fresh, "box", box);
    for (const [start, goal] of routes) {
      for (const radius of [20, 26, 35]) {
        assert.deepEqual(
          findPath(navigation, start, goal, radius),
          findPath(fresh, start, goal, radius),
          `step ${step}, radius ${radius}, ${JSON.stringify(states)}${boxed ? " boxed" : ""}`
        );
      }
    }
  }
});

test("a trap far from a route leaves the route's cached answers in place", () => {
  const navigation = createNavigationState(gatedWall({ north: true, south: false, far: true }));
  const start = { x: 200, y: 200 };
  const goal = { x: 1400, y: 600 };
  const route = findPath(navigation, start, goal, 26);
  const known = () =>
    navigation.pathfinding.byRadius.get("26").state.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  const before = known();
  assert.ok(before > 0);

  const revision = navigation.revision;
  assert.equal(setNavigationTriggerState(navigation, "far", false), true);
  assert.equal(navigation.revision, revision + 1, "every change still moves the revision");
  assert.deepEqual(findPath(navigation, start, goal, 26), route);
  assert.ok(known() >= before - 20, `only cells near the trap were forgotten (${known()} of ${before})`);
});

/** Each leg of a route from where the body stands, which is not its cell's anchor. */
const assertWalkable = (navigation, start, path, radius) => {
  let previous = start;
  for (const [index, point] of path.entries()) {
    assert.equal(
      hasLineOfSight(navigation, previous, point, radius),
      true,
      `leg ${index} ${JSON.stringify(previous)} -> ${JSON.stringify(point)} cuts a wall`
    );
    previous = point;
  }
  return previous;
};

test("a body just past the end of a wall that shuts its whole cell is given the route that exists", () => {
  /**
   * The geometry a yeti stood in for the rest of a floor. Its cell is the one
   * east of the wall's end: the wall reaches 31 units into it, so every probe
   * of the cell is within a body's width of the wall and the cell has no
   * anchor, while the body itself stands 23 units clear. A search used to leave
   * such a cell in whichever direction was shortest with nothing to say the
   * body could follow — north here, straight into the wall's corner — and
   * then refused its own route, though the step east was open all along.
   */
  const radius = 22.75;
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    cellSize: 60,
    staticColliders: [rectangle(425, 390, 86, 30)],
  });
  const start = { x: 534, y: 396 };
  const goal = { x: 448, y: 269 };

  assert.equal(isPositionBlocked(navigation, start, radius), false, "the body stands clear");
  assert.equal(hasLineOfSight(navigation, start, goal, radius), false, "the wall is between them");
  const path = findPath(navigation, start, goal, radius);
  assert.ok(path.length, "expected a route past the end of the wall");
  const end = assertWalkable(navigation, start, path, radius);
  assert.deepEqual(end, goal);
});

test("a body whose cell's anchor lies across a thin wall from it is still given its route", () => {
  /**
   * The same refusal with an anchor: the cell has one, but a board through the
   * cell puts it on the far side from the body, so the route's first point
   * cannot be walked to and nor can the rest, which all lie beyond the board.
   * Judged from where the body stands, the way round the board's end is open.
   */
  const radius = 22;
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    cellSize: 60,
    staticColliders: [rectangle(258, 330, 78, 1)],
  });
  const start = { x: 310, y: 354 };
  const goal = { x: 200, y: 240 };

  assert.equal(isPositionBlocked(navigation, start, radius), false, "the body stands clear");
  assert.equal(hasLineOfSight(navigation, start, goal, radius), false, "the board is between them");
  const path = findPath(navigation, start, goal, radius);
  assert.ok(path.length, "expected a route round the end of the board");
  const end = assertWalkable(navigation, start, path, radius);
  assert.deepEqual(end, goal);
});

test("the yeti's dead pocket on a laid-out ice cave has a way out", async () => {
  /**
   * Floor 1689 of a captured run, laid out again from its own seed: a
   * CRAZED_YETI stood at (534,1356), eight units past the east end of a
   * NORDIC_CAVE_WALL_3X1, for twenty seconds with the player at (448,1229) in
   * plain view, and never moved. Every route search answered [].
   */
  const radius = 22.75;
  const floor = await layOutFloor("nordic/caves/tiles.json", { tier: 2, tileCount: 7, seed: 848905916 });
  const navigation = createNavigationState(floor.navigation);
  const yeti = { x: 534, y: 1356 };
  const hero = { x: 448, y: 1229 };

  assert.equal(isPositionBlocked(navigation, yeti, radius), false, "the yeti stands clear");
  assert.equal(hasLineOfSight(navigation, yeti, hero, radius), false, "the wall's end is between them");
  const path = findPath(navigation, yeti, hero, radius);
  assert.ok(path.length, "expected the route east and round the wall's end");
  const end = assertWalkable(navigation, yeti, path, radius);
  assert.deepEqual(end, hero);

  // From every spot in that pocket, not only the one it stood in.
  for (const start of [{ x: 534, y: 1348 }, { x: 534, y: 1352 }, { x: 534, y: 1360 }, { x: 534, y: 1364 }]) {
    const route = findPath(navigation, start, hero, radius);
    assert.ok(route.length, `expected a route from ${JSON.stringify(start)}`);
    assertWalkable(navigation, start, route, radius);
  }
});

test("a route to a target in a slot the body cannot enter ends short, at the slot's mouth", () => {
  /**
   * A target between two boxes, in a slot 40 units wide that a body of 26
   * fits nowhere near; a wall between it and the start, so the route has to
   * be searched. It ends at the nearest place the body can get to with the
   * target in sight — the slot's west mouth, 90 from it — and says it ends
   * short. It used to end at the open cell nearest the target on the grid,
   * above the upper box, 108 from it and out of sight.
   */
  const radius = 26;
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    cellSize: 60,
    staticColliders: [rectangle(300, 450, 10, 250), rectangle(480, 400, 60, 30), rectangle(480, 500, 60, 30)],
  });
  const start = { x: 150, y: 450 };
  const target = { x: 480, y: 450 };

  assert.equal(isPositionBlocked(navigation, target, 10), false, "something small stands there");
  assert.equal(isPositionBlocked(navigation, target, radius), true, "the body does not fit the slot");
  const path = findPath(navigation, start, target, radius);
  assert.ok(path.length, "expected a route round the wall");
  assert.equal(path.endsShort, true, "the route says it does not reach the target");
  const end = assertWalkable(navigation, start, path, radius);
  assert.equal(isPositionBlocked(navigation, end, radius), false, "the route ends where the body can stand");
  assert.ok(hasLineOfSight(navigation, end, target, 0), `the route ends with the target in sight, not at ${JSON.stringify(end)}`);
  assert.ok(Math.hypot(end.x - target.x, end.y - target.y) <= 90.5, `at the mouth, not ${JSON.stringify(end)}`);

  const open = findPath(navigation, start, { x: 480, y: 300 }, radius);
  assert.deepEqual(open.at(-1), { x: 480, y: 300 }, "a target the body can stand at is reached");
  assert.equal(open.endsShort, undefined, "and that route says nothing more");
});

/**
 * A pocket the body cannot enter: walled on three sides, and on the fourth,
 * the east, a slit of 30 that a body of 26 does not pass. The target stands
 * in it 25 from the west wall.
 */
const pocket = () =>
  createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    cellSize: 60,
    staticColliders: [
      rectangle(400, 450, 10, 80),
      rectangle(450, 380, 60, 10),
      rectangle(450, 520, 60, 10),
      rectangle(500, 407.5, 10, 27.5),
      rectangle(500, 492.5, 10, 27.5),
    ],
  });

test("a route to a target in a pocket ends where the slit shows it, not behind the nearer wall", () => {
  /**
   * The nearest place the body can stand is west of the pocket, against the
   * wall the target stands 25 from, and the nearest open cell on the grid is
   * there too; neither sees the target. The route goes round the pocket to
   * the slit's side and ends where the target is in sight through it,
   * farther from it on the grid but the only place a swing could go from.
   */
  const radius = 26;
  const navigation = pocket();
  const start = { x: 150, y: 450 };
  const target = { x: 425, y: 450 };
  assert.equal(isPositionBlocked(navigation, target, radius), true, "the body does not fit where the target stands");
  assert.equal(isPositionBlocked(navigation, { x: 500, y: 450 }, radius), true, "but not through its slit");
  assert.equal(hasLineOfSight(navigation, { x: 360, y: 450 }, target, 0), false, "the west wall hides it");

  const path = findPath(navigation, start, target, radius);
  assert.equal(path.endsShort, true);
  const end = assertWalkable(navigation, start, path, radius);
  assert.ok(end.x > 510, `the route ends east of the pocket, not at ${JSON.stringify(end)}`);
  assert.ok(hasLineOfSight(navigation, end, target, 0), `with the target in sight through the slit: ${JSON.stringify(end)}`);
  assert.ok(Math.hypot(end.x - target.x, end.y - target.y) < 130);
});

test("a target nothing the body can reach sees has no route", () => {
  // The same pocket with its slit shut: no place it can get to shows the
  // target, and a place that does not is no use to it. With no route, the AI
  // walks straight at the target (test/no-route-walk.test.js).
  const navigation = pocket();
  addNavigationObstacle(navigation, "shutter", [rectangle(500, 450, 10, 20)]);
  assert.deepEqual(findPath(navigation, { x: 150, y: 450 }, { x: 425, y: 450 }, 26), []);
});

test("a target standing clear just past the end of a wall is reached, not its neighbour's anchor across the wall", () => {
  /**
   * The dead pocket of the yeti test with the ends swapped: the target stands
   * 23 units clear past the wall's end, in a cell every probe of which is
   * within a body's width of the wall, so the cell has no anchor. The nearest
   * cell with one lies on the far side of the wall, and a route that ended
   * there left the body across the wall from a target it could have walked
   * to from the cell beyond the wall's end.
   */
  const radius = 22.75;
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    cellSize: 60,
    staticColliders: [rectangle(425, 390, 86, 30)],
  });
  const start = { x: 448, y: 269 };
  const target = { x: 534, y: 396 };

  assert.equal(isPositionBlocked(navigation, target, radius), false, "the target stands clear");
  assert.equal(hasLineOfSight(navigation, start, target, radius), false, "the wall is between them");
  const path = findPath(navigation, start, target, radius);
  assert.ok(path.length, "expected a route round the wall's end");
  const end = assertWalkable(navigation, start, path, radius);
  assert.deepEqual(end, target);
});

test("a knight's route to a hero between the prison's barrel racks ends short, where the body can stand", async () => {
  /**
   * The capture of 2026-10-10: a hero at (167,684) in the slot between three
   * CASTLE_PRISON_SMASH_BARRELRACK props, the fourth smashed; a KNIGHT_HALBERD
   * of radius 42 and reach 140 from the east. Where its walk ends, and that it
   * swings from there, is the AI's (test/npc-melee-reach.test.js).
   */
  const radius = 42;
  const floor = await loadFloor("scenario-test/db_floor_GAPS_CASTLE_PRISON.json");
  const navigation = createNavigationState(floor.navigation);
  for (const [index, placement] of floor.placements.npc.entries()) {
    if (!placement.navigationColliders?.length) continue;
    // The north-east rack had been smashed before the knight came.
    if (placement.constant === "CASTLE_PRISON_SMASH_BARRELRACK" && Math.hypot(placement.x - 217, placement.y - 671) < 10) continue;
    addNavigationObstacle(navigation, `prop-${index}`, placement.navigationColliders);
  }
  const hero = { x: 167, y: 684 };
  assert.equal(isPositionBlocked(navigation, hero, radius), true, "the knight does not fit the slot");
  for (const knight of [{ x: 300.9, y: 641.1 }, { x: 346, y: 639 }]) {
    const path = findPath(navigation, knight, hero, radius);
    assert.ok(path.length, `expected a route from ${JSON.stringify(knight)}`);
    assert.equal(path.endsShort, true);
    const end = assertWalkable(navigation, knight, path, radius);
    assert.equal(isPositionBlocked(navigation, end, radius), false);
  }
});

test("with all four racks standing the knight's route ends where the hero is in sight, not behind the wall", async () => {
  /**
   * The same hero with the north-east rack standing too. The open cell
   * nearest him on the grid is behind CASTLE_PRISON_WALL_C @154,570, at
   * (90,498), 201 away and out of sight, and every route from the east went
   * there. He is in sight from a strip of floor east of the racks a few units
   * wide; the route ends on it, 151 from him.
   */
  const radius = 42;
  const floor = await loadFloor("scenario-test/db_floor_GAPS_CASTLE_PRISON.json");
  const navigation = createNavigationState(floor.navigation);
  for (const [index, placement] of floor.placements.npc.entries()) {
    if (placement.navigationColliders?.length) addNavigationObstacle(navigation, `prop-${index}`, placement.navigationColliders);
  }
  const hero = { x: 167, y: 684 };
  for (const knight of [{ x: 300.9, y: 641.1 }, { x: 346, y: 639 }, { x: 600, y: 640 }, { x: 150, y: 450 }]) {
    const path = findPath(navigation, knight, hero, radius);
    assert.equal(path.endsShort, true, `from ${JSON.stringify(knight)}`);
    const end = assertWalkable(navigation, knight, path, radius);
    assert.ok(hasLineOfSight(navigation, end, hero, 0), `from ${JSON.stringify(knight)} it ends out of sight at ${JSON.stringify(end)}`);
    assert.ok(Math.hypot(end.x - hero.x, end.y - hero.y) < 160, `from ${JSON.stringify(knight)} it ends at ${JSON.stringify(end)}`);
  }
});

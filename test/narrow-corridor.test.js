import assert from "node:assert/strict";
import test from "node:test";

import { aimAt, bodyBlocked, bodyRoute, bodyWalkClear } from "../src/socket/body.js";
import { loadFloor } from "../src/socket/floors.js";
import {
  addNavigationObstacle,
  createNavigationState,
  isPositionBlocked,
  loadNavigationLibrary,
} from "../src/socket/navigation.js";

/**
 * A corridor a body fits with a few units to spare is a way through.
 *
 * Played on the prison scenario floor (node 50070, 2026-10-11, build
 * 0748004): with the weapon racks at 217,671, 97,668 and 100,765 smashed, a
 * KNIGHT drawn at 1.2 (body radius 42, its middle 26.4 above its feet) stood
 * 12 s at feet 285,670 with the hero at 65,679 among the barrels, then 20 s
 * at 169,665 with the hero 450 away in the open room. Its body fits along the
 * row the racks stood in — feet y 659 to 668 are clear from x 270 to 170, a
 * 9-unit channel — but no point of a cell's anchor lattice (12 apart) fell
 * in it, so every cell along it read shut and the route ended where it
 * stood. A KNIGHT of radius 40 or less went through.
 */
const RACKS = [
  [217, 671],
  [97, 668],
  [100, 765],
];
const knight = { constant: "KNIGHT", scale: 1.2 };
const hero = { constant: "RANGER", scale: 1.176 };
const RADIUS = 42;

const prisonWithRacksSmashed = async () => {
  await loadNavigationLibrary();
  const floor = await loadFloor("scenario-test/db_floor_GAPS_CASTLE_PRISON.json");
  const navigation = createNavigationState(floor.navigation);
  for (const [index, placement] of floor.placements.npc.entries()) {
    if (!placement.navigationColliders?.length) continue;
    if (RACKS.some(([x, y]) => Math.hypot(placement.x - x, placement.y - y) < 12)) continue;
    addNavigationObstacle(navigation, `prop-${index}`, placement.navigationColliders);
  }
  return navigation;
};

test("the corridor between the barrels is there for a body of 42", async () => {
  const navigation = await prisonWithRacksSmashed();
  const clear = [];
  for (let y = 650; y <= 680; y++) if (!bodyBlocked(navigation, knight, { x: 220, y }, RADIUS)) clear.push(y);
  assert.ok(clear.length >= 5, `the body fits at x 220 at feet y ${clear.join(",")}`);
  assert.ok(clear.length <= 12, "and only just");
});

test("a knight of radius 42 routes through it to the hero, and back out to the open room", async () => {
  const navigation = await prisonWithRacksSmashed();
  for (const [from, to] of [
    [{ x: 285, y: 670 }, { x: 65, y: 679 }],
    [{ x: 169, y: 665 }, { x: 619, y: 561 }],
  ]) {
    const goal = aimAt(knight, hero, to);
    const route = bodyRoute({}, navigation, knight, from, goal, RADIUS);
    assert.ok(route.length > 0, `a route from ${from.x},${from.y}`);
    // Among the barrels the hero is not quite reached, by 13 as for a body
    // of 40 or 35; it used to end where the knight stood, 217 and 469 away.
    const end = route.at(-1);
    assert.ok(Math.hypot(end.x - to.x, end.y - to.y) <= 20, `that ends at ${to.x},${to.y}, not at ${Math.round(end.x)},${Math.round(end.y)}`);
    let at = from;
    for (const point of route) {
      assert.ok(bodyWalkClear(navigation, knight, at, point, RADIUS), `walkable from ${at.x},${at.y} to ${point.x},${point.y}`);
      at = point;
    }
  }
});

test("a cell the lattice misses opens where the body fits, and only inside the cell's reach", async () => {
  const { cellAnchorAt } = await import("../src/socket/pathfind.js");
  const navigation = await prisonWithRacksSmashed();
  // The channel in body space: feet y 659-668 less 26.4.
  const anchor = cellAnchorAt(navigation, RADIUS, 210, 637);
  assert.ok(anchor, "the cell over the channel is open");
  assert.ok(!isPositionBlocked(navigation, anchor, RADIUS + 2), "at a point the body stands clear at, two units to spare");
  const centre = { x: Math.floor(210 / 60) * 60 + 30, y: Math.floor(637 / 60) * 60 + 30 };
  assert.ok(Math.abs(anchor.x - centre.x) <= 24 && Math.abs(anchor.y - centre.y) <= 24, "within the lattice's reach");
});

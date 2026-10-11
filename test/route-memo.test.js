import assert from "node:assert/strict";
import test from "node:test";

import { buildFloor, loadFloor } from "../src/socket/floors.js";
import {
  addNavigationObstacle,
  createNavigationState,
  findPath,
  loadNavigationLibrary,
  removeNavigationObstacle,
  setNavigationTriggerState,
} from "../src/socket/navigation.js";
import { colliderSetKey, searchRoute } from "../src/socket/route-memo.js";

const rectangle = (x, y, halfWidth, halfHeight) => ({
  type: "rectangle",
  x,
  y,
  halfWidth,
  halfHeight,
  angle: 0,
});

/** A wall down the middle with two doorways, each with a gate that can shut it. */
const gatedRoom = () =>
  createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 1200, maxY: 900 },
    staticColliders: [rectangle(600, 75, 30, 75), rectangle(600, 450, 30, 150), rectangle(600, 825, 30, 75)],
    triggerColliders: new Map([
      ["north", { initialOn: false, onColliders: [rectangle(600, 225, 30, 75)], offColliders: [] }],
      ["south", { initialOn: false, onColliders: [rectangle(600, 675, 30, 75)], offColliders: [] }],
    ]),
  });

const start = { x: 150, y: 600 };
const goal = { x: 1050, y: 300 };

test("a remembered route is the route the search gives, under every gate state", () => {
  const navigation = gatedRoom();
  const owner = {};
  const routes = new Set();
  const states = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
    [false, false],
    [true, false],
    [true, true],
    [false, true],
  ];
  for (const [north, south] of states) {
    setNavigationTriggerState(navigation, "north", north);
    setNavigationTriggerState(navigation, "south", south);
    const route = searchRoute(owner, navigation, start, goal, 22);
    assert.deepEqual(route, findPath(navigation, start, goal, 22), `gates north=${north} south=${south}`);
    routes.add(JSON.stringify(route));
  }
  // Through the north doorway while it is open, else the south, else none.
  assert.equal(routes.size, 3);
  // Four collider sets, each searched once and then answered from memory.
  assert.equal(owner.routeMemo.routes.size, 4);
  setNavigationTriggerState(navigation, "north", true);
  setNavigationTriggerState(navigation, "south", true);
  assert.deepEqual(searchRoute(owner, navigation, start, goal, 22), [], "both doorways shut");
});

test("a route is remembered only for the exact start, goal, radius and navigation", () => {
  const navigation = gatedRoom();
  const owner = {};
  searchRoute(owner, navigation, start, goal, 22);
  const memo = owner.routeMemo;
  searchRoute(owner, navigation, { x: start.x + 1e-9, y: start.y }, goal, 22);
  assert.notEqual(owner.routeMemo, memo, "a moved start starts over");
  const moved = owner.routeMemo;
  searchRoute(owner, navigation, { x: start.x + 1e-9, y: start.y }, goal, 23);
  assert.notEqual(owner.routeMemo, moved, "another radius starts over");
  const other = gatedRoom();
  const wider = owner.routeMemo;
  searchRoute(owner, other, { x: start.x + 1e-9, y: start.y }, goal, 23);
  assert.notEqual(owner.routeMemo, wider, "another floor starts over");
});

test("an obstacle placed or taken away is a different collider set", () => {
  const navigation = gatedRoom();
  const before = colliderSetKey(navigation);
  addNavigationObstacle(navigation, 7, [{ type: "circle", x: 900, y: 450, radius: 40 }]);
  const placed = colliderSetKey(navigation);
  assert.notEqual(placed, before);
  // The same id with new colliders is another set again.
  addNavigationObstacle(navigation, 7, [{ type: "circle", x: 900, y: 300, radius: 40 }]);
  assert.notEqual(colliderSetKey(navigation), placed);
  removeNavigationObstacle(navigation, 7);
  assert.equal(colliderSetKey(navigation), before);

  const owner = {};
  for (const y of [450, 300, 450]) {
    addNavigationObstacle(navigation, 9, [{ type: "circle", x: 900, y, radius: 120 }]);
    assert.deepEqual(searchRoute(owner, navigation, start, goal, 22), findPath(navigation, start, goal, 22));
  }
});

test("a remembered route is handed out as a copy", () => {
  const navigation = gatedRoom();
  const owner = {};
  const first = searchRoute(owner, navigation, start, goal, 22);
  first[0].x = -1;
  first.push({ x: 0, y: 0 });
  assert.deepEqual(searchRoute(owner, navigation, start, goal, 22), findPath(navigation, start, goal, 22));
});

test("a goal carrying more than its coordinates is searched, not remembered", () => {
  const navigation = gatedRoom();
  const owner = {};
  const route = searchRoute(owner, navigation, start, { ...goal, layer: 1 }, 22);
  assert.equal(owner.routeMemo, undefined);
  assert.deepEqual(route, findPath(navigation, start, { ...goal, layer: 1 }, 22));
  const unnamed = { ...navigation, triggerGroups: undefined };
  assert.deepEqual(searchRoute(owner, unnamed, start, goal, 22), findPath(navigation, start, goal, 22));
  assert.equal(owner.routeMemo, undefined, "no collider set to name");
});

/**
 * What the memo's key rests on: the active colliders are the static ones and
 * each trigger group's current half, so one collider must not be in two
 * groups, or in a group and the static set — removing it for one would take it
 * out from under the other, and the set would depend on the order of toggles.
 */
test("no collider is shared between trigger groups or with the static geometry", async () => {
  await loadNavigationLibrary();
  const floors = [
    await loadFloor("tutorial"),
    await buildFloor("Resources/Levels/nordic/caves/tiles.json", { tier: 10, tileCount: 24, seed: 1 }),
    await buildFloor("Resources/Levels/castle/catacombs/tiles.json", { tier: 10, tileCount: 24, seed: 2 }),
  ];
  for (const floor of floors) {
    const owner = new Map();
    const claim = (collider, who) => {
      const previous = owner.get(collider);
      assert.ok(previous === undefined || previous === who, `${previous} and ${who} share a collider`);
      owner.set(collider, who);
    };
    for (const collider of floor.navigation.staticColliders) claim(collider, "static");
    for (const [id, group] of floor.navigation.triggerColliders) {
      for (const collider of [...group.onColliders, ...group.offColliders]) claim(collider, id);
    }
  }
});

test("a remembered route that ends short still says so", () => {
  // A target in a slot two boxes leave, too narrow for the body: the route ends short of it.
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    cellSize: 60,
    staticColliders: [rectangle(300, 450, 10, 250), rectangle(480, 400, 60, 30), rectangle(480, 500, 60, 30)],
  });
  const owner = {};
  const slot = { x: 480, y: 450 };
  const first = searchRoute(owner, navigation, { x: 150, y: 450 }, slot, 26);
  assert.equal(first.endsShort, true);
  const again = searchRoute(owner, navigation, { x: 150, y: 450 }, slot, 26);
  assert.equal(owner.routeMemo.routes.size, 1, "answered from the memo");
  assert.deepEqual(again, first);
  assert.equal(again.endsShort, true);
});

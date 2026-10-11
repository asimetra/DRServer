import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster, npcForConstant } from "../src/gamemaster.js";
import { activeCollidersOf } from "../src/socket/navigation-objects.js";
import {
  addNavigationObstacle,
  createNavigationState,
  isPositionBlocked,
  loadNavigationLibrary,
  navigationEntryFor,
  retireNavigationObject,
  setNavigationTriggerState,
} from "../src/socket/navigation.js";
import { colliderSetKey } from "../src/socket/route-memo.js";
import { buildFloor } from "./helpers/floor.js";

/**
 * Every object's colliders over its life, in one record (navigation.js): on,
 * switched off by its wiring, broken and kept, or gone.
 *
 * What the official does when an object with a shape is killed, over its 97
 * captures: the 158 `PermCorpse` gates and secret walls killed there were sent
 * trigger state 0 and stayed until the floor ended (never sent dead); the 6
 * barricades and 2 defence orbs killed there were sent dead and destroyed at
 * once.
 */

const box = (x, y) => ({ type: "rectangle", x, y, halfWidth: 20, halfHeight: 20, angle: 0 });
const floor = (triggerColliders = new Map()) =>
  createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    cellSize: 60,
    staticColliders: [],
    triggerColliders,
  });

test("a broken object stands as its off shapes until the floor ends", () => {
  const navigation = floor();
  addNavigationObstacle(navigation, 7, [box(100, 100)], [box(300, 300)]);
  assert.ok(isPositionBlocked(navigation, { x: 100, y: 100 }, 5), "standing, its on shape");
  assert.ok(!isPositionBlocked(navigation, { x: 300, y: 300 }, 5));
  const revision = navigation.revision;
  const key = colliderSetKey(navigation);

  assert.equal(retireNavigationObject(navigation, 7, { broken: true }), true);
  assert.ok(!isPositionBlocked(navigation, { x: 100, y: 100 }, 5), "broken, its on shape is gone");
  assert.ok(isPositionBlocked(navigation, { x: 300, y: 300 }, 5), "and its off shapes stand");
  assert.ok(navigation.revision > revision, "so the routes near it are searched again");
  assert.notEqual(colliderSetKey(navigation), key, "and no remembered route is reused");
  assert.equal(retireNavigationObject(navigation, 7, { broken: true }), false, "it breaks once");
});

test("a killed object that is not kept leaves the floor, wired or not", () => {
  const navigation = floor(new Map([["barricade", { onColliders: [box(200, 200)], offColliders: [] }]]));
  addNavigationObstacle(navigation, 9, [box(100, 100)]);
  assert.ok(isPositionBlocked(navigation, { x: 200, y: 200 }, 5), "a barricade blocks while it stands");

  assert.equal(retireNavigationObject(navigation, "barricade"), true);
  assert.equal(retireNavigationObject(navigation, 9), true);
  assert.ok(!isPositionBlocked(navigation, { x: 200, y: 200 }, 5), "a dead barricade opens its ground");
  assert.ok(!isPositionBlocked(navigation, { x: 100, y: 100 }, 5), "and so does a smashed prop");
  assert.equal(setNavigationTriggerState(navigation, "barricade", true), false, "the wiring cannot stand it up again");
  assert.ok(!isPositionBlocked(navigation, { x: 200, y: 200 }, 5));
});

test("a spike bed still blocks, and its toggles are still searched again", () => {
  const navigation = floor(new Map([["spikes", { onColliders: [box(200, 200)], offColliders: [], initialOn: false }]]));
  assert.ok(!isPositionBlocked(navigation, { x: 200, y: 200 }, 5), "down, it lets them cross");
  const revision = navigation.revision;
  const key = colliderSetKey(navigation);
  assert.equal(setNavigationTriggerState(navigation, "spikes", true), true);
  assert.ok(isPositionBlocked(navigation, { x: 200, y: 200 }, 5), "raised, they wait at it");
  assert.ok(navigation.revision > revision);
  assert.notEqual(colliderSetKey(navigation), key);
  setNavigationTriggerState(navigation, "spikes", false);
  assert.equal(colliderSetKey(navigation), key, "the same state is the same remembered set");
});

test("which objects stand broken is the GameMaster's PermCorpse, nothing else", async () => {
  await loadNavigationLibrary();
  const gm = await loadGameMaster();
  const { npcIsPermCorpse } = await import("../src/socket/npc-spawn.js");
  for (const constant of ["CASTLE_ARENA_GATE_B", "NORDIC_CAVE_WALL_SECRET_A", "NORDIC_TEMPLE_WALL_SECRET_D"]) {
    assert.equal(npcIsPermCorpse(await npcForConstant(constant)), true, constant);
  }
  // Sent dead and destroyed by the official, 2 of 2, though it carries an off shape.
  assert.ok(navigationEntryFor("HERO_DEFENSE_ORB").navCollisions_off.length);
  assert.equal(npcIsPermCorpse(await npcForConstant("HERO_DEFENSE_ORB")), false);
  for (const row of gm.raw.Npc) assert.equal(npcIsPermCorpse(row), Boolean(row.PermCorpse), row.Constant);
});

/** Kills `doid` and lets whatever its death waits on run. */
const kill = async (session, doid) => {
  const { applyDamage } = await import("../src/socket/combat.js");
  applyDamage(session, doid, 1e9);
  await new Promise((resolve) => setTimeout(resolve, 10));
};

const doidOf = (session, constant) =>
  [...session.actors].find(([, actor]) => actor.constant === constant && !actor.dead)?.[0];

test("a secret wall broken in a laid-out floor leaves its broken half and opens the rest", async (t) => {
  const world = await buildFloor("nordic/caves/tiles.json", { seed: 1 });
  t.after(() => world.session.runScope?.dispose?.());
  const { session } = world;
  const doid = doidOf(session, "NORDIC_CAVE_WALL_SECRET_A");
  assert.ok(doid, "the floor has a secret wall");
  const record = session.navigation.objects.get(doid);
  assert.equal(record.on.length, 1);
  assert.equal(record.off.length, 2, "and its broken half is on the record from the start");
  assert.ok(session.navigation.colliders.includes(record.on[0]));

  await kill(session, doid);
  assert.ok(session.actors.has(doid), "a PermCorpse wall stays on the floor");
  assert.ok(!session.navigation.colliders.includes(record.on[0]), "its standing shape is gone");
  for (const collider of record.off) assert.ok(session.navigation.colliders.includes(collider), "its broken half stands");
});

test("a barricade and a defence orb killed in the princess's defence leave nothing behind", async (t) => {
  const world = await buildFloor("nordic/village/db_floor_VILLAGE_PRINCESS_DEFENSE.json");
  t.after(() => world.session.runScope?.dispose?.());
  const { session } = world;
  for (const constant of ["HERO_BARRICADE_V", "HERO_DEFENSE_ORB"]) {
    const doid = doidOf(session, constant);
    assert.ok(doid, `the floor has a ${constant}`);
    const id = [...session.triggerableDoids].find(([, value]) => value === doid)?.[0];
    const colliders = activeCollidersOf(session.navigation.objects.get(id));
    assert.ok(colliders.length, `${constant} blocks while it stands`);

    await kill(session, doid);
    assert.ok(!session.navigation.objects.has(id), `a dead ${constant} has no record`);
    for (const collider of colliders) assert.ok(!session.navigation.colliders.includes(collider), `nor any collider`);
    assert.ok(!session.actors.has(doid), `and is taken off the floor, as the official's are`);
  }
});

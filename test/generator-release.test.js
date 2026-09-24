import assert from "node:assert/strict";
import test from "node:test";

import { generatorCadenceFor, generatorSpawn } from "../src/socket/dungeon.js";
import { loadFloor } from "../src/socket/floors.js";
import { createNavigationState, isPositionBlocked } from "../src/socket/navigation.js";

const cageNavigation = () => createNavigationState({
  bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
  triggerColliders: new Map([
    [
      "jail",
      {
        initialOn: true,
        onColliders: [
          { type: "rectangle", x: 300, y: 300, halfWidth: 30, halfHeight: 105, angle: 0 },
        ],
        offColliders: [
          { type: "rectangle", x: 300, y: 300, halfWidth: 30, halfHeight: 105, angle: 0 },
        ],
      },
    ],
  ]),
});

test("caged generator members are created at the authored origin, not pre-positioned outside", () => {
  const navigation = cageNavigation();
  const placement = { id: "cage:wave", x: 300, y: 300 };
  const session = {
    heroDoid: 10,
    playerActors: new Set([10]),
    actors: new Map([[10, {
      hitPoints: 100,
      maxHitPoints: 100,
      position: { x: 530, y: 300 },
    }]]),
    heroPosition: { x: 530, y: 300 },
    navigation,
  };
  const runtime = { placement, releasePlans: new Map() };
  const npc = { CollisionSize: 20, Scale: 1 };

  const spawns = Array.from({ length: 6 }, () => generatorSpawn(session, runtime, npc));

  for (const spawn of spawns) {
    assert.ok(spawn.release, "the enclosing cage was not recognized");
    assert.deepEqual(
      { x: spawn.position.x, y: spawn.position.y },
      { x: placement.x, y: placement.y },
      "a later wave member skipped its authored cage exit"
    );
    assert.equal(
      isPositionBlocked(navigation, spawn.position, 20, spawn.release),
      false,
      "the origin should be usable while only its enclosing cage is ignored"
    );
  }
  assert.deepEqual(spawns.map((spawn) => spawn.wave.index), [0, 1, 2, 3, 4, 5]);
});

test("generator pacing comes from each authored cage instead of one global release style", async () => {
  const tutorial = await loadFloor("tutorial");
  const boss = await loadFloor("tutorial_boss");

  assert.deepEqual(generatorCadenceFor(tutorial.placements.generator[0]), {
    intervalMs: 100,
    maxPopulation: 6,
    maxSpawns: 6,
  });
  assert.deepEqual(generatorCadenceFor(boss.placements.generator[0]), {
    intervalMs: 5000,
    maxPopulation: 1,
    maxSpawns: 10,
  });
});

test("a generator embedded in static scenery keeps the direct clear-ground fallback", () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    staticColliders: [
      { type: "rectangle", x: 300, y: 300, halfWidth: 30, halfHeight: 30, angle: 0 },
    ],
  });
  const placement = { id: "blocked:spawn", x: 300, y: 300 };
  const session = {
    heroDoid: 10,
    playerActors: new Set([10]),
    actors: new Map([[10, {
      hitPoints: 100,
      maxHitPoints: 100,
      position: { x: 530, y: 300 },
    }]]),
    heroPosition: { x: 530, y: 300 },
    navigation,
    id: "generator-test",
  };

  const spawn = generatorSpawn(
    session,
    { placement, releasePlans: new Map() },
    { CollisionSize: 20, Scale: 1 }
  );

  assert.equal(spawn.release, undefined);
  assert.notDeepEqual(spawn.position, placement, "a statically blocked origin was used anyway");
  assert.equal(isPositionBlocked(navigation, spawn.position, 20), false);
});

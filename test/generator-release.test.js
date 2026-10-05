import assert from "node:assert/strict";
import test from "node:test";

import { createPackDoor, generatorCadenceFor, generatorSpawn } from "../src/socket/dungeon.js";
import { loadFloor } from "../src/socket/floors.js";
import { createNavigationState, isPositionBlocked } from "../src/socket/navigation.js";
import { emitSignal } from "../src/socket/triggers.js";
import { buildFloor } from "./helpers/floor.js";

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

test("the Golem's toggled generators resume on a later SUMMON event", async (t) => {
  const world = await buildFloor("jungle/tribal/db_floor_LAVA_GOLEM_BOSS_final.json", {
    npcLevel: 19,
  });
  t.after(() => {
    for (const stop of world.session.generatorStops.values()) stop();
    world.session.stopAi?.();
    world.session.stopTriggers?.();
    world.session.stopTrapProjectiles?.();
  });

  const summonEvent = world.session.triggers.find(
    (trigger) => trigger.constant === "NPC_EVENT_TRIGGER" && trigger.eventName === "SUMMON"
  );
  const waves = [...world.session.generators.values()].filter(
    (runtime) => runtime.placement.spawnConstant !== "REWARD_CHEST_A"
  );
  const pulse = () => {
    emitSignal(world.session, summonEvent.id, true);
    emitSignal(world.session, summonEvent.id, false);
  };
  const settle = async (predicate) => {
    for (let attempt = 0; attempt < 20 && !predicate(); attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(predicate(), "generator state did not settle");
  };

  assert.ok(summonEvent);
  assert.equal(waves.length, 4);

  pulse(); // opening SUMMON event
  await settle(() => waves.every((runtime) => runtime.attemptedSpawns === 1));

  pulse(); // closing SUMMON event
  await settle(() => waves.every((runtime) => runtime.stopped && !runtime.spawnPromise));
  for (const runtime of waves) runtime.alive = 0; // the first wave has been beaten

  pulse(); // the next GOLEM_SUMMON opens the same generators again
  await settle(() => waves.every((runtime) => runtime.attemptedSpawns === 2));
});

test("a cave's door: a pack on the input, the next pack on the first death, five at once one pack", () => {
  /**
   * The official's Battleheim boss caves (socket-20261005-165901): ten out at
   * a tenth of a second, then ten more a tenth of a second after the first
   * death among them — nine still alive or not — and five dying together open
   * one pack. This server refilled one for one.
   */
  const door = createPackDoor({ maxPopulation: 10, maxSpawns: 25 });
  let out = 0;
  const drain = () => { while (door.open) { door.spawned(); out++; } };
  drain();
  assert.equal(out, 10, "a whole pack on the input");
  assert.equal(door.open, false, "and the door shuts behind it");
  assert.equal(door.died(), true, "the first death reopens it");
  assert.equal(door.died(), false, "a second at the same moment adds nothing");
  drain();
  assert.equal(out, 20, "the next pack is a whole one, however many still stand");
  door.died();
  drain();
  assert.equal(out, 25, "the last pack is what maxSpawns leaves");
  assert.equal(door.exhausted, true);
  assert.equal(door.died(), false, "nothing more to give");
});

test("a jail with a population of one is one out, one dead, one out, as it always was", () => {
  const door = createPackDoor({ maxPopulation: 1, maxSpawns: 3 });
  door.spawned();
  assert.equal(door.open, false);
  assert.equal(door.died(), true);
  door.spawned();
  door.died();
  door.spawned();
  assert.equal(door.exhausted, true);
});

test("a death while the pack is still coming out is absorbed", () => {
  const door = createPackDoor({ maxPopulation: 6, maxSpawns: 12 });
  door.spawned();
  door.spawned();
  assert.equal(door.died(), false, "the pack is already coming");
  for (let i = 0; i < 4; i++) door.spawned();
  assert.equal(door.open, false);
  assert.equal(door.died(), true);
});

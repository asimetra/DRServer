import assert from "node:assert/strict";
import test from "node:test";

import { createPopulationDoor, generatorBeatWait, generatorCadenceFor, generatorRefillWait, generatorSpawn } from "../src/socket/dungeon.js";
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
    periodMs: 80,
    maxPopulation: 6,
    maxSpawns: 6,
  }, "an authored tenth of a second is a tick: the six come out 80ms apart, in under half a second");
  assert.deepEqual(generatorCadenceFor(boss.placements.generator[0]), {
    periodMs: 5000,
    maxPopulation: 1,
    maxSpawns: 10,
  });
});

test("a generator's clock: under a second is a tick, a whole second or more is kept", () => {
  /**
   * Every official capture in the recorded corpus (1724 back-to-back spawns of one
   * generator's first pack): 0, 0.1, 0.2, 0.3, 0.4, 0.5 and 0.6 all come out
   * 80ms apart at the median; 1 and 2 at 1000 and 2000; the arena's lions,
   * authored 4, 4.08s apart.
   */
  for (const interval of [0, 0.1, 0.09999999999999935, 0.3, 0.5, 0.6]) {
    assert.equal(generatorCadenceFor({ spawnInterval: interval }).periodMs, 80, `${interval} is a tick`);
  }
  for (const [interval, ms] of [[1, 1000], [0.9999999999999992, 1000], [1.5, 1500], [2, 2000], [4, 4000], [5, 5000]]) {
    assert.equal(generatorCadenceFor({ spawnInterval: interval }).periodMs, ms);
  }
});

test("a refill waits for the generator's next beat, not a whole period from the death", () => {
  // Last out at 0, clock of 2000: a death at 700 is refilled at 2000; one at 2600, at 4000.
  assert.equal(generatorBeatWait(0, 700, 2000), 1300);
  assert.equal(generatorBeatWait(0, 2600, 2000), 1400);
  assert.equal(generatorBeatWait(0, 4000, 2000), 0, "on the beat");
  // A tick clock: a refill comes on the next tick, whenever the death.
  assert.ok(generatorBeatWait(0, 10_030, 80) <= 80);
  assert.equal(generatorBeatWait(0, 30, 80), 50, "never sooner than a period after the last one out");
  assert.equal(generatorBeatWait(10_000, 4_000, 2000), 2000, "a clock stepped backwards waits one period, not six seconds");
});

test("a refill comes on a beat after the tick that saw the death", () => {
  for (let death = 1000; death < 1080; death += 7) {
    const wait = generatorRefillWait(0, death, 80);
    assert.ok(wait >= 80 && wait < 160, `a death at ${death} is refilled ${wait}ms later`);
  }
  assert.equal(generatorRefillWait(0, 700, 2000), 1300, "a long clock: its next beat, a tick being well inside it");
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

test("a generator keeps up to maxPopulation standing: a whole pack on the input, then one for each death", () => {
  /**
   * Every official capture (532 generator mouths, 2681 spawns): none ever
   * stood more than its maxPopulation. The Battleheim boss's imp cave
   * (socket-20261005-165901, population 10): ten out in 0.75s; five die
   * together and five come back, not ten; four die and four come back.
   */
  const door = createPopulationDoor({ maxPopulation: 10, maxSpawns: 20 });
  let out = 0;
  const drain = () => { while (door.open) { door.spawned(); out++; } };
  drain();
  assert.equal(out, 10, "a whole pack on the input");
  assert.equal(door.open, false);
  for (let i = 0; i < 5; i++) assert.equal(door.died(), true, "each death has more to give");
  drain();
  assert.equal(out, 15, "five dead, five back");
  assert.equal(door.standing, 10);
  for (let i = 0; i < 4; i++) door.died();
  drain();
  assert.equal(out, 19, "four dead, four back");
});

test("killed one at a time, a jail of two never stands more than two, and gives its whole quota", () => {
  // The arena's knight jail: population 2, ten knights. The pack door stood six.
  const door = createPopulationDoor({ maxPopulation: 2, maxSpawns: 10 });
  let out = 0, most = 0;
  const drain = () => { while (door.open) { door.spawned(); out++; } most = Math.max(most, door.standing); };
  drain();
  while (door.standing) { door.died(); drain(); }
  assert.equal(most, 2);
  assert.equal(out, 10);
  assert.equal(door.exhausted, true);
  assert.equal(door.died(), false, "nothing more to give");
});

test("a spawn that never stood does not hold a place; a resumed wave counts who still stands", () => {
  const door = createPopulationDoor({ maxPopulation: 2, maxSpawns: 5 });
  door.spawned(false);
  assert.equal(door.open, true, "a failed spawn takes quota, not a place");
  const resumed = createPopulationDoor({ maxPopulation: 2, maxSpawns: 5, standing: 2 });
  assert.equal(resumed.open, false, "two of the last wave still out");
  resumed.died();
  assert.equal(resumed.open, true);
});

test("a cave a reset gate's pulse starts pours its pack: the pulse taking itself off does not stop it", async (t) => {
  /**
   * The Battleheim boss (socket-20261005-165901): every cave hangs off a
   * RESET_TIMER_GATE with a resetTime of 0 — one tick, about 100ms — and pours
   * ten out in 0.75s, twenty in all. Stopped on the pulse's fall, each made
   * one, or two, and stood empty. A state that goes low still stops its
   * generators: the tutorial's jails close when the minotaur dies (five
   * official runs, no brute after it).
   */
  const world = await buildFloor("nordic/village/db_floor_VILLAGE_PRINCESS_DEFENSE.json", { npcLevel: 10 });
  const { session } = world;
  t.after(() => {
    for (const stop of session.generatorStops.values()) stop();
    session.stopAi?.();
    session.stopTriggers?.();
    session.stopTrapProjectiles?.();
  });
  const cave = [...session.generators.values()].find(
    (runtime) => runtime.placement.spawnConstant === "ICE_IMP" && runtime.placement.maxPopulation === 10
  );
  const [gate] = session.signalIncoming.get(cave.placement.id);
  assert.equal(session.logicGates.get(gate)?.constant, "RESET_TIMER_GATE");

  emitSignal(session, gate, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  emitSignal(session, gate, false);
  for (let waited = 0; waited < 3000 && cave.attemptedSpawns < 10; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(cave.stopped, false, "the pulse's fall is not an order to stop");
  assert.equal(cave.attemptedSpawns, 10, "the whole population, a tick apart");
});

test("the arena's marksmen, killed one by one: two standing at most, all eight out, each refill a tick or two after its death", async (t) => {
  /**
   * The official's arena (socket-20261007-163805): its jails keep their two
   * standing, one for one; a refill's generate arrives 92 / 134 / 212ms (p10 /
   * median / p90) after the death that made room — both frames from the
   * server, so no link in it: the tick after the one that saw the death.
   */
  const world = await buildFloor("arena_gauntlet", { npcLevel: 10 });
  const { session } = world;
  t.after(() => {
    for (const stop of session.generatorStops.values()) stop();
    session.stopAi?.();
    session.stopTriggers?.();
    session.stopTrapProjectiles?.();
  });
  const jail = [...session.generators.values()].find(
    (runtime) => runtime.placement.spawnConstant === "KNIGHT_MARKSMAN" && runtime.placement.maxPopulation === 2
  );
  for (const source of session.signalIncoming.get(jail.placement.id) ?? []) emitSignal(session, source, true);

  const standing = () => [...jail.spawnedDoids].filter((doid) => session.actors.get(doid) && !session.actors.get(doid).dead);
  const births = [];
  let most = 0;
  const watch = setInterval(() => {
    most = Math.max(most, standing().length);
    while (births.length < jail.spawnedDoids.size) births.push(Date.now());
  }, 2);
  t.after(() => clearInterval(watch));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const kill = (doid) => {
    const actor = session.actors.get(doid);
    actor.dead = true;
    actor.hitPoints = 0;
    actor.onDeath?.(doid);
  };

  await sleep(400);
  const refills = [];
  for (let round = 0; round < 12 && jail.attemptedSpawns < jail.maxSpawns; round++) {
    const [first] = standing();
    if (!first) break;
    const before = births.length;
    const diedAt = Date.now();
    kill(first);
    // Off the generator's beat: a death lands anywhere between two ticks.
    await sleep(430);
    if (births.length > before) refills.push(births[before] - diedAt);
  }
  for (const doid of standing()) kill(doid);
  await sleep(200);

  t.diagnostic(`refills ${refills.join(" ")}`);
  assert.equal(most, 2, "never more than the jail's population");
  assert.equal(jail.attemptedSpawns, 8, "and its whole quota");
  assert.equal(jail.alive, 0);
  assert.equal(jail.door.standing, 0);
  assert.ok(refills.length >= 5);
  for (const ms of refills) assert.ok(ms >= 70 && ms <= 200, `a refill ${ms}ms after its death`);
});

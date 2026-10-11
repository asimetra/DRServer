import assert from "node:assert/strict";
import test from "node:test";

import { tickNpcAi } from "../src/socket/ai.js";
import { bodyBlocked, bodyRadius, seesBody } from "../src/socket/body.js";
import { canGetAt } from "../src/socket/routing.js";
import { cancelPetRespawn, spawnEquippedPet } from "../src/socket/dungeon.js";
import { readPlacements } from "../src/socket/floors.js";
import { addNavigationObstacle, createNavigationState } from "../src/socket/navigation.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";
import { contextWithPet } from "./helpers/pets.js";

/**
 * A pet's loop (npc-targeting.js `petTarget`): the leash, what it takes on,
 * how long it holds what it cannot get at, and where it rests.
 */

const WOLF = 3301;
const RHINO = 3303;
const SHADOW_WOLF = 3311;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The catacombs floor of the played capture socket-20261012-013624 (build
 * ec9ad9c), laid out as the official floor generate had it.
 */
const CATACOMBS_013624 = [
  ["60.1342726755062", 1800, 0], ["216.1333609518729", 1800, 900], ["19.1332884841110", 2700, 900],
  ["481.1332890350997", 2700, 1800], ["32.1334624915040", 1800, 1800], ["1298.1343157745966", 1800, 2700],
  ["323.1333656433507", 900, 2700], ["1775.1342827108267", 900, 1800], ["496.1343067980625", 2700, 2700],
  ["1237.1343085822450", 1800, 3600], ["127.1338326941546", 900, 900], ["203.1332888010666", 900, 3600],
  ["123.1342741222272", 0, 2700],
].map(([tileId, x, y]) => ({ tileId, x, y }));

/** Its scenery, with every prop that stands in the way standing (none was smashed there). */
const catacombs = async () => {
  const floor = await readPlacements("Resources/Levels/castle/catacombs/tiles.json", CATACOMBS_013624);
  const navigation = createNavigationState(floor.navigation);
  for (const [index, placement] of floor.placements.npc.entries()) {
    if (placement.navigationColliders?.length) addNavigationObstacle(navigation, `prop-${index}`, placement.navigationColliders);
  }
  return navigation;
};

/** A pet of row `npcId` on a floor, its owner at `owner`, itself at `at`. */
const petOnFloor = async (t, npcId, { owner, at, navigation = null }) => {
  const { session, context } = await contextWithPet(75, npcId);
  t.after(() => {
    cancelPetRespawn(session);
    for (const stop of session.hazardBeats?.values?.() ?? []) stop();
  });
  if (navigation) session.navigation = navigation;
  session.heroPosition = { ...owner };
  session.actors.get(session.heroDoid).position = { ...owner };
  const petDoid = await spawnEquippedPet(context, session);
  const pet = session.actors.get(petDoid);
  pet.position = { ...at };
  return { session, pet, petDoid };
};

/** A monster standing still where it is put: no AI of its own, so it neither walks nor swings. */
let nextEnemy = 9100;
const enemyAt = (session, position, constant = "SKELETON_WARRIOR") => {
  const doid = nextEnemy++;
  session.objects.set(doid, CLID.DistributedNPCGameObject);
  session.actors.set(doid, {
    hitPoints: 1e9,
    maxHitPoints: 1e9,
    collisionRadius: 25,
    constant,
    scale: 1,
    isEnemy: true,
    position: { ...position },
    team: TEAM.ENEMIES,
  });
  return doid;
};

const moveOwner = (session, to) => {
  session.heroPosition = { ...to };
  session.actors.get(session.heroDoid).position = { ...to };
};

/** Ticks a quarter of a second apart from `from`, answering with the time after the last. */
const ticks = async (session, from, count, each = () => {}) => {
  let now = from;
  for (let i = 0; i < count; i++) {
    await tickNpcAi(session, now, 0.25);
    each(now);
    now += 250;
  }
  return now;
};

/**
 * Played on that floor, the wolf stood 16 s at 2635,1531 facing a skeleton
 * 157 off behind the wall (2758,1629), and again at 01:38:24 and 01:38:45,
 * 37% of its time: it went for the nearest monster, which it had no way to,
 * while another stood at 2847,1209 in its reach by the corridor. The
 * official stands so 3.8% of its time.
 */
test("the wolf of 013624 passes over the skeleton behind the wall for the one it can get to", async (t) => {
  const navigation = await catacombs();
  // The owner stood at 2791,1439, in the passage the wolf goes through, which
  // a pet does not walk through its player in (npc-crowd.js); here he stands
  // aside, both monsters within TetherDist of him.
  const owner = { x: 2600, y: 1300 };
  // Where the played wolf stood, out of the scenery as ours reckons it.
  const at = { x: 2610, y: 1436 };
  const { session, pet } = await petOnFloor(t, WOLF, { owner, at, navigation });
  assert.equal(bodyBlocked(navigation, pet, at, bodyRadius(pet)), false, "the wolf stands clear");
  const walled = enemyAt(session, { x: 2758, y: 1629 });
  const reachable = enemyAt(session, { x: 2847, y: 1209 });
  const walledActor = session.actors.get(walled);
  assert.ok(distance(at, walledActor.position) < distance(at, session.actors.get(reachable).position), "the walled one is the nearer");
  assert.equal(seesBody(navigation, pet, at, walledActor, walledActor.position), false, "and behind the wall");

  const targets = new Set();
  await ticks(session, 1000, 12, () => targets.add(pet.ai.targetDoid));
  assert.ok(!targets.has(walled), "it never goes for the walled one");
  assert.ok(targets.has(reachable), "it goes for the one it can get to");
  assert.ok(distance(pet.position, session.actors.get(reachable).position) < 150, `and gets there: ${Math.round(pet.position.x)},${Math.round(pet.position.y)}`);
  assert.equal(pet.ai.state, "attack");
});

test("a monster behind a wall is passed over while one in sight is in range, though it is the nearer", async (t) => {
  const navigation = await catacombs();
  const at = { x: 2610, y: 1436 };
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 2700, y: 1440 }, at, navigation });
  const walled = enemyAt(session, { x: 2758, y: 1629 });
  const inSight = enemyAt(session, { x: 2870, y: 1440 });
  const seen = session.actors.get(inSight);
  assert.ok(seesBody(navigation, pet, at, seen, seen.position), "the far one is in sight");
  assert.ok(distance(at, seen.position) > distance(at, session.actors.get(walled).position));
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(pet.ai.targetDoid, inSight);
});

/**
 * A way to it that leaves the tether is no way: the leash would turn the
 * pet back before it got there, and it would set out again at its next pick.
 */
test("a monster the pet can only get to by leaving its owner's tether is one it cannot get at", async (t) => {
  const navigation = await catacombs();
  const at = { x: 2610, y: 1436 };
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 2600, y: 1300 }, at, navigation });
  const doid = enemyAt(session, { x: 2847, y: 1209 });
  const candidate = { doid, actor: session.actors.get(doid), position: session.actors.get(doid).position };
  assert.equal(seesBody(navigation, pet, at, candidate.actor, candidate.position), false, "not in sight from here");
  assert.equal(canGetAt(navigation, pet, candidate, 130), true, "a route goes round to it");
  // That route runs by the corridor south of y 1300 before it comes up to it.
  assert.equal(canGetAt(navigation, pet, candidate, 130, (point) => point.y < 1300), false);
});

/**
 * A teleporter comes back beside its victim (behaviours/teleport.js), so
 * a wall is no bar to it: the same loop takes the nearer monster.
 */
test("the shadow wolf, which comes back beside its victim, takes the walled one", async (t) => {
  const navigation = await catacombs();
  const at = { x: 2610, y: 1436 };
  const { session, pet } = await petOnFloor(t, SHADOW_WOLF, { owner: { x: 2700, y: 1440 }, at, navigation });
  const walled = enemyAt(session, { x: 2758, y: 1629 });
  enemyAt(session, { x: 2870, y: 1440 });
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(pet.ai.targetDoid, walled);
});

/**
 * Lost to a wall, a target is held until ChangeTargetT (2 s for the wolf) is
 * up, then let go and passed over until the wolf looks again; one it can get
 * to again is taken then.
 */
test("a target the wolf can no longer get to is let go at its next look, and taken again once it can", async (t) => {
  const navigation = await catacombs();
  const at = { x: 2610, y: 1436 };
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 2700, y: 1440 }, at, navigation });
  const skeleton = enemyAt(session, { x: 2870, y: 1440 });
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(pet.ai.targetDoid, skeleton, "taken in sight");
  const lockedUntil = pet.ai.nextTargetAt;
  assert.equal(lockedUntil, 3000, "for ChangeTargetT");

  // Behind the wall, out of the wolf's way: still its target until it looks again.
  session.actors.get(skeleton).position = { x: 2758, y: 1629 };
  pet.position = { ...at };
  let now = await ticks(session, 1250, 6);
  assert.equal(now, 2750);
  assert.equal(pet.ai.targetDoid, skeleton, "held while the pick holds");
  now = await ticks(session, now, 2);
  assert.equal(pet.ai.targetDoid, null, "let go once it is up");
  assert.ok(pet.ai.passedOver.has(skeleton), "and passed over");

  // Back where the wolf can get to it: not before the wolf looks again.
  session.actors.get(skeleton).position = { x: 2870, y: 1440 };
  await tickNpcAi(session, now, 0.25);
  assert.equal(pet.ai.targetDoid, null, "passed over until the next look");
  now = await ticks(session, now + 250, 8);
  assert.equal(pet.ai.targetDoid, skeleton, "taken again at it");
});

/**
 * The leash: farther than TetherDist (500) from its owner it drops what it
 * fights at once — the official turns back p50 0.5 s after crossing it,
 * whatever TetherTimer (1 s) says — walks back, and takes nothing on until
 * it is at ReturnDist (100) again.
 */
test("past its TetherDist the wolf drops its target at once and takes nothing on until it is back", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 1000, y: 1000 }, at: { x: 1000, y: 900 } });
  const first = enemyAt(session, { x: 1300, y: 900 });
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(pet.ai.targetDoid, first);

  // The owner runs off: the wolf is 610 from him.
  moveOwner(session, { x: 400, y: 1000 });
  pet.position = { x: 1000, y: 900 };
  const second = enemyAt(session, { x: 760, y: 980 });
  await tickNpcAi(session, 1250, 0.25);
  assert.equal(pet.ai.targetDoid, null, "the target dropped the same tick");
  assert.equal(pet.ai.state, "return");
  const states = [];
  const ownerDistances = [];
  await ticks(session, 1500, 6, () => {
    states.push(pet.ai.state);
    ownerDistances.push(distance(pet.position, session.heroPosition));
  });
  const back = ownerDistances.findIndex((d) => d <= 100 + 1e-6);
  assert.ok(back > 0, `back at its owner: ${ownerDistances.map(Math.round).join(" ")}`);
  assert.ok(states.slice(0, back).every((state) => state === "return"), `walking back the whole way: ${states.join(" ")}`);
  assert.ok(distance(pet.position, session.actors.get(second).position) > 0);
  // Back, the one within its owner's tether is taken.
  await ticks(session, 3000, 2);
  assert.equal(pet.ai.targetDoid, second, "and after that the near one");
});

test("the wolf leaves alone a monster farther than TetherDist from its owner", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 1000, y: 1000 }, at: { x: 1300, y: 1000 } });
  // 300 from the wolf, within its AggroRadius (600); 600 from its owner.
  enemyAt(session, { x: 1600, y: 1000 });
  await ticks(session, 1000, 4);
  assert.equal(pet.ai.targetDoid, null);
  assert.notEqual(pet.ai.state, "attack");
});

/**
 * With nothing to fight it walks to its owner and stands at ReturnDist,
 * where the walk ends; it does not appear at his side.
 */
test("idle, a pet walks to its owner and rests at its ReturnDist", async (t) => {
  for (const [npcId, returnDistance, speed] of [[WOLF, 100, 700], [RHINO, 150, 200]]) {
    const { session, pet } = await petOnFloor(t, npcId, { owner: { x: 1000, y: 1000 }, at: { x: 1000, y: 1600 } });
    let last = { ...pet.position };
    await ticks(session, 1000, 16, () => {
      assert.ok(distance(pet.position, last) <= speed * 0.25 + 1e-6, "no step longer than its walk");
      last = { ...pet.position };
    });
    assert.ok(Math.abs(distance(pet.position, session.heroPosition) - returnDistance) < 1, `npc ${npcId} rests at ${returnDistance}: ${distance(pet.position, session.heroPosition)}`);
    assert.equal(pet.ai.state, "idle");
  }
});

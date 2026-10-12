import assert from "node:assert/strict";
import test from "node:test";

import { tickNpcAi } from "../src/socket/ai.js";
import { bodyBlocked, bodyPointOf, bodyRadius, contact, seesBody } from "../src/socket/body.js";
import { inBand } from "../src/socket/npc-act.js";
import { clearNpcTarget } from "../src/socket/npc-targeting.js";
import { canGetAt } from "../src/socket/routing.js";
import { cancelPetRespawn, spawnEquippedPet } from "../src/socket/dungeon.js";
import { readPlacements } from "../src/socket/floors.js";
import { addNavigationObstacle, createNavigationState, removeNavigationObstacle } from "../src/socket/navigation.js";
import { createMatchWorld } from "../src/socket/match-world.js";
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

/**
 * A player's body holds no walk on the players' side (actor-roles.js
 * `friendly`). Played on the replay floor of socket-20261012-101941, the
 * wolf stood 8 s 55 from its owner with him between it and the skeleton
 * hitting them both; ours sat so the whole fight, its walk cut to nothing
 * at his body. Here the skeleton is beyond the bite from where the wolf
 * stands, and the way to it is through him.
 */
const walksThroughToBite = async (session, pet, skeleton) => {
  const from = distance(pet.position, session.actors.get(skeleton).position);
  const bodies = contact(pet, session.actors.get(skeleton));
  assert.ok(!pet.ai.attacks.some((attack) => inBand(attack, from, bodies, 0, true)), "nothing of its reaches from where it stands");
  let nearest = Infinity;
  await ticks(session, 1000, 12, () => {
    nearest = Math.min(nearest, distance(pet.position, session.actors.get(skeleton).position));
  });
  assert.equal(pet.ai.targetDoid, skeleton);
  assert.ok(nearest < 80, `at the skeleton: nearest ${Math.round(nearest)}`);
  assert.ok(pet.ai.nextAttackAt > 1000, "and bites it");
  assert.equal(pet.ai.state, "attack");
};

test("a wolf with its owner between it and its target walks through him and bites", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 1000, y: 1000 }, at: { x: 1000, y: 940 } });
  const skeleton = enemyAt(session, { x: 1000, y: 1140 });
  await walksThroughToBite(session, pet, skeleton);
});

test("a wolf walks through another player in its way as through its owner", async (t) => {
  const { session: host, pet } = await petOnFloor(t, WOLF, { owner: { x: 700, y: 1000 }, at: { x: 1000, y: 940 } });
  const skeleton = enemyAt(host, { x: 1000, y: 1140 });
  host.socket = { destroyed: false };
  const joiner = {
    accountId: 9002,
    heroDoid: 7002,
    heroPosition: { x: 1000, y: 1000 },
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid: host.allocateDoid,
  };
  const world = createMatchWorld({ members: new Set([host, joiner]) }, host);
  world.contextFor(joiner);
  world.objects.set(joiner.heroDoid, CLID.HeroGameObject);
  world.actors.set(joiner.heroDoid, {
    hitPoints: 500,
    maxHitPoints: 500,
    collisionRadius: 26,
    position: joiner.heroPosition,
    team: TEAM.PLAYERS,
  });
  await walksThroughToBite(world.contextFor(host), pet, skeleton);
});


/** The positions sent for `doid` since `from`, as the wire has them. */
const sentPositions = (session, doid, from = 0) =>
  session.sent.slice(from).filter(
    (frame) => frame.length >= 18 && frame.readUInt16LE(2) === 124 && frame.readUInt32LE(4) === doid && frame.readUInt16LE(8) === 132
  ).map((frame) => ({ x: frame.readFloatLE(10), y: frame.readFloatLE(14) }));

/**
 * Official pets out past 2000 from their owner are put back beside him in
 * one position update: 14 times in the solo captures, from 1996-2205 to
 * 55-225 (wolf 92, ReturnDist 100). Ours trailed behind, out to 5008.
 */
test("a pet beyond the snap-back distance lands beside its owner, its target dropped", async (t) => {
  for (const [npcId, returnDistance] of [[WOLF, 100], [RHINO, 150]]) {
    const { session, pet, petDoid } = await petOnFloor(t, npcId, { owner: { x: 1000, y: 1000 }, at: { x: 3010, y: 1000 } });
    pet.ai.targetDoid = enemyAt(session, { x: 3100, y: 1000 });
    const before = session.sent.length;
    await tickNpcAi(session, 1000, 0.25);
    assert.ok(Math.abs(distance(pet.position, session.heroPosition) - returnDistance) < 1, `npc ${npcId} at its ReturnDist: ${Math.round(pet.position.x)},${Math.round(pet.position.y)}`);
    assert.ok(pet.position.x > 1000, "on the side it came from");
    assert.deepEqual(sentPositions(session, petDoid, before).map(({ x, y }) => [Math.round(x), Math.round(y)]), [[Math.round(pet.position.x), Math.round(pet.position.y)]]);
    assert.equal(pet.ai.targetDoid, null);
  }
});

test("a pet short of the snap-back distance walks back", async (t) => {
  const { session, pet } = await petOnFloor(t, RHINO, { owner: { x: 1000, y: 1000 }, at: { x: 2990, y: 1000 } });
  await tickNpcAi(session, 1000, 0.25);
  assert.ok(Math.abs(pet.position.x - (2990 - 200 * 0.25)) < 1, `a step: ${pet.position.x}`);
});

/**
 * The players' side passes through itself (npc-move.js `bodyRule`): a
 * pet's walk is not held by another player's pet or by
 * an ally standing in its way, as it is not by a player.
 */
const neverHeldOnTheWay = async (session, pet, skeleton) => {
  // A wait drawn would not run out within the test (`waitFor`, ai.js).
  session.random = () => 0.999999;
  let drew = false;
  let nearest = Infinity;
  await ticks(session, 1000, 12, () => {
    drew ||= pet.ai.waitEndsAt != null;
    nearest = Math.min(nearest, distance(pet.position, session.actors.get(skeleton).position));
  });
  assert.equal(drew, false, "no wait drawn");
  assert.ok(nearest < 80, `at the skeleton: nearest ${Math.round(nearest)}`);
  assert.ok(pet.ai.nextAttackAt > 1000, "and bites it");
};

test("two pets of different owners walk through each other", async (t) => {
  const { session: host, pet } = await petOnFloor(t, WOLF, { owner: { x: 700, y: 1000 }, at: { x: 1000, y: 940 } });
  const skeleton = enemyAt(host, { x: 1000, y: 1140 });
  host.socket = { destroyed: false };
  const joiner = {
    accountId: 9002,
    heroDoid: 7002,
    heroPosition: { x: 1100, y: 1010 },
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid: host.allocateDoid,
  };
  // The joiner's wolf, resting by him across the first wolf's way: it takes
  // nothing on (no AggroRadius), so it stands there.
  const otherDoid = 8900;
  const other = {
    ...pet,
    position: { x: 1015, y: 1010 },
    ai: { ...pet.ai, ownerDoid: joiner.heroDoid, aggroRadius: 0, targetDoid: null },
  };
  host.objects.set(otherDoid, CLID.DistributedNPCGameObject);
  host.actors.set(otherDoid, other);
  const world = createMatchWorld({ members: new Set([host, joiner]) }, host);
  world.contextFor(joiner);
  world.objects.set(joiner.heroDoid, CLID.HeroGameObject);
  world.actors.set(joiner.heroDoid, {
    hitPoints: 500,
    maxHitPoints: 500,
    collisionRadius: 26,
    position: joiner.heroPosition,
    team: TEAM.PLAYERS,
  });
  const context = world.contextFor(host);
  await neverHeldOnTheWay(context, pet, skeleton);
});

test("a pet walks through an ally standing in its way", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 700, y: 1000 }, at: { x: 1000, y: 940 } });
  const skeleton = enemyAt(session, { x: 1000, y: 1140 });
  const ally = 8901;
  session.objects.set(ally, CLID.DistributedNPCGameObject);
  session.actors.set(ally, {
    hitPoints: 500, maxHitPoints: 500, collisionRadius: 22, team: TEAM.PLAYERS, isAlly: true,
    position: { x: 1010, y: 1015 }, heading: 0,
    // Takes nothing on: it stands.
    ai: { kind: "ally", state: "idle", engaged: false, aggroRadius: 0, disengageDistance: 1600, moveSpeed: 230, attackRange: 80, attackTimerMs: 1000, attackRandMs: 0, nextAttackAt: 0 },
  });
  await neverHeldOnTheWay(session, pet, skeleton);
});

/**
 * A wait is a queue, and a pet is not in one behind a monster: of the
 * official wolf's quarter seconds walking back past TetherDist with a
 * monster touching it in its way, it stood the next second on 10.6% (n 189),
 * as on 12.1% with nothing touching it.
 */
test("a pet held by a monster in its way goes round it at once", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 700, y: 1000 }, at: { x: 1000, y: 940 } });
  const skeleton = enemyAt(session, { x: 1000, y: 1240 });
  // A monster that is not to be fought, standing in the way.
  const wall = 8902;
  session.objects.set(wall, CLID.DistributedNPCGameObject);
  session.actors.set(wall, {
    hitPoints: 500, maxHitPoints: 500, collisionRadius: 35, team: TEAM.ENEMIES, isEnemy: true, attackable: false,
    position: { x: 1005, y: 1050 }, heading: 0,
    ai: { state: "idle", engaged: false, aggroRadius: 0, disengageDistance: 1600, moveSpeed: 0, attackRange: 80, attackTimerMs: 1000, attackRandMs: 0, nextAttackAt: Infinity },
  });
  session.random = () => 0.999999;
  let drew = false;
  let nearest = Infinity;
  await ticks(session, 1000, 12, () => {
    drew ||= pet.ai.waitEndsAt != null;
    nearest = Math.min(nearest, distance(pet.position, session.actors.get(skeleton).position));
  });
  assert.equal(drew, false, "no wait drawn");
  assert.ok(nearest < 80, `round it to the skeleton: nearest ${Math.round(nearest)}`);
});

/**
 * Going round a body is done at the body, not a step ahead of it. Turned to
 * the side while still a step off, a walk back to its owner stood off again
 * the next tick and came back the one after: the harness's dragon so turned
 * back on itself 616 times in one run (pet-dragon seed 3 walker), where the
 * official, held back so, turns 0.11-0.24 times a second.
 */
test("a pet walks up to a monster in its way before it goes round it, and does not turn back", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 700, y: 1100 }, at: { x: 1000, y: 900 } });
  const skeleton = enemyAt(session, { x: 1000, y: 1340 });
  const blocker = 8903;
  session.objects.set(blocker, CLID.DistributedNPCGameObject);
  session.actors.set(blocker, {
    hitPoints: 500, maxHitPoints: 500, collisionRadius: 35, team: TEAM.ENEMIES, isEnemy: true, attackable: false,
    position: { x: 1000, y: 1080 }, heading: 0,
    ai: { state: "idle", engaged: false, aggroRadius: 0, disengageDistance: 1600, moveSpeed: 0, attackRange: 80, attackTimerMs: 1000, attackRandMs: 0, nextAttackAt: Infinity },
  });
  const trail = [{ ...pet.position }];
  await ticks(session, 1000, 12, () => trail.push({ ...pet.position }));
  assert.ok(Math.abs(trail[1].x - 1000) < 1, `first a straight step at it: ${Math.round(trail[1].x)},${Math.round(trail[1].y)}`);
  let turns = 0;
  for (let i = 2; i < trail.length; i++) {
    const a = { x: trail[i - 1].x - trail[i - 2].x, y: trail[i - 1].y - trail[i - 2].y };
    const b = { x: trail[i].x - trail[i - 1].x, y: trail[i].y - trail[i - 1].y };
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la >= 10 && lb >= 10 && (a.x * b.x + a.y * b.y) / (la * lb) < -0.5) turns++;
  }
  assert.equal(turns, 0, `never back on itself: ${trail.map(({ x, y }) => `${Math.round(x)},${Math.round(y)}`).join(" ")}`);
  assert.ok(distance(pet.position, session.actors.get(skeleton).position) < 80, "and gets to the skeleton");
});

/**
 * Walking back to its owner with no way on, a pet clears its way: it takes
 * the monster touching it in its way as its target, and goes back to its
 * owner the moment a step to him is open again (npc-targeting.js
 * `petTarget`, behaviours/pet.js `pinnedBy`).
 */
/** A skeleton that stands where it is put and fights nobody, its body at `body`. */
const standingMonster = (body) => {
  const monster = {
    hitPoints: 1e6, maxHitPoints: 1e6, collisionRadius: 35, team: TEAM.ENEMIES, isEnemy: true, heading: 0,
    constant: "SKELETON_WARRIOR", scale: 1, position: { x: 0, y: 0 },
    ai: { state: "idle", engaged: false, aggroRadius: 0, disengageDistance: 1600, moveSpeed: 0, attackRange: 80, attackTimerMs: 1000, attackRandMs: 0, nextAttackAt: Infinity },
  };
  const offset = bodyPointOf(monster, { x: 0, y: 0 });
  monster.position = { x: body.x - offset.x, y: body.y - offset.y };
  return monster;
};

const pinnedWolf = async (t, { angles = [180, 130, 230], navigation = null, owner = { x: 0, y: 1000 }, at = { x: 700, y: 1000 } } = {}) => {
  const { session, pet, petDoid } = await petOnFloor(t, WOLF, { owner, at, navigation });
  const from = bodyPointOf(pet, pet.position);
  const doids = angles.map((angle, index) => {
    const doid = 9300 + index;
    const radians = (angle * Math.PI) / 180;
    session.objects.set(doid, CLID.DistributedNPCGameObject);
    session.actors.set(doid, standingMonster({ x: from.x + Math.cos(radians) * 64.5, y: from.y + Math.sin(radians) * 64.5 }));
    return doid;
  });
  return { session, pet, petDoid, doids };
};
const bitesBy = (session, petDoid, from) =>
  session.sent.slice(from).filter((frame) => frame.length >= 10 && frame.readUInt16LE(2) === 124 && frame.readUInt32LE(4) === petDoid && frame.readUInt16LE(8) === 143).length;

test("a leashed wolf boxed in by monsters fights the one in its way, and walks on once a way opens", async (t) => {
  const { session, pet, petDoid, doids: [ahead, above] } = await pinnedWolf(t);
  let now = await ticks(session, 1000, 3);
  assert.equal(pet.ai.targetDoid, ahead, "the one in its way");
  const before = session.sent.length;
  now = await ticks(session, now, 12);
  assert.ok(bitesBy(session, petDoid, before) >= 2, "it keeps biting it");
  assert.equal(pet.ai.targetDoid, ahead, "and keeps at it past its pick, still pinned");
  // The one above it falls: a way round the one ahead is open.
  session.actors.get(above).dead = true;
  session.actors.get(above).hitPoints = 0;
  const at = { ...pet.position };
  now = await ticks(session, now, 10);
  assert.equal(pet.ai.targetDoid, null, "it leaves the one ahead, alive, within a pick");
  assert.ok(pet.position.x < at.x - 50, `and walks on: ${Math.round(pet.position.x)}`);
});

test("a wolf clearing its way walks on when the one in its way falls, and takes nothing past its tether", async (t) => {
  // Above and below it, just wide enough apart to let it through once the one ahead is gone.
  const { session, pet, doids: [ahead, above, below] } = await pinnedWolf(t, { angles: [180, 90, 270] });
  const now = await ticks(session, 1000, 3);
  assert.equal(pet.ai.targetDoid, ahead);
  session.actors.get(ahead).dead = true;
  session.actors.get(ahead).hitPoints = 0;
  const targets = new Set();
  const at = { ...pet.position };
  await ticks(session, now, 8, () => targets.add(pet.ai.targetDoid));
  assert.ok(!targets.has(above) && !targets.has(below), "nothing past its tether taken");
  assert.ok(pet.position.x < at.x - 100, `it walks on: ${Math.round(pet.position.x)}`);
});

/** A wall from top to bottom at x 400, and no way round it. */
const walled = () =>
  createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
    cellSize: 30,
    staticColliders: [{ type: "rectangle", x: 400, y: 1000, halfWidth: 5, halfHeight: 1000, angle: 0 }],
  });

/** A leashed wolf stood at the wall, and a monster touching it in its way. */
const wolfAtTheWall = async (t) => {
  const { session, pet, petDoid } = await petOnFloor(t, WOLF, { owner: { x: 100, y: 1000 }, at: { x: 700, y: 1000 }, navigation: walled() });
  const now = await ticks(session, 1000, 6);
  assert.ok(pet.position.x < 460 && pet.position.x > 400, `at the wall: ${Math.round(pet.position.x)}`);
  assert.equal(pet.ai.state, "return");
  const from = bodyPointOf(pet, pet.position);
  const monster = 9400;
  session.objects.set(monster, CLID.DistributedNPCGameObject);
  session.actors.set(monster, standingMonster({ x: from.x - 27, y: from.y - 58.5 }));
  return { session, pet, petDoid, monster, now };
};

test("a leashed wolf at a wall with no way to its owner fights the monster on it, and then stands", async (t) => {
  const { session, pet, monster, now: start } = await wolfAtTheWall(t);
  let now = await ticks(session, start, 3);
  assert.equal(pet.ai.targetDoid, monster, "the monster on it, in its way");
  session.actors.delete(monster);
  now = await ticks(session, now, 3);
  const at = { ...pet.position };
  await ticks(session, now, 10);
  assert.equal(pet.ai.targetDoid, null);
  assert.ok(distance(pet.position, at) < 1, `it stands at the wall: ${Math.round(pet.position.x)},${Math.round(pet.position.y)}`);
});

test("a wolf clearing its way keeps at the monster when it steps back", async (t) => {
  const { session, pet, petDoid, monster, now: start } = await wolfAtTheWall(t);
  let now = await ticks(session, start, 3);
  assert.equal(pet.ai.targetDoid, monster);
  session.actors.get(monster).position.y -= 20;
  // Its bite due, whatever its timer rolled: it is swung if it is still at it.
  pet.ai.nextAttackAt = 0;
  for (const attack of pet.ai.attacks) attack.readyAt = 0;
  const before = session.sent.length;
  // Short of its next pick, when it tries its way back again.
  now = await ticks(session, now, 5);
  assert.equal(pet.ai.targetDoid, monster, "still its target");
  assert.ok(bitesBy(session, petDoid, before) >= 1, "and bitten");
});

/**
 * The way a clearing pet tries again opens with the scenery too, not only on
 * its pick: a raised spike row dropping is a navigation change, and the
 * wolf (ChangeTargetT 2 s, no roll) would otherwise try only every 2 s, in
 * step with a spike cycle of about as long, and could miss every opening.
 */
test("a wolf clearing its way at raised spikes crosses when they drop, on that tick, and not into them while they stand", async (t) => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
    cellSize: 30,
    staticColliders: [
      { type: "rectangle", x: 400, y: 450, halfWidth: 5, halfHeight: 450, angle: 0 },
      { type: "rectangle", x: 400, y: 1550, halfWidth: 5, halfHeight: 450, angle: 0 },
    ],
  });
  const spikes = [{ type: "rectangle", x: 400, y: 1000, halfWidth: 20, halfHeight: 100, angle: 0 }];
  addNavigationObstacle(navigation, "spikes", spikes);
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 100, y: 1000 }, at: { x: 700, y: 1000 }, navigation });
  let now = await ticks(session, 1000, 6);
  assert.ok(pet.position.x > 420 && pet.position.x < 480, `at the spikes: ${Math.round(pet.position.x)}`);
  const from = bodyPointOf(pet, pet.position);
  const monster = 9500;
  session.objects.set(monster, CLID.DistributedNPCGameObject);
  session.actors.set(monster, standingMonster({ x: from.x - 27, y: from.y - 58.5 }));
  now = await ticks(session, now, 2);
  assert.equal(pet.ai.targetDoid, monster, "clearing its way");

  // Something else on the floor changes: it tries again, finds the spikes still up, and is back at it.
  addNavigationObstacle(navigation, "elsewhere", [{ type: "rectangle", x: 1800, y: 1800, halfWidth: 10, halfHeight: 10, angle: 0 }]);
  now = await ticks(session, now, 3);
  assert.equal(pet.ai.targetDoid, monster, "back at it");
  assert.ok(pet.position.x > 420, `not into the spikes: ${Math.round(pet.position.x)}`);

  // The spikes drop, well inside its pick: it goes the tick it sees it.
  removeNavigationObstacle(navigation, "spikes");
  now = await ticks(session, now, 1);
  assert.equal(pet.ai.targetDoid, null, "the monster left at once");
  let westmost = Infinity;
  // Back at its owner it may well go for the monster again, by the open way.
  await ticks(session, now, 3, () => { westmost = Math.min(westmost, pet.position.x); });
  assert.ok(westmost < 300, `across: ${Math.round(westmost)}`);
});

/**
 * Letting go is complete (npc-targeting.js `clearNpcTarget`): nothing of the
 * target outlives it — the monster that pinned a pet and the ones it passed
 * over, and a wait in a queue, whose old draw would otherwise end the next
 * wait at once.
 */
test("letting go of a target forgets the pin, the passed-over and the wait", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 1000, y: 1000 }, at: { x: 1000, y: 900 } });
  Object.assign(pet.ai, { pinnedBy: 9150, pinnedRevision: 3, passedOver: new Set([9151]), waitEndsAt: 1234, passingUntil: 5678, targetDoid: 9150 });
  clearNpcTarget(pet);
  assert.equal(pet.ai.pinnedBy ?? null, null);
  assert.equal(pet.ai.passedOver ?? null, null);
  assert.equal(pet.ai.waitEndsAt ?? null, null);
  assert.equal(pet.ai.passingUntil ?? null, null);
  assert.equal(pet.ai.targetDoid, null);
  // Its owner gone and back: the old blocker is not taken up again.
  const blocker = enemyAt(session, { x: 2500, y: 1000 });
  pet.ai.pinnedBy = blocker;
  session.actors.get(session.heroDoid).dead = true;
  await tickNpcAi(session, 1000, 0.25);
  session.actors.get(session.heroDoid).dead = false;
  await tickNpcAi(session, 1250, 0.25);
  assert.notEqual(pet.ai.targetDoid, blocker, "the old blocker 1500 off is not locked on");
});

/**
 * A pet takes on what it can fight from inside its tether, not only what
 * stands inside it (behaviours/pet.js `petPick`, routing.js `canGetAt`):
 * archers park at their keep distance of 300 from the owner, on the
 * dragon's TetherDist of 300 exactly, and the dragon sat by its owner while
 * he was shot. The official dragon swung at targets past its tether 31% of
 * the time (n 13).
 */
const DRAGON = 3302;
test("a dragon takes an archer it can shoot from inside its tether, though the archer stands outside it", async (t) => {
  const { session, pet } = await petOnFloor(t, DRAGON, { owner: { x: 1000, y: 1000 }, at: { x: 1000, y: 1060 } });
  const archer = enemyAt(session, { x: 1340, y: 1000 });
  await ticks(session, 1000, 2);
  assert.equal(pet.ai.targetDoid, archer);
});

test("a wolf still leaves alone a monster it could only bite from outside its tether", async (t) => {
  const { session, pet } = await petOnFloor(t, WOLF, { owner: { x: 1000, y: 1000 }, at: { x: 1300, y: 1000 } });
  // 300 from the wolf, 600 from its owner: the bite is from 546, past TetherDist 500.
  enemyAt(session, { x: 1600, y: 1000 });
  await ticks(session, 1000, 4);
  assert.equal(pet.ai.targetDoid, null);
});

/**
 * A pet keeps no standoff from the players beyond their bodies: the crowd's
 * push lifts friendly bodies out of each other at contact, as any overlap,
 * and no more. The dragon's keep distance of 200 used to shove it off every
 * player it passed (player-eye #9).
 */
test("a dragon walking past another player is not shoved off him", async (t) => {
  const { session: host, pet } = await petOnFloor(t, DRAGON, { owner: { x: 0, y: 1000 }, at: { x: 700, y: 1000 } });
  host.socket = { destroyed: false };
  const joiner = {
    accountId: 9002, heroDoid: 7002, heroPosition: { x: 400, y: 1120 }, objects: new Map(), actors: new Map(),
    doobers: new Map(), socket: { destroyed: false }, send: () => {}, allocateDoid: host.allocateDoid,
  };
  const world = createMatchWorld({ members: new Set([host, joiner]) }, host);
  world.contextFor(joiner);
  world.objects.set(joiner.heroDoid, CLID.HeroGameObject);
  world.actors.set(joiner.heroDoid, { hitPoints: 500, maxHitPoints: 500, collisionRadius: 26, position: joiner.heroPosition, team: TEAM.PLAYERS });
  let drift = 0;
  await ticks(world.contextFor(host), 1000, 8, () => { drift = Math.max(drift, Math.abs(pet.position.y - 1000)); });
  assert.ok(drift < 1, `shoved ${drift.toFixed(1)} off its way`);
});

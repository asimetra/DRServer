import assert from "node:assert/strict";
import test from "node:test";

import { tickNpcAi } from "../src/socket/ai.js";
import {
  createNavigationState,
  findPath,
  hasLineOfSight,
  isPositionBlocked,
  setNavigationTriggerState,
} from "../src/socket/navigation.js";
import { CLID } from "../src/socket/opcodes.js";

/**
 * A monster with no route to the hero.
 *
 * The official does not plan to the nearest reachable point: across 110
 * engaged episodes with no route (96 captures) it walks straight at the hero,
 * slides along what it hits and stands where the straight line is blocked,
 * shooting from there if it can. Ours stood where the search failed. These
 * are the things that walk has to get right: it goes at BaseMove and stops at
 * the wall without grinding, a ranged one still shoots through a gap its body
 * does not fit, a gate opening gives it a real route, a kiter keeps its
 * distance, and a route that ends short of the hero ends where he is in
 * sight, if anywhere the body can get to has him in sight.
 */

const rectangle = (x, y, halfWidth, halfHeight) => ({
  type: "rectangle",
  x,
  y,
  halfWidth,
  halfHeight,
  angle: 0,
});

const HERO = 10;
const MONSTER = 20;
const RADIUS = 20;
const TICK = 0.25;

const makeSession = ({ navigation, hero, monster, ai = {} }) => {
  const sent = [];
  const session = {
    id: 7,
    heroDoid: HERO,
    heroPosition: { ...hero },
    navigation,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [MONSTER, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [HERO, { hitPoints: 200, maxHitPoints: 200, position: { ...hero } }],
      [
        MONSTER,
        {
          hitPoints: 15,
          maxHitPoints: 15,
          position: { ...monster },
          heading: 0,
          isEnemy: true,
          ai: {
            state: "idle",
            engaged: true,
            aggroRadius: 2000,
            disengageDistance: 4000,
            moveSpeed: 180,
            collisionRadius: RADIUS,
            attackRange: 80,
            attackTimerMs: 1500,
            attackRandMs: 0,
            nextAttackAt: 0,
            attackType: 920050,
            damage: 1,
            attackColliders: [{ type: "circleCollider", radius: 1000, xOffset: 0, frame: 0 }],
            impactFrame: 11,
            ...ai,
          },
        },
      ],
    ]),
    send: (frame) => sent.push(frame),
  };
  session.actors.get(HERO).position = session.heroPosition;
  const actor = session.actors.get(MONSTER);
  const distance = () => Math.hypot(actor.position.x - session.heroPosition.x, actor.position.y - session.heroPosition.y);
  const swings = () => sent.filter((frame) => frame.readUInt16LE(2) === 124 && frame.readUInt16LE(8) === 143).length;
  let tick = 0;
  const run = async (ticks) => {
    const trail = [];
    for (let index = 0; index < ticks; index++, tick++) {
      await tickNpcAi(session, 1000 + tick * TICK * 1000, TICK);
      trail.push({ ...actor.position });
    }
    return trail;
  };
  return { session, actor, sent, distance, swings, run };
};

/** A floor split in two by one wall the hero stands on the far side of. */
const wallBetween = () =>
  createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    cellSize: 30,
    staticColliders: [rectangle(300, 300, 5, 300)],
  });

test("with no route it walks at BaseMove to the wall and stands there", async () => {
  const navigation = wallBetween();
  const hero = { x: 100, y: 300 };
  const start = { x: 560, y: 340 };
  assert.deepEqual(findPath(navigation, start, hero, RADIUS), [], "the fixture must have no route");
  const { actor, run, distance } = makeSession({ navigation, hero, monster: start });

  const trail = await run(8);
  const steps = trail.map((at, index) => {
    const from = index ? trail[index - 1] : start;
    return Math.hypot(at.x - from.x, at.y - from.y);
  });
  // The walk ramps to BaseMove over 0.9 s (npcWalkingSpeed): the fourth tick is the first full one.
  assert.ok(Math.abs(steps[3] - 180 * TICK) < 0.5, `a full tick at BaseMove is 45, not ${steps[3].toFixed(1)}`);
  assert.ok(steps[0] > 0 && steps[1] > steps[0], `it set off at once: ${steps.slice(0, 3).map((s) => s.toFixed(1))}`);
  assert.ok(actor.position.x >= 325, `it went into the wall: x=${actor.position.x.toFixed(1)}`);
  assert.ok(actor.position.x < 340, `it did not reach the wall: x=${actor.position.x.toFixed(1)}`);
  assert.ok(!isPositionBlocked(navigation, actor.position, RADIUS), "it stands in the scenery");
  assert.equal(actor.ai.state, "blocked");

  const rested = { ...actor.position };
  const later = await run(20);
  const drift = Math.max(...later.map((at) => Math.hypot(at.x - rested.x, at.y - rested.y)));
  assert.ok(drift < 2, `it kept moving at the wall: ${drift.toFixed(2)} u`);
  assert.equal(actor.ai.walkSpeed, 0, "standing, its walk is at rest");
  assert.ok(distance() < 240, `it did not close on the hero: ${distance().toFixed(0)}`);
});

test("a ranged monster shoots through a gap its body does not fit", async () => {
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    cellSize: 30,
    staticColliders: [rectangle(300, 142.5, 5, 142.5), rectangle(300, 457.5, 5, 142.5)],
  });
  const hero = { x: 100, y: 300 };
  const start = { x: 500, y: 300 };
  // A 30 u gap lets no 40 u body through: the route ends short, at its mouth, with the hero in sight.
  const route = findPath(navigation, start, hero, RADIUS);
  assert.equal(route.endsShort, true);
  assert.ok(hasLineOfSight(navigation, route.at(-1), hero, 0), `the route ends in sight of him: ${JSON.stringify(route)}`);
  const { actor, run, swings } = makeSession({
    navigation,
    hero,
    monster: start,
    ai: { attackRange: 600 },
  });

  await run(12);
  assert.ok(actor.position.x >= 315 && actor.position.x < 335, `it stands at the gap: x=${actor.position.x.toFixed(1)}`);
  assert.ok(swings() >= 1, "with the hero in reach and in sight through the gap, it shoots");
  assert.ok(!isPositionBlocked(navigation, actor.position, RADIUS));
});

test("a gate opening turns the straight walk back into a route", async () => {
  const wall = rectangle(300, 200, 5, 200);
  const gate = rectangle(300, 500, 5, 100);
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    cellSize: 30,
    staticColliders: [wall],
    triggerColliders: new Map([["gate", { initialOn: true, onColliders: [gate], offColliders: [] }]]),
  });
  const hero = { x: 100, y: 100 };
  const start = { x: 500, y: 100 };
  assert.deepEqual(findPath(navigation, start, hero, RADIUS), []);
  const { actor, run, distance } = makeSession({ navigation, hero, monster: start });

  await run(10);
  assert.ok(actor.position.x >= 325 && actor.position.x < 340, `it stood at the wall first: x=${actor.position.x.toFixed(1)}`);
  assert.equal(actor.ai.routing.failed, true);

  assert.equal(setNavigationTriggerState(navigation, "gate", false), true);
  await run(1);
  assert.equal(actor.ai.routing.failed, false, "the changed revision searched again at once");
  assert.ok(actor.ai.routing.points.length > 1, "and found the way round through the gate");

  await run(40);
  assert.ok(distance() <= 60, `it reached the hero round the corner: ${distance().toFixed(0)} away`);
  assert.equal(actor.ai.state, "attack");
});

test("a kiter with no route keeps its distance rather than walking to the wall", async () => {
  const navigation = wallBetween();
  const hero = { x: 100, y: 300 };
  const start = { x: 560, y: 300 };
  const { session, actor, run, distance } = makeSession({
    navigation,
    hero,
    monster: start,
    ai: {
      behavior: "KITE_AI",
      attackRange: 600,
      keepDistance: 300,
      nextAttackAt: Number.MAX_SAFE_INTEGER,
      attacks: [{ attackType: 920050, range: 600, minRange: 0, rechargeMs: 0, readyAt: 0, impactFrame: 11 }],
    },
  });
  session.random = () => 0.999; // never rolls a back-off

  await run(12);
  assert.ok(
    Math.abs(distance() - 300) <= 10,
    `it should hold its keep distance, not reach the wall: ${distance().toFixed(0)} away`
  );
  const held = { ...actor.position };

  // The hero comes up to the wall, well inside its keep distance: it backs off.
  const rolls = [0, 0.99];
  session.random = () => (rolls.length ? rolls.shift() : 0.999);
  session.heroPosition.x = 270;
  await run(12);
  assert.ok(actor.position.x > held.x + 50, `inside its keep distance it should back away: ${actor.position.x.toFixed(0)}`);
  assert.ok(distance() >= 290, `and get back out to it: ${distance().toFixed(0)}`);
});

test("a route that ends short is walked to its end, where it stands and swings", async () => {
  /**
   * The hero in a slot between two boxes that a body of 26 does not fit, a
   * wall between them: the route ends short, at the slot's mouth, where the
   * hero is in sight (navigation.test.js). The monster walks it to its end,
   * swings from there, and stays: nothing nearer has him in sight.
   */
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    cellSize: 60,
    staticColliders: [rectangle(300, 450, 10, 250), rectangle(480, 400, 60, 30), rectangle(480, 500, 60, 30)],
  });
  const hero = { x: 480, y: 450 };
  const start = { x: 150, y: 450 };
  const route = findPath(navigation, start, hero, 26);
  assert.equal(route.endsShort, true, "the fixture's route must end short");
  const { actor, run, distance, swings } = makeSession({
    navigation,
    hero,
    monster: start,
    ai: { collisionRadius: 26 },
  });

  await run(60);
  const end = { ...actor.position };
  assert.ok(distance() < 100, `it should end at the slot's mouth, not ${distance().toFixed(1)} from the hero`);
  assert.ok(Math.abs(end.x - hero.x) >= 60 + 26 - 1, `against a box's end, not at ${JSON.stringify(end)}`);
  assert.ok(Math.abs(end.y - hero.y) <= 30, `level with the slot, not at ${JSON.stringify(end)}`);
  assert.equal(actor.ai.state, "attack");
  assert.ok(swings() >= 1, "from the mouth the hero is in reach and in sight");

  const later = await run(80);
  const drift = Math.max(...later.map((at) => Math.hypot(at.x - end.x, at.y - end.y)));
  assert.ok(drift < 2, `it should stay at the mouth, not move ${drift.toFixed(2)} u`);
});

test("a hero in a pocket it cannot enter is struck through the slit, from the far side", async () => {
  /**
   * Walled on three sides, a slit of 30 on the east that a body of 20 does
   * not pass, the hero 25 from the west wall: the nearest the monster can
   * stand to him is behind that wall, out of sight. It walks round to the
   * slit, where he is in sight and in reach, swings, and stays.
   */
  const navigation = createNavigationState({
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
  const hero = { x: 425, y: 450 };
  const { actor, run, distance, swings } = makeSession({ navigation, hero, monster: { x: 150, y: 450 } });

  await run(60);
  const end = { ...actor.position };
  assert.ok(end.x > 500, `it should go round to the slit, not stand at ${JSON.stringify(end)}`);
  assert.ok(hasLineOfSight(navigation, end, hero, 0), `with the hero in sight: ${JSON.stringify(end)}`);
  assert.ok(swings() >= 1, `and swing, ${distance().toFixed(0)} from him`);
  const later = await run(40);
  const drift = Math.max(...later.map((at) => Math.hypot(at.x - end.x, at.y - end.y)));
  assert.ok(drift < 2, `it should stay there, not move ${drift.toFixed(2)} u`);
});

import assert from "node:assert/strict";
import test from "node:test";

import { tickNpcAi } from "../src/socket/ai.js";
import { createNavigationState, findPath } from "../src/socket/navigation.js";
import { HEADING_DRIFT_DEGREES } from "../src/socket/npc-facing.js";
import { CLID } from "../src/socket/opcodes.js";

/**
 * Which way a monster faces (npc-facing.js). The official sends the bearing
 * to its victim, whichever way the monster walks, when that bearing has
 * turned 15° from the last one sent and with every swing, never twice in a
 * tick, and not while a swing is under way.
 */

const HERO = 10;
const MONSTER = 20;
const TICK = 0.25;

const makeSession = ({ navigation = null, hero, monster, heading = 0, ai = {} }) => {
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
      [HERO, { hitPoints: 20000, maxHitPoints: 20000, position: { ...hero } }],
      [
        MONSTER,
        {
          hitPoints: 15,
          maxHitPoints: 15,
          position: { ...monster },
          heading,
          isEnemy: true,
          ai: {
            state: "idle",
            engaged: true,
            aggroRadius: 2000,
            disengageDistance: 4000,
            moveSpeed: 180,
            collisionRadius: 20,
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
  let tick = 0;
  /** One tick: the frames it sent, each `{ field, heading? }` for the monster. */
  const step = async (ms = TICK * 1000) => {
    sent.length = 0;
    tick += ms;
    await tickNpcAi(session, 1000 + tick, ms / 1000);
    return sent
      .filter((frame) => frame.readUInt16LE(2) === 124 && frame.readUInt32LE(4) === MONSTER)
      .map((frame) => ({ field: frame.readUInt16LE(8), heading: frame.readUInt16LE(8) === 133 ? frame.readFloatLE(10) : null }));
  };
  return { session, actor, step, now: () => 1000 + tick };
};

const bearing = (from, to) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
const turn = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const headingsOf = (frames) => frames.filter(({ field }) => field === 133).map(({ heading }) => heading);

const rectangle = (x, y, halfWidth, halfHeight) => ({ type: "rectangle", x, y, halfWidth, halfHeight, angle: 0 });

test("walking round a wall it faces its victim, not the corner it walks at, once a tick at most", async () => {
  // A wall with a gap at its south end; the hero is on the far side.
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 600, maxY: 600 },
    cellSize: 30,
    staticColliders: [rectangle(300, 225, 5, 225)],
  });
  const hero = { x: 100, y: 200 };
  const start = { x: 500, y: 200 };
  const route = findPath(navigation, start, hero, 20);
  assert.ok(route.length > 1 && turn(bearing(start, route[0]), bearing(start, hero)) > 45, "the fixture walks round");
  const { actor, step, session } = makeSession({ navigation, hero, monster: start, heading: 0, ai: { attackRange: 0, nextAttackAt: Infinity } });

  let sentAny = 0;
  for (let index = 0; index < 24; index++) {
    // The hero drifts so the bearing keeps turning.
    session.heroPosition.y = 200 + index * 6;
    const headings = headingsOf(await step());
    assert.ok(headings.length <= 1, `tick ${index}: ${headings.length} headings`);
    for (const heading of headings) {
      sentAny++;
      const toHero = bearing(actor.position, session.heroPosition);
      assert.ok(turn(heading, toHero) < 0.001, `tick ${index}: faced ${heading.toFixed(1)}, the hero is at ${toHero.toFixed(1)}`);
    }
    // Between headings it is never further off its victim than a turn not yet worth sending.
    assert.ok(turn(actor.heading, bearing(actor.position, session.heroPosition)) < HEADING_DRIFT_DEGREES);
  }
  assert.ok(sentAny >= 1, "it turned to the hero at all");
  assert.ok(actor.position.y > 300, "and it did walk round");
});

test("a turn of less than 15 degrees is not sent; one of 15 or more is, exactly", async () => {
  const hero = { x: 300, y: 0 };
  const { step, session, actor } = makeSession({ hero, monster: { x: 0, y: 0 }, heading: 0, ai: { moveSpeed: 0, nextAttackAt: Infinity } });
  const at = (degrees) => {
    session.heroPosition.x = 300 * Math.cos((degrees * Math.PI) / 180);
    session.heroPosition.y = 300 * Math.sin((degrees * Math.PI) / 180);
  };
  assert.deepEqual(headingsOf(await step()), [], "already facing it");
  at(10);
  assert.deepEqual(headingsOf(await step()), [], "10 degrees is not a turn worth sending");
  at(14.5);
  assert.deepEqual(headingsOf(await step()), [], "nor 14.5");
  at(15.5);
  const sent = headingsOf(await step());
  assert.equal(sent.length, 1, "15.5 is");
  assert.ok(Math.abs(sent[0] - 15.5) < 1e-4, `and it is the bearing, ${sent[0]}`);
  at(25);
  assert.deepEqual(headingsOf(await step()), [], "measured from the last one sent, 9.5 is not");
  at(-170);
  assert.equal(headingsOf(await step()).length, 1, "and round the back of the circle it is");
  assert.ok(Math.abs(actor.heading + 170) < 1e-4);
});

test("a swing is faced exactly and always, before its choreography; one under way does not turn", async () => {
  // In reach and within a fraction of a degree of the hero: before, nothing was sent.
  const attacks = [{ attackType: 920050, range: 80, minRange: 0, rechargeMs: 0, readyAt: 0, projectile: null, impactFrame: 11 }];
  const { step, session, actor, now } = makeSession({ hero: { x: 0, y: 0 }, monster: { x: 60, y: 0 }, heading: 179.8, ai: { attacks } });
  const swing = await step(100);
  const fields = swing.map(({ field }) => field);
  assert.ok(fields.includes(143), "it swung");
  assert.deepEqual(headingsOf(swing), [180], "one heading, the bearing, with the swing");
  assert.ok(fields.indexOf(133) < fields.indexOf(143), "sent before the choreography");
  assert.equal(actor.ai.attackHeading, 180, "and the swing goes that way");

  // The hero steps round it while the swing is under way: it does not turn.
  const lockedUntil = actor.ai.attackLockedUntil;
  assert.ok(lockedUntil > now() + 200, "the fixture's swing locks it");
  session.heroPosition.x = 60;
  session.heroPosition.y = -60;
  while (now() + 100 < lockedUntil) {
    assert.deepEqual(headingsOf(await step(100)), [], "no turn inside its swing");
  }
  const after = headingsOf(await step(100));
  assert.equal(after.length, 1, "once the swing is over it turns");
  const toHero = bearing(actor.position, session.heroPosition);
  assert.ok(turn(after[0], toHero) < 1e-3 && Math.abs(toHero + 90) < 5, `to the hero, ${after[0]}`);
});

test("one that never turns sends no heading, not even with a swing", async () => {
  const { step, session } = makeSession({ hero: { x: 0, y: 0 }, monster: { x: 60, y: 0 }, heading: 0, ai: { lockRotation: true } });
  const frames = [...(await step(100)), ...(await step(2000))];
  session.heroPosition.y = 50;
  frames.push(...(await step(2000)));
  assert.ok(frames.some(({ field }) => field === 143), "it swung");
  assert.deepEqual(headingsOf(frames), []);
});

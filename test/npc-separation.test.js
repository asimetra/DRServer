import assert from "node:assert/strict";
import test from "node:test";

import { tickNpcAi } from "../src/socket/ai.js";
import { CLID } from "../src/socket/opcodes.js";

/**
 * Monsters standing inside one another.
 *
 * There is a separation displacement and the arithmetic in it is right; what was
 * wrong was the budget it had to spend. Both halves of a step — walking toward
 * the hero and being pushed off a neighbour — came out of the same allowance,
 * and that allowance was the debuffed speed.
 */

const npc = (position, overrides = {}) => ({
  hitPoints: 15,
  maxHitPoints: 15,
  position: { ...position },
  heading: 0,
  collisionRadius: 35,
  ai: {
    state: "idle",
    engaged: true,
    aggroRadius: 350,
    disengageDistance: 1600,
    moveSpeed: 180,
    attackRange: 80,
    attackTimerMs: 1500,
    attackRandMs: 0,
    nextAttackAt: Number.MAX_SAFE_INTEGER,
    attackType: 920050,
    damage: 1,
    impactFrame: 11,
    ...overrides,
  },
});

/** Two monsters almost exactly on top of each other, a long way from the hero. */
const makeSession = ({ stunned = false } = {}) => {
  const heroDoid = 10;
  const first = 20;
  const second = 21;

  const session = {
    id: 7,
    heroDoid,
    heroPosition: { x: 0, y: 0 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [first, CLID.DistributedNPCGameObject],
      [second, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 200, maxHitPoints: 200, position: { x: 0, y: 0 } }],
      [first, npc({ x: 300, y: 0 })],
      [second, npc({ x: 306, y: 0 })],
    ]),
    send: () => {},
  };

  if (stunned) {
    // What a garlic trap or a freeze actually puts on them: MOVEMENT zero.
    session.activeBuffs = new Map([
      ["a", { affectedActor: first, buff: { MOVEMENT: 0 } }],
      ["b", { affectedActor: second, buff: { MOVEMENT: 0 } }],
    ]);
  }

  return { session, first, second };
};

const gap = (session, first, second) => {
  const a = session.actors.get(first).position;
  const b = session.actors.get(second).position;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

test("two monsters standing in each other are pushed apart", async () => {
  const { session, first, second } = makeSession();
  assert.ok(gap(session, first, second) < 10, "they start almost on the same spot");

  for (let tick = 0; tick < 20; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  // Their bodies are 35 each, so touching is 70 and a burst gets 8 more on top.
  assert.ok(
    gap(session, first, second) >= 70,
    `bodies should not overlap, gap was ${gap(session, first, second).toFixed(1)}`
  );
});

test("a frozen wave is still pushed apart", async () => {
  const { session, first, second } = makeSession({ stunned: true });
  const before = gap(session, first, second);

  for (let tick = 0; tick < 20; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const after = gap(session, first, second);
  assert.ok(
    after > before,
    `MOVEMENT zero stops it walking, not being shoved: ${before.toFixed(1)} -> ${after.toFixed(1)}`
  );
  assert.ok(after >= 70, `and all the way out: gap was ${after.toFixed(1)}`);

  // It is shoved, not walking: neither of them closed on the hero.
  for (const doid of [first, second]) {
    const { x, y } = session.actors.get(doid).position;
    assert.ok(
      Math.hypot(x, y) > 250,
      `a stunned monster does not advance on the hero (${Math.round(x)},${Math.round(y)})`
    );
  }
});

test("being shoved is bounded by what the monster could walk", async () => {
  const { session, first, second } = makeSession({ stunned: true });
  const start = { ...session.actors.get(first).position };

  await tickNpcAi(session, 1000, 0.1);

  const moved = Math.hypot(
    session.actors.get(first).position.x - start.x,
    session.actors.get(first).position.y - start.y
  );
  // 180 units a second, a tenth of a second: eighteen, and not a jump out of a
  // deep stack in one tick.
  assert.ok(moved <= 18 + 0.001, `pushed ${moved.toFixed(1)} in one tick`);
});

test("a monster wider than its own reach can still get to the hero", async () => {
  // Red Dragon: an authored body of 120 and an authored range of 80. Held a
  // body's width off the hero it would hover outside its own bite for ever,
  // which is what it did — measured settling at 179 and never getting in.
  const { session, first, second } = makeSession();
  session.actors.delete(second);
  session.objects.delete(second);
  const dragon = session.actors.get(first);
  dragon.collisionRadius = 120;
  dragon.position = { x: 400, y: 0 };

  for (let tick = 0; tick < 60; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const { x, y } = dragon.position;
  const reached = Math.hypot(x, y);
  assert.ok(
    reached <= dragon.ai.attackRange,
    `it has to be able to swing: ${reached.toFixed(0)} against a range of ${dragon.ai.attackRange}`
  );
});

test("a chasing crowd spreads around the hero instead of piling on him", async () => {
  const { session, first, second } = makeSession();
  // Off the line between them and the hero. Exactly collinear there is no
  // sideways at all and queueing is the honest answer; any asymmetry and they
  // should come around rather than stack up behind one another.
  session.actors.get(second).position = { x: 300, y: 40 };

  for (let tick = 0; tick < 30; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  for (const doid of [first, second]) {
    const { x, y } = session.actors.get(doid).position;
    assert.ok(
      Math.hypot(x, y) <= 130,
      `both get to swing at him (${Math.round(x)},${Math.round(y)})`
    );
  }
  assert.ok(
    gap(session, first, second) >= 70,
    `and neither stands in the other: ${gap(session, first, second).toFixed(1)}`
  );
});

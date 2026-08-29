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

/**
 * A monster wider than its own reach.
 *
 * Red Dragon and twelve others have a body that meets the player's further out
 * than the attack we model can reach. It still has to be able to bite. This
 * used to be arranged by walking it *inside* the player, which bites but also
 * shoves the player for as long as it stands there — GIANT_LEECH by 69 units.
 * So the test asks for the outcome, not for the distance: it must swing, and it
 * must do it from outside the player.
 */
test("a monster wider than its own reach bites without standing inside the hero", async () => {
  const { session, first, second } = makeSession();
  session.actors.delete(second);
  session.objects.delete(second);
  const dragon = session.actors.get(first);
  dragon.collisionRadius = 120;
  dragon.ai.collisionRadius = 120;
  dragon.ai.nextAttackAt = 0;
  dragon.position = { x: 400, y: 0 };

  const swings = [];
  session.send = (frame) => {
    const body = frame.subarray(2);
    if (body.length >= 8 && body.readUInt16LE(0) === 124 && body.readUInt16LE(6) === 143) {
      swings.push(Math.hypot(dragon.position.x, dragon.position.y));
    }
  };

  for (let tick = 0; tick < 60; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const bodies = 120 + 35; // its own radius and the hero's
  assert.ok(swings.length > 0, "it has to be able to swing at all");
  assert.ok(
    swings.every((from) => from >= bodies - 1),
    `and from outside the player, not inside him: ${swings.map(Math.round).join(",")}`
  );
  assert.ok(
    Math.hypot(dragon.position.x, dragon.position.y) <= bodies + 6,
    "while still closing all the way to contact"
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

/**
 * Where the walk ends.
 *
 * Measured on 66 official recordings, restricted to monsters that had swung in
 * the last four seconds and were themselves standing still, the fifth
 * percentile of a chaser's distance to the hero sits on the sum of the two
 * bodies whatever its authored range is — KNIGHT 67 against 67.9, RAPTOR 69
 * against 71.9, KNIGHT_HALBERD 69 against 67.9. This server used to stop at the
 * range instead, which drew a pack as a ring of one radius with the player
 * alone in the middle.
 */
test("a chaser walks in until the bodies meet, not until it is barely in range", async () => {
  const { session, first, second } = makeSession();
  session.actors.delete(second);
  session.objects.delete(second);
  const chaser = session.actors.get(first);
  // A long reach and an ordinary body: the two rules are 140 apart here, so
  // which one it obeys is not a matter of interpretation.
  chaser.ai.attackRange = 220;
  chaser.position = { x: 600, y: 0 };

  for (let tick = 0; tick < 60; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const settled = Math.hypot(chaser.position.x, chaser.position.y);
  const bodies = 35 + 35; // its own radius and the hero's default
  assert.ok(
    settled <= bodies + 6,
    `it should close to its body, not to its reach: ${settled.toFixed(0)} against ${bodies}`
  );
});

/**
 * And where it does not.
 *
 * `Aggro_AI_Type` splits the 98 fighting rows into 78 CHASE_AI, 13 KITE_AI and
 * 7 TELEPORT_AI. The corpus separates the first from the rest cleanly: a
 * chaser's distances peak at contact, while KNIGHT_MARKSMAN's have a small bump
 * there and then a plateau from 240 to 460. `MinFleeDistMult` x range is 300
 * for that row, and lands inside the plateau for every kiter measured.
 */
test("a kiter holds its standoff instead of walking into the hero", async () => {
  const { session, first, second } = makeSession();
  session.actors.delete(second);
  session.objects.delete(second);
  const archer = session.actors.get(first);
  archer.ai.attackRange = 600;
  archer.ai.keepDistance = 300;
  archer.position = { x: 900, y: 0 };

  for (let tick = 0; tick < 80; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const settled = Math.hypot(archer.position.x, archer.position.y);
  assert.ok(
    Math.abs(settled - 300) <= 10,
    `it should stop at its standoff, not at contact or at its range: ${settled.toFixed(0)}`
  );
});

test("a standoff never puts a monster outside its own reach", async () => {
  const { session, first, second } = makeSession();
  session.actors.delete(second);
  session.objects.delete(second);
  const confused = session.actors.get(first);
  // A row whose flee distance exceeds what it can hit from would otherwise
  // stand off for ever and never swing. Nothing in the table does this today;
  // the clamp is what keeps that true if something ever does.
  confused.ai.attackRange = 100;
  confused.ai.keepDistance = 900;
  confused.position = { x: 700, y: 0 };

  for (let tick = 0; tick < 80; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const settled = Math.hypot(confused.position.x, confused.position.y);
  assert.ok(
    settled <= confused.ai.attackRange,
    `it has to be able to swing: ${settled.toFixed(0)} against a range of ${confused.ai.attackRange}`
  );
});

/**
 * The shove.
 *
 * On the client the local hero is the only dynamic Box2D body in the room:
 * `CircleNavCollider.buildBody` takes a plain `B2BodyDef`, which is static by
 * default, and `HeroGameObjectOwner` is the only thing that ever assigns
 * `b2_dynamicBody`. A static body a player walks into blocks them, which is
 * ordinary collision. A static body *moved into* a player is resolved by
 * position correction, and since only one of the two can move, the player is
 * what moves.
 *
 * So the rule is about what this server sends, not about how close things
 * stand. Measured on six knights around one player before it existed: 7.3% of
 * emitted positions overlapped the player while they stood still and 14.9%
 * while they walked, a median of 6.3 units deep and up to 43.
 */
test("no position this server sends puts a monster inside the player", async (t) => {
  const { session, first, second } = makeSession();
  const hero = session.actors.get(10);
  hero.collisionRadius = 22 * 1.176;
  const contact = 35 + hero.collisionRadius;

  let emitted = 0;
  let overlapping = 0;
  let deepest = 0;
  session.send = (frame) => {
    const body = frame.subarray(2);
    if (body.length < 16 || body.readUInt16LE(0) !== 124 || body.readUInt16LE(6) !== 132) return;
    emitted++;
    const gap = Math.hypot(
      body.readFloatLE(8) - session.heroPosition.x,
      body.readFloatLE(12) - session.heroPosition.y
    );
    if (gap < contact - 0.01) {
      overlapping++;
      deepest = Math.max(deepest, contact - gap);
    }
  };

  // A player walking about is the case that was worst: the chase aims at where
  // they were last heard from, and they are no longer there.
  let heading = 0;
  for (let tick = 0; tick < 400; tick++) {
    heading += 0.11;
    session.heroPosition.x += Math.cos(heading) * 25;
    session.heroPosition.y += Math.sin(heading) * 25;
    hero.position.x = session.heroPosition.x;
    hero.position.y = session.heroPosition.y;
    await tickNpcAi(session, 1000 + tick * 100, 0.1);
  }

  assert.ok(emitted > 200, `the monsters have to actually be moving: ${emitted} positions`);
  assert.equal(
    overlapping,
    0,
    `${overlapping} of ${emitted} overlapped, deepest ${deepest.toFixed(1)} units`
  );
  assert.ok(session.actors.get(first).ai.engaged, "and they are still chasing him");
  assert.ok(session.actors.get(second).ai.engaged);
});

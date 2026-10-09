import assert from "node:assert/strict";
import test from "node:test";

import { awayFromThreats, tickNpcAi } from "../src/socket/ai.js";
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

test("walking and crowd separation share one BaseMove budget", async () => {
  const { session, first } = makeSession();
  const start = { ...session.actors.get(first).position };

  await tickNpcAi(session, 1000, 0.1);

  const moved = Math.hypot(
    session.actors.get(first).position.x - start.x,
    session.actors.get(first).position.y - start.y
  );
  assert.ok(
    moved <= 18 + 0.001,
    `BaseMove 180 permits 18 units per 100ms, but walk + push moved ${moved.toFixed(1)}`
  );
});

test("overlapping idle monsters separate without acquiring or walking toward the hero", async () => {
  const { session, first, second } = makeSession();
  session.actors.get(first).position = { x: 700, y: 0 };
  session.actors.get(second).position = { x: 706, y: 0 };
  session.actors.get(first).ai.aggroRadius = 100;
  session.actors.get(second).ai.aggroRadius = 100;
  session.actors.get(first).ai.engaged = false;
  session.actors.get(second).ai.engaged = false;
  const sent = [];
  session.send = (frame) => sent.push(frame);
  const before = gap(session, first, second);

  // The official median is two position updates from overlap to contact.
  for (let tick = 0; tick < 2; tick++) {
    await tickNpcAi(session, 1000 + tick * 250, 0.25);
  }

  assert.ok(gap(session, first, second) >= 69, `idle bodies still overlap at ${gap(session, first, second)}`);
  assert.ok(sent.length > 0, "idle overlap produced no position correction");
  assert.ok(
    sent.every((frame) => frame.readUInt16LE(8) === 132),
    "idle separation emitted heading, attack, or another AI state field"
  );
  for (const doid of [first, second]) {
    const actor = session.actors.get(doid);
    assert.equal(actor.ai.engaged, false, "separation acquired the distant hero");
    assert.equal(actor.ai.state, "idle", "separation changed idle AI state");
    assert.ok(actor.position.x > 600, "an idle monster started chasing rather than separating");
  }
  assert.ok(gap(session, first, second) > before);

  const settledFrames = sent.length;
  await tickNpcAi(session, 1500, 0.25);
  assert.equal(sent.length, settledFrames, "idle pair kept drifting after reaching body contact");
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

/** A session random that plays `first` in order and then never rolls a back-off again. */
const rolls = (...first) => () => (first.length ? first.shift() : 0.999);

const kiterAlone = () => {
  const { session, first, second } = makeSession();
  session.actors.delete(second);
  session.objects.delete(second);
  const archer = session.actors.get(first);
  archer.ai.behavior = "KITE_AI";
  archer.ai.attackRange = 600;
  archer.ai.keepDistance = 300;
  archer.ai.moveSpeed = 100;
  archer.ai.nextAttackAt = 0;
  // A real attack holds the body for its wind-up; the promoted test attack has none.
  archer.ai.attacks = [{ attackType: 920050, range: 600, minRange: 0, rechargeMs: 0, readyAt: 0, impactFrame: 11 }];
  archer.position = { x: 100, y: 0 };
  const hero = session.actors.get(session.heroDoid);
  session.heroPosition = hero.position;
  const sent = [];
  session.send = (frame) => sent.push(frame);
  const attacks = () => sent.filter((frame) => frame.readUInt16LE(8) === 143).length;
  return { session, archer, hero, attacks };
};

/**
 * Walked into, a kiter is not pushed along. Separation used to keep it at its
 * keep distance from every hero, so a player walking at it dragged it across
 * the room whether it was backing off or shooting.
 */
test("a kiter walked into stands its ground", async () => {
  const { session, archer, hero, attacks } = kiterAlone();
  session.random = rolls();
  const start = archer.position.x;
  for (let tick = 0; tick < 40; tick++) {
    const gap = archer.position.x - hero.position.x;
    hero.position.x += Math.max(0, Math.min(25, gap - 71)); // stopped by its body, as the client stops it
    await tickNpcAi(session, 1000 + tick * 100, 0.1);
  }
  assert.ok(
    Math.abs(archer.position.x - start) < 1,
    `a player walking in pushed it ${(archer.position.x - start).toFixed(0)} units`
  );
  assert.ok(attacks() >= 2, "standing its ground, it should go on shooting");
});

test("a kiter backs off until its shot is due, and the shot ends the back-off", async () => {
  const { session, archer, attacks } = kiterAlone();
  archer.ai.nextAttackAt = 1500;
  // A back-off on the first tick, 3.2 s long (-ln(0.2) x 2000 ms).
  session.random = rolls(0, 0.8);
  await tickNpcAi(session, 1000, 0.1);
  assert.ok(archer.ai.fleeUntil > 1000, "the roll should have started a back-off");

  for (let tick = 1; tick <= 5; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);
  assert.equal(attacks(), 1, "a back-off must not withhold a swing that is due");
  assert.equal(archer.ai.fleeUntil, 0, "the shot should have ended the back-off");
  const moved = archer.position.x - 100;
  assert.ok(moved > 40 && moved < 70, `half a second at 100 u/s before the shot: moved ${moved.toFixed(0)}`);

  for (let tick = 6; tick <= 20; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);
  assert.ok(Math.abs(archer.position.x - 100 - moved) < 1, "after the shot it should fight from where it stands");
  assert.notEqual(archer.ai.state, "flee");
});

test("a back-off stops at the keep distance instead of hopping past it", async () => {
  const { session, archer } = kiterAlone();
  archer.ai.nextAttackAt = Number.MAX_SAFE_INTEGER;
  archer.position = { x: 290, y: 0 };
  session.random = rolls(0, 0.99);
  for (let tick = 0; tick < 4; tick++) await tickNpcAi(session, 1000 + tick * 250, 0.25);
  assert.ok(
    Math.abs(archer.position.x - 300) < 0.01,
    `a 25-unit step from 10 inside should stop on the keep distance, stopped at ${archer.position.x.toFixed(2)}`
  );
  assert.equal(archer.ai.fleeUntil, 0, "back out at its keep distance, the back-off is over");
});

test("a back-off left a rounding error short of the keep distance is over", async () => {
  const { session, archer, hero } = kiterAlone();
  archer.ai.nextAttackAt = Number.MAX_SAFE_INTEGER;
  archer.position = { x: 300 - 5.7e-14, y: 0 };
  archer.ai.fleeUntil = 5000;
  session.random = rolls();
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(archer.ai.fleeUntil, 0, "a back-off with nowhere left to go should be over");
  hero.position.x += 25;
  await tickNpcAi(session, 1250, 0.25);
  assert.ok(archer.position.x < 300.001, `a player walking in pushed it to ${archer.position.x.toFixed(3)}`);
});

test("a moving target makes a back-off likelier than a still one", async () => {
  const { session, archer, hero } = kiterAlone();
  archer.ai.nextAttackAt = Number.MAX_SAFE_INTEGER;
  // 0.05 lies between the still chance (1 - e^-0.035) and the moving one (1 - e^-0.08) for a 0.1 s tick.
  session.random = rolls(0.05, 0.05, 0.05, 0.5);
  await tickNpcAi(session, 1000, 0.1);
  await tickNpcAi(session, 1100, 0.1);
  assert.ok(!(archer.ai.fleeUntil > 1100), "a still target should not have started one on that roll");
  hero.position.x += 10; // 100 u/s
  await tickNpcAi(session, 1200, 0.1);
  assert.ok(archer.ai.fleeUntil > 1200, "a moving target should have started one on the same roll");
});

test("a kiter that cannot get away ends its back-off and fights", async () => {
  const { session, first, second } = makeSession();
  const archer = session.actors.get(first);
  archer.ai.behavior = "KITE_AI";
  archer.ai.attackRange = 600;
  archer.ai.keepDistance = 300;
  archer.ai.moveSpeed = 100;
  archer.ai.nextAttackAt = Number.MAX_SAFE_INTEGER;
  archer.position = { x: 100, y: 0 };
  // Something standing right behind it, against its body.
  const wall = session.actors.get(second);
  wall.position = { x: 170, y: 0 };
  wall.ai.moveSpeed = 0;
  session.random = rolls(0, 0.99);
  await tickNpcAi(session, 1000, 0.1);
  assert.ok(archer.position.x < 105, "it should not have got past the body behind it");
  assert.equal(archer.ai.fleeUntil, 0, "a back-off with nowhere to go should end at once");
});

test("pressed from both sides, a kiter has no away to back off to", () => {
  const actor = { position: { x: 0, y: 0 } };
  assert.equal(
    awayFromThreats(actor, [{ position: { x: -100, y: 0 } }, { position: { x: 100, y: 0 } }], 300),
    null
  );
  const away = awayFromThreats(actor, [{ position: { x: -100, y: 0 } }, { position: { x: 0, y: 250 } }], 300);
  assert.ok(away.x > 0.8 && away.y < 0, `away from the nearer one, a little from the other: ${JSON.stringify(away)}`);
  assert.equal(awayFromThreats(actor, [{ position: { x: 400, y: 0 } }], 300), null, "nobody inside its keep distance");
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

import assert from "node:assert/strict";
import test from "node:test";

import { attackForConstant } from "../src/gamemaster.js";
import { npcWalkingSpeed, tickNpcAi } from "../src/socket/ai.js";
import { clearDungeonBuffs, grantBuff } from "../src/socket/buffs.js";
import { performNpcAttack, tickTrapProjectiles } from "../src/socket/combat.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";
import { createNavigationState, isPositionBlocked } from "../src/socket/navigation.js";
import { createMatchWorld } from "../src/socket/match-world.js";

const readUpdate = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  return { reader, doid: reader.u32(), fieldId: reader.u16() };
};

/** A frame-zero contact shape for tests exercising the hit path directly. */
const contactShape = [{ type: "circleCollider", radius: 1000, xOffset: 0, frame: 0 }];

const makeSession = () => {
  const sent = [];
  const heroDoid = 10;
  const knightDoid = 20;
  return {
    sent,
    heroDoid,
    knightDoid,
    session: {
      id: 7,
      heroDoid,
      heroPosition: { x: 0, y: 0 },
      objects: new Map([
        [heroDoid, CLID.HeroGameObject],
        [knightDoid, CLID.DistributedNPCGameObject],
      ]),
      actors: new Map([
        [heroDoid, { hitPoints: 200, maxHitPoints: 200, position: { x: 0, y: 0 } }],
        [
          knightDoid,
          {
            hitPoints: 15,
            maxHitPoints: 15,
            position: { x: 200, y: 0 },
            heading: 0,
            ai: {
              state: "idle",
              engaged: false,
              aggroRadius: 350,
              disengageDistance: 1600,
              moveSpeed: 180,
              attackRange: 80,
              attackTimerMs: 1500,
              attackRandMs: 0,
              nextAttackAt: 0,
              attackType: 920050,
              damage: 1,
              attackColliders: contactShape,
              impactFrame: 11,
            },
          },
        ],
      ]),
      send: (frame) => sent.push(frame),
    },
  };
};

const enableBuffs = (session) => {
  let nextDoid = 1000;
  session.floorDoid = 99;
  session.dungeonZone = 10;
  session.allocateDoid = (clid) => {
    const doid = nextDoid++;
    session.objects.set(doid, clid);
    return doid;
  };
};

test("chase AI moves and faces an aggroed hero", async () => {
  const { session, sent, knightDoid } = makeSession();
  await tickNpcAi(session, 1000, 0.5);

  assert.equal(session.actors.get(knightDoid).ai.state, "chase");
  assert.equal(session.actors.get(knightDoid).position.x, 150);
  assert.equal(sent.length, 2);

  const heading = readUpdate(sent[0]);
  assert.equal(heading.doid, knightDoid);
  assert.equal(heading.fieldId, 133);
  assert.equal(heading.reader.f32(), 180);

  const position = readUpdate(sent[1]);
  assert.equal(position.doid, knightDoid);
  assert.equal(position.fieldId, 132);
  assert.equal(position.reader.f32(), 150);
  assert.equal(position.reader.f32(), 0);
});

test("an enemy acquires and releases targets at its authored awareness boundaries", async () => {
  const { session, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);

  knight.position = { x: 351, y: 0 };
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(knight.ai.engaged, false, "one unit outside AggroRadius acquired the hero");
  assert.equal(knight.position.x, 351, "an idle enemy outside awareness started moving");

  knight.position = { x: 350, y: 0 };
  await tickNpcAi(session, 1250, 0.25);
  assert.equal(knight.ai.engaged, true, "the authored AggroRadius boundary was excluded");
  assert.equal(knight.ai.state, "chase");

  knight.position = { x: 1600, y: 0 };
  await tickNpcAi(session, 1500, 0.25);
  assert.equal(knight.ai.engaged, true, "the authored DisengageDist boundary was excluded");

  knight.position = { x: 1601, y: 0 };
  await tickNpcAi(session, 1750, 0.25);
  assert.equal(knight.ai.engaged, false, "a target beyond DisengageDist stayed locked");
  assert.equal(knight.ai.state, "idle");
  assert.equal(knight.ai.targetDoid, null);
});

test("a moving row with zero authored awareness stays passive", async () => {
  const { session, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 1, y: 0 };
  knight.ai.aggroRadius = 0;

  await tickNpcAi(session, 1000, 0.25);

  assert.equal(knight.ai.engaged, false);
  assert.equal(knight.ai.state, "idle");
  assert.deepEqual(knight.position, { x: 1, y: 0 });
});

test("attack AI embeds a timed combat result and reduces hero hit points", async () => {
  const { session, sent, heroDoid, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 60, y: 0 };
  knight.heading = 180;

  await tickNpcAi(session, 1000, 0.1);
  assert.equal(knight.ai.state, "attack");
  assert.equal(session.actors.get(heroDoid).hitPoints, 199);
  /**
   * A monster standing inside the player is now pushed off them, so a position
   * update can ride along with the swing. What matters is the swing and its
   * result, not how many packets the tick happened to produce.
   */
  assert.ok(sent.length >= 2, `expected at least the swing and its result, got ${sent.length}`);

  // Found by field rather than by position in the list: being pushed off the
  // player can put a movement update ahead of the swing.
  const choreography = sent.map(readUpdate).find((packet) => packet.fieldId === 143);
  assert.ok(choreography, "the swing went out");
  assert.equal(choreography.doid, knightDoid);
  assert.equal(choreography.reader.u8(), 0);
  assert.equal(choreography.reader.u8(), 0);
  assert.equal(choreography.reader.u32(), 920050);
  assert.equal(choreography.reader.u32(), heroDoid);
  choreography.reader.u8();
  choreography.reader.f32();
  choreography.reader.f32();
  /**
   * The swing carries no result any more. It used to embed one stamped with the
   * frame the client should play it on, which meant the damage was decided when
   * the monster started moving — see performNpcAttack. The result follows on
   * its own, when the swing actually lands.
   */
  assert.equal(choreography.reader.u16(), 0, "the animation goes out by itself");

  const result = sent.map(readUpdate).find((packet) => packet.fieldId === 160);
  assert.ok(result, "and the hit followed as its own result");
  assert.equal(result.doid, heroDoid);
  assert.equal(result.reader.u32(), knightDoid, "dealt by the knight");
  assert.equal(result.reader.u32(), heroDoid, "to the hero");
  assert.equal(result.reader.buf.readInt32LE(result.reader.pos), -1, "for one point");

  const hitPoints = sent.map(readUpdate).find((packet) => packet.fieldId === 151);
  assert.ok(hitPoints, "and so did the new hit points");
  assert.equal(hitPoints.doid, heroDoid);
  assert.equal(hitPoints.reader.u16(), 199);

  sent.length = 0;
  await tickNpcAi(session, 2000, 0.1);
  // Movement may still go out — it is being pushed off the player it is
  // standing in — but nothing may swing again while the cooldown runs.
  assert.equal(
    sent.map(readUpdate).filter((packet) => packet.fieldId === 143).length,
    0,
    "no second swing during the cooldown"
  );
  assert.equal(session.actors.get(heroDoid).hitPoints, 199);

  await tickNpcAi(session, 2500, 0.1);
  assert.equal(
    sent.map(readUpdate).filter((packet) => packet.fieldId === 143).length,
    1,
    "and exactly one once it comes round again"
  );
  assert.equal(session.actors.get(heroDoid).hitPoints, 198);
});

test("shared-world AI attacks the nearest live member instead of the host forever", async () => {
  const { session: host, sent, heroDoid, knightDoid } = makeSession();
  host.accountId = 100;
  host.socket = { destroyed: false };
  host.allocateDoid = function (clid) {
    const doid = 9000 + this.objects.size;
    this.objects.set(doid, clid);
    return doid;
  };
  host.heroPosition = { x: 0, y: 0 };
  host.actors.get(heroDoid).position = host.heroPosition;
  const knight = host.actors.get(knightDoid);
  knight.position = { x: 60, y: 0 };
  knight.heading = 180;

  const joinerSent = [];
  const joiner = {
    accountId: 101,
    heroDoid: 11,
    heroPosition: { x: 55, y: 0 },
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: (frame) => joinerSent.push(frame),
    allocateDoid: host.allocateDoid,
  };
  const world = createMatchWorld({ members: new Set([host, joiner]) }, host);
  world.contextFor(joiner);
  world.objects.set(joiner.heroDoid, CLID.HeroGameObject);
  world.actors.set(joiner.heroDoid, {
    hitPoints: 200,
    maxHitPoints: 200,
    position: joiner.heroPosition,
  });

  await tickNpcAi(world.contextFor(host), 1000, 0.1);

  assert.equal(world.actors.get(heroDoid).hitPoints, 200);
  assert.equal(world.actors.get(joiner.heroDoid).hitPoints, 199);
  const choreography = sent.map(readUpdate).find((packet) => packet.fieldId === 143);
  assert.ok(choreography);
  choreography.reader.u8();
  choreography.reader.u8();
  choreography.reader.u32();
  assert.equal(choreography.reader.u32(), joiner.heroDoid);
  assert.ok(joinerSent.length > 0, "the same world result is broadcast to the joiner");
});

test("overlapping melee NPCs separate instead of stacking on the hero", async () => {
  const { session, knightDoid } = makeSession();
  const first = session.actors.get(knightDoid);
  first.position = { x: 60, y: 0 };
  first.ai.collisionRadius = 35;
  first.ai.nextAttackAt = Number.POSITIVE_INFINITY;

  const secondDoid = knightDoid + 1;
  const second = structuredClone(first);
  second.position = { x: 60, y: 0 };
  session.objects.set(secondDoid, CLID.DistributedNPCGameObject);
  session.actors.set(secondDoid, second);

  /**
   * Over several ticks, not one.
   *
   * They start on the same point *and* inside the hero's body, which is a state
   * the server no longer produces — nothing it sends may overlap the player, see
   * `keptOutOfHeroes`. So the first tick now spends part of its budget lifting
   * them out of him and gets 32.7 apart where it used to get 35. Where they end
   * up is what this is about: their bodies do not overlap, at least the front
   * monster can attack, and the other remains engaged without being snapped
   * through the player merely to put both on the same contact ring.
   */
  for (let tick = 0; tick < 10; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const spacing = Math.hypot(
    first.position.x - second.position.x,
    first.position.y - second.position.y
  );
  assert.ok(spacing >= 70, `expected visible separation, got ${spacing}`);
  for (const npc of [first, second]) {
    const fromHero = Math.hypot(npc.position.x, npc.position.y);
    assert.ok(fromHero >= 70 - 0.01, `and neither left standing inside him: ${fromHero}`);
  }
  const states = [first.ai.state, second.ai.state];
  assert.ok(states.includes("attack"), `neither separated monster could attack: ${states}`);
  assert.ok(
    states.every((state) => state === "attack" || state === "chase"),
    `a separated monster dropped combat: ${states}`
  );
  assert.ok(first.ai.engaged && second.ai.engaged);
});

test("members of one generator burst stay compact without overlapping", async () => {
  const { session, knightDoid } = makeSession();
  const first = session.actors.get(knightDoid);
  first.position = { x: 60, y: 0 };
  first.ai.collisionRadius = 35;
  first.ai.nextAttackAt = Number.POSITIVE_INFINITY;
  const group = { id: "generator:1", expiresAt: 10_000 };
  first.ai.wave = { group, index: 0 };

  const secondDoid = knightDoid + 1;
  const second = structuredClone(first);
  second.position = { x: 60, y: 0 };
  second.ai.wave = { group, index: 1 };
  session.objects.set(secondDoid, CLID.DistributedNPCGameObject);
  session.actors.set(secondDoid, second);

  // Separation is a nudge per tick, so it settles over a few of them.
  for (let tick = 0; tick < 12; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const spacing = Math.hypot(
    first.position.x - second.position.x,
    first.position.y - second.position.y
  );
  /**
   * Shoulder to shoulder, not inside one another. The old bound allowed a pair
   * of 35-radius bodies to sit 35 apart, which is half of each inside the other
   * — it was written on the belief that the client separates them, and the
   * client makes every actor but the local hero a static body.
   */
  const bodies = first.ai.collisionRadius + second.ai.collisionRadius;
  assert.ok(spacing >= bodies * 0.9, `expected them not to overlap, got ${spacing}`);
  assert.ok(spacing <= bodies * 1.3, `wave members should stay compact, got ${spacing}`);
});

test("generator burst members plan their own route around an obstacle", async () => {
  const { session, knightDoid } = makeSession();
  const first = session.actors.get(knightDoid);
  first.position = { x: 240, y: 150 };
  first.ai.collisionRadius = 20;
  first.ai.nextAttackAt = Number.POSITIVE_INFINITY;
  session.heroPosition = { x: 60, y: 150 };
  session.actors.get(session.heroDoid).position = session.heroPosition;
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    cellSize: 30,
    staticColliders: [
      { type: "rectangle", x: 150, y: 150, halfWidth: 5, halfHeight: 60, angle: 0 },
    ],
  });
  const group = { id: "generator:1", expiresAt: 10_000 };
  first.ai.wave = { group, index: 0 };

  const secondDoid = knightDoid + 1;
  const second = structuredClone(first);
  second.position = { x: 240, y: 165 };
  second.ai.wave = { group, index: 1 };
  session.objects.set(secondDoid, CLID.DistributedNPCGameObject);
  session.actors.set(secondDoid, second);

  await tickNpcAi(session, 1000, 0.1);

  assert.ok(first.ai.path?.length, "first member should own an obstacle route");
  assert.ok(second.ai.path?.length, "second member should plan its own obstacle route");
});

test("release movement exits only its enclosing cage before normal AI starts", async () => {
  const { session, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 150, y: 150 };
  knight.ai.collisionRadius = 20;
  knight.ai.moveSpeed = 180;
  session.heroPosition = { x: 50, y: 150 };
  session.actors.get(session.heroDoid).position = session.heroPosition;
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    triggerColliders: new Map([
      [
        "jail",
        {
          initialOn: true,
          onColliders: [
            { type: "rectangle", x: 150, y: 150, halfWidth: 25, halfHeight: 80, angle: 0 },
          ],
          offColliders: [
            { type: "rectangle", x: 150, y: 150, halfWidth: 25, halfHeight: 80, angle: 0 },
          ],
        },
      ],
    ]),
  });
  const jail = session.navigation.triggerGroups.get("jail").onColliders[0];
  knight.ai.release = {
    target: { x: 198, y: 150 },
    ignoredColliders: new Set([jail]),
    startsAt: 0,
  };

  await tickNpcAi(session, 1000, 0.1);
  assert.equal(knight.ai.state, "release");
  assert.ok(knight.position.x > 150, `expected outward movement, got ${knight.position.x}`);

  await tickNpcAi(session, 1100, 0.2);
  assert.equal(knight.ai.release, null);
  assert.equal(isPositionBlocked(session.navigation, knight.position, 20), false);
});

test("a released NPC chases the latest hero position instead of its old cage target", async () => {
  const { session, heroDoid, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 198, y: 150 };
  knight.ai.collisionRadius = 20;
  knight.ai.moveSpeed = 180;
  // The actor position has not caught up to the inbound position field yet.
  // Release logic must use that authoritative field just like regular chase.
  session.actors.get(heroDoid).position = { x: 50, y: 150 };
  session.heroPosition = { x: 300, y: 150 };
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 360, maxY: 300 },
    triggerColliders: new Map([
      [
        "jail",
        {
          initialOn: true,
          onColliders: [
            { type: "rectangle", x: 150, y: 150, halfWidth: 25, halfHeight: 80, angle: 0 },
          ],
          offColliders: [],
        },
      ],
    ]),
  });
  const jail = session.navigation.triggerGroups.get("jail").onColliders[0];
  knight.ai.release = {
    target: { x: 198, y: 150 },
    ignoredColliders: new Set([jail]),
    startsAt: 0,
  };

  await tickNpcAi(session, 1000, 0.1);

  assert.equal(knight.ai.release, null);
  assert.ok(knight.position.x > 198, `expected direct pursuit, got ${knight.position.x}`);
});

test("chase AI cannot cross a wall when no route exists", async () => {
  const { session, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 240, y: 150 };
  knight.ai.collisionRadius = 20;
  session.heroPosition = { x: 60, y: 150 };
  session.actors.get(session.heroDoid).position = session.heroPosition;
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    cellSize: 30,
    staticColliders: [
      { type: "rectangle", x: 150, y: 150, halfWidth: 5, halfHeight: 150, angle: 0 },
    ],
  });

  for (let index = 0; index < 20; index++) {
    await tickNpcAi(session, 1000 + index * 100, 0.1);
  }

  assert.ok(knight.position.x >= 175, `knight crossed the wall to x=${knight.position.x}`);
  assert.equal(knight.ai.state, "blocked");
});

test("melee AI cannot attack a nearby hero through a wall", async () => {
  const { session, heroDoid, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 120, y: 150 };
  knight.ai.collisionRadius = 20;
  session.heroPosition = { x: 60, y: 150 };
  session.actors.get(heroDoid).position = session.heroPosition;
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 180, maxY: 300 },
    cellSize: 30,
    staticColliders: [
      { type: "rectangle", x: 90, y: 150, halfWidth: 5, halfHeight: 150, angle: 0 },
    ],
  });

  await tickNpcAi(session, 1000, 0.1);

  assert.equal(session.actors.get(heroDoid).hitPoints, 200);
  assert.equal(knight.ai.state, "blocked");
});

test("AI releases a downed hero instead of retaining a stale chase target", async () => {
  const { session, sent, heroDoid, knightDoid } = makeSession();
  const hero = session.actors.get(heroDoid);
  const knight = session.actors.get(knightDoid);
  hero.hitPoints = 0;
  hero.dead = true;
  knight.ai.engaged = true;
  knight.ai.state = "chase";
  knight.ai.path = [{ x: 100, y: 0 }];
  knight.ai.pathTarget = { x: 0, y: 0 };

  await tickNpcAi(session, 1000, 0.1);

  assert.equal(knight.ai.engaged, false);
  assert.equal(knight.ai.state, "idle");
  assert.equal(knight.ai.path, null);
  assert.equal(knight.ai.pathTarget, null);
  assert.equal(sent.length, 0);
});

/**
 * A release reports the actor as handled on every tick it runs, so one that can
 * never reach its exit never reaches ordinary AI either — it will not chase and
 * will not answer to a player standing beside it. That is the last one out of a
 * cage left standing there for the rest of the floor.
 */
test("a release that cannot make headway is given up on", async () => {
  const { session, knightDoid } = makeSession();
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 150, y: 150 };
  knight.ai.collisionRadius = 20;
  knight.ai.moveSpeed = 180;
  session.heroPosition = { x: 50, y: 150 };
  session.actors.get(session.heroDoid).position = session.heroPosition;

  // Walled in on every side, so no step of the release can move it anywhere.
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 },
    staticColliders: [
      { type: "rectangle", x: 150, y: 90, halfWidth: 120, halfHeight: 20, angle: 0 },
      { type: "rectangle", x: 150, y: 210, halfWidth: 120, halfHeight: 20, angle: 0 },
      { type: "rectangle", x: 90, y: 150, halfWidth: 20, halfHeight: 120, angle: 0 },
      { type: "rectangle", x: 210, y: 150, halfWidth: 20, halfHeight: 120, angle: 0 },
    ],
  });
  knight.ai.release = {
    target: { x: 280, y: 150 },
    ignoredColliders: new Set(),
    startsAt: 0,
  };

  await tickNpcAi(session, 1000, 0.1);
  // Long enough that nothing has moved for more than the stall allowance.
  await tickNpcAi(session, 3000, 0.1);
  assert.equal(knight.ai.release, null, "it stops trying rather than hanging");
});

test("a stunned monster neither closes in nor swings", async () => {
  const { tickNpcAi } = await import("../src/socket/ai.js");
  const { grantBuff, clearDungeonBuffs } = await import("../src/socket/buffs.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  let next = 900;
  const session = {
    id: 7,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map(),
    allocateDoid: () => ++next,
    send: () => {},
  };
  session.actors.set(500, {
    hitPoints: 400,
    maxHitPoints: 400,
    position: { x: 1000, y: 1000 },
    collisionRadius: 30,
  });
  session.actors.set(700, {
    hitPoints: 100,
    maxHitPoints: 100,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 30,
    position: { x: 1400, y: 1000 },
    ai: {
      state: "idle",
      engaged: true,
      aggroRadius: 2000,
      disengageDistance: 4000,
      moveSpeed: 200,
      collisionRadius: 30,
      attackRange: 80,
      attackTimerMs: 100,
      attackRandMs: 0,
      nextAttackAt: 0,
      attackType: 920050,
      damage: 5,
    },
  });

  // STUN_L4 is what a garlic trap leaves: three seconds, MOVEMENT zero.
  await grantBuff(session, "STUN_L4", { affectedActor: 700, attackerActor: 500 });

  const before = { ...session.actors.get(700).position };
  await tickNpcAi(session, Date.now(), 0.5);

  assert.deepEqual(session.actors.get(700).position, before, "it cannot close in");
  assert.equal(session.actors.get(500).hitPoints, 400, "and cannot swing");

  clearDungeonBuffs(session);
});

test("an enemy's swings are spaced by its own timer and its own spread", async () => {
  /**
   * "Attack speeds are broken, they are far quicker than they should be."
   *
   * They were, by about half again, and every enemy of a kind swung on the same
   * millisecond as every other — because the cadence was `AttackTimer` flat and
   * `AttackTimeRand` was not read at all. The corpus gives both halves directly,
   * as gaps between one NPC's successive ReceiveAttackChoreography frames:
   *
   *   BRUTE  (1.5 + 1)           p05 1584  p50 2092  p75 2442   n=110
   *   KNIGHT (1.5 + 1)           p05 1604  p50 2259  p75 2841   n=146
   *   ICE_IMP (2 + 1)            p05 2077  p50 2667  p75 2992   n=1429
   *   KNIGHT_MARKSMAN (2 + 1.5)  p05 2151  p50 3176  p75 4258   n=446
   *
   * Each floor sits on the row's `AttackTimer` and each spread is the row's
   * `AttackTimeRand`. So: uniform, rolled per swing, no animation term.
   */
  const { attackIntervalMs } = await import("../src/socket/ai.js");
  const rolls = Array.from({ length: 400 }, () =>
    attackIntervalMs({ attackTimerMs: 1500, attackRandMs: 1000 })
  );

  assert.ok(Math.min(...rolls) >= 1500, "never quicker than the row's timer");
  assert.ok(Math.max(...rolls) <= 2500, "never slower than timer plus spread");
  assert.ok(new Set(rolls).size > 300, "a fresh roll each swing, not one per NPC");

  const mean = rolls.reduce((sum, value) => sum + value, 0) / rolls.length;
  assert.ok(Math.abs(mean - 2000) < 120, `mean ${Math.round(mean)} should sit near timer + spread/2`);

  // A row with no spread is still spaced by its timer, and the four enemy rows
  // authoring `AttackTimer` 0 do not fall through to one attack per tick.
  assert.equal(attackIntervalMs({ attackTimerMs: 2000, attackRandMs: 0 }), 2000);
  assert.equal(attackIntervalMs({ attackTimerMs: 0, attackRandMs: 0 }), 100);
});

test("a swing lands where and when the timeline says, or not at all", async () => {
  /**
   * "Their attacks don't connect and we take damage anyway."
   *
   * Reach was `Range` from the monster's middle in every direction, and the
   * damage came off the bar in the same breath as the animation was sent. The
   * timeline disagrees on both counts, per attack:
   *
   *   EN_SWORD_SLASH    circle r40 at 45 in front, frame 11 of 12
   *   EN_MACE_CHOP      circle r35 at 70 in front, frame 3
   *   EN_SPEAR_THRUST   200x70 box at 100 in front, frame 4
   *
   * A knight's sword is therefore in the air for 458ms before it can hurt
   * anyone, and it covers a circle in front of him rather than a ring around
   * him. Both of those are enough on their own to hit somebody watching the
   * swing miss.
   */
  const slash = [{ type: "circleCollider", radius: 40, xOffset: 45, frame: 11 }];
  const swing = async (heroAt, heading = 0) => {
    const { session, sent, heroDoid, knightDoid } = makeSession();
    session.heroPosition = { ...heroAt };
    session.actors.get(heroDoid).position = { ...heroAt };
    const knight = session.actors.get(knightDoid);
    knight.position = { x: 0, y: 0 };
    knight.heading = heading;

    await performNpcAttack(session, knightDoid, {
      attackType: 920050,
      damage: 1,
      weaponPower: 1,
      attackColliders: slash,
      impactFrame: 11,
    });
    return { session, sent, heroDoid, hero: session.actors.get(heroDoid) };
  };

  // Nothing lands while the sword is still going up.
  const early = await swing({ x: 45, y: 0 });
  assert.equal(early.hero.hitPoints, 200, "the bar does not move before the impact frame");
  assert.ok(
    early.sent.map(readUpdate).some((packet) => packet.fieldId === 143),
    "though the animation is already playing"
  );

  // 11 frames at 24fps is 458ms; give it room and the hit arrives.
  await new Promise((resolve) => setTimeout(resolve, 620));
  assert.ok(early.hero.hitPoints < 200, "and lands when the sword does");

  // Standing behind him is standing out of it, however close.
  const behind = await swing({ x: -45, y: 0 });
  await new Promise((resolve) => setTimeout(resolve, 620));
  assert.equal(behind.hero.hitPoints, 200, "a knight does not cut backwards");

  // Neither does distance the arc never reaches.
  const far = await swing({ x: 140, y: 0 });
  await new Promise((resolve) => setTimeout(resolve, 620));
  assert.equal(far.hero.hitPoints, 200, "nor past the end of his reach");

  // Turned around, the same spot is inside it.
  const turned = await swing({ x: -45, y: 0 }, 180);
  await new Promise((resolve) => setTimeout(resolve, 620));
  assert.ok(turned.hero.hitPoints < 200, "facing it, the same spot is hit");
});

/**
 * A monster's shot is a flight, not a decision.
 *
 * "The ranged enemies' attacks don't connect and we take damage anyway." They
 * did: with no timeline collider to check, the shot fell through to the
 * immediate path and the bar dropped in the same tick the animation was sent.
 *
 * The official does not work that way and the captures say so twice over.
 * First, authority: across 54 recordings the client proposes 4646 combat
 * results and every one is the hero hitting something — it never proposes a
 * monster hitting the hero, and the 4469 results that do are all sent by the
 * server. Second, timing: the server's result arrives long after the animation,
 * by a median of 584ms for KNIGHT_MARKSMAN, 842 for ICE_IMP, 983 for
 * KNIGHT_THROWING and 1494 for PURPLE_SPECTER — and most ranged choreographies
 * are never paired with a result at all.
 *
 * Ticked directly rather than waited on, so the suite does not spend a second
 * of real time per arrow.
 */
const shootingSession = () => {
  const made = makeSession();
  const { session, knightDoid, heroDoid } = made;
  const knight = session.actors.get(knightDoid);
  knight.position = { x: 0, y: 0 };
  knight.heading = 0;
  session.heroPosition = { x: 350, y: 0 };
  session.actors.get(heroDoid).position = { x: 350, y: 0 };
  session.actors.get(heroDoid).collisionRadius = 30;
  return made;
};

const arrowAi = {
  attackType: 920050,
  damage: 1,
  weaponPower: 1,
  attackColliders: [],
  impactFrame: 0,
  // PROJ_ARROW, straight, 700 a second, 800 of range, 15 across.
  projectile: { ProjSpeed: 700, Range: 800, CollisionSize: 15, FlightPattern: "STRAIGHT" },
  projectileLaunches: [
    { frame: 0, xOffset: 0, yOffset: 0, headingOffset: 0, headingOffsetAngle: 0, headingRandomnessAngle: 0 },
  ],
};

test("a shot is put in the air rather than resolved on the spot", async () => {
  const { session, sent, heroDoid } = shootingSession();
  const hero = session.actors.get(heroDoid);

  await performNpcAttack(session, 20, arrowAi);
  assert.ok(
    sent.map(readUpdate).some((packet) => packet.fieldId === 143),
    "the animation plays at once"
  );
  assert.equal(hero.hitPoints, 200, "but nothing is taken off the bar for it");
  assert.equal(session.activeTrapProjectiles?.length, 1, "an arrow is in the air");
});

test("a shot lands when it arrives, and not before", async () => {
  const { session, heroDoid } = shootingSession();
  const hero = session.actors.get(heroDoid);
  await performNpcAttack(session, 20, arrowAi);

  // 350 units at 700 a second is half a second. A tenth of that is not enough.
  await tickTrapProjectiles(session, 0.1);
  assert.equal(hero.hitPoints, 200, "still in flight at 70 units");

  await tickTrapProjectiles(session, 0.5);
  assert.ok(hero.hitPoints < 200, "and lands once it has covered the distance");
  assert.equal(session.activeTrapProjectiles.length, 0, "the arrow is spent");
});

test("stepping out of the line is a miss", async () => {
  const { session, heroDoid } = shootingSession();
  const hero = session.actors.get(heroDoid);
  await performNpcAttack(session, 20, arrowAi);

  await tickTrapProjectiles(session, 0.1);
  // Out of the path while it is still travelling — the dodge that was being
  // taken as a hit.
  hero.position = { x: 350, y: 400 };
  session.heroPosition = { ...hero.position };

  await tickTrapProjectiles(session, 0.6);
  assert.equal(hero.hitPoints, 200, "the arrow goes past");
});

test("stepping into the line can be hit by it", async () => {
  const { session, heroDoid } = shootingSession();
  const hero = session.actors.get(heroDoid);
  hero.position = { x: 350, y: 400 };
  session.heroPosition = { ...hero.position };

  await performNpcAttack(session, 20, arrowAi);
  await tickTrapProjectiles(session, 0.1);
  assert.equal(hero.hitPoints, 200, "not there yet, and not in the way either");

  hero.position = { x: 350, y: 0 };
  session.heroPosition = { ...hero.position };
  await tickTrapProjectiles(session, 0.5);
  assert.ok(hero.hitPoints < 200, "walking into it is walking into it");
});

test("a shot dies at its authored range rather than following anyone", async () => {
  const { session, heroDoid } = shootingSession();
  const hero = session.actors.get(heroDoid);
  hero.position = { x: 5000, y: 0 };
  session.heroPosition = { ...hero.position };

  await performNpcAttack(session, 20, arrowAi);
  // 800 of range at 700 a second is 1.14s; two seconds is well past it.
  await tickTrapProjectiles(session, 2);
  assert.equal(hero.hitPoints, 200, "nothing is hit at five thousand units");
  assert.equal(session.activeTrapProjectiles.length, 0, "and the arrow is gone");
});

test("the shot leaves on the frame the timeline looses it", async () => {
  /**
   * A bow looses on frame 2 and a specter's fireball leaves its hands on frame
   * 30, which is 1250ms of casting. The official's median delay for a
   * PURPLE_SPECTER is 1494ms, so the cast is most of it — launching at frame
   * zero would be a second and a quarter early on that attack alone.
   */
  const { session } = shootingSession();
  await performNpcAttack(session, 20, {
    ...arrowAi,
    projectileLaunches: [
      { frame: 30, xOffset: 0, yOffset: 0, headingOffset: 0, headingOffsetAngle: 0, headingRandomnessAngle: 0 },
    ],
  });
  assert.equal(session.activeTrapProjectiles?.length ?? 0, 0, "nothing has left yet");

  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(session.activeTrapProjectiles?.length, 1, "it leaves when the cast finishes");
});

test("two shots fly independently", async () => {
  const { session, heroDoid } = shootingSession();
  const hero = session.actors.get(heroDoid);
  session.objects.set(21, session.objects.get(20));
  session.actors.set(21, { hitPoints: 15, maxHitPoints: 15, position: { x: 0, y: -600 }, heading: 90 });

  await performNpcAttack(session, 20, arrowAi);
  await performNpcAttack(session, 21, arrowAi);
  assert.equal(session.activeTrapProjectiles.length, 2);

  // The one aimed along +x reaches the hero; the one at 90 degrees does not.
  await tickTrapProjectiles(session, 0.6);
  assert.ok(hero.hitPoints < 200, "the aimed one landed");
  assert.equal(session.activeTrapProjectiles.length, 1, "and only that one is spent");
});

test("headingOffset is a distance and headingOffsetAngle is the angle", async () => {
  /**
   * `ProjectileAttackTimelineAction.execute`, read from the client:
   *
   *   angle  = heading + headingOffsetAngle
   *   origin = worldCenter + headingOffset x (cos, sin)(angle) + (xOffset, yOffset)
   *   direction = getHeadingAsVector(headingOffsetAngle)
   *
   * This server added `headingOffset` to the heading as though it were degrees.
   * `TM_GATLING_ARROW` authors 40 with an angle of zero, so every arrow out of
   * an aztec statue flew forty degrees away from the one drawn — damage from a
   * line with nothing on it, which is the report exactly.
   */
  const { session } = shootingSession();
  await performNpcAttack(session, 20, {
    ...arrowAi,
    projectileLaunches: [
      { frame: 0, xOffset: 0, yOffset: 0, headingOffset: 40, headingOffsetAngle: 0, headingRandomnessAngle: 0 },
    ],
  });

  const [shot] = session.activeTrapProjectiles;
  assert.ok(shot, "the arrow left");
  // A distance of 40 moves the muzzle forward; it does not turn the shot.
  assert.ok(Math.abs(shot.direction.x - 1) < 1e-9, "still flying straight ahead");
  assert.ok(Math.abs(shot.direction.y) < 1e-9, "and not forty degrees off it");
  assert.ok(shot.position.x >= 40 - 1e-6, `muzzle at ${shot.position.x}, expected 40 ahead`);

  // The angle, when it is authored, is the one that turns it.
  const turned = shootingSession();
  await performNpcAttack(turned.session, 20, {
    ...arrowAi,
    projectileLaunches: [
      { frame: 0, xOffset: 0, yOffset: 0, headingOffset: 0, headingOffsetAngle: 90, headingRandomnessAngle: 0 },
    ],
  });
  const [across] = turned.session.activeTrapProjectiles;
  assert.ok(Math.abs(across.direction.x) < 1e-9, "ninety degrees turns it");
  assert.ok(Math.abs(across.direction.y - 1) < 1e-9);
});

test("a shot leaves from the body, not from the feet", async () => {
  /**
   * The client builds the projectile's Box2D body at `worldCenter`, which is
   * the actor's first navigation circle — 22 above the wire position for the
   * heroes and 97 of 122 monsters. Victims are already tested there, through
   * `collisionPointOf`; the shooter was not, so the two ends of the same flight
   * were 22 units apart in the one axis a sidestep uses.
   */
  const { session } = shootingSession();
  const knight = session.actors.get(20);
  knight.constant = "KNIGHT_MARKSMAN";

  await performNpcAttack(session, 20, arrowAi);
  const [shot] = session.activeTrapProjectiles;
  const { collisionPointOf } = await import("../src/socket/navigation.js");
  const expected = collisionPointOf(knight, knight.position) ?? knight.position;
  assert.equal(shot.position.y, expected.y, "launched from the same centre victims are judged at");
});

test("every action a timeline authors is loosed, on its own frame", async () => {
  /**
   * `TM_GATLING_ARROW` authors six projectile actions — frames 35, 39, 43, 47,
   * 51 and 54 — and the server was simulating one. Five sixths of a gatling
   * burst was drawn by the client and unknown to this server, which is both a
   * volley that does nothing and a volley that cannot be dodged honestly.
   *
   * `TN_AREA_PULL_PULSE_ATTACK` authors sixteen, four each on frames 10, 20, 30
   * and 40, so actions sharing a frame must all leave.
   */
  const { projectileLaunches } = await import("../src/gamemaster.js");
  const gatling = await projectileLaunches("TM_GATLING_ARROW");
  assert.deepEqual(
    gatling.map((launch) => launch.frame),
    [35, 39, 43, 47, 51, 54],
    "the authored frames, in order"
  );
  assert.equal(gatling[0].headingOffset, 40, "and its muzzle is a distance");
  assert.equal(gatling[0].headingOffsetAngle, 0, "fired straight ahead");

  const pulse = await projectileLaunches("TN_AREA_PULL_PULSE_ATTACK");
  assert.equal(pulse.length, 16);
  assert.equal(pulse.filter((launch) => launch.frame === 10).length, 4, "four share frame 10");

  // And the server looses all of them: three on one frame arrive together.
  const { session } = shootingSession();
  await performNpcAttack(session, 20, {
    ...arrowAi,
    projectileLaunches: [
      { frame: 0, headingOffsetAngle: 0 },
      { frame: 0, headingOffsetAngle: 20 },
      { frame: 0, headingOffsetAngle: -20 },
    ],
  });
  assert.equal(session.activeTrapProjectiles.length, 3, "a fan is three arrows, not one");
});

/**
 * An NPC row carries `Attack1`, `Attack2` and `Attack3` and this server read
 * only the first, so every monster in the game had one move for its whole life.
 * Counting `attackType` off the field-143 choreographies in 66 official
 * recordings: ICE_IMP 531/493/378 across its three, SHAMAN_IMP 230/148/138/110,
 * RAPTOR 99/65, LION 120/31.
 */
test("a monster with three attacks uses more than the first one", async () => {
  const { session, knightDoid, sent } = makeSession();
  const npc = session.actors.get(knightDoid);
  npc.position = { x: 60, y: 0 };
  npc.ai.engaged = true;
  npc.ai.attackRange = 300;
  npc.ai.attacks = [
    { attackType: 920050, range: 300, minRange: 0, rechargeMs: 0, readyAt: 0, damage: 1, impactFrame: 0 },
    { attackType: 920163, range: 300, minRange: 0, rechargeMs: 0, readyAt: 0, damage: 1, impactFrame: 0 },
    { attackType: 920051, range: 300, minRange: 0, rechargeMs: 0, readyAt: 0, damage: 1, impactFrame: 0 },
  ];

  for (let tick = 0; tick < 400; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const used = new Set(
    sent
      .map(readUpdate)
      .filter((packet) => packet.fieldId === 143)
      .map((packet) => {
        packet.reader.u8();
        packet.reader.u8();
        return packet.reader.u32();
      })
  );
  assert.equal(used.size, 3, `all three should appear, saw ${[...used].join(",")}`);
});

/**
 * `MinRange` is the bottom of an attack's band. EN_ICE_IMP_ATTACK is a spear
 * throw with a MinRange of 400, so it is not a thing an imp does to someone
 * standing on its toes.
 */
test("an attack with a MinRange is not used from inside it", async () => {
  const { session, knightDoid, sent } = makeSession();
  const npc = session.actors.get(knightDoid);
  npc.position = { x: 60, y: 0 };
  npc.ai.engaged = true;
  npc.ai.attackRange = 700;
  npc.ai.attacks = [
    { attackType: 920163, range: 700, minRange: 400, rechargeMs: 0, readyAt: 0, damage: 1, impactFrame: 0 },
    { attackType: 920050, range: 700, minRange: 0, rechargeMs: 0, readyAt: 0, damage: 1, impactFrame: 0 },
  ];

  for (let tick = 0; tick < 200; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const used = sent
    .map(readUpdate)
    .filter((packet) => packet.fieldId === 143)
    .map((packet) => {
      packet.reader.u8();
      packet.reader.u8();
      return packet.reader.u32();
    });
  assert.ok(used.length > 0, "it still attacks with the one that fits");
  assert.ok(!used.includes(920163), "but never with the one it is stood inside the range of");
});

/**
 * `AI_RechargeT` is each attack's own cooldown — half a second for an ordinary
 * melee and fifteen for a shaman's summon, which is what keeps the summon rare
 * among its three-second bolts.
 */
test("an attack's own recharge keeps it from being spammed", async () => {
  const { session, knightDoid, sent } = makeSession();
  const npc = session.actors.get(knightDoid);
  npc.position = { x: 60, y: 0 };
  npc.ai.engaged = true;
  npc.ai.attackTimerMs = 500;
  npc.ai.attackRandMs = 0;
  npc.ai.attacks = [
    { attackType: 920050, range: 300, minRange: 0, rechargeMs: 0, readyAt: 0, damage: 1, impactFrame: 0 },
    { attackType: 920163, range: 300, minRange: 0, rechargeMs: 15000, readyAt: 0, damage: 1, impactFrame: 0 },
  ];
  npc.ai.attackRange = 300;

  // Thirty seconds: the cheap one is free to fire throughout, the expensive one
  // may come round twice.
  for (let tick = 0; tick < 300; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  const counts = new Map();
  for (const packet of sent.map(readUpdate).filter((p) => p.fieldId === 143)) {
    packet.reader.u8();
    packet.reader.u8();
    const id = packet.reader.u32();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  assert.ok((counts.get(920050) ?? 0) > 10, "the half-second one is used freely");
  assert.ok(
    (counts.get(920163) ?? 0) <= 3,
    `the fifteen-second one is rationed: ${counts.get(920163)} in 30s`
  );
});

/**
 * Some attacks move the thing making them, and the client does it only for the
 * local player — `AttackAutoMoveTimelineAction.buildFromJson` returns the action
 * `if (param1.isOwner)` and null otherwise. So a monster's lunge is the
 * server's. Measured on 66 recordings, taking each NPC's furthest displacement
 * after a swing against the way it was facing: HEADBUTT (400@0) went 252 at
 * +0.99, BACKOFF (500@180) went 202 at -0.99, against 25-49 at +0.7 for the
 * attacks that author no move at all.
 */
test("an attack that authors a backwards move takes the monster backwards", async () => {
  const { session, knightDoid } = makeSession();
  const npc = session.actors.get(knightDoid);
  npc.position = { x: 60, y: 0 };
  npc.ai.engaged = true;
  npc.ai.attacks = [
    {
      attackType: 920050,
      range: 300,
      minRange: 0,
      rechargeMs: 0,
      readyAt: 0,
      damage: 1,
      impactFrame: 0,
      moveAmount: 500,
      moveAngle: 180,
      moveDurationMs: 500,
    },
  ];
  npc.ai.attackRange = 300;

  // One swing, then just the move: far enough apart that nothing else fires.
  await tickNpcAi(session, 1000, 0.1);
  for (let tick = 1; tick <= 5; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);

  // It was at x=60 facing the hero at the origin, so backwards is +x.
  assert.ok(
    npc.position.x > 200,
    `it should have hopped away from him, ended at x=${npc.position.x.toFixed(0)}`
  );
  assert.ok(Math.abs(npc.position.y) < 40, "and straight back, not off to one side");
});

test("a forward attack lunge stops on the near side instead of teleporting through the hero", async () => {
  const { session, knightDoid } = makeSession();
  const monster = session.actors.get(knightDoid);
  monster.position = { x: 80, y: 0 };
  monster.ai.engaged = true;
  monster.ai.nextAttackAt = Number.POSITIVE_INFINITY;
  monster.ai.lunge = { until: 2000, x: -800, y: 0 };

  await tickNpcAi(session, 1000, 0.25);

  const contact = 70; // Both test actors use the 35-unit fallback body.
  assert.ok(
    monster.position.x >= contact - 0.01,
    `the lunge crossed the hero in one update and landed at ${monster.position.x}`
  );
  assert.ok(
    monster.position.x <= 80,
    `the collision guard moved it away from the intended lunge: ${monster.position.x}`
  );
});

test("a melee windup does not chase or turn after a retreating hero", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, heroDoid, knightDoid } = makeSession();
  const hero = session.actors.get(heroDoid);
  const monster = session.actors.get(knightDoid);
  const slash = [{ type: "circleCollider", radius: 40, xOffset: 45, frame: 11 }];
  monster.position = { x: 80, y: 0 };
  monster.ai.engaged = true;
  monster.ai.nextAttackAt = 0;
  monster.ai.attackRange = 80;
  monster.ai.attacks = [{
    attackType: 920050,
    attackSpeed: 1,
    range: 80,
    minRange: 0,
    rechargeMs: 0,
    readyAt: 0,
    weaponPower: 1,
    attackColliders: slash,
    projectileLaunches: [],
    impactFrame: 11,
    attackLockFrame: 11,
    moveAmount: 0,
    moveDurationMs: 0,
  }];

  await tickNpcAi(session, 1000, 0.1);
  const castPosition = { ...monster.position };
  const castHeading = monster.heading;
  assert.ok(monster.ai.attackLockedUntil > 1450, "the authored impact frame did not lock windup");

  hero.position = { x: -200, y: 0 };
  session.heroPosition = { ...hero.position };
  await tickNpcAi(session, 1250, 0.25);

  assert.deepEqual(monster.position, castPosition, "the monster chased during its swing");
  assert.equal(monster.heading, castHeading, "the melee collider turned to follow the dodge");

  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(hero.hitPoints, 200, "the retreat cleared the impact but still took damage");
  session.hazardBeats?.get(`swing:${knightDoid}`)?.();
});

test("stunning a monster during windup cancels its pending melee impact", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, heroDoid, knightDoid } = makeSession();
  const hero = session.actors.get(heroDoid);
  session.actors.get(knightDoid).position = { x: 60, y: 0 };
  const stun = (await import("../src/gamemaster.js")).buffForConstant;

  await performNpcAttack(session, knightDoid, {
    attackType: 920050,
    attackSpeed: 1,
    weaponPower: 1,
    attackColliders: [{ type: "circleCollider", radius: 100, xOffset: 0, frame: 11 }],
  }, heroDoid);
  session.activeBuffs = new Map([[
    999,
    { affectedActor: knightDoid, buff: await stun("STUN_L1"), effectAbility: "STUN" },
  ]]);

  t.mock.timers.tick(500);
  await Promise.resolve();

  assert.equal(hero.hitPoints, 200, "the stunned monster's queued swing still landed");
  session.hazardBeats?.get(`swing:${knightDoid}`)?.();
});

test("an NPC attack's authored speed controls its cadence and choreography", async () => {
  /**
   * SAVAGE_BOW is the clean capture fixture: EN_POISON_ARROW authors AttackSpd
   * 0.25. The official sends playSpeed 0.25 on all 100 recorded casts and its
   * cadence starts around 6.2 seconds, while this server sent playSpeed 1 and
   * started again around 1.5 seconds.
   */
  const { session, knightDoid, sent } = makeSession();
  const npc = session.actors.get(knightDoid);
  const poisonArrow = await attackForConstant("EN_POISON_ARROW");
  npc.position = { x: 60, y: 0 };
  npc.ai.engaged = true;
  npc.ai.attackRange = 300;
  npc.ai.attackTimerMs = 1500;
  npc.ai.attackRandMs = 0;
  npc.ai.attacks = [{
    attackType: poisonArrow.Id,
    attackSpeed: poisonArrow.AttackSpd,
    range: 300,
    minRange: 0,
    rechargeMs: 0,
    readyAt: 0,
    damage: 1,
    impactFrame: 0,
  }];

  await tickNpcAi(session, 1000, 0.1);

  assert.equal(npc.ai.nextAttackAt, 7000, "1.5 seconds at quarter speed becomes 6 seconds");
  const choreography = sent.map(readUpdate).find((packet) => packet.fieldId === 143);
  assert.ok(choreography, "the poison arrow choreography was sent");
  choreography.reader.u8();
  choreography.reader.u8();
  assert.equal(choreography.reader.u32(), poisonArrow.Id);
  choreography.reader.u32();
  choreography.reader.u8();
  assert.equal(choreography.reader.f32(), 0.25, "the client plays the same quarter-speed cast");
});

test("zero-damage NPC skills buff their caster without injuring the target", async (t) => {
  /**
   * The official sends no CombatResult for monster roars or taunts. A captured
   * EN_JUGGERNAUT_SWING instead creates SUPER_SPEED_BOOSTER_L3 on its caster
   * immediately before the choreography. The old fallback turned its authored
   * zero damage into one point and discarded the self buff.
   */
  const { session, heroDoid, knightDoid, sent } = makeSession();
  enableBuffs(session);
  t.after(() => clearDungeonBuffs(session));
  const skill = await attackForConstant("EN_JUGGERNAUT_SWING");

  await performNpcAttack(session, knightDoid, {
    attackType: skill.Id,
    attackSpeed: skill.AttackSpd,
    weaponPower: 1,
    damage: 0,
    attackColliders: contactShape,
    impactFrame: 0,
  }, heroDoid);

  assert.equal(session.actors.get(heroDoid).hitPoints, 200, "the buff skill dealt damage");
  assert.ok(
    !sent
      .filter((frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD)
      .map(readUpdate)
      .some((packet) => packet.fieldId === 160),
    "a zero-damage skill sent a combat result"
  );
  assert.ok(
    [...session.activeBuffs.values()].some(
      (active) =>
        active.affectedActor === knightDoid &&
        active.buff?.Constant === "SUPER_SPEED_BOOSTER_L3"
    ),
    "the skill did not buff its caster"
  );
});

test("NPC hits apply both authored target effects", async (t) => {
  /**
   * EN_BABY_YETI_SUICIDE authors CHILL_L1 and FREEZE. Official captures create
   * both buffs from the yeti; the NPC damage path created neither.
   */
  const { session, heroDoid, knightDoid } = makeSession();
  enableBuffs(session);
  t.after(() => clearDungeonBuffs(session));
  const skill = await attackForConstant("EN_BABY_YETI_SUICIDE");

  await performNpcAttack(session, knightDoid, {
    attackType: skill.Id,
    attackSpeed: skill.AttackSpd,
    weaponPower: 1,
    damage: 1,
    attackColliders: contactShape,
    impactFrame: 0,
  }, heroDoid);

  const effects = new Set(
    [...session.activeBuffs.values()]
      .filter((active) => active.affectedActor === heroDoid)
      .map((active) => active.buff?.Constant)
  );
  assert.ok(effects.has("CHILL_L1"), "the primary target buff was lost");
  assert.ok(effects.has("FREEZE"), "the secondary target buff was lost");
});

test("an invulnerable target receives neither NPC damage nor its debuff", async (t) => {
  const { session, heroDoid, knightDoid } = makeSession();
  enableBuffs(session);
  t.after(() => clearDungeonBuffs(session));
  await grantBuff(session, "INVULNERBILITY", {
    affectedActor: heroDoid,
    attackerActor: heroDoid,
  });
  const poisonArrow = await attackForConstant("EN_POISON_ARROW");

  await performNpcAttack(session, knightDoid, {
    attackType: poisonArrow.Id,
    attackSpeed: poisonArrow.AttackSpd,
    weaponPower: 1,
    damage: 1,
    attackColliders: contactShape,
    impactFrame: 0,
  }, heroDoid);

  assert.equal(session.actors.get(heroDoid).hitPoints, 200);
  assert.ok(
    ![...session.activeBuffs.values()].some(
      (active) => active.affectedActor === heroDoid && active.buff?.Constant === "POISON_L1"
    ),
    "an attack rejected by invulnerability still applied poison"
  );
});

test("freeze and disabled-controls debuffs stop NPC attacks", async (t) => {
  for (const constant of ["FREEZE", "FROZEN"]) {
    const { session, heroDoid, knightDoid } = makeSession();
    enableBuffs(session);
    t.after(() => clearDungeonBuffs(session));
    const knight = session.actors.get(knightDoid);
    knight.position = { x: 60, y: 0 };
    knight.heading = 180;
    knight.ai.engaged = true;
    knight.ai.nextAttackAt = 0;
    await grantBuff(session, constant, {
      affectedActor: knightDoid,
      attackerActor: heroDoid,
    });

    await tickNpcAi(session, 1000, 0.1);

    assert.equal(
      session.actors.get(heroDoid).hitPoints,
      200,
      `${constant} left the frozen NPC able to attack`
    );
  }
});

test("an enemy accelerates into its authored top speed instead of starting there", () => {
  const ai = { moveSpeed: 180 };
  const samples = Array.from({ length: 4 }, () => npcWalkingSpeed(ai, 180, 0.25));

  assert.ok(samples[0] < 180, "the first chase tick already used top speed");
  assert.equal(samples[3], 180, "the authored top speed was never reached");
  const firstSecond = samples.reduce((sum, speed) => sum + speed * 0.25, 0);
  assert.ok(
    Math.abs(firstSecond / 180 - 2 / 3) < 1e-9,
    `first-second movement ratio ${firstSecond / 180} does not match the capture ramp`
  );
});

test("NPC damage that defence fully absorbs stays at zero", async () => {
  /** The official corpus contains zero-damage EN_SWORD_SLASH results. */
  const { session, heroDoid, knightDoid, sent } = makeSession();
  const hero = session.actors.get(heroDoid);
  hero.stats = new Map([["SHOOT_DEF", 100]]);
  const slash = await attackForConstant("EN_SWORD_SLASH");

  await performNpcAttack(session, knightDoid, {
    attackType: slash.Id,
    attackSpeed: slash.AttackSpd,
    weaponPower: 1,
    damage: 1,
    attackColliders: contactShape,
    impactFrame: 0,
  }, heroDoid);

  assert.equal(hero.hitPoints, 200, "the fallback restored damage that defence absorbed");
  const result = sent.map(readUpdate).find((packet) => packet.fieldId === 160);
  assert.ok(result, "an absorbed hit is still reported");
  result.reader.u32();
  result.reader.u32();
  assert.equal(result.reader.i32(), 0, "the combat result did not preserve zero damage");
});

test("authored attack speed also paces projectile release frames", async () => {
  const { session } = shootingSession();
  const poisonArrow = await attackForConstant("EN_POISON_ARROW");

  await performNpcAttack(session, 20, {
    ...arrowAi,
    attackType: poisonArrow.Id,
    attackSpeed: poisonArrow.AttackSpd,
    projectileLaunches: [{ frame: 2, headingOffsetAngle: 0 }],
  });

  // Frame 2 is 83ms at normal speed and 333ms at the authored quarter speed.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(session.activeTrapProjectiles?.length ?? 0, 0, "the arrow left at full speed");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(session.activeTrapProjectiles?.length, 1, "the slowed release frame never arrived");
});

test("NPC timeline invulnerability protects the caster for the authored window", async (t) => {
  const { session, heroDoid, knightDoid } = makeSession();
  enableBuffs(session);
  t.after(() => clearDungeonBuffs(session));
  const skill = await attackForConstant("EN_DBUSTER_BERSERK");
  const startedAt = Date.now();

  await performNpcAttack(session, knightDoid, {
    attackType: skill.Id,
    attackSpeed: skill.AttackSpd,
    weaponPower: 1,
    damage: 0,
    attackColliders: [],
    impactFrame: 0,
  }, heroDoid);

  assert.ok(
    session.invulnerableUntil.get(knightDoid) >= startedAt + 2800,
    "the server-owned invulnerability action was discarded"
  );
});

test("an NPC suicide action retires its caster on the authored frame", async () => {
  const { session, heroDoid, knightDoid } = makeSession();
  const skill = await attackForConstant("EN_BABY_YETI_SUICIDE");

  await performNpcAttack(session, knightDoid, {
    attackType: skill.Id,
    attackSpeed: skill.AttackSpd,
    weaponPower: 1,
    damage: 1,
    attackColliders: [{ type: "circleCollider", radius: 150, xOffset: 0, frame: 15 }],
    impactFrame: 15,
  }, heroDoid);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(!session.actors.has(knightDoid), "the suicide skill left its caster alive");
  assert.ok(!session.objects.has(knightDoid), "the retired caster stayed on the floor");
});

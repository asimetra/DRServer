import assert from "node:assert/strict";
import test from "node:test";

import { attackForConstant } from "../src/gamemaster.js";
import { tickNpcAi } from "../src/socket/ai.js";
import { applyDamage } from "../src/socket/combat.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";
import { createNavigationState } from "../src/socket/navigation.js";

const field = (frame) =>
  frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD
    ? frame.readUInt16LE(8)
    : null;

/**
 * A specter's cycle runs on its own clock (behaviours/teleport.js): it starts
 * by going when it engages, then each visible period waits
 * PreTeleportAttack, has its attack moment — a swing if the gate lets it —
 * stands PostTeleportAttack from that moment, goes out, hides
 * TeleportRecurT + rand, and comes back within TeleportRange of its victim.
 */
const makeSpecterSession = async ({ heroAt = { x: 0, y: 0 }, specterAt = { x: 100, y: 0 }, range = 400, engaged = true, navigation } = {}) => {
  const heroDoid = 10;
  const specterDoid = 20;
  const attack = await attackForConstant("SPECTER_LIGHTNING");
  const sent = [];
  const regenerations = [];
  const hero = { hitPoints: 200, maxHitPoints: 200, collisionRadius: 25, position: { ...heroAt }, team: TEAM.PLAYERS };
  const specter = {
    hitPoints: 200,
    maxHitPoints: 200,
    collisionRadius: 25,
    position: { ...specterAt },
    heading: 180,
    team: TEAM.ENEMIES,
    isEnemy: true,
    teleportRegenerate: (position, heading) => regenerations.push({ position: { ...position }, heading }),
    ai: {
      kind: "enemy",
      behavior: "TELEPORT_AI",
      state: "idle",
      engaged,
      aggroRadius: 600,
      disengageDistance: 1600,
      moveSpeed: 0,
      collisionRadius: 25,
      attackRange: range,
      attacks: [{ attackType: attack.Id, attackSpeed: attack.AttackSpd, range, minRange: 0, rechargeMs: 0, readyAt: 0, weaponPower: 1, attackColliders: [], projectile: null, projectileLaunches: [] }],
      attackTimerMs: 1500,
      attackRandMs: 0,
      nextAttackAt: 0,
      teleportRange: 450,
      teleportRecurMs: 2000,
      teleportRecurRandMs: 1000,
      preTeleportAttackMs: 1500,
      postTeleportAttackMs: 3000,
      teleportInTimeline: "TELEPORT_IN",
      teleportOutTimeline: "TELEPORT_OUT",
      teleportOutDelayMs: 500,
      teleportPhase: "visible",
    },
  };
  const session = {
    id: 70,
    heroDoid,
    heroPosition: hero.position,
    navigation,
    objects: new Map([[heroDoid, CLID.HeroGameObject], [specterDoid, CLID.DistributedNPCGameObject]]),
    actors: new Map([[heroDoid, hero], [specterDoid, specter]]),
    random: () => 0.5,
    send: (frame) => sent.push(frame),
  };
  const swings = () => sent.filter((frame) => field(frame) === 143).length;
  const timeline = (name) => sent.some((frame) => field(frame) === 145 && frame.includes(Buffer.from(name)));
  const disables = () => sent.filter((frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_DISABLE_RESP).length;
  return { session, specter, hero, sent, regenerations, swings, timeline, disables, specterDoid };
};

/** Ticks of 250 ms from `from` to `to`, inclusive. */
const run = async (session, from, to) => {
  for (let now = from; now <= to; now += 250) await tickNpcAi(session, now, 0.25);
};

test("a specter starts by going, then swings on its clock and goes out PostTeleportAttack after", async () => {
  const { session, specter, sent, regenerations, swings, timeline, disables, specterDoid } = await makeSpecterSession();

  // Activation: its first engaged tick disables it, with no out animation.
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(specter.teleportHidden, true, "an engaged specter did not start by going");
  assert.equal(disables(), 1);
  assert.equal(timeline("TELEPORT_OUT"), false, "activation played an out animation");

  // Hidden TeleportRecurT + rand (2000 + 0.5 x 1000), then back within range with TELEPORT_IN.
  await run(session, 1250, 3250);
  assert.equal(regenerations.length, 0, "it came back before TeleportRecurT/Rand");
  await tickNpcAi(session, 3500, 0.25);
  assert.equal(regenerations.length, 1);
  assert.ok(timeline("TELEPORT_IN"));
  assert.ok(Math.hypot(regenerations[0].position.x, regenerations[0].position.y) <= 450, "it came back beyond TeleportRange");

  const before = specter.hitPoints;
  // PreTeleportAttack (1500): the attack moment at 5000, a swing since it is in reach and in sight.
  await run(session, 3750, 4750);
  assert.equal(swings(), 0, "it swung before PreTeleportAttack");
  await tickNpcAi(session, 5000, 0.25);
  assert.equal(swings(), 1, "the attack moment did not swing");

  // PostTeleportAttack (3000) from the swing: out at 8000, disabled teleportOutDelayMs (500) later.
  await run(session, 5250, 7750);
  assert.equal(timeline("TELEPORT_OUT"), false, "it went before PostTeleportAttack");
  await tickNpcAi(session, 8000, 0.25);
  assert.equal(specter.ai.teleportPhase, "teleport-out");
  assert.ok(timeline("TELEPORT_OUT"));
  assert.equal(specter.teleportHidden, false, "TELEPORT_OUT disabled it at once");
  await run(session, 8250, 8500);
  assert.equal(specter.teleportHidden, true);
  assert.equal(disables(), 2);

  let announced = false;
  assert.equal(applyDamage(session, specterDoid, 10, () => (announced = true)), false);
  assert.equal(specter.hitPoints, before, "a hidden specter took damage");
  assert.equal(announced, false, "a hidden specter emitted a visible combat result");
  assert.equal(sent.length > 0, true);
});

test("a specter with no reach of the hero still goes out after Pre + Post, and comes back within range", async () => {
  const { session, specter, hero, regenerations, swings, timeline } = await makeSpecterSession();
  await run(session, 1000, 3500); // activation, and back at 3500
  assert.equal(regenerations.length, 1);
  // The hero walks off, out of its reach but not out of the fight (DisengageDist 1600).
  hero.position.x = 1000;
  session.heroPosition = hero.position;
  await run(session, 3750, 7750);
  assert.equal(timeline("TELEPORT_OUT"), false, "out before Pre + Post");
  await tickNpcAi(session, 8000, 0.25); // 3500 + 1500 + 3000
  assert.ok(timeline("TELEPORT_OUT"), "a specter that could not swing waited for one instead of its clock");
  assert.equal(swings(), 0);
  await run(session, 8250, 11000);
  assert.equal(regenerations.length, 2, "it did not come back");
  assert.ok(Math.hypot(regenerations[1].position.x - 1000, regenerations[1].position.y) <= 450, "it came back beyond TeleportRange of the hero");
  assert.equal(specter.teleportHidden, false);
});

test("a specter with nowhere clear round the hero comes back where it went out, and keeps cycling", async () => {
  // The hero stands inside a block too big for any spot within TeleportRange to be clear.
  const navigation = createNavigationState({
    bounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 },
    cellSize: 60,
    staticColliders: [{ type: "rectangle", x: 0, y: 0, halfWidth: 700, halfHeight: 700, angle: 0 }],
  });
  const { session, specter, regenerations } = await makeSpecterSession({ specterAt: { x: 900, y: 0 }, navigation });
  await run(session, 1000, 3500);
  assert.equal(regenerations.length, 1);
  assert.deepEqual(regenerations[0].position, { x: 900, y: 0 }, "with no clear point it should come back where it went");
  await run(session, 3750, 11000);
  assert.equal(regenerations.length, 2, "and keep cycling");
  assert.deepEqual(regenerations[1].position, { x: 900, y: 0 });
  assert.equal(specter.teleportHidden, false);
});

test("a specter outside its AggroRadius never cycles; inside it, it activates", async () => {
  const { session, specter, hero, disables } = await makeSpecterSession({ engaged: false, specterAt: { x: 700, y: 0 } });
  await run(session, 1000, 6000);
  assert.equal(specter.ai.engaged, false);
  assert.equal(disables(), 0, "a dormant specter went");
  assert.notEqual(specter.teleportHidden, true);
  // The hero comes within 600: it engages, and goes at once.
  hero.position.x = 200;
  session.heroPosition = hero.position;
  await tickNpcAi(session, 6250, 0.25);
  assert.equal(specter.ai.engaged, true);
  assert.equal(specter.teleportHidden, true, "it engaged and did not start its cycle");
  assert.equal(disables(), 1);
});

/**
 * A teleporter lets go as everything else does: past its DisengageDist, or
 * with nothing left to fight. Hidden, it comes back where it went out and
 * stands there visible; going out, it comes back in.
 */
test("a hidden specter whose hero runs past its DisengageDist comes back where it went out, and idles", async () => {
  const { session, specter, hero, regenerations, timeline } = await makeSpecterSession();
  await tickNpcAi(session, 1000, 0.25);
  assert.equal(specter.teleportHidden, true);
  const wentOut = { ...specter.position };
  hero.position.x = 3000;
  session.heroPosition = hero.position;
  await tickNpcAi(session, 1250, 0.25);
  assert.equal(specter.teleportHidden, false, "still hidden");
  assert.deepEqual(specter.position, wentOut, "back where it went out");
  assert.deepEqual(regenerations.at(-1)?.position, wentOut);
  assert.ok(timeline("TELEPORT_IN"));
  assert.equal(specter.ai.engaged, false);
  assert.equal(specter.ai.state, "idle");
  await run(session, 1500, 6000);
  assert.equal(specter.teleportHidden, false, "it stays on the floor while it idles");
});

test("a specter let go during its out animation comes back in", async () => {
  const { session, specter, hero, sent, timeline, disables } = await makeSpecterSession();
  await run(session, 1000, 8000);
  assert.equal(specter.ai.teleportPhase, "teleport-out");
  const before = disables();
  const outAt = sent.length;
  hero.position.x = 3000;
  session.heroPosition = hero.position;
  await run(session, 8250, 9000);
  assert.equal(specter.teleportHidden, false);
  assert.equal(specter.ai.teleportPhase, "visible");
  assert.equal(disables(), before, "disabled after it let go");
  assert.ok(sent.slice(outAt).some((frame) => field(frame) === 145 && frame.includes(Buffer.from("TELEPORT_IN"))), "not brought back in");
});

/** A teleporting pet hidden when its fight ends is never left off the floor (review probe 4). */
test("a shadow wolf hidden when its fight ends comes back on the floor", async () => {
  const heroDoid = 10;
  const regen = [];
  const hero = { hitPoints: 200, maxHitPoints: 200, collisionRadius: 26, position: { x: 0, y: 0 }, team: TEAM.PLAYERS };
  const monster = {
    hitPoints: 99999, maxHitPoints: 99999, collisionRadius: 30, team: TEAM.ENEMIES, isEnemy: true, position: { x: 230, y: 0 }, heading: 180,
    ai: { kind: "enemy", state: "idle", engaged: false, aggroRadius: 0, disengageDistance: 1600, moveSpeed: 0, attackRange: 80, attackTimerMs: 1500, nextAttackAt: Infinity, attackType: 920050, attackColliders: [] },
  };
  const wolf = {
    hitPoints: 999, maxHitPoints: 999, collisionRadius: 25, team: TEAM.PLAYERS, isPet: true, position: { x: 120, y: 0 }, heading: 0,
    teleportRegenerate: (position) => regen.push({ ...position }),
    ai: {
      kind: "pet", behavior: "TELEPORT_AI", ownerDoid: heroDoid, state: "idle", engaged: false, aggroRadius: 300, disengageDistance: 1000,
      tetherDistance: 400, returnDistance: 250, collects: {}, moveSpeed: 312, attackRange: 120, keepDistance: 0, targetTimerMs: 1000,
      targetRandMs: 0, nextAttackAt: Infinity, attacks: [{ attackType: 1, range: 120, minRange: 0, rechargeMs: 0, readyAt: 0 }],
      teleportRange: 75, teleportRecurMs: 200, teleportRecurRandMs: 300, preTeleportAttackMs: 200, postTeleportAttackMs: 1200,
      teleportOutDelayMs: 1000, teleportPhase: "visible",
    },
  };
  const session = {
    id: 71, heroDoid, heroPosition: hero.position, random: () => 0.5, send: () => {},
    objects: new Map([[heroDoid, CLID.HeroGameObject], [20, CLID.DistributedNPCGameObject], [30, CLID.DistributedNPCGameObject]]),
    actors: new Map([[heroDoid, hero], [20, monster], [30, wolf]]),
  };
  let now = 1000;
  for (let tick = 0; tick < 40 && !(wolf.teleportHidden && regen.length >= 1); tick++) await tickNpcAi(session, (now += 250), 0.25);
  assert.equal(wolf.teleportHidden, true, "it went out in its fight");
  monster.dead = true;
  monster.hitPoints = 0;
  await run(session, now + 250, now + 1500);
  assert.equal(wolf.teleportHidden, false, "left off the floor when its fight ended");
});

/** Following its owner, a teleporting pet walks: its cycle is its fight's. */
test("a shadow wolf walking back to its owner does not teleport", async () => {
  const heroDoid = 10;
  const hero = { hitPoints: 200, maxHitPoints: 200, collisionRadius: 26, position: { x: 0, y: 0 }, team: TEAM.PLAYERS };
  const wolf = {
    hitPoints: 999, maxHitPoints: 999, collisionRadius: 25, team: TEAM.PLAYERS, isPet: true, position: { x: 700, y: 0 }, heading: 0,
    teleportRegenerate: () => {},
    ai: {
      kind: "pet", behavior: "TELEPORT_AI", ownerDoid: heroDoid, state: "idle", engaged: false, aggroRadius: 300, disengageDistance: 1000,
      tetherDistance: 400, returnDistance: 250, collects: {}, moveSpeed: 312, attackRange: 120, keepDistance: 0, targetTimerMs: 1000,
      targetRandMs: 0, nextAttackAt: Infinity, attacks: [{ attackType: 1, range: 120, minRange: 0, rechargeMs: 0, readyAt: 0 }],
      teleportRange: 75, teleportRecurMs: 200, teleportRecurRandMs: 300, preTeleportAttackMs: 200, postTeleportAttackMs: 1200,
      teleportOutDelayMs: 1000, teleportPhase: "visible",
    },
  };
  const session = {
    id: 72, heroDoid, heroPosition: hero.position, random: () => 0.5, send: () => {},
    objects: new Map([[heroDoid, CLID.HeroGameObject], [30, CLID.DistributedNPCGameObject]]),
    actors: new Map([[heroDoid, hero], [30, wolf]]),
  };
  let hid = false;
  for (let now = 1250; now <= 4000; now += 250) {
    await tickNpcAi(session, now, 0.25);
    hid ||= Boolean(wolf.teleportHidden);
  }
  assert.equal(hid, false, "it teleported on its way back");
  assert.ok(wolf.position.x < 400, `it walked back: ${Math.round(wolf.position.x)}`);
});

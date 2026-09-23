import assert from "node:assert/strict";
import test from "node:test";

import { attackForConstant } from "../src/gamemaster.js";
import { tickNpcAi } from "../src/socket/ai.js";
import { applyDamage } from "../src/socket/combat.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";

const field = (frame) =>
  frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD
    ? frame.readUInt16LE(8)
    : null;

test("TELEPORT_AI disables, relocates, regenerates, and observes its authored waits", async () => {
  const heroDoid = 10;
  const specterDoid = 20;
  const attack = await attackForConstant("SPECTER_LIGHTNING");
  const sent = [];
  const regenerations = [];
  const hero = {
    hitPoints: 200,
    maxHitPoints: 200,
    collisionRadius: 25,
    position: { x: 0, y: 0 },
    team: TEAM.PLAYERS,
  };
  const specter = {
    hitPoints: 200,
    maxHitPoints: 200,
    collisionRadius: 25,
    position: { x: 100, y: 0 },
    heading: 180,
    team: TEAM.ENEMIES,
    isEnemy: true,
    teleportRegenerate: (position, heading) =>
      regenerations.push({ position: { ...position }, heading }),
    ai: {
      kind: "enemy",
      behavior: "TELEPORT_AI",
      state: "idle",
      engaged: true,
      aggroRadius: 600,
      disengageDistance: 1600,
      moveSpeed: 0,
      collisionRadius: 25,
      attackRange: 400,
      attacks: [{
        attackType: attack.Id,
        attackSpeed: attack.AttackSpd,
        range: 400,
        minRange: 0,
        rechargeMs: 0,
        readyAt: 0,
        weaponPower: 1,
        attackColliders: [],
        projectile: null,
        projectileLaunches: [],
      }],
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
      teleportPhase: "visible",
    },
  };
  const session = {
    id: 70,
    heroDoid,
    heroPosition: hero.position,
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [specterDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, hero],
      [specterDoid, specter],
    ]),
    random: () => 0.5,
    send: (frame) => sent.push(frame),
  };

  await tickNpcAi(session, 1000, 0.25);
  assert.equal(sent.filter((frame) => field(frame) === 143).length, 0, "pre-attack wait was skipped");

  await tickNpcAi(session, 2500, 0.25);
  assert.equal(sent.filter((frame) => field(frame) === 143).length, 1, "first attack never fired");

  await tickNpcAi(session, 5250, 0.25);
  assert.equal(specter.teleportHidden, undefined, "specter vanished before PostTeleportAttack");

  await tickNpcAi(session, 5500, 0.25);
  assert.equal(specter.teleportHidden, true);
  assert.ok(sent.some((frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_DISABLE_RESP));

  const before = specter.hitPoints;
  let announced = false;
  assert.equal(applyDamage(session, specterDoid, 10, () => (announced = true)), false);
  assert.equal(specter.hitPoints, before, "a hidden specter took damage");
  assert.equal(announced, false, "a hidden specter emitted a visible combat result");

  await tickNpcAi(session, 7750, 0.25);
  assert.equal(regenerations.length, 0, "TeleportRecurT/Rand ended early");

  await tickNpcAi(session, 8000, 0.25);
  assert.equal(regenerations.length, 1, "specter was not regenerated with the same doid");
  assert.equal(specter.teleportHidden, false);
  assert.notDeepEqual(regenerations[0].position, { x: 100, y: 0 });
  assert.ok(
    Math.hypot(regenerations[0].position.x, regenerations[0].position.y) <= 400,
    "teleport destination left the attack's usable range"
  );
  assert.ok(sent.some((frame) => field(frame) === 145), "TELEPORT_IN was not sent");

  await tickNpcAi(session, 9250, 0.25);
  assert.equal(sent.filter((frame) => field(frame) === 143).length, 1);
  await tickNpcAi(session, 9500, 0.25);
  assert.equal(
    sent.filter((frame) => field(frame) === 143).length,
    2,
    "PreTeleportAttack was not observed after regeneration"
  );
});

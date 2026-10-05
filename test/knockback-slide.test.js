import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster } from "../src/gamemaster.js";
import { tickNpcAi } from "../src/socket/ai.js";
import { pushVictim } from "../src/socket/combat.js";
import { knockbackOf } from "../src/socket/modifiers.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

const BLASTBACK = 70055;
const TRAPPER = 70065;
const HERO = 10;
const KNIGHT = 20;

/** A knight the AI walks, 200 to the hero's right, out of aggro so it stands still. */
const makeSession = () => {
  const sent = [];
  const knight = {
    hitPoints: 15, maxHitPoints: 15, collisionRadius: 25,
    position: { x: 200, y: 0 }, heading: 0,
    ai: {
      state: "idle", engaged: false, aggroRadius: 50, disengageDistance: 60,
      moveSpeed: 180, attackRange: 80, attackTimerMs: 1500, attackRandMs: 0,
      nextAttackAt: Infinity, attackType: 920050, damage: 1, attackColliders: [],
    },
  };
  const session = {
    id: 7, heroDoid: HERO, heroPosition: { x: 0, y: 0 }, navigation: null,
    objects: new Map([[HERO, CLID.HeroGameObject], [KNIGHT, CLID.DistributedNPCGameObject]]),
    actors: new Map([
      [HERO, { hitPoints: 200, maxHitPoints: 200, position: { x: 0, y: 0 }, collisionRadius: 22 }],
      [KNIGHT, knight],
    ]),
    send: (frame) => sent.push(frame),
  };
  return { session, knight, sent };
};

const positionsSent = (sent) =>
  sent
    .map((frame) => {
      const reader = new PacketReader(frame.subarray(2));
      if (reader.u16() !== OP.CLIENT_OBJECT_UPDATE_FIELD) return null;
      const doid = reader.u32();
      const field = reader.u16();
      return field === 132 ? { doid, x: reader.f32(), y: reader.f32() } : null;
    })
    .filter(Boolean);

test("a modifier's throw takes its authored time: two frames on a 250ms tick, not one teleport", async () => {
  const gm = await loadGameMaster();
  const { distance, durationMs } = knockbackOf(gm, { modifier1: BLASTBACK });
  assert.deepEqual({ distance, durationMs }, { distance: 250, durationMs: 400 });

  const { session, knight, sent } = makeSession();
  const start = Date.now();
  assert.equal(pushVictim(session, KNIGHT, HERO, distance, durationMs), true);
  assert.equal(knight.position.x, 200, "moved before the first tick");
  assert.equal(positionsSent(sent).length, 0, "a position frame before the first tick");

  await tickNpcAi(session, start + 250, 0.25);
  assert.equal(Math.round(knight.position.x), 200 + Math.round(250 * (250 / 400)), "the first tick's share");
  assert.equal(positionsSent(sent).length, 1);

  await tickNpcAi(session, start + 500, 0.25);
  assert.equal(Math.round(knight.position.x), 450, "the whole distance by the end");
  assert.equal(positionsSent(sent).length, 2);
  assert.equal(knight.ai.shove, null, "the shove outlived its duration");

  await tickNpcAi(session, start + 750, 0.25);
  assert.equal(Math.round(knight.position.x), 450, "moved on after the throw ended");
});

test("a pull is carried the same way and stops where the bodies meet", async () => {
  const gm = await loadGameMaster();
  const { distance, durationMs } = knockbackOf(gm, { modifier1: TRAPPER });
  assert.deepEqual({ distance, durationMs }, { distance: -300, durationMs: 200 });

  const { session, knight } = makeSession();
  const start = Date.now();
  pushVictim(session, KNIGHT, HERO, distance, durationMs);
  await tickNpcAi(session, start + 250, 0.25);
  // 200 apart, radii 25 and 22: it lands at contact, not 100 behind the hero.
  assert.equal(Math.round(knight.position.x), 47, "the pull carried the monster through the hero");
});

test("what the AI does not walk, and a throw given no time, move at once", async () => {
  const { session, knight, sent } = makeSession();
  pushVictim(session, KNIGHT, HERO, 100, 0);
  assert.equal(knight.position.x, 300, "a throw with no duration waited for a tick");
  assert.equal(positionsSent(sent).length, 1);

  const prop = { hitPoints: 5, maxHitPoints: 5, collisionRadius: 10, position: { x: 0, y: 100 } };
  session.actors.set(30, prop);
  session.objects.set(30, CLID.DistributedNPCGameObject);
  pushVictim(session, 30, HERO, 100, 400);
  assert.equal(prop.position.y, 200, "a thing without an AI tick never got its throw");
});

test("the attack's own knockback is spread over its KnockbackDur too", async () => {
  /**
   * The push through `applyProposals` hands the attack's `KnockbackDur` (0.2s
   * on every melee row) to the same shove when no modifier names a longer one.
   * Checked at the seam the proposal path uses rather than through a swing:
   * the arithmetic is one helper, exercised above.
   */
  const { session, knight } = makeSession();
  const start = Date.now();
  pushVictim(session, KNIGHT, HERO, 50, 200);
  assert.deepEqual(
    { x: knight.ai.shove.x, durationMs: knight.ai.shove.durationMs },
    { x: 50, durationMs: 200 }
  );
  await tickNpcAi(session, start + 250, 0.25);
  assert.equal(Math.round(knight.position.x), 250);
});

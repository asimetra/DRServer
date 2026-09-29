import test from "node:test";
import assert from "node:assert/strict";

import { loadGameMaster, weaponForConstant } from "../src/gamemaster.js";
import { performNpcAttack } from "../src/socket/combat.js";
import { npcAttackChoices } from "../src/socket/npc-attacks.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";

/**
 * How many times one monster cast lands on one hero, against the official.
 *
 * The most hits one cast landed on one hero equals the attack's collider frame
 * count for all 40 monster attacks the corpus has: BABY_YETI_SCRATCH three,
 * YETI_PUNCH two, SHADOW_SLASH six, every single-frame swing one. This server
 * allowed one per cast, which is most of why a boss or a miniboss "barely hit".
 */

const HERO = 10;
const NPC = 20;

const cast = async (
  constant,
  attackConstant,
  { heroAt = { x: 30, y: 0 }, scheduleMovement = null } = {}
) => {
  const gm = await loadGameMaster();
  const npc = gm.raw.Npc.find((row) => row.Constant === constant);
  const weapon = npc.Weapon1 ? await weaponForConstant(npc.Weapon1) : null;
  const choices = await npcAttackChoices(npc, weapon, Number(weapon?.Power ?? 1));
  const chosen = choices.find((choice) => choice.attackType === gm.raw.Attack.find((row) => row.Constant === attackConstant).Id);
  assert.ok(chosen, `${constant} authors ${attackConstant}`);

  const timers = [];
  const sent = [];
  const session = {
    id: 1,
    heroDoid: HERO,
    dungeonActive: true,
    floorDoid: 55,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [NPC, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [HERO, { hitPoints: 60_000, maxHitPoints: 60_000, position: heroAt, collisionRadius: 25, team: TEAM.PLAYERS }],
      [NPC, { hitPoints: 1000, maxHitPoints: 1000, position: { x: 0, y: 0 }, heading: 0, constant, level: 13, team: TEAM.ENEMIES, isEnemy: true }],
    ]),
    combatClock: {
      setTimeout: (run, delay) => (timers.push({ run, delay }), timers.length),
      clearTimeout: () => {},
    },
    send: (frame) => sent.push(frame),
    allocateDoid: () => 900,
  };
  await performNpcAttack(session, NPC, { ...chosen, attackHeading: 0 }, HERO);
  scheduleMovement?.(session, timers);
  for (const timer of timers.sort((a, b) => a.delay - b.delay)) await timer.run();
  const results = sent.filter((frame) => frame.readUInt32LE(4) === HERO && frame.readUInt16LE(8) === 160);
  return { results: results.length, session };
};

test("a baby yeti's three-frame scratch lands three times on a hero standing in it", async () => {
  const { results } = await cast("BABY_YETI", "EN_BABY_YETI_SCRATCH");
  assert.equal(results, 3, "the official's scratch: 349 casts once, 119 twice, 152 three times");
});

test("a single-frame swing still lands once", async () => {
  const { results } = await cast("BRUTE", "EN_MACE_CHOP");
  assert.equal(results, 1);
});

test("a persistent collider catches a hero who enters between re-hit boundaries", async () => {
  const { results } = await cast("RED_SPECTER_HEAVY", "SPECTER_FLAME_DIVE", {
    heroAt: { x: 200, y: 0 },
    scheduleMovement: (session, timers) => {
      timers.push({
        delay: 13.5 * (1000 / 24),
        run: () => {
          session.actors.get(HERO).position = { x: 0, y: 0 };
        },
      });
    },
  });
  assert.equal(results, 1, "the collider is still alive through frame 16");
});

test("a late hit starts its own re-hit delay instead of using global frame windows", async () => {
  const { results } = await cast("RED_SPECTER_HEAVY", "SPECTER_FLAME_DIVE", {
    heroAt: { x: 200, y: 0 },
    scheduleMovement: (session, timers) => {
      timers.push(
        {
          delay: 10.5 * (1000 / 24),
          run: () => {
            session.actors.get(HERO).position = { x: 0, y: 0 };
          },
        },
        {
          delay: 12.5 * (1000 / 24),
          run: () => {
            session.actors.get(HERO).position = { x: 200, y: 0 };
          },
        }
      );
    },
  });
  assert.equal(results, 1, "frame 12 is only one frame after the actual hit on frame 11");
});

/**
 * The Mini Boss Imp's pulse authors a 500-unit circle on frame 0 and sixteen
 * bolts after it; the official's hero took up to seventeen hits from one cast.
 */
test("an attack that authors a collider and projectiles does both", async () => {
  const { results, session } = await cast("MINI_BOSS_IMP", "EN_AREA_PULL_PULSE_ATTACK", {
    heroAt: { x: 200, y: 0 },
  });
  assert.equal(results, 1, "the circle catches the hero");
  assert.equal(session.activeTrapProjectiles?.length, 16, "and the bolts are loosed");
});

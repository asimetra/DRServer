import test from "node:test";
import assert from "node:assert/strict";

import { dealTrapHit } from "../src/socket/combat.js";
import { attackForConstant, npcForConstant } from "../src/gamemaster.js";
import { CLID } from "../src/socket/opcodes.js";

/**
 * When a trap staggers the hero, against the official corpus.
 *
 * Every damaging spike hit carried suffer and knockback here. The official's
 * 332 damaging `TRAP_SPIKES` hits on heroes carry them 78% of the time, and
 * what decides it is how soon the hit follows the hero's previous trap hit:
 * within 0.3s, 15% of 95 hits are staggered; after longer, 81 to 88%.
 *
 * It is what a row of spike beds is made of: standing against one, the beds
 * hit together, and here a knockback from each threw the hero every time.
 */

const HERO = 10;
const TRAP = 20;
const KNOCKBACK_AT = 34; // frame: doid(4) field(2) … damage at 18, attack(10), when, suffer, knockback

const session = (sent) => ({
  id: 7,
  heroDoid: HERO,
  playerActors: new Set([HERO]),
  dungeonActive: true,
  heroStats: new Map([["MELEE_DEF", 0], ["SHOOT_DEF", 0], ["MAGIC_DEF", 0]]),
  objects: new Map([
    [HERO, CLID.HeroGameObject],
    [TRAP, CLID.DistributedNPCGameObject],
  ]),
  actors: new Map([
    [HERO, { hitPoints: 60_000, maxHitPoints: 60_000, constant: "BERSERKER" }],
    [TRAP, { constant: "CASTLE_CATACOMB_TRAP_SPIKES" }],
  ]),
  send: (frame) => sent.push(frame),
});

const spikes = async () => {
  const trap = await npcForConstant("CASTLE_CATACOMB_TRAP_SPIKES");
  return attackForConstant(trap.Attack1);
};

const knockbacks = (sent) =>
  sent
    .filter((frame) => frame.readUInt32LE(4) === HERO && frame.readUInt16LE(8) === 160)
    .map((frame) => frame.readUInt8(KNOCKBACK_AT));

test("a second trap hit within a moment of the first does not knock the hero back again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const attack = await spikes();
  const sent = [];
  const floor = session(sent);

  await dealTrapHit(floor, TRAP, attack, HERO, 1);
  t.mock.timers.tick(100);
  await dealTrapHit(floor, TRAP, attack, HERO, 1);

  assert.deepEqual(knockbacks(sent), [1, 0], "the first bed staggers, the one beside it does not");
});

test("a trap hit after a pause staggers the hero as before", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const attack = await spikes();
  const sent = [];
  const floor = session(sent);

  await dealTrapHit(floor, TRAP, attack, HERO, 1);
  t.mock.timers.tick(500);
  await dealTrapHit(floor, TRAP, attack, HERO, 1);

  assert.deepEqual(knockbacks(sent), [1, 1]);
});

import assert from "node:assert/strict";
import { weaponWith } from "./helpers/weapons.js";
import test from "node:test";

import { attackForConstant } from "../src/gamemaster.js";
import { slideShoved } from "../src/socket/ai.js";
import {
  dealTrapHit,
  handleProposeCombatResults,
  heroStaggerFor,
  staggerFor,
} from "../src/socket/combat.js";
import { CLID } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

/**
 * Who flinches, against the official's recordings.
 *
 * A combat result carries two bytes the client proposes as zero and the server
 * decides: `suffer` and `knockback`. They are what makes the victim react —
 * the client plays its stagger or its knockback only when told to — and the
 * official fills them in on every hit. This server echoed a hero's hit with
 * both still zero, so nothing a hero struck ever flinched; and it set them on
 * a monster's hit whenever the attack authored any chance at all, so a thrown
 * axe with a 15% chance staggered the hero every time.
 *
 * What the recordings say, both ways round:
 *
 *   an attack that authors a Knockback   suffer and knockback, every time
 *   one that does not                    suffer, by its SufferChance
 *
 * KATANA_SOUL_BANG (chance 1, knockback 50) is 6583 of 6583 staggered and 95%
 * thrown; LONG_BOW_SHOT (chance 0.1, none) is 8%; THROW_AXE_KN (chance 0.05,
 * knockback 30) staggers three hits in four all the same.
 */

const HERO = 500;
const VICTIM = 700;
const TRAP = 20;
const ATTACK = { LONG_BOW_SHOT: 900504, KATANA_SOUL_BANG: 902509 };
const SUFFER_AT = 33;
const KNOCKBACK_AT = 34;
const EFFECTIVENESS_AT = 37;

const heroHit = async (attackId, { random = () => 0.5, abilities, moveSpeed = 180 } = {}) => {
  const sent = [];
  const monster = {
    hitPoints: 9_000_000,
    maxHitPoints: 9_000_000,
    constant: "BRUTE",
    isEnemy: true,
    position: { x: 1100, y: 1000 },
    collisionRadius: 25,
    ai: { moveSpeed },
    abilities,
  };
  const session = {
    id: 95,
    heroDoid: HERO,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    // Holding something that has the attack: a hit names its slot's weapon.
    heroWeapons: [await weaponWith(attackId, { power: 500 })],
    random,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [VICTIM, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([[VICTIM, monster]]),
    allocateDoid: () => 900,
    send: (frame) => sent.push(frame),
  };
  const result = new PacketWriter()
    .u32(HERO).u32(VICTIM).i32(0).u8(0).u8(0).u32(attackId).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  const before = Date.now();
  await handleProposeCombatResults(
    session,
    new PacketReader(new PacketWriter().u16(result.length).raw(result).body())
  );
  const echo = sent.find((frame) => frame.readUInt32LE(4) === VICTIM && frame.readUInt16LE(8) === 144);
  assert.ok(echo, "the hit is echoed on the victim");
  // The throw is spread over the attack's KnockbackDur by the AI tick
  // (knockback-slide.test.js); settle it, so `moved` is where it ends.
  slideShoved(session, VICTIM, monster, Date.now() + 10_000);
  return {
    suffer: echo.readUInt8(SUFFER_AT),
    knockback: echo.readUInt8(KNOCKBACK_AT),
    moved: Math.round(monster.position.x - 1100),
    heldFor: (monster.ai.staggeredUntil ?? 0) - before,
  };
};

test("a hero's hit that authors a knockback staggers the monster and throws it", async () => {
  const hit = await heroHit(ATTACK.KATANA_SOUL_BANG);

  assert.deepEqual([hit.suffer, hit.knockback], [1, 1]);
  // The official's monsters end a median 48 from where they stood; the row says 50.
  assert.equal(hit.moved, 50, "away from the hero, by what the attack authors");
});

/**
 * And it is not only a picture. After a hit that staggered it, an official
 * monster's next attack comes a second later at the quartile and 1.4 at the
 * median; after one that did not, 0.16 and 0.56.
 */
test("a staggered monster is held for the attack's hit stun", async () => {
  const hit = await heroHit(ATTACK.KATANA_SOUL_BANG);
  assert.ok(hit.heldFor >= 990 && hit.heldFor <= 1200, `a second, as its row says — saw ${hit.heldFor}ms`);

  const arrow = await heroHit(ATTACK.LONG_BOW_SHOT, { random: () => 0.9 });
  assert.ok(arrow.heldFor <= 0, "and a hit that did not stagger holds nothing");
});

test("a hit with no knockback staggers by its chance", async () => {
  // LONG_BOW_SHOT: SufferChance 0.1.
  const lucky = await heroHit(ATTACK.LONG_BOW_SHOT, { random: () => 0.05 });
  const usual = await heroHit(ATTACK.LONG_BOW_SHOT, { random: () => 0.5 });

  assert.deepEqual([lucky.suffer, lucky.knockback, lucky.moved], [1, 0, 0]);
  assert.deepEqual([usual.suffer, usual.knockback, usual.moved], [0, 0, 0]);
});

test("a monster that cannot be thrown still flinches", async () => {
  const hit = await heroHit(ATTACK.KATANA_SOUL_BANG, { abilities: new Set(["KNOCKBACK_IMMUNE"]) });
  assert.deepEqual([hit.suffer, hit.knockback, hit.moved], [1, 0, 0]);
});

/**
 * A barrel is told it was thrown — the official flags 99% of 722 such hits on
 * props, which is the client shaking it — and stays where it is.
 */
test("what cannot walk is told it was thrown and is not moved", async () => {
  const hit = await heroHit(ATTACK.KATANA_SOUL_BANG, { moveSpeed: 0 });
  assert.deepEqual([hit.suffer, hit.knockback, hit.moved], [1, 1, 0]);
});

// --- a monster's hit on a hero -------------------------------------------------

test("a monster's attack with no knockback rolls its chance on the hero", async () => {
  const farAxe = await attackForConstant("THROW_FAR_AXE_KN"); // chance 0.15, no knockback
  assert.deepEqual(staggerFor(farAxe, 10, () => 0.1), { suffer: 1, knockback: 0 });
  assert.deepEqual(staggerFor(farAxe, 10, () => 0.2), { suffer: 0, knockback: 0 }, "287 recorded: 11%");
});

test("one that authors a knockback staggers whatever its chance says", async () => {
  const axe = await attackForConstant("THROW_AXE_KN"); // chance 0.05, knockback 30
  assert.deepEqual(staggerFor(axe, 10, () => 0.99), { suffer: 1, knockback: 1 });
  assert.deepEqual(staggerFor(axe, 0, () => 0), { suffer: 0, knockback: 0 }, "a hit that did nothing does not");
});

/**
 * A hero already thrown is not thrown again by the next blow. Sorted by the
 * time since the hero last staggered, the official's 684 knockback hits by
 * monsters stagger 1% within 0.3s, 31% up to 0.7s, 83% up to 2s and every one
 * of the 345 after that — the same shape its floor traps have.
 */
test("a hero just staggered shrugs off the next blow, and not the one after", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const tackle = await attackForConstant("EN_RAPTOR_TACKLE"); // hit stun 1, knockback 0.2
  const session = { objects: new Map([[HERO, CLID.HeroGameObject]]) };

  assert.deepEqual(heroStaggerFor(session, tackle, 10, HERO), { suffer: 1, knockback: 1 });
  t.mock.timers.tick(600);
  assert.deepEqual(heroStaggerFor(session, tackle, 10, HERO), { suffer: 0, knockback: 0 }, "still reeling");
  t.mock.timers.tick(700);
  assert.deepEqual(heroStaggerFor(session, tackle, 10, HERO), { suffer: 1, knockback: 1 }, "on his feet again");
});

// --- the legendary shields -----------------------------------------------------

/**
 * `Barrier`, `Cover` and `Comprehend` halve one type of damage each, and the
 * official says so on the hit: 408 of 408 arrows on a hero carrying `Cover`
 * arrive with effectiveness -1, which the client draws as the weak flash and
 * the pale number. The half was taken here and nothing said it had been.
 */
const arrowOn = async (weapons) => {
  const sent = [];
  const session = {
    id: 96,
    heroDoid: HERO,
    playerActors: new Set([HERO]),
    dungeonActive: true,
    heroWeapons: weapons,
    heroStats: new Map([["MELEE_DEF", 0], ["SHOOT_DEF", 0], ["MAGIC_DEF", 0]]),
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [TRAP, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [HERO, { hitPoints: 60_000, maxHitPoints: 60_000, constant: "GHOST_SAMURAI" }],
      [TRAP, { constant: "SKELETON_ARCHER", isEnemy: true }],
    ]),
    send: (frame) => sent.push(frame),
  };
  await dealTrapHit(session, TRAP, await attackForConstant("EN_ARROW_SHOT"), HERO, 400);
  const hit = sent.find((frame) => frame.readUInt32LE(4) === HERO && frame.readUInt16LE(8) === 160);
  assert.ok(hit, "the arrow lands");
  return { damage: 0 - hit.readInt32LE(18), effectiveness: hit.readInt8(EFFECTIVENESS_AT) };
};

test("a hit a legendary shield halves is told to the client as resisted", async () => {
  const bare = await arrowOn([{ power: 10 }]);
  const covered = await arrowOn([{ power: 10, legendarymodifier: 11 }]); // Cover: ranged
  const barred = await arrowOn([{ power: 10, legendarymodifier: 10 }]); // Barrier: melee

  assert.equal(bare.effectiveness, 0);
  assert.equal(covered.effectiveness, -1, "Cover took half of an arrow, and says so");
  assert.ok(covered.damage < bare.damage);
  assert.equal(barred.effectiveness, 0, "Barrier is for swords and has nothing to say about arrows");
  assert.equal(barred.damage, bare.damage);
});

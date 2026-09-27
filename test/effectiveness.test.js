import test from "node:test";
import assert from "node:assert/strict";

import { loadGameMaster } from "../src/gamemaster.js";
import { applyTargetBuff, dealTrapHit, handleProposeCombatResults } from "../src/socket/combat.js";
import { CLID } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

/**
 * How well a hit lands on a monster, against the official corpus.
 *
 * Every NPC row rates itself against melee, shooting and magic at +1, 0 or -1,
 * and the official halves or doubles the hit by it and tells the client, which
 * draws the pale or the orange number, the weak or the super flash and the
 * WeakAttack or StrongHit sound. 15717 of 15721 recorded hero hits carry it.
 * The same hero's AXE_COMBO_1 landed 944, 1887 and 3774 on resistant, neutral
 * and weak monsters; KATANA_SOUL_BANG 5237 and 10474 — exact, which is also
 * what says a rating is only a category and never a point of flat defence.
 */

const HERO = 500;
const VICTIM = 700;
const ATTACK = { AXE_COMBO_1: 900101, LONG_BOW_SHOT: 900504, KATANA_SOUL_BANG: 902509 };

/** A frame's damage and effectiveness, from its CombatResult body. */
const readEcho = (frame) => ({
  damage: 0 - frame.readInt32LE(18),
  effectiveness: frame.readInt8(37),
});

const heroHit = async (constant, attackId, { activeBuffs, weapon = { power: 500 }, after } = {}) => {
  const sent = [];
  const session = {
    id: 91,
    heroDoid: HERO,
    floorDoid: 400,
    dungeonActive: true,
    heroWeapons: [weapon],
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [VICTIM, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [VICTIM, { hitPoints: 9_000_000, maxHitPoints: 9_000_000, constant, isEnemy: true }],
    ]),
    activeBuffs,
    allocateDoid: () => 900,
    send: (frame) => sent.push(frame),
  };
  const result = new PacketWriter()
    .u32(HERO).u32(VICTIM).i32(0).u8(0).u8(0).u32(attackId).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  await handleProposeCombatResults(
    session,
    new PacketReader(new PacketWriter().u16(result.length).raw(result).body())
  );
  const echo = sent.find((frame) => frame.readUInt32LE(4) === VICTIM && frame.readUInt16LE(8) === 144);
  assert.ok(echo, "the hit is echoed on the victim");
  const taken = 9_000_000 - session.actors.get(VICTIM).hitPoints;
  await after?.();
  return { ...readEcho(echo), taken, ticked: 9_000_000 - session.actors.get(VICTIM).hitPoints - taken };
};

test("a hero's hit is halved on a resistant monster and doubled on a weak one, and says so", async () => {
  // Melee against MELEE_DEF: BRUTE 0, PURPLE_SPECTER +1, SKELETON_WARRIOR -1.
  const neutral = await heroHit("BRUTE", ATTACK.AXE_COMBO_1);
  const resisted = await heroHit("PURPLE_SPECTER", ATTACK.AXE_COMBO_1);
  const weak = await heroHit("SKELETON_WARRIOR", ATTACK.AXE_COMBO_1);

  assert.equal(neutral.effectiveness, 0);
  assert.equal(resisted.effectiveness, -1);
  assert.equal(weak.effectiveness, 1);
  assert.equal(resisted.damage, Math.round(neutral.damage / 2));
  assert.equal(weak.damage, neutral.damage * 2, "no point of flat defence alongside the category");
  assert.equal(weak.taken, weak.damage, "and it is what the monster loses");
});

test("the columns are read straight: shooting against SHOOT_DEF, magic against MAGIC_DEF", async () => {
  // ICE_IMP: MELEE +1, SHOOT -1. The cross-wired reading halved its arrows,
  // where the official doubles them.
  const arrow = await heroHit("ICE_IMP", ATTACK.LONG_BOW_SHOT);
  const plain = await heroHit("BRUTE", ATTACK.LONG_BOW_SHOT);
  assert.equal(arrow.effectiveness, 1);
  assert.equal(arrow.damage, plain.damage * 2);

  // PURPLE_SPECTER: MAGIC -1.
  const bang = await heroHit("PURPLE_SPECTER", ATTACK.KATANA_SOUL_BANG);
  const flat = await heroHit("BRUTE", ATTACK.KATANA_SOUL_BANG);
  assert.equal(bang.effectiveness, 1);
  assert.equal(bang.damage, flat.damage * 2);
});

/**
 * The star mushroom: `IgnoreResistances` and 1.5 attack. 135 of 135 hits under
 * it carry +1, at 1.5 times the neutral hit whatever the rating.
 */
test("under the star mushroom every hit is neutral in size and told it landed well", async () => {
  const gm = await loadGameMaster();
  const mushroom = gm.raw.Buff.find((row) => row.Constant === "CONSUMABLE_STAR_MUSHROOM_BUFF");
  const buffed = () =>
    new Map([[9001, { buff: mushroom, affectedActor: HERO, attackerActor: HERO }]]);

  const neutral = await heroHit("BRUTE", ATTACK.AXE_COMBO_1);
  for (const constant of ["BRUTE", "PURPLE_SPECTER", "SKELETON_WARRIOR"]) {
    const hit = await heroHit(constant, ATTACK.AXE_COMBO_1, { activeBuffs: buffed() });
    assert.equal(hit.effectiveness, 1, constant);
    assert.equal(hit.damage, Math.round(neutral.damage * 1.5), constant);
  }
});

/**
 * A hit that does nothing says nothing about how well. A thrown garlic strikes
 * for zero before its cloud does the work, and the official's carries zero on
 * a KNIGHT_BOXERS weak to magic — eleven such hits on rated monsters, all zero.
 */
test("a hit that deals nothing carries no effectiveness", async () => {
  const gm = await loadGameMaster();
  const garlic = gm.raw.Attack.find((row) => row.Constant === "THROW_GARLIC");
  assert.equal(Number(garlic.DamageMod), 0);
  const hit = await heroHit("KNIGHT_BOXERS", garlic.Id);
  assert.equal(hit.damage, 0);
  assert.equal(hit.effectiveness, 0);
});

/**
 * The burn a weapon's own modifier leaves is the same burn: BURNING_1 is
 * FIRE_L1, the one the official ticks at 194 on every monster whatever its
 * rating. It is priced from the neutral hit like the attack's own debuffs.
 */
test("a Burning weapon ticks the same on a neutral, a weak and a resistant monster", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const weapon = { power: 500, modifier1: 70081 };
  const tickOnce = () => t.mock.timers.tick(1000);
  const neutral = await heroHit("BRUTE", ATTACK.AXE_COMBO_1, { weapon, after: tickOnce });
  const weak = await heroHit("BABY_YETI", ATTACK.AXE_COMBO_1, { weapon, after: tickOnce });
  const resisted = await heroHit("PURPLE_SPECTER", ATTACK.AXE_COMBO_1, { weapon, after: tickOnce });

  assert.ok(neutral.ticked > 0, "the weapon burns");
  assert.equal(weak.damage, neutral.damage * 2, "the hit itself is judged");
  assert.equal(weak.ticked, neutral.ticked, "its burn is not");
  assert.equal(resisted.ticked, neutral.ticked);
});

/** The floor's own traps and barrels are not judged: all of their 3000 recorded hits carry zero. */
test("a floor's PROP trap is not judged by the monster's rating", async () => {
  const sent = [];
  const TRAP = 800;
  const session = {
    id: 93,
    heroDoid: HERO,
    objects: new Map([
      [TRAP, CLID.DistributedNPCGameObject],
      [VICTIM, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [VICTIM, { hitPoints: 9000, maxHitPoints: 9000, constant: "SKELETON_WARRIOR", isEnemy: true }],
    ]),
    trapNames: new Map([[TRAP, { constant: "CASTLE_CATACOMB_GROUND_SPIKES_A" }]]),
    send: (frame) => sent.push(frame),
  };
  const gm = await loadGameMaster();
  const blade = gm.raw.Attack.find((row) => row.Constant === "EN_SWORD_CHOP");
  await dealTrapHit(session, TRAP, blade, VICTIM, 50);
  const echo = sent.find((frame) => frame.readUInt32LE(4) === VICTIM && frame.readUInt16LE(8) === 144);
  assert.equal(readEcho(echo).effectiveness, 0);
});

/**
 * A burn ticks the same on every monster — 194 on knights, lions, yetis and a
 * shaman imp rated exactly like an ice imp — except the rows weak to fire,
 * which take 387 and the +2 flash: 98 of 98.
 */
test("a burn ticks twice as hard on a monster weak to fire, and flashes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const burn = async (constant) => {
    const sent = [];
    const session = {
      id: 94,
      heroDoid: 10,
      dungeonActive: true,
      floorDoid: 55,
      allocateDoid: () => 900,
      objects: new Map([[20, CLID.DistributedNPCGameObject]]),
      actors: new Map([
        [20, {
          hitPoints: 100_000,
          maxHitPoints: 100_000,
          constant,
          isEnemy: true,
          abilities: new Set([(await loadGameMaster()).raw.Npc.find((row) => row.Constant === constant).Ability1]),
        }],
      ]),
      send: (frame) => sent.push(frame),
    };
    await applyTargetBuff(session, {
      attack: { TargetBuff1: "FIRE_L1" },
      victimDoid: 20,
      attackerDoid: 30,
      damage: 1935,
    });
    t.mock.timers.tick(1000);
    const report = sent.find((frame) => frame.readUInt16LE(8) === 168);
    return {
      tick: 100_000 - session.actors.get(20).hitPoints,
      effectiveness: report.readInt8(22),
    };
  };

  const shaman = await burn("SHAMAN_IMP");
  const ice = await burn("ICE_IMP");
  assert.equal(shaman.effectiveness, 0);
  assert.equal(ice.effectiveness, 2);
  assert.equal(shaman.tick, 194, "FIRE_L1 is a tenth of the hit");
  assert.equal(ice.tick, 387, "doubled before it is rounded: 2 × 193.5");
});

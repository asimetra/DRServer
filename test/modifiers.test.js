import test from "node:test";
import assert from "node:assert/strict";
import { critRollFor } from "../src/socket/modifiers.js";
import { loadGameMaster } from "../src/gamemaster.js";

/**
 * The modifiers a weapon carries, which nothing on this side has ever read.
 *
 * A chest has been rolling them onto weapons correctly for a while — the type
 * is filtered by what the weapon allows and the count and level by its rarity —
 * and then combat priced every hit as though the weapon were plain.
 */

const CRITICAL_L1 = 70111; // CRIT_CHANCE 0.1, CRIT_DAMAGE 1
const CRITICAL_L5 = 70115; // CRIT_CHANCE 0.25, CRIT_DAMAGE 1
const VICIOUS_L1 = 70121; // CRIT_CHANCE 0.05, CRIT_DAMAGE 2
const VICIOUS_L5 = 70125; // CRIT_CHANCE 0.05, CRIT_DAMAGE 4
const CLEVER_L1 = 70161; // MANA_COST, which carries no crit columns at all

/** A random that returns each of the given rolls in turn, then 1 (never crits). */
const rolls = (...values) => {
  let at = 0;
  return () => (at < values.length ? values[at++] : 1);
};

test("Critical doubles the hit, which is what the wire shows", async () => {
  /**
   * `CRIT_DAMAGE` is the *extra*, so 1 means twice. Grouping the official's
   * echoes by attack and comparing the median crit against the median ordinary
   * hit gives exactly 2.00 on six attacks, including `KATANA_SOUL_BANG` over
   * 1600 crits.
   */
  const gm = await loadGameMaster();
  const weapon = { modifier1: CRITICAL_L1, modifier2: 0 };

  assert.deepEqual(critRollFor(gm, weapon, rolls(0.05)), { critical: true, multiplier: 2 });
});

test("Vicious pays its own multiplier, not Critical's", async () => {
  const gm = await loadGameMaster();

  assert.equal(critRollFor(gm, { modifier1: VICIOUS_L1 }, rolls(0.01)).multiplier, 3);
  assert.equal(critRollFor(gm, { modifier1: VICIOUS_L5 }, rolls(0.01)).multiplier, 5);
});

test("a roll above the chance is an ordinary hit", async () => {
  const gm = await loadGameMaster();

  assert.deepEqual(
    critRollFor(gm, { modifier1: CRITICAL_L1 }, rolls(0.5)),
    { critical: false, multiplier: 1 }
  );
});

test("two crit modifiers each roll, and the larger one is paid", async () => {
  /**
   * "Stacks with Vicious!" and "Stacks with Critical!" — each brings its own
   * chance and its own damage. A single hit crits once, so when both come up
   * the bigger multiplier is the one the player sees.
   */
  const gm = await loadGameMaster();
  const weapon = { modifier1: CRITICAL_L1, modifier2: VICIOUS_L5 };

  // Both roll under: Critical would pay 2, Vicious 5.
  assert.equal(critRollFor(gm, weapon, rolls(0.05, 0.01)).multiplier, 5);
  // Only Critical comes up.
  assert.equal(critRollFor(gm, weapon, rolls(0.05, 0.9)).multiplier, 2);
  // Only Vicious.
  assert.equal(critRollFor(gm, weapon, rolls(0.9, 0.01)).multiplier, 5);
  // Neither.
  assert.equal(critRollFor(gm, weapon, rolls(0.9, 0.9)).critical, false);
});

test("a modifier with no crit columns never crits", async () => {
  const gm = await loadGameMaster();

  assert.equal(critRollFor(gm, { modifier1: CLEVER_L1 }, rolls(0)).critical, false);
  assert.equal(critRollFor(gm, {}, rolls(0)).critical, false);
  assert.equal(critRollFor(gm, null, rolls(0)).critical, false);
});

test("the chances are the ones the table authors", async () => {
  /**
   * Measured rather than asserted one roll at a time: `Critical` runs 10% to
   * 25% by level and `Vicious` is a flat 5%, and the official's overall rate
   * across a mixed corpus was 7.87%.
   */
  const gm = await loadGameMaster();

  for (const [id, expected] of [[CRITICAL_L1, 0.1], [CRITICAL_L5, 0.25], [VICIOUS_L1, 0.05]]) {
    let hits = 0;
    const trials = 20000;
    // A deterministic sweep rather than a sampled one, so the test cannot flake.
    for (let index = 0; index < trials; index += 1) {
      const at = index / trials;
      if (critRollFor(gm, { modifier1: id }, () => at).critical) hits += 1;
    }
    assert.ok(
      Math.abs(hits / trials - expected) < 0.001,
      `modifier ${id} fired ${(hits / trials).toFixed(4)} of the time, table says ${expected}`
    );
  }
});

test("a crit reaches the client as double damage, flagged", async () => {
  /**
   * End to end, because the roll and the packet are two different mistakes. The
   * client proposes `criticalHit` as 0 on all 13626 recorded results, so if this
   * server does not set the byte the client draws an ordinary number over a hit
   * that was twice the size.
   */
  const { handleProposeAttackChoreography } = await import("../src/socket/buster.js");
  const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  const SOUL_BANG = 902509;
  const KATANA = 12502;
  const HERO = 500;
  const ENEMY = 9900;

  const hit = (session) => {
    const record = new PacketWriter()
      .u32(HERO).u32(ENEMY).u32(0)
      .u8(0).u8(0).u32(SOUL_BANG).u32(ENEMY)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0)
      .u32(0).u32(0).u8(0)
      .body();
    return new PacketWriter()
      .u8(0).u8(0).u32(SOUL_BANG).u32(ENEMY).u8(0).f32(1).f32(1)
      .u16(record.length).raw(record)
      .body();
  };

  const run = async (random) => {
    const sent = [];
    let nextDoid = 900;
    const session = {
      id: 43,
      heroDoid: HERO,
      floorDoid: 400,
      dungeonActive: true,
      heroPosition: { x: 1000, y: 1000 },
      heroHeading: 0,
      heroManaPoints: 100,
      maxHeroManaPoints: 100,
      dungeonBusterPoints: 0,
      dungeonAvatar: { avatar_id: 104, experience: 0 },
      heroWeapons: [{ type: KATANA, power: 30, modifier1: 70111 }], // Critical L1
      random,
      objects: new Map([[ENEMY, CLID.DistributedNPCGameObject]]),
      actors: new Map([[ENEMY, {
        hitPoints: 500000, maxHitPoints: 500000, collisionRadius: 25,
        constant: "BRUTE", isEnemy: true, position: { x: 1050, y: 1000 },
      }]]),
      allocateDoid: () => ++nextDoid,
      sent,
      send: (packet) => sent.push(packet),
    };
    await handleProposeAttackChoreography(session, new PacketReader(hit(session)));
    return { session, sent };
  };

  const always = await run(() => 0); // under every chance
  const never = await run(() => 1); // over every chance

  const dealt = (r) => 500000 - r.session.actors.get(ENEMY).hitPoints;
  assert.ok(dealt(never) > 0, "the ordinary hit landed at all");
  assert.equal(dealt(always), dealt(never) * 2, "a Critical hit is twice an ordinary one");

  // Field 144 is DistributedNPCGameObject.ReceiveCombatResult; the enemy also
  // gets a hit-point update on the same doid, which is a much shorter packet.
  const echo = always.sent.find(
    (packet) =>
      packet.readUInt16LE(2) === 124 &&
      packet.readUInt32LE(4) === ENEMY &&
      packet.readUInt16LE(8) === 144
  );
  assert.ok(echo, "the result was echoed to the client");
  // op(2) doid(4) field(2) then the record; criticalHit is byte 26 of it.
  assert.equal(echo.readUInt8(2 + 8 + 26), 1, "the echo does not say it was a crit");
});

const NOXIOUS_L1 = 70101; // POISON, BUFF_1 = POISON_L1
const SLOWING_L1 = 70021; // SLOW, whose SLOW_L0 authors MaxStacks 1

test("a weapon's modifiers name the debuffs it leaves", async () => {
  const { onHitBuffsFor } = await import("../src/socket/modifiers.js");
  const gm = await loadGameMaster();

  assert.deepEqual(onHitBuffsFor(gm, { modifier1: NOXIOUS_L1 }), ["POISON_L1"]);
  assert.deepEqual(onHitBuffsFor(gm, { modifier1: CRITICAL_L1 }), [], "crit leaves nothing behind");
  assert.deepEqual(onHitBuffsFor(gm, null), []);
});

/** A dungeon session with one enemy and one weapon, ready to be hit. */
const arena = async (weapon) => {
  const { CLID } = await import("../src/socket/opcodes.js");
  const ENEMY = 9900;
  let nextDoid = 900;
  const sent = [];
  const session = {
    id: 44,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    dungeonZone: 10,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    heroManaPoints: 1000,
    maxHeroManaPoints: 1000,
    dungeonBusterPoints: 0,
    dungeonAvatar: { avatar_id: 104, experience: 0 },
    heroWeapons: [weapon],
    random: () => 1, // never crits, so the damage assertions stay readable
    objects: new Map([[ENEMY, CLID.DistributedNPCGameObject]]),
    actors: new Map([[ENEMY, {
      hitPoints: 5000000, maxHitPoints: 5000000, collisionRadius: 25,
      constant: "BRUTE", isEnemy: true, position: { x: 1050, y: 1000 },
    }]]),
    allocateDoid: () => ++nextDoid,
    sent,
    send: (packet) => sent.push(packet),
  };
  return { session, sent, ENEMY };
};

const swing = async (session, enemy) => {
  const { handleProposeAttackChoreography } = await import("../src/socket/buster.js");
  const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");
  const SOUL_BANG = 902509;
  const record = new PacketWriter()
    .u32(500).u32(enemy).u32(0)
    .u8(0).u8(0).u32(SOUL_BANG).u32(enemy)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0)
    .u32(0).u32(0).u8(0)
    .body();
  const packet = new PacketWriter()
    .u8(0).u8(0).u32(SOUL_BANG).u32(enemy).u8(0).f32(1).f32(1)
    .u16(record.length).raw(record)
    .body();
  await handleProposeAttackChoreography(session, new PacketReader(packet));
};

const held = (session, enemy, constant) =>
  [...session.activeBuffs.values()].filter(
    (active) => active.affectedActor === enemy && active.buff?.Constant === constant
  ).length;

test("a Noxious weapon poisons what it hits", async () => {
  const { session, ENEMY } = await arena({ type: 12502, power: 30, modifier1: NOXIOUS_L1 });

  await swing(session, ENEMY);

  assert.equal(held(session, ENEMY, "POISON_L1"), 1, "the hit left no poison");
});

test("poison stacks to six and stops, as the table says", async () => {
  /**
   * `MaxStacks` is 6 on every poison level, and the official reaches exactly
   * six concurrent poisons on one victim and never a seventh. Past the limit
   * `grantBuff` refreshes the oldest instead of adding another, so the count
   * holds rather than the effect compounding without end.
   */
  const { session, ENEMY } = await arena({ type: 12502, power: 30, modifier1: NOXIOUS_L1 });

  for (let swings = 0; swings < 10; swings += 1) await swing(session, ENEMY);

  assert.equal(held(session, ENEMY, "POISON_L1"), 6, "poison did not stop at six");
});

test("a buff authored MaxStacks 1 never doubles", async () => {
  const { onHitBuffsFor } = await import("../src/socket/modifiers.js");
  const { session, ENEMY } = await arena({ type: 12502, power: 30, modifier1: SLOWING_L1 });
  const [buff] = onHitBuffsFor(await loadGameMaster(), { modifier1: SLOWING_L1 });
  assert.ok(buff, "the Slowing modifier names a buff");

  for (let swings = 0; swings < 5; swings += 1) await swing(session, ENEMY);

  assert.equal(held(session, ENEMY, buff), 1, `${buff} stacked past its limit`);
});

const STURDY_L1 = 70001; // DAMAGE, MELEE_ATK/SHOOT_ATK/MAGIC_ATK 1.1

test("a Sturdy weapon multiplies the stat the swing is paid on", async () => {
  const { attackMultiplierFor } = await import("../src/socket/modifiers.js");
  const gm = await loadGameMaster();
  const weapon = { modifier1: STURDY_L1 };

  const authored = gm.modifiersById.get(STURDY_L1);
  assert.equal(authored.MODIFIER_TYPE, "DAMAGE", "the fixture is the Sturdy row");

  assert.equal(attackMultiplierFor(gm, weapon, "MELEE_ATK"), authored.MELEE_ATK);
  assert.equal(attackMultiplierFor(gm, weapon, "SHOOT_ATK"), authored.SHOOT_ATK);
  // A weapon with no DAMAGE modifier leaves the hit alone.
  assert.equal(attackMultiplierFor(gm, { modifier1: CRITICAL_L1 }, "MELEE_ATK"), 1);
  assert.equal(attackMultiplierFor(gm, null, "MELEE_ATK"), 1);
});

test("two DAMAGE modifiers multiply rather than the larger winning", async () => {
  const { attackMultiplierFor } = await import("../src/socket/modifiers.js");
  const gm = await loadGameMaster();
  const one = gm.modifiersById.get(70001).MELEE_ATK;
  const five = gm.modifiersById.get(70005).MELEE_ATK;

  assert.equal(
    attackMultiplierFor(gm, { modifier1: 70001, modifier2: 70005 }, "MELEE_ATK"),
    one * five
  );
});

test("Sturdy actually makes the hit land harder", async () => {
  /**
   * End to end, because the multiplier reaching `netAttackDamage` is the part
   * that was missing rather than the arithmetic. Neither side of the wire read
   * these columns: the client's modifier pass does speed, mana, chain, pierce,
   * cooldown, charge and collision, and the three attack columns are not in it.
   */
  const gm = await loadGameMaster();
  const sturdy = gm.modifiersById.get(STURDY_L1).MELEE_ATK;

  const plainArena = await arena({ type: 12502, power: 30 });
  await swing(plainArena.session, plainArena.ENEMY);
  const plain = 5000000 - plainArena.session.actors.get(plainArena.ENEMY).hitPoints;

  const sturdyArena = await arena({ type: 12502, power: 30, modifier1: STURDY_L1 });
  await swing(sturdyArena.session, sturdyArena.ENEMY);
  const boosted = 5000000 - sturdyArena.session.actors.get(sturdyArena.ENEMY).hitPoints;

  assert.ok(plain > 0, "the plain weapon landed at all");
  assert.ok(boosted > plain, `Sturdy dealt ${boosted} against a plain ${plain}`);
  assert.equal(boosted, Math.round(plain * sturdy));
});

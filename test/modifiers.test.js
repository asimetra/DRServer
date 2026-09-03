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

test("two crit modifiers each roll, and together they multiply", async () => {
  /**
   * "Stacks with Vicious!" and "Stacks with Critical!" — each brings its own
   * chance and its own damage, and when both come up the two multiply.
   *
   * Measured, and it overturned the first reading. Grouping the official's
   * crits by session and attack and dividing by the modal ordinary hit of the
   * same group, two groups carry three magnitudes on one weapon: x2, x4 and x8
   * — `AXE_COMBO_1` at 6/4/4 and `KATANA_SOUL_BANG` at 53/44/18. Summing the
   * extras would put the third tier at x5; taking the larger would never
   * produce it.
   */
  const gm = await loadGameMaster();
  const weapon = { modifier1: CRITICAL_L1, modifier2: VICIOUS_L5 };

  // Both roll under: Critical pays 2 and Vicious 5, so together 10.
  assert.equal(critRollFor(gm, weapon, rolls(0.05, 0.01)).multiplier, 10);
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

const SAUCIER_L1 = 70191; // SPAWN_FOOD_ON_HIT, 3%
const COOKS_L1 = 70201; // DEATH_FOOD, 5%

test("the food modifiers read their own percentage column", async () => {
  const { foodChanceFor, FOOD_ON_HIT, FOOD_ON_DEATH } = await import("../src/socket/modifiers.js");
  const gm = await loadGameMaster();

  const saucier = gm.modifiersById.get(SAUCIER_L1);
  const cooks = gm.modifiersById.get(COOKS_L1);
  assert.equal(saucier.MODIFIER_TYPE, "SPAWN_FOOD_ON_HIT", "the fixture is Saucier");
  assert.equal(cooks.MODIFIER_TYPE, "DEATH_FOOD", "the fixture is Cook's");

  assert.equal(
    foodChanceFor(gm, { modifier1: SAUCIER_L1 }, FOOD_ON_HIT),
    saucier.SPAWN_FOOD_ON_HIT_PERCENTAGE / 100
  );
  // Each column is its own roll: Saucier never fires on a kill and Cook's never
  // on an ordinary hit.
  assert.equal(foodChanceFor(gm, { modifier1: SAUCIER_L1 }, FOOD_ON_DEATH), 0);
  assert.equal(foodChanceFor(gm, { modifier1: COOKS_L1 }, FOOD_ON_HIT), 0);
  assert.equal(foodChanceFor(gm, { modifier1: CRITICAL_L1 }, FOOD_ON_HIT), 0);
});

test("two food modifiers add their chances", async () => {
  const { foodChanceFor, FOOD_ON_HIT } = await import("../src/socket/modifiers.js");
  const gm = await loadGameMaster();
  const one = gm.modifiersById.get(70191).SPAWN_FOOD_ON_HIT_PERCENTAGE;
  const five = gm.modifiersById.get(70195).SPAWN_FOOD_ON_HIT_PERCENTAGE;

  assert.equal(
    foodChanceFor(gm, { modifier1: 70191, modifier2: 70195 }, FOOD_ON_HIT),
    (one + five) / 100
  );
});

/** The doober constants a session put on the floor, in order. */
const dropped = async (sent) => {
  const { CLID } = await import("../src/socket/opcodes.js");
  const gm = await loadGameMaster();
  const byId = new Map(gm.raw.Doobers.map((row) => [row.Id, row.Constant]));
  return sent
    .filter(
      (packet) => (packet.readUInt16LE(2) === 134 || packet.readUInt16LE(2) === 135) &&
        packet.readUInt16LE(12) === CLID.DistributedDooberGameObject
    )
    .map((packet) => byId.get(packet.readUInt32LE(18)) ?? packet.readUInt32LE(18));
};

test("a Saucier weapon drops the Chef Burger on a hit that does not kill", async () => {
  /**
   * Which food is not a choice: two doobers carry `DooberType` `CHEF_FOOD` and
   * are named after the two events — `FOOD_CHEF_HIT`, the Chef Burger worth 2%
   * of the bar, and `FOOD_CHEF_DEATH`, the Chef Cupcake worth 20%. Neither is
   * in `DooberDrop`, so no monster drops either.
   *
   * This first picked from the victim's own drop table and handed out sausages.
   * Those are ordinary loot; the burger is what the modifier promises.
   */
  const { session, sent, ENEMY } = await arena({
    type: 12502, power: 30, modifier1: SAUCIER_L1,
  });
  session.random = () => 0; // every roll succeeds; the crit roll is separate

  await swing(session, ENEMY);

  assert.ok(!session.actors.get(ENEMY).dead, "the enemy survived the hit");
  assert.deepEqual(await dropped(sent), ["FOOD_CHEF_HIT"]);
});

test("a Cook's weapon drops the Chef Cupcake on the kill", async () => {
  const COOKS = 70201;
  const { session, sent, ENEMY } = await arena({ type: 12502, power: 30, modifier1: COOKS });
  session.random = () => 0;
  const victim = session.actors.get(ENEMY);
  victim.hitPoints = 1; // the next hit kills

  await swing(session, ENEMY);

  // Held from before the swing: a death takes the actor off the floor, so
  // `session.actors` no longer has it to ask.
  assert.ok(victim.dead, "the enemy died");
  assert.deepEqual(await dropped(sent), ["FOOD_CHEF_DEATH"]);
});

test("a plain weapon on a hero without COOKING drops nothing", async () => {
  /**
   * The arena's own avatar is 104, the Battle Chef, so a plain weapon still
   * makes food there — his `COOKING` base is 1% and this roll always succeeds.
   * That is the class ability working, so the assertion moves to a hero who has
   * no such slot.
   */
  const { session, sent, ENEMY } = await arena({ type: 12502, power: 30 });
  session.random = () => 0;
  session.dungeonAvatar = { avatar_id: 101 }; // Berserker, no COOKING slot

  await swing(session, ENEMY);

  assert.deepEqual(await dropped(sent), [], "food appeared with nothing asking for it");
});

test("a plain weapon on the Chef still makes food, from the stat alone", async () => {
  const { session, sent, ENEMY } = await arena({ type: 12502, power: 30 });
  session.random = () => 0; // under the 1% base

  await swing(session, ENEMY);

  assert.deepEqual(await dropped(sent), ["FOOD_CHEF_HIT"]);
});

test("a poison tick is a share of the hit, not the whole of it", async () => {
  /**
   * `PercentDamage` is authored per level — 2.5%, 5%, 10%, 15%, 20% from one
   * star to five — and was never read, so an eight-second poison dealt nine
   * times the swing that applied it. Fifteen per cent at four stars is what the
   * item card promises and what the table says.
   */
  const gm = await loadGameMaster();
  for (const [constant, expected] of [["POISON_L1", 0.025], ["POISON_L4", 0.15], ["FIRE_L5", 0.5]]) {
    const buff = gm.raw.Buff.find((row) => row.Constant === constant);
    assert.equal(buff.PercentDamage, expected, `${constant} authors a different share`);
  }

  const { session, sent, ENEMY } = await arena({ type: 12502, power: 30, modifier1: NOXIOUS_L1 });
  const before = session.actors.get(ENEMY).hitPoints;
  await swing(session, ENEMY);
  const hit = before - session.actors.get(ENEMY).hitPoints;

  // The floater the tick sends carries the amount, so the tick can be read
  // without waiting a second for it.
  const share = gm.raw.Buff.find((row) => row.Constant === "POISON_L1").PercentDamage;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const ticked = before - hit - session.actors.get(ENEMY).hitPoints;
  assert.equal(ticked, Math.max(1, Math.round(hit * share)), `tick was ${ticked} against a ${hit} hit`);
  for (const timer of session.damageOverTimeTimers ?? []) clearInterval(timer);
});

test("repeated hits do not pile up poison clocks", async () => {
  /**
   * `grantBuff` refreshes the oldest copy once `MaxStacks` is reached rather
   * than adding another, and the damage-over-time used to start a fresh
   * interval whatever it did — so a fast weapon accumulated timers without
   * limit, each ticking for the whole authored duration.
   */
  const { session, ENEMY } = await arena({ type: 12502, power: 30, modifier1: NOXIOUS_L1 });

  for (let swings = 0; swings < 12; swings += 1) await swing(session, ENEMY);

  assert.equal(
    session.damageOverTimeTimers.size,
    6,
    "one clock per live poison, and poison stacks six deep"
  );
  for (const timer of session.damageOverTimeTimers) clearInterval(timer);
});

test("a body takes its buffs with it", async () => {
  /**
   * The report: poison still showing on a monster that is gone. `removeActor`
   * deleted the actor and disabled its object and left the buffs running. The
   * official takes them together — of 3048 poison and fire buffs whose victim
   * was disabled in the recordings, 2176 are disabled within 250ms of it and
   * only 8 outlive their host.
   */
  const { session, ENEMY } = await arena({ type: 12502, power: 30, modifier1: NOXIOUS_L1 });
  await swing(session, ENEMY);
  assert.ok(held(session, ENEMY, "POISON_L1") > 0, "the enemy was poisoned to begin with");

  const { applyDamage } = await import("../src/socket/combat.js");
  applyDamage(session, ENEMY, session.actors.get(ENEMY).hitPoints);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(held(session, ENEMY, "POISON_L1"), 0, "poison outlived the monster");
  for (const timer of session.damageOverTimeTimers ?? []) clearInterval(timer);
});

test("the crit ladder the official shows is reproducible", async () => {
  /**
   * The whole of what the measurement found, asserted as one shape: a weapon
   * carrying `Critical` and a `Vicious` worth x4 produces x2 when the first
   * fires alone, x4 when the second does, x8 when both do, and nothing when
   * neither. Two recorded groups carry exactly that ladder on a single weapon.
   */
  const gm = await loadGameMaster();
  const VICIOUS_X4 = 70123; // CRIT_DAMAGE 3, so 1 + 3
  assert.equal(gm.modifiersById.get(VICIOUS_X4).CRIT_DAMAGE, 3, "the fixture pays x4 alone");

  const weapon = { modifier1: CRITICAL_L1, modifier2: VICIOUS_X4 };
  const ladder = ([first, second]) => critRollFor(gm, weapon, rolls(first, second)).multiplier;

  assert.equal(ladder([0.05, 0.9]), 2, "Critical alone");
  assert.equal(ladder([0.9, 0.01]), 4, "Vicious alone");
  assert.equal(ladder([0.05, 0.01]), 8, "both, which is the product and not the sum");
  assert.equal(critRollFor(gm, weapon, rolls(0.9, 0.9)).critical, false, "neither");
});

test("the Battle Chef makes food from his own COOKING, and nobody else does", async () => {
  /**
   * `COOKING` is his second slot and is not a combat stat — every ordinary
   * column on the row is zero. Its real fields are the four spawn columns, its
   * description is "Better chance to make Food when attacking enemies", and the
   * doobers it makes are the two named after him.
   *
   * Small, and asserted as such: the slot pays 0.1 units a point, so an
   * untrained Chef sits on the base and a well-trained one is barely above it.
   */
  const { cookingFoodChance, FOOD_ON_HIT, FOOD_ON_DEATH } = await import(
    "../src/socket/modifiers.js"
  );
  const gm = await loadGameMaster();
  const row = gm.raw.SuperStats.find((entry) => entry.Constant === "COOKING");
  const chef = gm.raw.Hero.find((hero) => hero.Constant === "BATTLE_CHEF");
  const berserker = gm.raw.Hero.find((hero) => hero.Constant === "BERSERKER");

  const untrained = { avatar_id: 104 };
  assert.equal(cookingFoodChance(gm, chef, untrained, FOOD_ON_HIT), row.HitSpawnBase);
  assert.equal(cookingFoodChance(gm, chef, untrained, FOOD_ON_DEATH), row.DeathSpawnBase);

  /**
   * The base is not a floor every hero stands on. A Berserker has no `COOKING`
   * slot, so the stat does not exist for him and neither does its base.
   */
  assert.equal(cookingFoodChance(gm, berserker, untrained, FOOD_ON_HIT), 0);
  assert.equal(cookingFoodChance(gm, null, untrained, FOOD_ON_HIT), 0);

  // And training it raises the chance rather than leaving it on the base.
  const cookingSlot = [1, 2, 3, 4].find((slot) => chef[`StatUpgrade${slot}`] === "COOKING");
  assert.ok(cookingSlot, "the Chef declares COOKING in a slot");
  const trained = { avatar_id: 104, [`statupgrade${cookingSlot}`]: 50 };
  assert.ok(
    cookingFoodChance(gm, chef, trained, FOOD_ON_HIT) > row.HitSpawnBase,
    "fifty points bought nothing"
  );
});

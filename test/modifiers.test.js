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

test("a plain weapon makes no food, whoever is holding it", async () => {
  /**
   * Including the Battle Chef, whose `COOKING` improves a chance rather than
   * creating one. This is on a report from the live game and on the row's own
   * wording — "Better *chance* to make Food" — and not on the captures: the two
   * that looked like a Ghost Samurai making food he has no slot for are both
   * parties with a Battle Chef in them.
   */
  const { session, sent, ENEMY } = await arena({ type: 12502, power: 30 });
  session.random = () => 0; // every roll would succeed, if one were taken

  await swing(session, ENEMY);

  assert.deepEqual(await dropped(sent), []);
});

test("the Chef's COOKING raises a chance the weapon already has", async () => {
  const { foodChanceFor, cookingFoodChance, FOOD_ON_HIT } = await import(
    "../src/socket/modifiers.js"
  );
  const gm = await loadGameMaster();
  const chef = gm.raw.Hero.find((hero) => hero.Constant === "BATTLE_CHEF");
  const weapon = { modifier1: SAUCIER_L1 };

  const alone = foodChanceFor(gm, weapon, FOOD_ON_HIT);
  const withChef = alone + cookingFoodChance(gm, chef, { avatar_id: 104 }, FOOD_ON_HIT);
  assert.ok(withChef > alone, "the stat added nothing to a weapon that has the modifier");
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

test("Muzzling actually slows an enemy's attacks", async () => {
  /**
   * `CRIPPLE_5` is "Muzzling" and promises "Slow enemy attacks for 6 sec!". Its
   * `CRIPPLE_L4` authors `MELEE_SPD`, `SHOOT_SPD` and `MAGIC_SPD` at 0.2, and
   * nothing read them — the buff was created and drawn and the monster swung on
   * exactly the same clock. Reported as: the effect is there, it does not slow.
   */
  const { attackIntervalMs } = await import("../src/socket/ai.js");
  const gm = await loadGameMaster();

  const cripple = gm.raw.Buff.find((row) => row.Constant === "CRIPPLE_L4");
  assert.equal(cripple.MELEE_SPD, 0.2, "the fixture still authors a fifth speed");
  assert.equal(
    gm.modifiersById.get(70035).Name,
    "Muzzling",
    "CRIPPLE_5 is the one the report named"
  );

  const ai = { attackTimerMs: 1000, attackRandMs: 0 };
  assert.equal(attackIntervalMs(ai), 1000, "an unhindered monster keeps its own cadence");
  assert.equal(
    attackIntervalMs(ai, 1 / cripple.MELEE_SPD),
    5000,
    "a muzzled one waits five times as long"
  );

  // A buff that speeds an actor up must not shorten an NPC's interval below its
  // authored one; the floor is the monster's own cadence.
  assert.equal(attackIntervalMs(ai, 1 / 1.5), 1000);
});

test("a muzzled monster's cadence is read off its live buffs", async () => {
  const { attackIntervalMs } = await import("../src/socket/ai.js");
  const { buffMultiplierFor } = await import("../src/socket/buffs.js");
  const gm = await loadGameMaster();
  const cripple = gm.raw.Buff.find((row) => row.Constant === "CRIPPLE_L4");

  const ENEMY = 9900;
  const session = { activeBuffs: new Map([[1, { affectedActor: ENEMY, buff: cripple }]]) };
  const speed = buffMultiplierFor(session, ENEMY, "MELEE_SPD");

  assert.equal(speed, 0.2, "the live buff reports the authored speed");
  assert.equal(attackIntervalMs({ attackTimerMs: 1000, attackRandMs: 0 }, 1 / speed), 5000);
  // And an enemy carrying nothing is unaffected.
  assert.equal(buffMultiplierFor({ activeBuffs: new Map() }, ENEMY, "MELEE_SPD"), 1);
});

test("the AI tick actually pays the muzzle, not just the arithmetic", async () => {
  /**
   * The two tests above assert `attackIntervalMs` and `buffMultiplierFor`
   * separately, and both pass with the two never introduced to each other — the
   * first version of this fix was checked that way and the check was worthless.
   * This one runs the tick.
   */
  const { buildFloor } = await import("./helpers/floor.js");
  const { tickNpcAi } = await import("../src/socket/ai.js");
  const gm = await loadGameMaster();
  const cripple = gm.raw.Buff.find((row) => row.Constant === "CRIPPLE_L4");

  /** Runs one tick with the hero standing on a monster, and reports its wait. */
  const waitAfterSwinging = async (buffed) => {
    const world = await buildFloor("castle/arena/db_floor_TUTORIAL_LEVEL_1.json");
    const { session } = world;
    const [doid, actor] =
      [...session.actors].find(([, candidate]) => candidate.ai && candidate.isEnemy) ?? [];
    assert.ok(actor, "the floor produced an enemy with AI");

    session.heroPosition = { ...actor.position };
    const hero = session.actors.get(session.heroDoid);
    if (hero) hero.position = { ...actor.position };
    if (buffed) {
      session.activeBuffs = new Map([[1, { affectedActor: doid, buff: cripple }]]);
    }

    actor.ai.attackTimerMs = 1000;
    actor.ai.attackRandMs = 0;
    actor.ai.nextAttackAt = 0;
    const now = 100000;
    await tickNpcAi(session, now, 0.1);
    return actor.ai.nextAttackAt - now;
  };

  const plain = await waitAfterSwinging(false);
  const muzzled = await waitAfterSwinging(true);

  assert.ok(plain > 0, `the monster never swung (wait ${plain})`);
  assert.equal(
    muzzled,
    plain * (1 / cripple.MELEE_SPD),
    `muzzled waited ${muzzled} against an ordinary ${plain}`
  );
});

test("every debuff a weapon can leave has something that reads it", async () => {
  /**
   * An audit rather than a case: the eight modifier debuffs between them author
   * four kinds of effect, and each needs a different part of the server to be
   * looking. The first version of this audit filtered zero out as "no effect"
   * and reported `STOP` and `SHOCK` as dead — but `MOVEMENT` zero is the whole
   * of what a root is, and reading it as nothing is how a debuff stays a
   * picture on the health bar.
   */
  const gm = await loadGameMaster();
  const named = new Set();
  for (const modifier of gm.raw.Modifiers) if (modifier.BUFF_1) named.add(modifier.BUFF_1);

  const families = new Map();
  for (const buff of gm.raw.Buff) {
    if (!named.has(buff.Constant)) continue;
    const family = buff.Constant.replace(/_L\d+$/, "");
    const carries = (key) => buff[key] !== undefined && buff[key] !== "" && Number(buff[key]) !== 1;
    families.set(family, {
      dot: buff.BuffType === "DAMAGE_OVER_TIME" && Number(buff.PercentDamage) > 0,
      movement: carries("MOVEMENT"),
      speed: carries("MELEE_SPD"),
      ability: buff.Ability1,
      ...(families.get(family) ?? {}),
    });
  }

  assert.equal(families.size, 8, "eight families of debuff come off a weapon");
  for (const [family, row] of families) {
    const covered =
      row.dot || // startDamageOverTime
      row.movement || // the AI's mobility multiplier
      row.speed || // attackIntervalMs
      row.ability === "STUN" ||
      row.ability === "SHOCK"; // the attack gate
    assert.ok(covered, `${family} authors nothing this server acts on`);
  }
});

test("a shocked monster does not swing", async () => {
  /**
   * `SHOCK_L0` says "Unable to attack or move". Its `MOVEMENT` zero held the
   * monster still and the swinging half was nobody's, so Zapping pinned a
   * monster in place and let it go on hitting whoever stood next to it.
   */
  const { buildFloor } = await import("./helpers/floor.js");
  const { tickNpcAi } = await import("../src/socket/ai.js");
  const gm = await loadGameMaster();
  const shock = gm.raw.Buff.find((row) => row.Constant === "SHOCK_L1");
  assert.equal(shock.Ability1, "SHOCK");

  const swung = async (buffed) => {
    const world = await buildFloor("castle/arena/db_floor_TUTORIAL_LEVEL_1.json");
    const { session } = world;
    const [doid, actor] =
      [...session.actors].find(([, candidate]) => candidate.ai && candidate.isEnemy) ?? [];
    session.heroPosition = { ...actor.position };
    const hero = session.actors.get(session.heroDoid);
    if (hero) hero.position = { ...actor.position };
    if (buffed) session.activeBuffs = new Map([[1, { affectedActor: doid, buff: shock }]]);

    actor.ai.attackTimerMs = 1000;
    actor.ai.attackRandMs = 0;
    actor.ai.nextAttackAt = 0;
    await tickNpcAi(session, 100000, 0.1);
    return actor.ai.nextAttackAt !== 0;
  };

  assert.equal(await swung(false), true, "the monster swings when nothing stops it");
  assert.equal(await swung(true), false, "a shocked monster swung anyway");
});

test("the movement debuffs move a monster as far as they say", async () => {
  /**
   * Run rather than read. Muzzling looked correct in the source and did nothing,
   * so "the multiplier is in the code" is not an answer to "does root work" —
   * this walks a monster for half a second and measures how far it got.
   *
   * `MOVEMENT` is a multiplier on its speed, so a root is a zero and a slow is
   * a fraction. Both are asserted: a debuff that stops a monster and a debuff
   * that halves it are different claims and only one of them is "it works".
   */
  const { buildFloor } = await import("./helpers/floor.js");
  const { tickNpcAi } = await import("../src/socket/ai.js");
  const gm = await loadGameMaster();

  const walked = async (constant) => {
    const buff = constant ? gm.raw.Buff.find((row) => row.Constant === constant) : null;
    const world = await buildFloor("castle/arena/db_floor_TUTORIAL_LEVEL_1.json");
    const { session } = world;
    const [doid, actor] =
      [...session.actors].find(([, candidate]) => candidate.ai && candidate.isEnemy) ?? [];
    assert.ok(actor, "the floor produced an enemy with AI");

    // Far enough that it wants to walk rather than stand and swing.
    session.heroPosition = { x: actor.position.x + 500, y: actor.position.y };
    const hero = session.actors.get(session.heroDoid);
    if (hero) hero.position = { ...session.heroPosition };
    if (buff) session.activeBuffs = new Map([[1, { affectedActor: doid, buff }]]);

    const from = { ...actor.position };
    let now = 100000;
    for (let tick = 0; tick < 5; tick += 1) {
      await tickNpcAi(session, now, 0.1);
      now += 100;
    }
    return Math.hypot(actor.position.x - from.x, actor.position.y - from.y);
  };

  const free = await walked(null);
  assert.ok(free > 20, `an unhindered monster barely moved (${free})`);

  // Sticky, Stunning and Zapping all author MOVEMENT zero.
  for (const constant of ["STOP_L4", "STUN_L4", "SHOCK_L1"]) {
    assert.equal(await walked(constant), 0, `${constant} let the monster walk`);
  }

  // And Slowing is a fraction of the distance, not a stop.
  const slow = gm.raw.Buff.find((row) => row.Constant === "SLOW_L1");
  const slowed = await walked("SLOW_L1");
  assert.ok(slowed > 0, "a slow is not a stop");
  assert.ok(
    Math.abs(slowed - free * slow.MOVEMENT) < free * 0.05,
    `slowed ${Math.round(slowed)} against an expected ${Math.round(free * slow.MOVEMENT)}`
  );
});

test("a placed bomb burns with the modifiers of the weapon that threw it", async () => {
  /**
   * Reported: a napalm bomb's fire should take its power from the modifier.
   * The placeable path has always carried the weapon's `power` and never the
   * weapon, so `attackMultiplierFor` had nothing to read and a Sturdy bomb
   * burned exactly as hard as a plain one.
   *
   * Only the lingering damage runs through here. A thrown weapon's impact is
   * proposed by the client and priced in `applyProposals`, which has had the
   * weapon since the modifiers went in.
   */
  const { performPlaceableAttack } = await import("../src/socket/combat.js");
  const { CLID } = await import("../src/socket/opcodes.js");
  const gm = await loadGameMaster();
  const sturdy = gm.modifiersById.get(STURDY_L1);

  /**
   * `GARLIC_EXPLOSION` and not `THROW_FIREBOMB`: the throw carries no
   * `DamageMod` at all — it is the arc, and the damage belongs to the thing it
   * leaves behind, which is the half that runs through here.
   */
  const attack = gm.raw.Attack.find((row) => row.Constant === "GARLIC_EXPLOSION");
  assert.ok(Number(attack?.DamageMod) < 0, "the fixture attack still deals damage");

  const dealt = async (weapon) => {
    const ENEMY = 9900;
    const actor = {
      hitPoints: 5000000, maxHitPoints: 5000000, collisionRadius: 25,
      constant: "BRUTE", isEnemy: true, position: { x: 1050, y: 1000 },
    };
    const session = {
      id: 45,
      heroDoid: 500,
      floorDoid: 400,
      dungeonActive: true,
      dungeonAvatar: { avatar_id: 104, experience: 0 },
      heroWeapons: [weapon ?? {}],
      random: () => 1,
      objects: new Map([[ENEMY, CLID.DistributedNPCGameObject]]),
      actors: new Map([[ENEMY, actor]]),
      allocateDoid: () => 901,
      send: () => {},
    };
    await performPlaceableAttack(session, 700, {
      attack,
      victims: [{ doid: ENEMY, actor }],
      weaponPower: 30,
      weapon,
    });
    return 5000000 - actor.hitPoints;
  };

  const plain = await dealt(null);
  const boosted = await dealt({ type: 12502, power: 30, modifier1: STURDY_L1 });

  assert.ok(plain > 0, "the bomb hurt anything at all");
  assert.equal(boosted, Math.round(plain * sturdy.MELEE_ATK));
});

test("a bomb crits when the weapon that threw it can, and not otherwise", async () => {
  /**
   * Thrown weapons crit officially — `THROW_GARLIC` 13, `THROW_FIREBOMB` 11,
   * `THROW_MINE` 7 — while `HEALTH_BOMB_ATTACK` and `PARTY_BOMB_ATTACK` carry
   * none across 623 recorded hits, and no floor trap does either. A crit comes
   * off a weapon's modifiers, so the thing without a weapon does not get one.
   */
  const { performPlaceableAttack } = await import("../src/socket/combat.js");
  const { CLID } = await import("../src/socket/opcodes.js");
  const gm = await loadGameMaster();
  const attack = gm.raw.Attack.find((row) => row.Constant === "GARLIC_EXPLOSION");

  const dealt = async (weapon, random) => {
    const ENEMY = 9900;
    const actor = {
      hitPoints: 5000000, maxHitPoints: 5000000, collisionRadius: 25,
      constant: "BRUTE", isEnemy: true, position: { x: 1050, y: 1000 },
    };
    const sent = [];
    const session = {
      id: 46, heroDoid: 500, floorDoid: 400, dungeonActive: true,
      dungeonAvatar: { avatar_id: 104, experience: 0 },
      heroWeapons: [weapon ?? {}], random,
      objects: new Map([[ENEMY, CLID.DistributedNPCGameObject]]),
      actors: new Map([[ENEMY, actor]]),
      allocateDoid: () => 901,
      send: (packet) => sent.push(packet),
    };
    await performPlaceableAttack(session, 700, {
      attack, victims: [{ doid: ENEMY, actor }], weaponPower: 30, weapon,
    });
    const echo = sent.find(
      (packet) => packet.readUInt16LE(2) === 124 && packet.readUInt32LE(4) === ENEMY &&
        packet.readUInt16LE(8) === 144
    );
    return { damage: 5000000 - actor.hitPoints, crit: echo ? echo.readUInt8(2 + 8 + 26) : null };
  };

  const critical = { type: 12502, power: 30, modifier1: CRITICAL_L1 };
  const rolled = await dealt(critical, () => 0); // under the chance
  const missed = await dealt(critical, () => 1); // over it

  assert.ok(missed.damage > 0, "the bomb hurt anything at all");
  assert.equal(rolled.damage, missed.damage * 2, "a Critical bomb hits twice as hard");
  assert.equal(rolled.crit, 1, "and says so on the wire");
  assert.equal(missed.crit, 0);

  // A bomb with no weapon behind it — a consumable, or a floor trap — never does.
  const bare = await dealt(null, () => 0);
  assert.equal(bare.crit, 0, "something with no weapon crit anyway");
});

test("a consumable bomb is not lent the first weapon's modifiers", async (t) => {
  /**
   * `useConsumable` passes slot 0 because the slot a bomb came from indexes the
   * powerups, not the weapons — so reading `heroWeapons[0]` hands the bomb
   * whatever is in the hero's first slot. It would crit and scale on modifiers
   * that have nothing to do with it.
   *
   * Asserted on the placeable that is actually left standing rather than on the
   * shape of the call, because a flag that is passed and ignored looks the same
   * from the caller.
   */
  const { schedulePlaceables, clearDungeonPlaceables } = await import(
    "../src/socket/placeables.js"
  );
  const { CLID } = await import("../src/socket/opcodes.js");
  const gm = await loadGameMaster();

  const placed = async (options) => {
    let nextDoid = 900;
    const session = {
      id: 47, heroDoid: 500, floorDoid: 400, dungeonActive: true, dungeonZone: 10,
      heroPosition: { x: 1000, y: 1000 }, heroHeading: 0,
      dungeonAvatar: { avatar_id: 104, experience: 0 },
      heroWeapons: [{ type: 12502, power: 30, modifier1: CRITICAL_L1 }],
      objects: new Map(), actors: new Map(),
      allocateDoid: () => ++nextDoid, send: () => {},
    };
    // COOKING_COOLDOWN_POISON is the poison pot: an attack that places a cloud.
    const attack = gm.raw.Attack.find((row) => row.Constant === "COOKING_COOLDOWN_POISON");
    assert.ok(attack, "the fixture attack still places something");
    await schedulePlaceables(session, attack, 0, options);
    t.after(() => clearDungeonPlaceables(session));
    /**
     * The spawn is scheduled on the attack's own timeline frame. Waiting a fixed
     * sleep guesses at that; polling until it lands does not, and gives up
     * rather than hanging if the fixture ever stops placing anything.
     */
    for (let waited = 0; waited < 3000 && !(session.placeables?.size > 0); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [...(session.placeables?.values() ?? [])];
  };

  const fromWeapon = await placed({ playSpeed: 1 });
  const fromBomb = await placed({ playSpeed: 1, fromWeapon: false });

  assert.ok(fromWeapon.length || fromBomb.length, "something was placed to inspect");
  for (const live of fromWeapon) {
    assert.ok(live.heroWeapon, "a weapon's placeable lost the weapon that threw it");
  }
  for (const live of fromBomb) {
    assert.equal(live.heroWeapon, null, "a consumable's placeable was lent a weapon");
  }
});

const STICKY_L1 = 70041; // ROOT, BUFF_1 = STOP_L0

test("a Sticky bomb roots whatever its fire catches, not only what it struck", async () => {
  /**
   * Reported: a Sticky napalm rooted the enemy the bomb hit on its way down and
   * nothing that walked into the burning patch afterwards. The weapon's debuffs
   * were applied where the client proposes a hit and nowhere else, so the
   * lingering half of every placeable left nothing behind.
   */
  const { performPlaceableAttack } = await import("../src/socket/combat.js");
  const { CLID } = await import("../src/socket/opcodes.js");
  const gm = await loadGameMaster();

  const sticky = gm.modifiersById.get(STICKY_L1);
  assert.equal(sticky.MODIFIER_TYPE, "ROOT", "the fixture is the Sticky row");
  const rooted = gm.raw.Buff.find((row) => row.Constant === sticky.BUFF_1);
  assert.equal(Number(rooted.MOVEMENT), 0, "and what it leaves is a root");

  const caught = async (weapon) => {
    const ENEMY = 9900;
    const actor = {
      hitPoints: 5000000, maxHitPoints: 5000000, collisionRadius: 25,
      constant: "BRUTE", isEnemy: true, position: { x: 1050, y: 1000 },
    };
    let nextDoid = 900;
    const session = {
      id: 48, heroDoid: 500, floorDoid: 400, dungeonActive: true, dungeonZone: 10,
      dungeonAvatar: { avatar_id: 104, experience: 0 },
      heroWeapons: [weapon ?? {}], random: () => 1,
      objects: new Map([[ENEMY, CLID.DistributedNPCGameObject]]),
      actors: new Map([[ENEMY, actor]]),
      allocateDoid: () => ++nextDoid, send: () => {},
    };
    await performPlaceableAttack(session, 700, {
      attack: gm.raw.Attack.find((row) => row.Constant === "GARLIC_EXPLOSION"),
      victims: [{ doid: ENEMY, actor }],
      weaponPower: 30,
      weapon,
    });
    return [...(session.activeBuffs?.values() ?? [])]
      .filter((live) => live.affectedActor === ENEMY)
      .map((live) => live.buff?.Constant);
  };

  assert.ok(
    (await caught({ type: 12502, power: 30, modifier1: STICKY_L1 })).includes(sticky.BUFF_1),
    "the fire caught it and left nothing"
  );

  // A trap or a consumable throws nothing of its own, so it leaves nothing.
  assert.ok(!(await caught(null)).includes(sticky.BUFF_1));
});

test("the fire a bomb leaves keeps the weapon that lit it", async (t) => {
  /**
   * Reported: standing in the burning patch took damage and no debuff, while
   * being hit by the bomb itself did both.
   *
   * `BURNING_EXPLOSION` spawns `BURNING_FIRE_PLACEABLE` — the bomb sets the
   * floor alight where it goes off — and that second spawn was handed the
   * hero's weapon under the wrong key. `spawnPlaceable` names the parameter
   * `heroWeapon` because it already has a `weapon` of its own, the one the
   * placed NPC fights with, so `weapon:` was accepted in silence and dropped.
   *
   * The bomb needs something to go off on, and the fire has to be found by its
   * own name: the first version of this looked for a constant matching /FIRE/
   * and was satisfied by `FIREBOMB_PLACEABLE_L1` — the bomb — so it passed with
   * the chain never running and with the bug restored.
   */
  const { spawnPlaceable, clearDungeonPlaceables } = await import(
    "../src/socket/placeables.js"
  );
  const { CLID } = await import("../src/socket/opcodes.js");
  const gm = await loadGameMaster();
  const weapon = { type: 12502, power: 30, modifier1: STICKY_L1 };

  const firebomb = gm.raw.Npc.find((row) => row.Constant === "FIREBOMB_PLACEABLE_L1");
  assert.equal(firebomb?.Attack1, "BURNING_EXPLOSION", "the fixture bomb still explodes into fire");

  const ENEMY = 9900;
  let nextDoid = 900;
  const session = {
    id: 49, heroDoid: 500, floorDoid: 400, dungeonActive: true, dungeonZone: 10,
    heroPosition: { x: 1000, y: 1000 }, heroHeading: 0,
    dungeonAvatar: { avatar_id: 104, experience: 0 },
    heroWeapons: [weapon],
    objects: new Map([[ENEMY, CLID.DistributedNPCGameObject]]),
    // Something for the blast to catch, or it never performs and never chains.
    actors: new Map([[ENEMY, {
      hitPoints: 5000000, maxHitPoints: 5000000, collisionRadius: 25,
      constant: "BRUTE", isEnemy: true, position: { x: 1010, y: 1000 },
    }]]),
    allocateDoid: () => ++nextDoid, send: () => {},
  };
  t.after(() => clearDungeonPlaceables(session));

  await spawnPlaceable(session, {
    action: { spawnname: firebomb.Constant, offset: 60, headingOffsetAngle: 0, timetolive: 10, frame: 14 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
    weaponPower: 30,
    heroWeapon: weapon,
  });

  const fireOf = () =>
    [...(session.placeables?.values() ?? [])].find(
      (placed) => placed.constant === "BURNING_FIRE_PLACEABLE"
    );
  for (let waited = 0; waited < 6000 && !fireOf(); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const fire = fireOf();
  assert.ok(
    fire,
    `the bomb lit no fire — placed ${[...(session.placeables?.values() ?? [])]
      .map((p) => p.constant)
      .join(", ") || "nothing"}`
  );
  assert.equal(fire.heroWeapon, weapon, "the fire lost the weapon that lit it");
});

const MUZZLING = 70035; // CRIPPLE_5, BUFF_1 = CRIPPLE_L4

test("swinging a Muzzling weapon leaves the slowdown where the AI reads it", async () => {
  /**
   * The link between "the weapon grants the debuff" and "the AI pays it". Both
   * halves were tested on their own — the grant in one test and the interval in
   * another, with the buff placed by hand — and a chain tested only at its ends
   * is how Muzzling looked correct while doing nothing in the first place.
   */
  const { buffMultiplierFor } = await import("../src/socket/buffs.js");
  const { attackIntervalMs } = await import("../src/socket/ai.js");
  const gm = await loadGameMaster();

  const muzzling = gm.modifiersById.get(MUZZLING);
  assert.equal(muzzling.Name, "Muzzling", "the fixture is the reported modifier");
  const cripple = gm.raw.Buff.find((row) => row.Constant === muzzling.BUFF_1);

  const { session, ENEMY } = await arena({ type: 12502, power: 30, modifier1: MUZZLING });
  await swing(session, ENEMY);

  assert.equal(
    held(session, ENEMY, muzzling.BUFF_1),
    1,
    "the swing left no muzzle on the monster"
  );

  // The value the AI tick reads off that same session, and what it does with it.
  const speed = buffMultiplierFor(session, ENEMY, "MELEE_SPD");
  assert.equal(speed, cripple.MELEE_SPD, "the AI would read a different speed than was granted");
  assert.equal(
    attackIntervalMs({ attackTimerMs: 1000, attackRandMs: 0 }, 1 / speed),
    1000 / cripple.MELEE_SPD
  );
});

test("a muzzled monster swings slowly, not just seldom", async () => {
  /**
   * Reported twice, and the second report was the precise one: the monster's
   * *motion* while striking should slow, which is a different thing from how
   * often it strikes and a different thing again from how fast it walks.
   *
   * `playSpeed` on `ReceiveAttackChoreography` is what the client plays the
   * swing at, and the official scales it by exactly the attack-speed multiplier
   * the actor carries — 57 of its packets sit on 0.20 while the monster holds a
   * `CRIPPLE_L3` or `CRIPPLE_L4`, both authoring `MELEE_SPD` 0.2, and 3 on 0.85
   * under `CHILL_L1`, which authors 0.85.
   */
  const { buildFloor } = await import("./helpers/floor.js");
  const { tickNpcAi } = await import("../src/socket/ai.js");
  const gm = await loadGameMaster();
  const cripple = gm.raw.Buff.find((row) => row.Constant === "CRIPPLE_L4");

  const playSpeedOf = async (buffed) => {
    const world = await buildFloor("castle/arena/db_floor_TUTORIAL_LEVEL_1.json");
    const { session } = world;
    const [doid, actor] =
      [...session.actors].find(([, candidate]) => candidate.ai && candidate.isEnemy) ?? [];
    session.heroPosition = { ...actor.position };
    const hero = session.actors.get(session.heroDoid);
    if (hero) hero.position = { ...actor.position };
    if (buffed) session.activeBuffs = new Map([[1, { affectedActor: doid, buff: cripple }]]);

    actor.ai.attackTimerMs = 1000;
    actor.ai.attackRandMs = 0;
    actor.ai.nextAttackAt = 0;
    // The helper keeps its frames to itself, so take the tap for this tick.
    const sent = [];
    session.send = (frame) => sent.push(frame);
    await tickNpcAi(session, 100000, 0.1);

    // Field 143 on the monster: op(2) doid(4) field(2), then the header, whose
    // playSpeed sits past weaponSlot, isConsumable, attackType, target and loop.
    const packet = sent
      .find(
        (frame) => frame.readUInt16LE(2) === 124 &&
          frame.readUInt32LE(4) === doid &&
          frame.readUInt16LE(8) === 143
      );
    assert.ok(packet, "the monster sent no attack choreography");
    return packet.readFloatLE(2 + 8 + 11);
  };

  assert.equal(await playSpeedOf(false), 1, "an unhindered monster swings at full speed");

  // Compared with a tolerance: the field is an f32 on the wire, so an authored
  // 0.2 comes back as 0.20000000298023224.
  const muzzled = await playSpeedOf(true);
  assert.ok(
    Math.abs(muzzled - cripple.MELEE_SPD) < 1e-6,
    `swung at ${muzzled} against an authored ${cripple.MELEE_SPD}`
  );
});

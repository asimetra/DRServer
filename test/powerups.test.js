import assert from "node:assert/strict";
import test from "node:test";

import { dooberForConstant } from "../src/gamemaster.js";
import { buffMultiplierFor } from "../src/socket/buffs.js";
import { handleProposeAttackChoreography } from "../src/socket/buster.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import { collectNearby } from "../src/socket/pickups.js";
import { clearDungeonPowerups, spawnPowerup } from "../src/socket/powerups.js";

test("FOOD_BUFF resolves to the authored three-soup category", async () => {
  const power = await dooberForConstant("FOOD_BUFF", () => 0);
  const defense = await dooberForConstant("FOOD_BUFF", () => 0.999);

  assert.equal(power.Constant, "FOOD_BUFF_BEEFY");
  assert.equal(defense.Constant, "FOOD_BUFF_DEFENSE");
});

test("the cooking-pot choreography spends its Mana and schedules one protected powerup", async () => {
  const session = {
    id: 40,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 100, y: 100 },
    heroManaPoints: 50,
    heroWeapons: [{ type: 15502 }], // HERO_BUFF_COOKING_POT
    dungeonBusterPoints: 0,
    objects: new Map(),
    send() {},
  };
  const proposal = new PacketWriter()
    .u8(0) // weapon slot
    .u8(0) // not a consumable
    .u32(901702) // COOKING_COOLDOWN_BUFF
    .u32(0) // no target
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

  await handleProposeAttackChoreography(session, new PacketReader(proposal));

  assert.equal(session.heroManaPoints, 0);
  // Keyed by the slot it came from as well as the attack; see cooldowns.js.
  assert.ok(session.attackCooldownUntil.get("COOKING_COOLDOWN_BUFF|0") > Date.now());
  assert.equal(session.powerupSpawnTimers.size, 1);
  clearDungeonPowerups(session);
});

test("a forged cooking-pot attack cannot create powerups without the buff pot", async () => {
  const session = {
    id: 40,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 100, y: 100 },
    heroManaPoints: 50,
    heroWeapons: [{ type: 15501 }], // HERO_FOOD_COOKING_POT, not the buff variant
    dungeonBusterPoints: 0,
    objects: new Map(),
    send() {},
  };
  const proposal = new PacketWriter()
    .u8(0)
    .u8(0)
    .u32(901702)
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

  await handleProposeAttackChoreography(session, new PacketReader(proposal));

  assert.equal(session.heroManaPoints, 50);
  assert.equal(session.powerupSpawnTimers, undefined);
});

test("a Battle Chef powerup is visible, collectable, and grants its HUD/combat buff", async () => {
  const sent = [];
  const heroDoid = 500;
  const session = {
    id: 41,
    heroDoid,
    floorDoid: 400,
    dungeonZone: 10,
    heroPosition: { x: 100, y: 100 },
    random: () => 0,
    objects: new Map([
      [400, CLID.DistributedDungeonFloor],
      [heroDoid, CLID.HeroGameObject],
    ]),
    actors: new Map([[heroDoid, { position: { x: 100, y: 100 } }]]),
    nextDoid: 700,
    allocateDoid(clid) {
      const doid = this.nextDoid++;
      this.objects.set(doid, clid);
      return doid;
    },
    send: (frame) => sent.push(frame),
  };

  const { powerupActionFor } = await import("../src/socket/powerups.js");
  const { attackForConstant } = await import("../src/gamemaster.js");
  const action = await powerupActionFor(await attackForConstant("COOKING_COOLDOWN_BUFF"));
  const doid = await spawnPowerup(session, { action, count: 1 });
  const doober = session.doobers.get(doid);
  assert.equal(doober.constant, "FOOD_BUFF_BEEFY");
  assert.equal(doober.buffGranted, "CHEF_BEEFY_BUFF");

  const generated = new PacketReader(sent[0].subarray(2));
  assert.equal(generated.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(generated.u32(), session.floorDoid);
  assert.equal(generated.u32(), session.dungeonZone);
  assert.equal(generated.u16(), CLID.DistributedDooberGameObject);
  assert.equal(generated.u32(), doid);
  assert.equal(generated.u32(), 30301);
  assert.equal(generated.f32(), doober.x);
  assert.equal(generated.f32(), doober.y);
  assert.equal(generated.u8(), 20);
  assert.equal(generated.eof(), true);

  assert.equal(collectNearby(session, doober), 1);
  await new Promise((resolve) => setImmediate(resolve));

  const buff = new PacketReader(sent.at(-1).subarray(2));
  assert.equal(buff.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(buff.u32(), session.floorDoid);
  assert.equal(buff.u32(), session.dungeonZone);
  assert.equal(buff.u16(), CLID.DistributedBuffGameObject);
  buff.u32(); // server-owned buff doid
  assert.equal(buff.u32(), 35601); // CHEF_BEEFY_BUFF
  assert.equal(buff.u32(), heroDoid);
  assert.equal(buff.u32(), heroDoid);
  assert.equal(buff.eof(), true);

  // Beefy Steak's exact GameMaster multiplier now feeds the server's damage
  // calculation as well as the client's HUD/VFX.
  assert.equal(buffMultiplierFor(session, heroDoid, "MELEE_ATK"), 1.5);
});

/**
 * The pot the Battle Chef actually carries.
 *
 * Only COOKING_COOLDOWN_BUFF was recognised, and the chef's slot 1 is
 * HERO_FOOD_COOKING_POT, whose attack is COOKING_COOLDOWN_FOOD — so the pot
 * every chef starts with did nothing at all. The two cook different things:
 * FOOD_COOK is ham, meatbone, steak and turkey; FOOD_BUFF is the three soups.
 */
test("the food pot cooks food, and the buff pot soup", async () => {
  const { isPowerupAttack } = await import("../src/socket/powerups.js");
  const { attackForConstant } = await import("../src/gamemaster.js");

  const food = await attackForConstant("COOKING_COOLDOWN_FOOD");
  const buff = await attackForConstant("COOKING_COOLDOWN_BUFF");
  const poison = await attackForConstant("COOKING_COOLDOWN_POISON");

  assert.equal(await isPowerupAttack(food), true);
  assert.equal(await isPowerupAttack(buff), true);
  // HOSTILE, thirty collisions: an area attack, not something to pick up.
  assert.equal(await isPowerupAttack(poison), false);

  const cook = async (potConstant) => {
    const { powerupActionFor } = await import("../src/socket/powerups.js");
    const action = await powerupActionFor(await attackForConstant(potConstant));
    const session = {
      id: 42,
      heroDoid: 500,
      floorDoid: 400,
      heroPosition: { x: 100, y: 100 },
      random: () => 0,
      objects: new Map(),
      nextDoid: 800,
      allocateDoid() {
        return this.nextDoid++;
      },
      send() {},
    };
    const doid = await spawnPowerup(session, { action, count: 1 });
    return session.doobers.get(doid);
  };

  assert.match((await cook("COOKING_COOLDOWN_FOOD")).constant, /_COOK$/);
  assert.ok((await cook("COOKING_COOLDOWN_FOOD")).hpPercentage > 0, "food heals");
  assert.equal((await cook("COOKING_COOLDOWN_BUFF")).buffGranted, "CHEF_BEEFY_BUFF");
});

/**
 * One shared timer meant cooking soup blocked cooking food — and one timer per
 * attack meant the second of two identical pots did nothing at all.
 */
test("each pot keeps its own cooldown, by attack and by slot", async () => {
  const { isOffCooldown, noteCooldown } = await import("../src/socket/cooldowns.js");
  const { attackForConstant } = await import("../src/gamemaster.js");

  const food = await attackForConstant("COOKING_COOLDOWN_FOOD");
  const buff = await attackForConstant("COOKING_COOLDOWN_BUFF");
  // Not a pot at all: the Ranger's speed scroll authors twenty seconds too, and
  // used to be tracked by nothing because it cooks nothing.
  const scroll = await attackForConstant("SPEED_BUFF_PULSE_COOLDOWN");
  const session = { id: 43 };

  await noteCooldown(session, buff, 0);
  assert.equal(isOffCooldown(session, buff, 0), false, "the soup pot is recharging");
  assert.equal(isOffCooldown(session, food, 0), true, "the food pot is not");
  assert.equal(isOffCooldown(session, scroll, 0), true, "nor is the scroll");

  /**
   * And the same pot in the other slot is a different pot.
   *
   * The official's own recording, on a five second cooldown:
   *
   *   13:30:01.187  propose THROW_FIREBOMB from slot 1
   *   13:30:01.919    FIREBOMB_PLACEABLE_L3 spawned
   *   13:30:02.309  propose THROW_FIREBOMB from slot 2
   *   13:30:03.051    FIREBOMB_PLACEABLE_L3 spawned
   *
   * A second bomb a second and a half into a five second wait, and it landed.
   */
  assert.equal(isOffCooldown(session, buff, 1), true, "the same pot in the other slot is ready");
  await noteCooldown(session, buff, 1);
  assert.equal(isOffCooldown(session, buff, 1), false, "until that one is used too");
  assert.equal(isOffCooldown(session, buff, 0), false, "and the first is still counting");

  await noteCooldown(session, scroll, 0);
  assert.equal(isOffCooldown(session, scroll, 0), false, "and now the scroll waits its twenty");
  assert.equal(
    isOffCooldown(session, scroll, 0, Date.now() + 21_000),
    true,
    "which it does not do forever"
  );
});

/**
 * The authored seconds are not the wait. `WeaponController.startCooldown`:
 *
 *   mCoolDownTime = L*1000 * weapon.cooldownReduction()
 *                 - L*1000 * hero.attackCooldownMultiplier
 *
 * Enforcing the authored number instead is stricter than the game for anybody
 * who bought the reduction, and with DR_REQUIRE_CAST on a cast refused for a
 * cooldown that had actually expired takes the following hits down with it.
 */
test("a cooldown is shortened by the weapon and by the hero", async () => {
  const { effectiveCooldownMs } = await import("../src/socket/cooldowns.js");
  const { attackForConstant } = await import("../src/gamemaster.js");

  const attack = await attackForConstant("THUNDER_PULSE");
  assert.equal(Number(attack.CooldownLength), 1.5, "the authored wait this is measured against");

  const plain = { id: 44, heroDoid: 500 };
  assert.equal(await effectiveCooldownMs(plain, attack, 0), 1500, "unmodified, it is the authored wait");

  // COOLDOWN_REDUC_5, the strongest of the five modifier rows that carry one.
  const modded = { id: 44, heroDoid: 500, heroWeapons: [{ modifier1: 70185 }] };
  assert.equal(
    await effectiveCooldownMs(modded, attack, 0),
    600,
    "0.4 off the weapon is 0.4 of the wait"
  );

  /**
   * Only the Sorcerer authors MAGIC_COOLDOWN, and only in slot three, which is
   * the one slot the client's override looks at. `AmtStat3` is 1 against the
   * super stat's CooldownReduction of 0.33, so a hundred points takes a third.
   */
  const sorcerer = {
    id: 44,
    heroDoid: 500,
    dungeonAvatar: { avatar_id: 103, statupgrade3: 100 },
  };
  assert.equal(
    Math.round(await effectiveCooldownMs(sorcerer, attack, 0)),
    Math.round(1500 - 1500 * 0.33),
    "a fully bought Sorcerer takes a third off"
  );

  // A hero without the slot is not shortened, because no buff authors anything
  // but 1 — the branch is live, its data is inert.
  const ranger = { id: 44, heroDoid: 500, dungeonAvatar: { avatar_id: 102, statupgrade3: 100 } };
  assert.equal(
    await effectiveCooldownMs(ranger, attack, 0),
    1500,
    "and everybody else waits the authored time"
  );
});

/**
 * The two consumable slots — what the game calls powerups.
 *
 * All twenty-seven Stackables rows a slot can hold report ItemCategory POWERUP.
 * They ride in the hero's own generate, and HeroGameObject.set_consumableDetails
 * reads index 0 and 1 and hands them to setupConsumables, which builds the
 * ConsumableWeaponGameObjects. Leaving them at their default sent two empty
 * slots, so a player entered the dungeon without the potions they equipped.
 */
test("the hero carries its equipped powerups into the dungeon", async () => {
  const { consumablesForAvatar } = await import("../src/socket/dungeon.js");

  assert.deepEqual(
    consumablesForAvatar({
      consumable1_id: 70004,
      consumable1_count: 1,
      consumable2_id: 70002,
      consumable2_count: 3,
    }),
    [
      { type: 70004, count: 1 },
      { type: 70002, count: 3 },
    ]
  );
});

/** A type with no count, or a count with no type, is an empty slot. */
test("a half-filled powerup slot is an empty one", async () => {
  const { consumablesForAvatar } = await import("../src/socket/dungeon.js");

  assert.deepEqual(
    consumablesForAvatar({
      consumable1_id: 70004,
      consumable1_count: 0,
      consumable2_id: 0,
      consumable2_count: 5,
    }),
    [{}, {}]
  );
  assert.deepEqual(consumablesForAvatar(undefined), [{}, {}]);
});

/**
 * Using a powerup.
 *
 * ConsumableWeaponGameObject.consume() decrements the client's own copy and
 * tells the HUD, and that is all of it — nothing about the count crosses the
 * wire. So the number went 1 to 0 on screen while the account kept the potion
 * and nothing happened. The use arrives as an ordinary attack choreography
 * with isConsumableWeapon set, and the slot then indexes the powerup slots.
 */
const consumableProposal = (slot, attackId) =>
  new PacketWriter()
    .u8(slot)
    .u8(1) // isConsumableWeapon
    .u32(attackId)
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

const potionSession = (overrides = {}) => ({
  id: 50,
  heroDoid: 500,
  floorDoid: 400,
  dungeonActive: true,
  heroPosition: { x: 0, y: 0 },
  heroConsumables: [
    { type: 70000, count: 2 }, // CONSUMABLE_HEALTH_POTION
    { type: 70005, count: 1 }, // CONSUMABLE_STAT_MOVEMENT_POTION
  ],
  dungeonAvatar: { consumable1_id: 70000, consumable1_count: 2 },
  dungeonAccount: { account_stackables: [{ stack_id: 70000, count: 4 }] },
  actors: new Map([[500, { hitPoints: 100, maxHitPoints: 400 }]]),
  objects: new Map(),
  nextDoid: 900,
  allocateDoid() {
    return this.nextDoid++;
  },
  queueAccountSave() {},
  send() {},
  ...overrides,
});

test("a health potion is charged to the account and actually heals", async () => {
  const session = potionSession();

  await handleProposeAttackChoreography(session, new PacketReader(consumableProposal(0, 910500)));

  assert.equal(session.heroConsumables[0].count, 1, "the slot is spent");
  assert.equal(session.dungeonAvatar.consumable1_count, 1, "and so is the avatar's own count");
  /**
   * The bag is the reserve, and one potion is one charge.
   *
   * This asserted a decrement here as well, which was invisible only because
   * equipping moved the whole stack out of the bag and left nothing behind to
   * decrement. Now that the bag holds everything over the carry limit, taking
   * one from each would charge a player twice for one drink. The single charge
   * is the *total* falling by one — the slot pays for it, and leaving the
   * dungeon tops the slot back up out of the reserve.
   */
  assert.equal(session.dungeonAccount.account_stackables[0].count, 4, "the reserve is untouched");
  // PercentHealthDamageValue 1 against a 400 maximum, from 100.
  assert.equal(session.actors.get(500).hitPoints, 400);
});

test("an empty slot cannot be used", async () => {
  const session = potionSession({ heroConsumables: [{ type: 70000, count: 0 }, {}] });

  await handleProposeAttackChoreography(session, new PacketReader(consumableProposal(0, 910500)));

  assert.equal(session.actors.get(500).hitPoints, 100, "no heal");
  assert.equal(session.dungeonAccount.account_stackables[0].count, 4, "and no charge");
});

/** The slot decides what was used, not the attack the client names. */
test("a slot cannot be used for someone else's effect", async () => {
  const session = potionSession();

  // Slot 0 holds a health potion; ask it for the movement potion's attack.
  await handleProposeAttackChoreography(session, new PacketReader(consumableProposal(0, 910504)));

  assert.equal(session.heroConsumables[0].count, 2, "nothing spent");
  assert.equal(session.actors.get(500).hitPoints, 100, "nothing gained");
});

/** Stat potions cost no Crowd, and the buff used to hang off the Crowd branch. */
test("a stat potion grants its buff", async () => {
  const granted = [];
  const session = potionSession({
    dungeonAvatar: { consumable2_id: 70005, consumable2_count: 1 },
    allocateDoid() {
      granted.push(this.nextDoid);
      return this.nextDoid++;
    },
  });

  await handleProposeAttackChoreography(session, new PacketReader(consumableProposal(1, 910504)));

  assert.equal(session.heroConsumables[1].count, 0);
  assert.equal(granted.length, 1, "CONSUMABLE_MOVEMENT_BUFF was generated");
});

/**
 * How much a pot leaves is the chef's COOKING, capped at five.
 *
 * The count is in no table, so it is the rule the game shows. It is read across
 * the stat's own reachable range rather than against a number in the code: the
 * Battle Chef declares COOKING in slot 2 at 0.1 a point, and with the 75-point
 * cap that is a ceiling of 7.5.
 *
 * COOKING is invisible to statTotals — every combat column on the SuperStats
 * row is zero, its real fields being the HitSpawn and DeathSpawn chances — so
 * it has to be read off the slots that declare it.
 */
test("training points buy quality, not helpings", async () => {
  const { loadGameMaster, attackForConstant } = await import("../src/gamemaster.js");
  const { powerupActionFor } = await import("../src/socket/powerups.js");

  const gm = await loadGameMaster();
  const chef = gm.raw.Hero.find((hero) => hero.Constant === "BATTLE_CHEF");
  const action = await powerupActionFor(await attackForConstant("COOKING_COOLDOWN_FOOD"));

  const cook = async (points) => {
    const session = {
      id: 60,
      heroDoid: 500,
      floorDoid: 400,
      heroPosition: { x: 0, y: 0 },
      dungeonAvatar: { avatar_id: chef.Id, statupgrade2: points },
      objects: new Map(),
      nextDoid: 1000,
      allocateDoid() {
        return this.nextDoid++;
      },
      send() {},
    };
    const made = [];
    for (let round = 0; round < 40; round++) {
      session.doobers = new Map();
      await spawnPowerup(session, { action });
      made.push(...[...session.doobers.values()].map((entry) => entry.constant));
    }
    return made;
  };

  /**
   * The captured pots produced three, four, four and five in four uses by one
   * cook, so the number varies per use and the points are spent elsewhere.
   */
  const trained = await cook(75);
  const untrained = await cook(0);
  for (const batch of [trained, untrained]) {
    assert.ok(batch.length >= 40 * 3 && batch.length <= 40 * 5, "three to five a time");
  }

  // Where they are spent: an untrained cook turns out meatbones, a capped one
  // turkey, and no meatbone survives to the top of the ladder.
  assert.ok(untrained.every((name) => name === "FOOD_MEATBONE_COOK"), "bones untrained");
  assert.ok(trained.includes("FOOD_TURKEY_COOK"), "turkey at the cap");
  assert.ok(!trained.includes("FOOD_MEATBONE_COOK"), "and no bones there");

  // The captured chef sat at 65 of 75 and produced steak and ham, no bone and
  // no turkey. See docs/evidence.md — the curve is fitted to that.
  const captured = await cook(65);
  assert.deepEqual(
    [...new Set(captured)].sort(),
    ["FOOD_HAM_COOK", "FOOD_STEAK_COOK"],
    "65 of 75 cooks steak and ham"
  );
});

/** A hero with no COOKING slot at all cooks at the bottom of the ladder. */
test("a hero that cannot cook turns out the small stuff", async () => {
  const { loadGameMaster, attackForConstant } = await import("../src/gamemaster.js");
  const { powerupActionFor } = await import("../src/socket/powerups.js");
  const gm = await loadGameMaster();
  const ranger = gm.raw.Hero.find((hero) => hero.Constant === "RANGER");

  const session = {
    id: 61,
    heroDoid: 500,
    floorDoid: 400,
    heroPosition: { x: 0, y: 0 },
    dungeonAvatar: { avatar_id: ranger.Id, statupgrade2: 75 },
    objects: new Map(),
    nextDoid: 1100,
    allocateDoid() {
      return this.nextDoid++;
    },
    send() {},
  };

  const action = await powerupActionFor(await attackForConstant("COOKING_COOLDOWN_FOOD"));
  await spawnPowerup(session, { action });
  const made = [...session.doobers.values()].map((entry) => entry.constant);
  assert.ok(made.length >= 3, "it still cooks");
  assert.ok(made.every((name) => name === "FOOD_MEATBONE_COOK"), "but only bones");
});

test("a cooked pickup lands in front of the chef, not at some angle off it", async () => {
  const sent = [];
  const session = {
    id: 42,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    dungeonAvatar: { avatar_id: 104, experience: 0 },
    objects: new Map(),
    doobers: new Map(),
    allocateDoid: () => 901,
    send: (packet) => sent.push(packet),
  };

  /**
   * Heading is degrees on the wire, so 90 faces +y. Taking its cosine directly
   * — as this did — treats 90 as radians and throws the food roughly backwards.
   * No spread, so the landing point is exactly the offset.
   */
  await spawnPowerup(session, {
    origin: { x: 1000, y: 1000 },
    heading: 90,
    count: 1,
    action: {
      spawnname: "FOOD_COOK",
      offset: 120,
      randomXoffset: 0,
      randomYoffset: 0,
      timetolive: 15,
      frame: 14,
    },
  });

  const landed = [...session.doobers.values()][0];
  assert.ok(landed, "something was cooked");
  assert.ok(Math.abs(landed.x - 1000) < 0.01, "no drift across the facing");
  assert.ok(Math.abs(landed.y - 1120) < 0.01, "a hundred and twenty units in front");
  clearDungeonPowerups(session);
});

test("the pot draws on the chef's rarity row, so a turkey is possible at all", async () => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const { pickByRarity } = await import("../src/socket/drops.js");
  const gm = await loadGameMaster();
  const food = gm.doobers.filter((doober) => doober.DooberType === "FOOD_COOK");

  /**
   * The floor's row is three quarters meatbone and carries no UBER at all, so
   * cooking against it could never produce a turkey. CHEF_COOK is the chef's
   * own and spreads evenly across all four.
   */
  const floor = gm.rarityProbById.get("DOOBER");
  const chef = gm.rarityProbById.get("CHEF_COOK");
  assert.equal(floor.UBER ?? 0, 0, "the floor row has no turkey in it");
  assert.ok(chef.UBER > 0, "the chef's row does");

  const seen = new Set();
  for (let roll = 0; roll < 400; roll++) {
    seen.add(pickByRarity(food, chef, Math.random).Constant);
  }
  assert.ok(seen.has("FOOD_TURKEY_COOK"), "and a full heal comes up");
  assert.ok(seen.has("FOOD_MEATBONE_COOK"), "alongside the small one");
});

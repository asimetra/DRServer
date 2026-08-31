import test from "node:test";
import assert from "node:assert/strict";

import { handleProposeAttackChoreography } from "../src/socket/buster.js";
import {
  attackForConstant,
  loadGameMaster,
  spawnDooberActions,
  spawnNpcActions,
} from "../src/gamemaster.js";
import { CLID } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import { clearDungeonPlaceables, spawnPlaceable } from "../src/socket/placeables.js";
import { createNavigationState, isPositionBlocked } from "../src/socket/navigation.js";

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const world = (constant) => {
  let next = 900;
  const session = {
    id: 70,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 0,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    heroManaPoints: 500,
    maxHeroManaPoints: 500,
    dungeonBusterPoints: 999,
    maxDungeonBusterPoints: 999,
    dungeonBusterAttack: constant,
    heroWeapons: [{ type: 11001, power: 10 }],
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map(),
    navigation: null,
    random: () => 0.5,
    allocateDoid: (clid) => {
      const doid = ++next;
      session.objects.set(doid, clid);
      return doid;
    },
    sent: [],
    send: (frame) => session.sent.push(frame),
  };
  return session;
};

/** What went out on the wire as a generate of this class, by its type id. */
const generatedOf = (session, clid) => {
  const types = [];
  for (const frame of session.sent) {
    const body = frame.subarray(2);
    if (body.length < 20 || body.readUInt16LE(10) !== clid) continue;
    types.push(body.readUInt32LE(16));
  }
  return types;
};

const cast = async (session, attack) =>
  handleProposeAttackChoreography(
    session,
    new PacketReader(
      new PacketWriter().u8(0).u8(0).u32(Number(attack.Id)).u32(0).u8(0).f32(1).f32(1).u16(0).body()
    )
  );

/**
 * `spawnname` was read as a `DooberType` and rolled on a rarity table, which is
 * right for the four names that are one and wrong for the seven that name a row
 * outright. `FOOD_HAMBURGER` is a `Doobers` row, so filtering by type found
 * nothing and the Battle Chef's Dungeon Buster dropped nothing at all.
 *
 * And the shower authors twelve of them, each at its own offset and angle, where
 * this read only the first.
 */
test("the Battle Chef's shower leaves twelve burgers", async () => {
  const attack = await attackForConstant("DBUSTER_MEATEOR_SHOWER");
  const actions = await spawnDooberActions(attack.AttackTimeline);
  assert.equal(actions.length, 12, "the timeline authors twelve");

  const session = world("DBUSTER_MEATEOR_SHOWER");
  await cast(session, attack);
  // The twelve land across frames 20 to 60, which at 24fps is 2.5 seconds.
  await settle(3000);

  const gm = await loadGameMaster();
  const burger = Number(gm.raw.Doobers.find((row) => row.Constant === "FOOD_HAMBURGER").Id);
  const dropped = generatedOf(session, CLID.DistributedDooberGameObject).filter(
    (type) => type === burger
  );
  assert.equal(dropped.length, 12, `twelve landed, got ${dropped.length}`);
});

/**
 * The angle comes under two names and only one was read. 93 of the game's 143
 * `spawnnpc` actions carry `headingOffsetAngle`; the other 31 carry
 * `angleOffset`, and they are exactly the ones that arrange things in a ring.
 * Reading one name put every member of those rings on the same spot.
 */
test("the Vampire Hunter's garlic goes around him, not in front of him", async () => {
  const attack = await attackForConstant("DBUSTER_GARLIC_NUKE");
  const session = world("DBUSTER_GARLIC_NUKE");
  await cast(session, attack);
  await settle(2000);

  const placed = [...session.actors.values()].filter((actor) => actor.position);
  assert.equal(placed.length, 6, `six garlic, got ${placed.length}`);

  const spots = new Set(placed.map((actor) => `${Math.round(actor.position.x)},${Math.round(actor.position.y)}`));
  assert.equal(spots.size, 6, "each in its own place");

  // A ring: all six the same distance out, spread around the hero.
  const radii = placed.map((actor) =>
    Math.hypot(actor.position.x - 1000, actor.position.y - 1000)
  );
  assert.ok(Math.max(...radii) - Math.min(...radii) < 1, "all at one radius");
  assert.ok(radii[0] > 100, `and out from the caster, not on him (${radii[0].toFixed(0)})`);
  clearDungeonPlaceables(session);
});

test("Garlic Nuke bombs honour their authored arming delays", async () => {
  const attack = await attackForConstant("DBUSTER_GARLIC_NUKE");
  const session = world("DBUSTER_GARLIC_NUKE");
  session.objects.set(700, CLID.DistributedNPCGameObject);
  session.actors.set(700, {
    hitPoints: 10000,
    maxHitPoints: 10000,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 20,
    position: { x: 1120, y: 1000 },
  });

  await cast(session, attack);
  assert.equal(
    [...(session.activeBuffs?.values() ?? [])].some(
      (active) => active.affectedActor === session.heroDoid && active.buff.Constant === "ENSNARED"
    ),
    false,
    "the player-owned trap attack does not apply its hostile target debuff to its caster"
  );
  // Spawn is frame 20 (833ms); the earliest delayattack is another 1.25s.
  await settle(1100);

  assert.equal(session.actors.get(700).hitPoints, 10000, "landing alone does not detonate one");
  const earlyExplosions = session.sent.filter((frame) => {
    const body = frame.subarray(2);
    return body.length >= 14 && body.readUInt16LE(0) === 124 &&
      body.readUInt16LE(6) === 143 && body.readUInt32LE(10) === 910605;
  });
  assert.equal(earlyExplosions.length, 0, "no Garlic Nuke choreography precedes delayattack");
  clearDungeonPlaceables(session);
});

test("a blocked Garlic Nuke ring fits distinct bombs onto clear ground", async () => {
  const attack = await attackForConstant("DBUSTER_GARLIC_NUKE");
  const actions = await spawnNpcActions(attack.AttackTimeline);
  const session = world("DBUSTER_GARLIC_NUKE");
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
    staticColliders: [
      { type: "circle", x: 1060, y: 1104, radius: 18 },
      { type: "circle", x: 1060, y: 896, radius: 18 },
    ],
  });
  const placementGroup = { positions: [] };

  for (const action of actions) {
    await spawnPlaceable(session, {
      action,
      origin: session.heroPosition,
      heading: session.heroHeading,
      weaponPower: 10,
      placementGroup,
    });
  }

  const bombs = [...session.actors.values()].filter(
    (actor) => actor.constant === "GARLIC_NUKE_PLACEABLE"
  );
  assert.equal(bombs.length, 6);
  for (const bomb of bombs) {
    assert.equal(
      isPositionBlocked(session.navigation, bomb.position, bomb.collisionRadius),
      false,
      `bomb fitted at ${JSON.stringify(bomb.position)}`
    );
  }
  for (let left = 0; left < bombs.length; left++) {
    for (let right = left + 1; right < bombs.length; right++) {
      assert.ok(
        Math.hypot(
          bombs[left].position.x - bombs[right].position.x,
          bombs[left].position.y - bombs[right].position.y
        ) >= bombs[left].collisionRadius + bombs[right].collisionRadius,
        "fitted bombs do not stack into the same gap"
      );
    }
  }
  clearDungeonPlaceables(session);
});

test("Berserker's own ultimate impact does not add the party Berserk buff", async () => {
  const { applyTargetBuff } = await import("../src/socket/combat.js");
  const { clearDungeonBuffs } = await import("../src/socket/buffs.js");
  const attack = await attackForConstant("DBUSTER_BERSERK");
  const session = world("DBUSTER_BERSERK");

  await cast(session, attack);
  assert.deepEqual(
    [...session.activeBuffs.values()].map((active) => active.buff.Constant),
    ["BERSERK_DB"],
    "the caster starts with the authored self buff"
  );

  await applyTargetBuff(session, {
    attack,
    victimDoid: session.heroDoid,
    attackerDoid: session.heroDoid,
    damage: 0,
  });
  assert.deepEqual(
    [...session.activeBuffs.values()].map((active) => active.buff.Constant),
    ["BERSERK_DB"],
    "the impact's party buff excludes the caster covered by SelfBuff"
  );
  clearDungeonBuffs(session);
});

/** Three clones, in front and to either side. */
test("the Ghost Samurai brings three clones", async () => {
  const attack = await attackForConstant("DBUSTER_IRON_LEGION");
  const session = world("DBUSTER_IRON_LEGION");
  await cast(session, attack);
  await settle(3500);

  const placed = [...session.actors.values()].filter((actor) => actor.position);
  assert.equal(placed.length, 3, `three clones, got ${placed.length}`);
  const spots = new Set(placed.map((actor) => `${Math.round(actor.position.x)},${Math.round(actor.position.y)}`));
  assert.equal(spots.size, 3, "and not stacked on one another");
});

/**
 * A timeline says for itself how long its performer is untouchable:
 * `invulnerable` with `isInvulnerable` true opens the window and the same
 * action with false closes it. Twenty-two carry one, and every hero's Dungeon
 * Buster is among them — all six open at frame zero and hold it for most of the
 * animation, from the Vampire Hunter's 1625ms to the Sorcerer's 2917.
 *
 * None of it was granted, so a player using his ultimate took everything the
 * room had while standing still in an animation he could not cancel. From
 * inside, that reads as the ultimate hurting him.
 */
test("an ultimate keeps its caster untouchable while it plays", async () => {
  const { invulnerableForMs, attackForConstant } = await import("../src/gamemaster.js");
  const { applyDamage } = await import("../src/socket/combat.js");

  // Every hero's opens one, and the shortest is the Vampire Hunter's.
  const windows = {};
  for (const constant of [
    "DBUSTER_BERSERK",
    "DBUSTER_ARROWSTORM",
    "DBUSTER_BALL_LIGHTNING",
    "DBUSTER_MEATEOR_SHOWER",
    "DBUSTER_GARLIC_NUKE",
    "DBUSTER_IRON_LEGION",
  ]) {
    const attack = await attackForConstant(constant);
    windows[constant] = await invulnerableForMs(attack.AttackTimeline);
    assert.ok(windows[constant] > 1000, `${constant} opens one (${windows[constant]}ms)`);
  }
  assert.ok(
    Math.abs(windows.DBUSTER_GARLIC_NUKE - 1625) < 1,
    `the Vampire Hunter's is 1625ms, got ${windows.DBUSTER_GARLIC_NUKE}`
  );

  // An ordinary swing authors none, so nothing is being handed out generally.
  const axe = await attackForConstant("AXE_COMBO_1");
  assert.equal(await invulnerableForMs(axe.AttackTimeline), 0, "a swing is not a shield");

  // And while the window is open, nothing lands.
  const attack = await attackForConstant("DBUSTER_GARLIC_NUKE");
  const session = world("DBUSTER_GARLIC_NUKE");
  session.actors.set(500, {
    hitPoints: 5000,
    maxHitPoints: 5000,
    constant: "VAMPIRE_HUNTER",
    position: { x: 1000, y: 1000 },
  });
  await cast(session, attack);

  assert.equal(applyDamage(session, 500, 900), false, "the hit does not land");
  assert.equal(session.actors.get(500).hitPoints, 5000, "and nothing is taken");

  // Past it, he is a person again.
  session.invulnerableUntil.set(500, Date.now() - 1);
  assert.equal(applyDamage(session, 500, 900), true, "afterwards it lands");
  assert.equal(session.actors.get(500).hitPoints, 4100, "and is felt");
});

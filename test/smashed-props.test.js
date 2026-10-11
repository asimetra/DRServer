import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster, propForConstant, npcForConstant, weaponForConstant } from "../src/gamemaster.js";
import { tickNpcAi } from "../src/socket/ai.js";
import { applyDamage } from "../src/socket/combat.js";
import { buildFloor as layOutFloor, loadFloor } from "../src/socket/floors.js";
import { findPath, hasLineOfSight, isPositionBlocked } from "../src/socket/navigation.js";
import { npcAttackChoices } from "../src/socket/npc-attacks.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";
import { buildFloor } from "./helpers/floor.js";

/**
 * A smashed prop opens its ground.
 *
 * Seventeen constants are authored as `LEProp` in some tiles and are not in the
 * client's Prop table: the caves' ice stalagmites, ground spikes and towers,
 * the catacombs' ground spikes, the dino eggs and signs, the arena's chopper
 * statue. The server generates them as smashable PROP NPCs (floors.js,
 * serverOwnedProp). Their shape went into the floor's static colliders as if
 * the client drew them, and the spawn carried none, so once one was smashed
 * the spot stayed shut for the rest of the floor: no route through it, nobody
 * standing on it, no sight across it — and a hero standing where the client
 * shows bare floor read as standing inside geometry.
 *
 * A collider belongs to whatever owns the object's life. These now live only
 * as the NPC's navigation obstacle, added when it is generated and removed
 * when it breaks, exactly as the same constants authored as LENPC always did.
 */

const GHOST_SAMURAI = "castle/catacombs/db_floor_CATACOMBS_GHOST_SAMURAI_RIVAL_BATTLE.json";
const PAPA_YETI = "nordic/caves/db_floor_ICE_CAVES_PAPA_YETI_BOSS.json";
const CAVES = "Resources/Levels/nordic/caves/tiles.json";

/** The floor built for real, the prop authored as LEProp at `at`, and its doid. */
const propOn = async (floorName, constant, at, seed = 1) => {
  // A library is laid out at tier 10 and 24 tiles, from `seed`.
  const world = await buildFloor(floorName, { seed });
  const placement = world.floor.placements.npc.find(
    (npc) => npc.constant === constant && Math.hypot(npc.x - at.x, npc.y - at.y) < 1
  );
  assert.ok(placement, `${floorName} places ${constant} at ${at.x},${at.y}`);
  const doid = world.session.npcDoids.get(placement.id);
  assert.ok(doid, `${constant} at ${at.x},${at.y} was generated`);
  return { world, placement, doid, navigation: world.session.navigation };
};

const smash = (world, doid) => {
  const actor = world.session.actors.get(doid);
  assert.ok(actor, "the prop is an actor");
  applyDamage(world.session, doid, (actor.hitPoints ?? 1) + 1_000_000);
  assert.equal(actor.dead, true, "the prop broke");
};

test("no server-owned LEProp leaves a static collider, and every one carries its shape", async () => {
  for (const floor of [
    await loadFloor(GHOST_SAMURAI),
    await loadFloor(PAPA_YETI),
    await layOutFloor(CAVES, { tier: 10, tileCount: 24, seed: 3 }),
  ]) {
    const owned = [];
    for (const collider of floor.navigation.staticColliders) {
      if (collider.sourceKind !== "LEProp") continue;
      if (!(await propForConstant(collider.sourceConstant)) && (await npcForConstant(collider.sourceConstant))) {
        owned.push(collider);
      }
    }
    assert.deepEqual(owned, [], `${floor.name}: static colliders of server-owned props`);
  }

  // The yeti's floor authors its tower and a stalagmite as LEProp only.
  const yeti = await loadFloor(PAPA_YETI);
  const tower = yeti.placements.npc.find((npc) => npc.constant === "NORDIC_CAVE_TOWER_C");
  assert.equal(tower.navigationColliders?.length, 2, "the tower's two authored boxes");
  assert.deepEqual(
    tower.navigationColliders.map(({ type, x, y }) => ({ type, x, y })),
    [
      { type: "rectangle", x: 4102, y: 4994 },
      { type: "rectangle", x: 4065, y: 4965 },
    ]
  );
});

/**
 * Standing, the prop blocks the spot, sight across it and a route onto it;
 * smashed, none of the three. `spot` is the middle of its authored shape, and
 * the points `reach.x` and `reach.y` away on either axis are open ground on this layout.
 */
const opensWhenSmashed = async (floorName, constant, at, spot, { seed, reach = { x: 90, y: 90 } }) => {
  const { world, doid, navigation } = await propOn(floorName, constant, at, seed);
  const across = [
    [{ x: spot.x - reach.x, y: spot.y }, { x: spot.x + reach.x, y: spot.y }],
    [{ x: spot.x, y: spot.y - reach.y }, { x: spot.x, y: spot.y + reach.y }],
  ];
  for (const [from, to] of across) {
    assert.equal(isPositionBlocked(navigation, from, 42), false);
    assert.equal(isPositionBlocked(navigation, to, 42), false);
  }

  // Standing, it is in the way — the obstacle exists from the start.
  assert.equal(isPositionBlocked(navigation, spot, 0), true, `a standing ${constant} is in the way`);
  for (const [from, to] of across) {
    assert.equal(hasLineOfSight(navigation, from, to, 0), false, "and nobody sees through it");
  }
  // No route arrives: none at all, as nothing outside it sees a point inside
  // it (pathfind.js placeReached), or one that ends short.
  const standing = findPath(navigation, across[0][0], spot, 25.87);
  assert.ok(standing.length === 0 || standing.endsShort === true, "and no route ends on it");

  smash(world, doid);

  assert.equal(isPositionBlocked(navigation, spot, 0), false, "its ground is open once it breaks");
  assert.equal(isPositionBlocked(navigation, spot, 25.87), false, "a hero fits where it stood");
  for (const [from, to] of across) {
    assert.equal(hasLineOfSight(navigation, from, to, 0), true, "and so is the view across it");
    const path = findPath(navigation, from, to, 25.87);
    assert.deepEqual(path, [to], "and a straight walk through it");
  }
  const path = findPath(navigation, across[0][0], spot, 42);
  assert.notEqual(path.endsShort, true, "a route to where it stood arrives");
  assert.deepEqual(path.at(-1), spot);
};

test("a smashed ground spike opens its spot to routes, standing and sight", async () => {
  // Authored as LEProp; its shape is one box of 48 by 64.
  await opensWhenSmashed("nordic/caves/tiles.json", "NORDIC_CAVE_GROUND_SPIKES_C", { x: 3804, y: 2705 }, { x: 3807, y: 2661 }, { seed: 3 });
});

test("a smashed ice stalagmite opens its spot to routes, standing and sight", async () => {
  // Authored as LEProp; a circle of 70 and a box of 125 by 60.
  await opensWhenSmashed("nordic/caves/tiles.json", "NORDIC_CAVE_GROUND_ICESTALAGMITE_A", { x: 3024, y: 4192 }, { x: 3012.3, y: 4131.55 }, { seed: 4, reach: { x: 180, y: 120 } });
});

/** A halberd knight walking at a hero who stands still, on `navigation`. */
const HERO = 10;
const KNIGHT = 20;
const HERO_RADIUS = 25.87;
const walkAt = async (navigation, heroAt, from, seconds = 30) => {
  const gm = await loadGameMaster();
  const npc = gm.raw.Npc.find((row) => row.Constant === "KNIGHT_HALBERD");
  const weapon = await weaponForConstant(npc.Weapon1);
  const attacks = await npcAttackChoices(npc, weapon, Number(weapon?.Power ?? 1));
  const collisionRadius = (npc.CollisionSize ?? 35) * (npc.Scale ?? 1);
  const sent = [];
  const timers = [];
  const session = {
    id: 7,
    heroDoid: HERO,
    heroPosition: heroAt,
    dungeonActive: true,
    floorDoid: 55,
    random: () => 0,
    navigation,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [KNIGHT, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [HERO, { hitPoints: 60_000, maxHitPoints: 60_000, position: heroAt, collisionRadius: HERO_RADIUS, constant: "RANGER", team: TEAM.PLAYERS }],
      [
        KNIGHT,
        {
          hitPoints: 1000,
          maxHitPoints: 1000,
          position: { ...from },
          heading: 0,
          constant: "KNIGHT_HALBERD",
          level: 10,
          team: TEAM.ENEMIES,
          isEnemy: true,
          collisionRadius,
          ai: {
            state: "idle",
            engaged: true,
            behavior: "CHASE_AI",
            aggroRadius: 1000,
            disengageDistance: 3000,
            moveSpeed: Number(npc.BaseMove),
            collisionRadius,
            attackRange: Math.max(...attacks.map((attack) => attack.range)),
            attacks,
            attackTimerMs: 1500,
            attackRandMs: 0,
            nextAttackAt: 0,
            ...attacks[0],
          },
        },
      ],
    ]),
    combatClock: {
      setTimeout: (run, delay) => (timers.push({ run, delay }), timers.length),
      clearTimeout: () => {},
    },
    send: (frame) => sent.push(frame),
    allocateDoid: () => 900,
  };
  const knight = session.actors.get(KNIGHT);
  for (let tick = 0; tick < seconds * 4; tick++) await tickNpcAi(session, 1000 + tick * 250, 0.25);
  // The swings' hits are timed from the choreography; land them all.
  for (const timer of timers.sort((a, b) => a.delay - b.delay)) await timer.run();
  return {
    distance: Math.hypot(knight.position.x - heroAt.x, knight.position.y - heroAt.y),
    swings: sent.filter((frame) => frame.readUInt32LE(4) === KNIGHT && frame.readUInt16LE(8) === 143).length,
    hits: sent.filter((frame) => frame.readUInt32LE(4) === HERO && frame.readUInt16LE(8) === 160).length,
  };
};

test("a hero standing where a tower was smashed is walked up to and swung at", async () => {
  // Papa Yeti's NORDIC_CAVE_TOWER_C, authored as LEProp: boxes of 190x76 and
  // 116x44. A hero in the middle of where it stood.
  const { world, placement, doid, navigation } = await propOn(PAPA_YETI, "NORDIC_CAVE_TOWER_C", { x: 4068, y: 5004 });
  const hero = { x: 4065, y: 4965 };
  assert.equal(isPositionBlocked(navigation, hero, 0), true, "standing, the tower is where the hero would be");

  smash(world, doid);
  assert.equal(isPositionBlocked(navigation, hero, HERO_RADIUS), false, "the hero fits where the tower stood");

  const from = { x: hero.x, y: hero.y - 260 };
  assert.equal(isPositionBlocked(navigation, from, 42), false);
  const path = findPath(navigation, from, hero, 42);
  assert.notEqual(path.endsShort, true, "a route to the hero arrives");
  const walk = await walkAt(navigation, hero, from);
  assert.ok(walk.distance <= 42 + HERO_RADIUS + 10, `the knight stopped ${walk.distance.toFixed(1)} away, short of the hero`);
  assert.ok(walk.swings >= 1, "the knight swung");
  assert.ok(walk.hits >= 1, "and the hero was hit");
  assert.ok(placement.navigationColliders?.length);
});

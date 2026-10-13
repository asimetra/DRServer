import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster, stackableById } from "../src/gamemaster.js";
import { handleProposeAttackChoreography } from "../src/socket/buster.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

/**
 * How far a consumable reaches: what its timeline's collider covers, measured
 * from the drinker. The party potions author a circle of 300, the prank potion
 * one of 3000.
 */

const HOST = 500;
const NEAR = 501;
const FAR = 502;

const party = () => {
  const memberFor = (heroDoid) => ({
    id: heroDoid,
    accountId: heroDoid,
    heroDoid,
    dungeonZone: 10,
    heroManaPoints: 10,
    maxHeroManaPoints: 200,
    dungeonBusterPoints: 2,
    maxDungeonBusterPoints: 120,
    allocateDoid: (() => {
      let next = 900 + heroDoid * 10;
      return () => next++;
    })(),
    send: () => {},
  });
  const host = memberFor(HOST);
  const near = memberFor(NEAR);
  const far = memberFor(FAR);
  const world = createMatchWorld({ id: 9, members: new Set([host, near, far]) }, host);
  world.contextFor(near);
  world.contextFor(far);
  const hero = (x) => ({ hitPoints: 100, maxHitPoints: 1000, team: TEAM.PLAYERS, collisionRadius: 26, position: { x, y: 0 } });
  const monster = (x) => ({
    hitPoints: 1000,
    maxHitPoints: 1000,
    team: TEAM.ENEMIES,
    isEnemy: true,
    attackable: true,
    constant: "SKELETON_WARRIOR",
    collisionRadius: 30,
    position: { x, y: 0 },
  });
  world.objects = new Map([
    [HOST, CLID.HeroGameObject],
    [NEAR, CLID.HeroGameObject],
    [FAR, CLID.HeroGameObject],
    [600, CLID.DistributedNPCGameObject],
    [601, CLID.DistributedNPCGameObject],
    [602, CLID.DistributedNPCGameObject],
  ]);
  world.actors = new Map([
    [HOST, hero(0)],
    [NEAR, hero(200)],
    [FAR, hero(9000)],
    [600, monster(100)],
    [601, monster(2500)],
    [602, monster(3500)],
  ]);
  let nextDoid = 7000;
  const session = {
    id: 95,
    member: host,
    world,
    heroDoid: HOST,
    floorDoid: 400,
    dungeonZone: 10,
    heroPosition: { x: 0, y: 0 },
    heroHeading: 0,
    heroManaPoints: 10,
    maxHeroManaPoints: 200,
    dungeonBusterPoints: 2,
    maxDungeonBusterPoints: 120,
    objects: world.objects,
    actors: world.actors,
    allocateDoid: () => nextDoid++,
    send: () => {},
  };
  return { session, near, far, world };
};

const drink = async (session, stackableId, options) => {
  session.heroConsumables = [{ type: stackableId, count: 3 }, {}];
  const gm = await loadGameMaster();
  const stackable = await stackableById(stackableId);
  const usage = gm.raw.Attack.find((row) => row.Constant === stackable.UsageAttack);
  const proposal = new PacketWriter().u8(0).u8(1).u32(usage.Id).u32(0).u8(0).f32(1).f32(1).body();
  await handleProposeAttackChoreography(session, new PacketReader(proposal), options);
  return usage;
};

const buffedWith = (session, constant) =>
  [...(session.activeBuffs ?? session.world.activeBuffs ?? new Map()).values()]
    .filter((active) => active.buff?.Constant === constant)
    .map((active) => active.affectedActor)
    .sort((a, b) => a - b);

test("a party potion's buff reaches the ally beside the drinker and not the one across the floor", async () => {
  const { session } = party();
  await drink(session, 70011); // CONSUMABLE_STAT_ATTACK_PARTY_POTION
  assert.deepEqual(buffedWith(session, "CONSUMABLE_ATTACK_BUFF"), [HOST, NEAR]);
});

test("a party health potion heals the ally beside the drinker and not the one across the floor", async () => {
  const { session } = party();
  await drink(session, 70001); // CONSUMABLE_HEALTH_PARTY_POTION
  assert.ok(session.actors.get(NEAR).hitPoints > 100, "the near ally is healed");
  assert.equal(session.actors.get(FAR).hitPoints, 100, "the far one is not");
});

test("a party buster bottle fills the ally beside the drinker and not the one across the floor", async () => {
  const { session, near, far } = party();
  await drink(session, 70014); // CONSUMABLE_STAT_BOOSTER_PARTY_POTION
  assert.equal(session.dungeonBusterPoints, 120, "the drinker's own");
  assert.equal(near.dungeonBusterPoints, 120);
  assert.equal(far.dungeonBusterPoints, 2);
});

test("the prank potion puts its buff on the enemies inside its 3000, with no hit proposed", async () => {
  const { session } = party();
  await drink(session, 70022); // CONSUMABLE_STAR_MUSHROOM_PRANK_POTION
  assert.deepEqual(buffedWith(session, "CONSUMABLE_STAR_MUSHROOM_ENEMY_BUFF"), [600, 601]);
});

/**
 * A drink is not relayed to the other players. Across 22 official sessions
 * with more than one hero, 2666 of the other heroes' choreographies arrived and
 * not one was a consumable's.
 */
test("a consumable's choreography is not relayed to the party", async () => {
  const { session } = party();
  let relayed = 0;
  await drink(session, 70011, { onAccepted: () => (relayed += 1) });
  assert.equal(relayed, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import { advanceFloor, rescaleNpcHealthForParty } from "../src/socket/dungeon.js";
import { floorCountOf, floorPlanForMapNode } from "../src/socket/floors.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

let nextDoid = 50_000;

const member = (accountId, heroDoid) => {
  const sent = [];
  return {
    id: accountId,
    accountId,
    playerDoid: accountId,
    heroDoid,
    dungeonZone: 10,
    dungeonAvatar: { id: heroDoid, avatar_id: 101 },
    dungeonAccount: { id: accountId, name: `P${accountId}` },
    dungeonBusterPoints: 0,
    heroSpawn: {
      doid: heroDoid,
      heroType: 101,
      skinType: 151,
      playerId: accountId,
      screenName: `P${accountId}`,
      experiencePoints: 0,
      slotPoints: [0, 0, 0, 0],
      weapons: [],
      consumables: [],
      hitPoints: 200,
      manaPoints: 80,
      effectiveHitPoints: 200,
      collisionRadius: 24,
      scale: 1,
      constant: "BERSERKER",
    },
    objects: new Map([
      [accountId, CLID.PlayerGameObject],
      [heroDoid, CLID.HeroGameObject],
    ]),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    sent,
    send: (frame) => sent.push(frame),
    allocateDoid(clid) {
      const doid = nextDoid++;
      this.objects.set(doid, clid);
      return doid;
    },
  };
};

const creates = (frames, clid) => frames.flatMap((frame) => {
  const reader = new PacketReader(frame.subarray(2));
  const opcode = reader.u16();
  if (opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP) {
    const actual = reader.u16();
    const doid = reader.u32();
    reader.u32();
    return actual === clid ? [{ owner: true, doid, frame }] : [];
  }
  if (opcode !== OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP) return [];
  const parent = reader.u32();
  reader.u32();
  const actual = reader.u16();
  const doid = reader.u32();
  return actual === clid ? [{ owner: false, doid, parent, frame }] : [];
});

/**
 * The first consumable slot as the client receives it.
 *
 * Walked rather than indexed, because the offset is the sum of everything the
 * hero body writes before it and a hard-coded number would silently point at a
 * weapon modifier the day any of that changes.
 */
const consumableCountOf = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  reader.u16(); // opcode
  reader.u16(); // clid
  reader.u32(); // doid
  reader.u32(); // parent
  reader.u32(); // zone
  reader.u32(); // heroType
  reader.f32(); reader.f32(); reader.f32(); reader.f32(); // x, y, heading, scale
  reader.u8();  // flip
  reader.u16(); // hitPoints
  for (let i = 0; i < 4; i++) {
    reader.u32(); reader.u16(); reader.u8(); reader.u8();
    reader.u32(); reader.u32(); reader.u32();
  }
  reader.u32(); // slot 1 type
  return reader.u16();
};

test("joining and leaving rescales live NPC health without healing damage", () => {
  const host = member(901, 1_200_901);
  const peer = member(902, 1_200_902);
  const world = createMatchWorld({ id: 9, members: new Set([host, peer]) }, host);
  world.contextFor(peer);
  const npcDoid = 60_000;
  world.objects.set(npcDoid, CLID.DistributedNPCGameObject);
  world.actors.set(npcDoid, {
    hitPoints: 50,
    maxHitPoints: 100,
    partySize: 1,
    partyHitPoints: [0, 100, 180, 220, 260, 300],
  });

  assert.equal(rescaleNpcHealthForParty(world.contextFor(host), 2), 1);
  assert.deepEqual(
    [world.actors.get(npcDoid).hitPoints, world.actors.get(npcDoid).maxHitPoints],
    [90, 180],
    "the NPC keeps its fifty-percent health share"
  );
  for (const recipient of [host, peer]) {
    const update = recipient.sent.find(
      (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
        frame.readUInt32LE(4) === npcDoid && frame.readUInt16LE(8) === 136
    );
    assert.ok(update, `member ${recipient.accountId} receives the scaled HP`);
    assert.equal(update.readUInt32LE(10), 90);
  }

  assert.equal(rescaleNpcHealthForParty(world.contextFor(host), 1), 1);
  assert.deepEqual(
    [world.actors.get(npcDoid).hitPoints, world.actors.get(npcDoid).maxHitPoints],
    [50, 100]
  );
  world.destroy();
});

test("one floor transition regenerates every party hero for every recipient", async (t) => {
  const host = member(1001, 1_201_001);
  const peer = member(1002, 1_201_002);
  const oldArea = 40_000;
  const oldFloor = 40_001;
  const oldPet = 40_002;
  host.objects.set(oldArea, CLID.DistributedDungionArea);
  host.objects.set(oldFloor, CLID.DistributedDungeonFloor);
  host.objects.set(oldPet, CLID.DistributedNPCGameObject);
  host.actors.set(host.heroDoid, { hitPoints: 50, maxHitPoints: 200, position: { x: 0, y: 0 } });
  host.actors.set(oldPet, {
    hitPoints: 850,
    maxHitPoints: 850,
    isPet: true,
    masterId: host.heroDoid,
    position: { x: 0, y: -111 },
  });
  host.petDoid = oldPet;
  host.petSpawn = {
    instanceId: 81,
    npcId: 3301,
    constant: "WOLF_PET",
    level: 75,
    ownerHeroDoid: host.heroDoid,
  };
  const match = { id: 1, members: new Set([host, peer]), floorIndex: 0 };
  const world = createMatchWorld(match, host);
  t.after(() => {
    world.destroy();
    host.stopManaRegen?.();
    peer.stopManaRegen?.();
  });
  world.contextFor(peer);
  world.objects.set(peer.playerDoid, CLID.PlayerGameObject);
  world.objects.set(peer.heroDoid, CLID.HeroGameObject);
  world.actors.set(peer.heroDoid, { hitPoints: 75, maxHitPoints: 200, position: { x: 5, y: 0 } });
  world.playerActors = new Set([host.heroDoid, peer.heroDoid]);
  world.areaDoid = oldArea;
  world.floorDoid = oldFloor;
  world.mapNodeId = 50002;
  world.floorPlan = await floorPlanForMapNode(50002);
  world.floorCount = floorCountOf(world.floorPlan);
  world.floorIndex = 0;
  world.dungeonZone = 10;
  world.dungeonActive = true;
  world.dungeonEpoch = 1;
  world.tierConstant = "TIER_1";

  const advanced = await advanceFloor(world.contextFor(host));

  assert.equal(advanced, true);
  assert.equal(world.floorIndex, 1);
  assert.equal(match.floorIndex, 1);
  assert.equal(world.playerActors.size, 2);
  assert.equal(world.actors.get(host.heroDoid).hitPoints, 200);
  assert.equal(world.actors.get(peer.heroDoid).hitPoints, 200);
  assert.notEqual(host.petDoid, oldPet);
  assert.equal(world.objects.has(oldPet), false);
  assert.equal(world.actors.get(host.petDoid).masterId, host.heroDoid);
  for (const recipient of [host, peer]) {
    const heroes = creates(recipient.sent, CLID.HeroGameObject);
    assert.deepEqual(
      heroes.slice(-2).map(({ owner, doid }) => ({ owner, doid })),
      [
        { owner: true, doid: recipient.heroDoid },
        { owner: false, doid: recipient === host ? peer.heroDoid : host.heroDoid },
      ]
    );
    assert.equal(heroes.at(-1).parent, world.floorDoid);
  }
  assert.deepEqual(
    [...world.snapshotCreates.values()]
      .filter(({ clid }) => clid === CLID.DistributedDungeonFloor)
      .map(({ doid }) => doid),
    [world.floorDoid]
  );
  assert.equal(world.snapshotCreates.has(oldFloor), false);
});

/**
 * A potion drunk on one floor is still gone on the next.
 *
 * "Nine for the whole dungeon" is only true if a doorway does not restock the
 * hero. Every floor rebuilds each party member from `heroSpawn`, and the
 * consumable pair inside it is captured once when the dungeon is entered — so
 * what makes a spend survive is that the pair is mutated in place rather than
 * rebuilt from the avatar. Read off the wire rather than off the session,
 * because the number the client is told is the one that decides this.
 */
test("a spent powerup is still spent on the next floor", async (t) => {
  const host = member(1101, 1_201_101);
  const oldArea = 41_000;
  const oldFloor = 41_001;
  host.objects.set(oldArea, CLID.DistributedDungionArea);
  host.objects.set(oldFloor, CLID.DistributedDungeonFloor);
  host.actors.set(host.heroDoid, { hitPoints: 200, maxHitPoints: 200, position: { x: 0, y: 0 } });
  host.heroSpawn.consumables = [{ type: 70000, count: 9 }, {}];

  const match = { id: 2, members: new Set([host]), floorIndex: 0 };
  const world = createMatchWorld(match, host);
  t.after(() => {
    world.destroy();
    host.stopManaRegen?.();
  });
  world.areaDoid = oldArea;
  world.floorDoid = oldFloor;
  world.mapNodeId = 50002;
  world.floorPlan = await floorPlanForMapNode(50002);
  world.floorCount = floorCountOf(world.floorPlan);
  world.floorIndex = 0;
  world.dungeonZone = 10;
  world.dungeonActive = true;
  world.dungeonEpoch = 1;
  world.tierConstant = "TIER_1";
  world.playerActors = new Set([host.heroDoid]);

  // Two drunk on this floor, the way useConsumable spends them.
  host.heroSpawn.consumables[0].count -= 2;
  host.sent.length = 0;

  assert.equal(await advanceFloor(world.contextFor(host)), true);

  const owned = creates(host.sent, CLID.HeroGameObject).find((create) => create.owner);
  assert.ok(owned, "the new floor generates the hero it owns");
  assert.equal(
    consumableCountOf(owned.frame),
    7,
    "the next floor carries what is left, not the nine that were equipped"
  );
});

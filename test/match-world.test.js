import assert from "node:assert/strict";
import test from "node:test";

import {
  MATCH_WORLD_SHARED_FIELDS,
  broadcastWorld,
  createMatchWorld,
  heroMembersOf,
  memberForHero,
  membersOf,
  worldOf,
} from "../src/socket/match-world.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketWriter } from "../src/socket/packet.js";

let nextDoid = 5000;

const member = (accountId, overrides = {}) => {
  const sent = [];
  const socket = { destroyed: false, ...(overrides.socket ?? {}) };
  const session = {
    accountId,
    objects: new Map([[accountId, `local-${accountId}`]]),
    actors: new Map(),
    doobers: new Map(),
    sent,
    socket,
    send(frame) {
      sent.push(frame);
    },
    allocateDoid(clid) {
      const doid = nextDoid++;
      if (clid !== undefined) this.objects.set(doid, clid);
      return doid;
    },
    ...overrides,
  };
  return session;
};

test("shared fields route through the world and member fields stay local", () => {
  const seed = member(1, {
    floorIndex: 3,
    signalValues: new Map([["gate", 1]]),
    dungeonRewards: { gold: 1 },
  });
  const joiner = member(2, {
    floorIndex: 99,
    heroManaPoints: 75,
    dungeonRewards: { gold: 9 },
  });
  const match = { members: new Set([seed, joiner]) };

  const world = createMatchWorld(match, seed);
  const context = world.contextFor(joiner);

  assert.equal(match.world, world);
  assert.equal(context, world.contextFor(joiner), "member contexts are cached");
  assert.equal(context.world, world);
  assert.equal(context.member, joiner);
  assert.equal(context.floorIndex, 3, "shared reads ignore the member-local shadow");
  assert.equal(context.dungeonRewards, joiner.dungeonRewards);
  assert.equal(context.objects, world.objects);
  assert.equal(MATCH_WORLD_SHARED_FIELDS.has("floorIndex"), true);

  context.floorIndex = 7;
  context.heroManaPoints = 40;
  assert.equal(world.floorIndex, 7);
  assert.equal(match.floorIndex, 7);
  assert.equal(joiner.floorIndex, 99);
  assert.equal(joiner.heroManaPoints, 40);
  assert.equal(world.heroManaPoints, undefined);

  delete context.signalValues;
  delete context.heroManaPoints;
  assert.equal(world.signalValues, undefined);
  assert.ok(seed.signalValues instanceof Map, "deleting world state does not erase the seed member");
  assert.equal("heroManaPoints" in joiner, false);
});

test("connection-scoped MatchMaker and Presence objects never enter the world", () => {
  const seed = member(5, { matchMakerDoid: 500, presenceDoid: 501 });
  seed.objects.clear();
  seed.objects.set(500, CLID.MatchMaker);
  seed.objects.set(501, CLID.PresenceManager);
  seed.objects.set(502, CLID.DistributedDungionArea);

  const world = createMatchWorld({ members: new Set([seed]) }, seed);

  assert.deepEqual([...world.objects], [[502, CLID.DistributedDungionArea]]);
});

test("context send publishes framed world state while explicit direct send stays local", () => {
  const host = member(10);
  const joiner = member(11);
  const closed = member(12, { closed: true });
  const destroyed = member(13, { socket: { destroyed: true } });
  const match = { members: new Set([host, joiner, closed, destroyed]) };

  const world = createMatchWorld(match, host);
  const context = world.contextFor(joiner);

  context.sendDirect("direct");
  assert.deepEqual(joiner.sent, ["direct"]);
  assert.deepEqual(host.sent, []);

  const count = context.broadcast("party", { except: joiner });
  assert.equal(count, 1);
  assert.deepEqual(host.sent, ["party"]);
  assert.deepEqual(joiner.sent, ["direct"]);
  assert.deepEqual(closed.sent, []);
  assert.deepEqual(destroyed.sent, []);

  const npc = visibleGenerate(CLID.DistributedNPCGameObject, 10101);
  world.objects.set(10101, CLID.DistributedNPCGameObject);
  context.send(npc);
  assert.deepEqual(host.sent, ["party", npc]);
  assert.deepEqual(joiner.sent, ["direct", npc]);
});

test("shared allocation uses the seed allocator with the world as owner", () => {
  const seed = member(20);
  const joiner = member(21);
  const world = createMatchWorld({ members: new Set([seed, joiner]) }, seed);
  const context = world.contextFor(joiner);

  const one = world.allocateDoid(144);
  const two = context.allocateDoid(145);

  assert.equal(world.objects.get(one), 144);
  assert.equal(world.objects.get(two), 145);
  assert.equal(seed.objects.has(one), false);
  assert.equal(seed.objects.has(two), false);
  assert.equal(joiner.objects.has(one), false);
});

test("helpers resolve worlds, members and hero owners with solo fallbacks", () => {
  const host = member(30, { heroDoid: 3001 });
  const joiner = member(31, { heroDoid: 3002 });
  const match = { members: new Set([host, joiner]) };
  const world = createMatchWorld(match, host);
  const context = world.contextFor(joiner);

  assert.equal(worldOf(world), world);
  assert.equal(worldOf(host), world);
  assert.equal(worldOf(context), world);
  assert.equal(membersOf(world), world.liveMembers);
  assert.deepEqual(heroMembersOf(world), new Map([
    [3001, host],
    [3002, joiner],
  ]));
  assert.equal(memberForHero(context, 3002), joiner);
  assert.equal(memberForHero(host, 9999), null);

  const solo = member(99, { heroDoid: 9090 });
  assert.equal(worldOf(solo), null);
  assert.deepEqual([...membersOf(solo)], [solo]);
  assert.equal(memberForHero(solo, 9090), solo);
});

test("detaching removes the member without clearing shared world state or auto-destroying", () => {
  const host = member(40);
  const joiner = member(41, { heroDoid: 4101 });
  const match = { members: new Set([host, joiner]) };
  const world = createMatchWorld(match, host);

  world.contextFor(joiner).floorCleared = true;

  assert.equal(world.detachMember(joiner), true);
  assert.equal(match.members.has(joiner), false);
  assert.equal(worldOf(joiner), null);
  assert.deepEqual([...membersOf(joiner)], [joiner]);
  assert.equal(memberForHero(world, 4101), null);
  assert.equal(world.floorCleared, true);

  assert.equal(world.detachMember(host), true);
  assert.equal(match.members.size, 0);
  assert.equal(match.world, world, "last member leaving does not implicitly destroy the world");
  assert.equal(world.active, true);
  assert.equal(broadcastWorld(world, "nobody"), 0);
});

test("destroy is idempotent and clears the match world binding", () => {
  const host = member(50);
  const joiner = member(51);
  const match = { members: new Set([host, joiner]) };
  const world = createMatchWorld(match, host);
  let generatorStops = 0;
  world.dungeonActive = true;
  world.dungeonEpoch = 4;
  world.generatorStops = new Map([["wave", () => generatorStops++]]);

  world.contextFor(joiner);
  assert.equal(world.destroy(), true);
  assert.equal(world.destroy(), false);
  assert.equal(world.active, false);
  assert.equal(world.destroyed, true);
  assert.equal(world.dungeonActive, false);
  assert.equal(world.dungeonEpoch, 5);
  assert.equal(generatorStops, 1);
  assert.equal(match.world, null);
  assert.equal(worldOf(host), null);
  assert.equal(worldOf(joiner), null);
  assert.equal(broadcastWorld(world, "after-destroy"), 0);
  assert.throws(() => world.contextFor(member(52)), /destroyed match world/);
});

test("readiness settles once for successful builds and destroyed builds", async () => {
  const readyWorld = createMatchWorld({ members: new Set() }, member(55));
  assert.equal(readyWorld.ready, false);
  assert.equal(readyWorld.markReady(), true);
  assert.equal(await readyWorld.readyPromise, true);
  assert.equal(readyWorld.markReady(), false);

  const failedWorld = createMatchWorld({ members: new Set() }, member(56));
  failedWorld.destroy();
  assert.equal(await failedWorld.readyPromise, false);
  assert.equal(failedWorld.markReady(), false);
});

const visibleGenerate = (clid, doid, parent = 0) =>
  new PacketWriter(OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP)
    .u32(parent)
    .u32(10)
    .u16(clid)
    .u32(doid)
    .frame();

const fieldUpdate = (doid, fieldId, value) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(fieldId)
    .u32(value)
    .frame();

test("snapshot compacts shared creates and field state without owner/member objects", () => {
  const host = member(60);
  const joiner = member(61);
  const world = createMatchWorld({ members: new Set([host, joiner]) }, host);
  const context = world.contextFor(host);
  const area = visibleGenerate(CLID.DistributedDungionArea, 6001);
  const floor = visibleGenerate(CLID.DistributedDungeonFloor, 6002, 6001);
  const npc = visibleGenerate(CLID.DistributedNPCGameObject, 6003, 6002);
  const remoteHero = visibleGenerate(CLID.HeroGameObject, 6004, 6002);
  const oldHp = fieldUpdate(6003, 134, 90);
  const newHp = fieldUpdate(6003, 134, 50);
  const closure = new PacketWriter(OP.CLIENT_INTEREST_CONTEXT).u16(1802).u32(6002).frame();

  world.objects.set(6001, CLID.DistributedDungionArea);
  world.objects.set(6002, CLID.DistributedDungeonFloor);
  world.objects.set(6003, CLID.DistributedNPCGameObject);
  world.objects.set(6004, CLID.HeroGameObject);
  for (const frame of [area, floor, npc, remoteHero, oldHp, newHp, closure]) context.send(frame);

  assert.deepEqual(world.snapshotFrames("foundation"), [area, floor]);
  assert.deepEqual(world.snapshotFrames("area"), [area]);
  assert.deepEqual(world.snapshotFrames("floor"), [floor]);
  assert.deepEqual(world.snapshotFrames("children"), [npc, newHp, closure]);
  assert.equal(world.snapshotCreates.has(6004), false, "member heroes are recipient-specific");
  assert.equal(world.sendSnapshot(joiner, "all"), 5);
  assert.deepEqual(joiner.sent, [area, floor, npc, newHp, closure]);
});

test("admitted members receive no partial broadcasts before their snapshot activates", () => {
  const host = member(65);
  const pending = member(66);
  const match = { members: new Set([host, pending]) };
  const world = createMatchWorld(match, host);
  const frame = visibleGenerate(CLID.DistributedNPCGameObject, 6501);
  world.objects.set(6501, CLID.DistributedNPCGameObject);

  world.contextFor(host).send(frame);
  assert.deepEqual(host.sent, [frame]);
  assert.deepEqual(pending.sent, []);

  world.contextFor(pending);
  world.contextFor(host).send(frame);
  assert.deepEqual(pending.sent, [frame]);
});

test("disable removes stale state and a new floor snapshot retains only the area", () => {
  const host = member(70);
  const world = createMatchWorld({ members: new Set([host]) }, host);
  const area = visibleGenerate(CLID.DistributedDungionArea, 7001);
  const floor = visibleGenerate(CLID.DistributedDungeonFloor, 7002, 7001);
  const npc = visibleGenerate(CLID.DistributedNPCGameObject, 7003, 7002);
  world.objects.set(7001, CLID.DistributedDungionArea);
  world.objects.set(7002, CLID.DistributedDungeonFloor);
  world.objects.set(7003, CLID.DistributedNPCGameObject);
  for (const frame of [area, floor, npc, fieldUpdate(7003, 134, 1)]) world.observe(frame);

  world.observe(new PacketWriter(OP.CLIENT_OBJECT_DISABLE_RESP).u32(7003).frame());
  assert.equal(world.snapshotCreates.has(7003), false);
  assert.equal(world.snapshotUpdates.size, 0);

  world.beginFloorSnapshot();
  assert.deepEqual([...world.snapshotCreates.keys()], [7001]);
  assert.equal(world.snapshotClosure, null);
});

test("disabling a parent forgets every descendant and its compacted fields", () => {
  const host = member(75);
  const world = createMatchWorld({ members: new Set([host]) }, host);
  const area = visibleGenerate(CLID.DistributedDungionArea, 7501);
  const floor = visibleGenerate(CLID.DistributedDungeonFloor, 7502, 7501);
  const npc = visibleGenerate(CLID.DistributedNPCGameObject, 7503, 7502);
  for (const [doid, clid] of [
    [7501, CLID.DistributedDungionArea],
    [7502, CLID.DistributedDungeonFloor],
    [7503, CLID.DistributedNPCGameObject],
  ]) world.objects.set(doid, clid);
  for (const frame of [area, floor, npc, fieldUpdate(7503, 134, 1)]) world.observe(frame);

  world.observe(new PacketWriter(OP.CLIENT_OBJECT_DISABLE_RESP).u32(7502).frame());

  assert.deepEqual([...world.snapshotCreates.keys()], [7501]);
  assert.equal(world.snapshotUpdates.size, 0);
});

test("an NPC death stays visible live but is absent from future late-join snapshots", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");
  const host = member(76, { heroDoid: 7600 });
  const world = createMatchWorld({ members: new Set([host]) }, host);
  const context = world.contextFor(host);
  const npcDoid = 7601;
  const npc = visibleGenerate(CLID.DistributedNPCGameObject, npcDoid, 7502);
  world.objects.set(npcDoid, CLID.DistributedNPCGameObject);
  world.actors.set(npcDoid, {
    hitPoints: 1,
    maxHitPoints: 1,
    isEnemy: true,
    position: { x: 10, y: 10 },
  });
  world.floorCleared = true;
  context.send(npc);

  applyDamage(context, npcDoid, 1);

  assert.ok(
    host.sent.some(
      (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
        frame.readUInt32LE(4) === npcDoid
    ),
    "clients already in the fight still receive the death"
  );
  assert.equal(world.objects.has(npcDoid), true, "the corpse remains in live teardown state");
  assert.equal(world.snapshotCreates.has(npcDoid), false, "a late join never recreates the corpse");
  assert.equal(
    world.snapshotFrames("children").some(
      (frame) => frame.readUInt32LE(4) === npcDoid
    ),
    false
  );
  world.destroy();
});

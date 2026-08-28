import assert from "node:assert/strict";
import test from "node:test";

import { joinDungeonMatch, leaveDungeonSession } from "../src/socket/match-runtime.js";
import { DungeonMatchRegistry } from "../src/socket/matches.js";
import {
  dungeonAreaGenerate,
  dungeonFloorGenerate,
  heroOwnerGenerate,
  interestClosure,
  npcGenerate,
  playerOwnerGenerate,
} from "../src/socket/objects.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";
import { applyDamage } from "../src/socket/combat.js";

let nextDoid = 9000;

const member = (accountId, avatarDoid) => {
  const sent = [];
  return {
    id: accountId,
    accountId,
    matchMakerDoid: accountId + 100,
    objects: new Map([[accountId + 100, CLID.MatchMaker]]),
    actors: new Map(),
    doobers: new Map(),
    sent,
    socket: { destroyed: false },
    send(frame) {
      sent.push(frame);
    },
    allocateDoid(clid) {
      const doid = nextDoid++;
      if (clid !== undefined) this.objects.set(doid, clid);
      return doid;
    },
    fixtureAvatarDoid: avatarDoid,
  };
};

const prepareFixture = async (session, { sendPlayerOwner = false } = {}) => {
  session.dungeonAccount = {
    id: session.accountId,
    name: `Player${session.accountId}`,
    basic_currency: 123,
  };
  session.dungeonAvatar = { id: session.fixtureAvatarDoid, avatar_id: 101 };
  session.playerDoid = session.accountId;
  session.heroDoid = session.fixtureAvatarDoid;
  session.dungeonBusterPoints = 0;
  session.heroManaPoints = 100;
  session.maxHeroManaPoints = 100;
  session.heroSpawn = {
    doid: session.heroDoid,
    heroType: 101,
    skinType: 151,
    playerId: session.accountId,
    screenName: session.dungeonAccount.name,
    experiencePoints: 0,
    slotPoints: [0, 0, 0, 0],
    weapons: [],
    consumables: [],
    hitPoints: 100,
    manaPoints: 100,
    effectiveHitPoints: 100,
    collisionRadius: 24,
    scale: 1,
    constant: "BERSERKER",
  };
  session.objects.set(session.playerDoid, CLID.PlayerGameObject);
  if (sendPlayerOwner) {
    session.send(
      playerOwnerGenerate({
        doid: session.playerDoid,
        zone: 10,
        screenName: session.dungeonAccount.name,
        basicCurrency: 123,
      })
    );
  }
  return true;
};

const buildFixtureWorld = async (context, mapNodeId) => {
  await prepareFixture(context, { sendPlayerOwner: true });
  context.dungeonActive = true;
  context.dungeonZone = 10;
  context.mapNodeId = mapNodeId;
  context.floorIndex = 0;
  context.floorCount = 2;
  context.floorPlan = { name: "fixture" };
  const areaDoid = context.allocateDoid(CLID.DistributedDungionArea);
  context.areaDoid = areaDoid;
  context.send(dungeonAreaGenerate({ doid: areaDoid, tileLibraries: [] }));
  const floorDoid = context.allocateDoid(CLID.DistributedDungeonFloor);
  context.floorDoid = floorDoid;
  context.send(
    dungeonFloorGenerate({
      doid: floorDoid,
      parent: areaDoid,
      mapNodeId,
      floor: { tileLibrary: "fixture.json", tiles: [] },
    })
  );
  context.objects.set(context.playerDoid, CLID.PlayerGameObject);
  context.objects.set(context.heroDoid, CLID.HeroGameObject);
  context.actors.set(context.heroDoid, {
    hitPoints: 100,
    maxHitPoints: 100,
    collisionRadius: 24,
    constant: "BERSERKER",
    position: { x: 10, y: 20 },
  });
  context.heroPosition = { x: 10, y: 20 };
  context.send(
    heroOwnerGenerate({
      ...context.heroSpawn,
      parent: floorDoid,
      position: context.heroPosition,
    })
  );
  const npcDoid = context.allocateDoid(CLID.DistributedNPCGameObject);
  context.send(
    npcGenerate({
      doid: npcDoid,
      parent: floorDoid,
      npcType: 318,
      position: { x: 30, y: 40 },
    })
  );
  context.send(interestClosure(floorDoid));
  return true;
};

const frameHead = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  const opcode = reader.u16();
  if (opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP) {
    const parent = reader.u32();
    reader.u32();
    const clid = reader.u16();
    const doid = reader.u32();
    return { opcode, parent, clid, doid };
  }
  if (opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP) {
    const clid = reader.u16();
    const doid = reader.u32();
    return { opcode, clid, doid };
  }
  if (
    opcode === OP.CLIENT_OBJECT_DISABLE_RESP ||
    opcode === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP
  ) {
    return { opcode, doid: reader.u32() };
  }
  return { opcode };
};

test("late join replays one shared world in captured parent/owner order", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(1001, 1101001);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  const joiner = member(1002, 1101002);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  const hostBefore = host.sent.length;
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {
      assert.deepEqual(
        joiner.sent.map(frameHead).map(({ opcode, clid }) => [opcode, clid]),
        [
          [OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP, CLID.PlayerGameObject],
          [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.DistributedDungionArea],
          [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.PlayerGameObject],
        ],
        "floor replay waits until the area cache phase has had time to run"
      );
    },
  });

  const heads = joiner.sent.map(frameHead);
  assert.deepEqual(
    heads.map(({ opcode, clid }) => [opcode, clid]),
    [
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP, CLID.PlayerGameObject],
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.DistributedDungionArea],
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.PlayerGameObject],
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.DistributedDungeonFloor],
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP, CLID.HeroGameObject],
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.HeroGameObject],
      [OP.CLIENT_OBJECT_UPDATE_FIELD, undefined],
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.DistributedNPCGameObject],
      [OP.CLIENT_INTEREST_CONTEXT, undefined],
    ]
  );
  assert.equal(new Set(heads.filter((head) => head.doid).map((head) => head.doid)).size, 7);
  assert.deepEqual(
    host.sent.slice(hostBefore).map(frameHead).map(({ opcode, clid }) => [opcode, clid]),
    [
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.PlayerGameObject],
      [OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, CLID.HeroGameObject],
    ]
  );
  assert.equal(host.world, joiner.world);
  assert.equal(host.world.actors.has(joiner.heroDoid), true);
  assert.equal(host.world.playerActors.has(joiner.heroDoid), true);
});

test("late join does not recreate an NPC that already died", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(1051, 1101051);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });
  const world = host.world;
  const deadNpcDoid = [...world.objects].find(
    ([, clid]) => clid === CLID.DistributedNPCGameObject
  )[0];
  world.actors.set(deadNpcDoid, {
    hitPoints: 1,
    maxHitPoints: 1,
    isEnemy: true,
    position: { x: 30, y: 40 },
  });
  world.floorCleared = true;
  applyDamage(world.contextFor(host), deadNpcDoid, world.actors.get(deadNpcDoid).hitPoints);
  assert.equal(world.snapshotCreates.has(deadNpcDoid), false);

  const joiner = member(1052, 1101052);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });

  const received = joiner.sent.map(frameHead);
  assert.equal(
    received.some(({ doid }) => doid === deadNpcDoid),
    false,
    "neither the corpse create nor its terminal fields are replayed"
  );
  assert.equal(
    received.some(({ clid }) => clid === CLID.DistributedNPCGameObject),
    false
  );
  assert.equal(world.objects.has(deadNpcDoid), true, "live teardown still owns the corpse doid");
});

test("one member leaving preserves the shared world and disables only that remote peer", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2001, 1102001);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });
  const joiner = member(2002, 1102002);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });
  const world = host.world;
  const hostBefore = host.sent.length;
  const joinerHeroDoid = joiner.heroDoid;
  const joinerPlayerDoid = joiner.playerDoid;
  joiner.sent.length = 0;

  assert.equal(leaveDungeonSession(joiner, { notifyClient: true, registry }), true);

  assert.equal(host.world, world);
  assert.equal(world.destroyed, false);
  assert.equal(world.actors.has(joiner.heroDoid), false);
  assert.equal(registry.matches.has(hostResult.match.id), true);
  assert.deepEqual(
    host.sent.slice(hostBefore).map(frameHead).map(({ opcode }) => opcode),
    [OP.CLIENT_OBJECT_DISABLE_RESP, OP.CLIENT_OBJECT_DISABLE_RESP]
  );

  const teardown = joiner.sent.map(frameHead);
  const indexOf = (doid) => teardown.findIndex((frame) => frame.doid === doid);
  assert.equal(
    teardown.filter((frame) => frame.doid === joinerHeroDoid).length,
    1,
    "owner hero is not appended a second time by the raw member teardown"
  );
  assert.equal(
    teardown[indexOf(joinerHeroDoid)].opcode,
    OP.CLIENT_OBJECT_DISABLE_OWNER_RESP
  );
  assert.equal(
    teardown[indexOf(joinerPlayerDoid)].opcode,
    OP.CLIENT_OBJECT_DISABLE_OWNER_RESP
  );
  assert.ok(indexOf(joinerHeroDoid) < indexOf(world.floorDoid));
  assert.ok(indexOf(joinerHeroDoid) < indexOf(world.areaDoid));
  assert.ok(indexOf(joinerPlayerDoid) > indexOf(world.areaDoid));
  assert.equal(
    teardown.filter((frame) => frame.opcode === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP).length,
    2
  );
});

test("the final matched member destroys its owner hero before floor and area", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2101, 1102101);
  const resolved = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, resolved, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });
  const world = host.world;
  const heroDoid = host.heroDoid;
  const playerDoid = host.playerDoid;
  host.sent.length = 0;

  assert.equal(leaveDungeonSession(host, { notifyClient: true, registry }), true);

  const teardown = host.sent.map(frameHead);
  const indexOf = (doid) => teardown.findIndex((frame) => frame.doid === doid);
  assert.equal(teardown.length, 5);
  assert.equal(teardown[indexOf(heroDoid)].opcode, OP.CLIENT_OBJECT_DISABLE_OWNER_RESP);
  assert.equal(teardown[indexOf(playerDoid)].opcode, OP.CLIENT_OBJECT_DISABLE_OWNER_RESP);
  assert.ok(indexOf(heroDoid) < indexOf(world.floorDoid));
  assert.ok(indexOf(heroDoid) < indexOf(world.areaDoid));
  assert.ok(indexOf(playerDoid) > indexOf(world.areaDoid));
  assert.equal(registry.matches.has(resolved.match.id), false);
});

test("a duplicate hero doid is rejected before it overwrites the live member", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(3001, 1103001);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });
  const joiner = member(3002, host.heroDoid);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });

  await assert.rejects(
    joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
      prepareMember: prepareFixture,
      beginManaRegen: async () => () => {},
      grantArrivalBuff: async () => null,
      waitForAssets: async () => {},
    }),
    /duplicate hero doid/
  );
  assert.equal(host.world.actors.get(host.heroDoid).maxHitPoints, 100);
});

test("a socket closed while waiting for world readiness cannot reattach itself", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(4001, 1104001);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  const worldBuild = joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: async (context, mapNodeId) => {
      await new Promise((resolve) => setImmediate(resolve));
      return buildFixtureWorld(context, mapNodeId);
    },
  });
  const joiner = member(4002, 1104002);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  const waiting = joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });
  joiner.closed = true;
  registry.remove(joiner);

  await worldBuild;
  await assert.rejects(waiting, /disconnected during entry/);
  assert.equal(host.world.liveMembers.has(joiner), false);
  assert.equal(hostResult.match.members.has(joiner), false);
});

/**
 * Two players dropping at once must not take the server with them.
 *
 * A socket close marks its session `closed` and then tears the member out of
 * the match, which ends by rescaling NPC health for whoever is left. "Whoever
 * is left" was every other member, including ones whose own close handler had
 * already run — and asking the world for a context on a closed member throws.
 * Inside a socket `close` handler nothing catches that, so the process exits.
 *
 * Found by running twenty-five sessions and stopping them together: several
 * shared a match, several closed in the same tick, and the server died. A pair
 * is the smallest version of it.
 */
test("two members closing together tear down without throwing", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2401, 1102401);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });
  const joiner = member(2402, 1102402);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });

  // Both sockets are gone before either teardown runs, which is what a
  // simultaneous drop looks like from inside the close handlers.
  host.closed = true;
  joiner.closed = true;

  assert.doesNotThrow(() => leaveDungeonSession(joiner, { registry }));
  assert.doesNotThrow(() => leaveDungeonSession(host, { registry }));
});

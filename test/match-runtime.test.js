import assert from "node:assert/strict";
import test from "node:test";

import { joinDungeonMatch, leaveDungeonSession } from "../src/socket/match-runtime.js";
import { prepareDungeonMember } from "../src/socket/dungeon.js";
import { beginFloorFailing, clearFloorFailing } from "../src/socket/floorstate.js";
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
import { applyDamage, hitPointsUpdate } from "../src/socket/combat.js";
import { readNpc } from "./helpers/floor.js";

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

test("match admission account data is reused for host and late-join preparation", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(1051, 1101051);
  const hostAccount = { marker: "host account" };
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  hosted.account = hostAccount;
  let hostPreparedWith;
  await joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: async (context, mapNodeId, options) => {
      hostPreparedWith = options.account;
      return buildFixtureWorld(context, mapNodeId);
    },
  });

  const joiner = member(1052, 1101052);
  const joinerAccount = { marker: "joiner account" };
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  joined.account = joinerAccount;
  let joinerPreparedWith;
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: async (session, options) => {
      joinerPreparedWith = options.account;
      return prepareFixture(session, options);
    },
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });

  assert.equal(hostPreparedWith, hostAccount);
  assert.equal(joinerPreparedWith, joinerAccount);
});

test("a late joiner's equipped pet is snapshotted for itself and owned by the shared world", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(1071, 1101071);
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  const joiner = member(1072, 1101072);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  const hostBefore = host.sent.length;
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: async (session, options) => {
      await prepareFixture(session, options);
      session.petSpawn = {
        instanceId: 81,
        npcId: 3301,
        constant: "WOLF_PET",
        level: 75,
        ownerHeroDoid: session.heroDoid,
      };
      return true;
    },
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });

  const petDoid = joiner.petDoid;
  assert.ok(petDoid);
  assert.equal(host.world.objects.get(petDoid), CLID.DistributedNPCGameObject);
  assert.equal(host.world.actors.get(petDoid).masterId, joiner.heroDoid);
  const joinerPetFrame = joiner.sent.find((frame) => {
    const head = frameHead(frame);
    return head.clid === CLID.DistributedNPCGameObject && head.doid === petDoid;
  });
  assert.ok(joinerPetFrame, "the owner's ordered child snapshot includes the pet");
  const pet = readNpc(joinerPetFrame.subarray(2));
  assert.equal(pet.masterId, joiner.heroDoid);
  assert.equal(pet.level, 75);
  assert.equal(pet.weapons[0].power, 167);

  const hostNewFrames = host.sent.slice(hostBefore).map(frameHead);
  assert.ok(hostNewFrames.some(({ doid }) => doid === petDoid));
  const hostBeforeLeave = host.sent.length;
  leaveDungeonSession(joiner, { registry });
  assert.equal(host.world.actors.has(petDoid), false);
  assert.equal(host.world.objects.has(petDoid), false);
  assert.equal(host.world.snapshotCreates.has(petDoid), false);
  assert.ok(
    host.sent.slice(hostBeforeLeave).map(frameHead).some(({ doid }) => doid === petDoid),
    "remaining members are told to remove the departing member's pet"
  );
});

test("member preparation starts each dungeon with fresh completion and summary state", async () => {
  const session = member(1061, 1200001061);
  session.floorPlan = { npcLevel: 1 };
  session.completionAwarded = true;
  session.receivedTrophy = 9;
  session.dungeonTreasures = [{ chestId: 7 }];
  session.dungeonContribution = { kills: 99, damage: 9999 };
  const account = {
    id: session.accountId,
    name: "FreshRun",
    basic_currency: 100,
    active_avatar: session.fixtureAvatarDoid,
    account_avatars: [{
      id: session.fixtureAvatarDoid,
      avatar_id: 101,
      skin_type: 151,
      experience: 0,
    }],
    account_items: [],
  };

  await prepareDungeonMember(session, {
    account,
    sendPlayerOwner: false,
  });

  assert.equal(session.dungeonAccount, account);
  assert.equal(session.completionAwarded, false);
  assert.equal(session.receivedTrophy, 0);
  assert.deepEqual(session.dungeonTreasures, []);
  assert.deepEqual(session.dungeonContribution, { kills: 0, damage: 0 });
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
  assert.equal(world.objects.has(deadNpcDoid), false, "and the corpse left the shared world");
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

test("a failed host build releases every joiner waiting on world readiness", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(4051, 1104051);
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  let enteredBuild;
  const building = new Promise((resolve) => {
    enteredBuild = resolve;
  });
  let failBuild;
  const blocked = new Promise((_, reject) => {
    failBuild = reject;
  });
  const hostJoin = joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: async () => {
      enteredBuild();
      return blocked;
    },
  });
  await building;

  const joiner = member(4052, 1104052);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  const waiting = joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });

  failBuild(new Error("fixture world build failed"));
  await assert.rejects(hostJoin, /fixture world build failed/);
  await assert.rejects(
    Promise.race([
      waiting,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("joiner remained stuck on readiness")), 100)
      ),
    ]),
    /world did not become ready|destroyed match world/
  );
  assert.equal(hosted.match.state, "failed");
  assert.equal(hosted.match.world, null);

  leaveDungeonSession(host, { registry });
  leaveDungeonSession(joiner, { registry });
  assert.equal(registry.matches.size, 0);
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

/**
 * The reported bug, through the real join path rather than a stand-in.
 *
 * A party wipes, the shared countdown starts, and somebody joins the match
 * before it runs out. They arrive on full health, so the floor is no longer
 * lost — but only a revive used to say so, and the timer ended the run with a
 * live player standing on it.
 */
test("joining a wiped match stops the defeat countdown", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2501, 1102501);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  // The host goes down, which is the whole party while it is alone.
  const world = host.world;
  const hostActor = world.actors.get(host.heroDoid);
  hostActor.dead = true;
  hostActor.hitPoints = 0;
  beginFloorFailing(world.contextFor(host));
  assert.ok(world.floorFailingTimer, "the wipe started a countdown");

  const joiner = member(2502, 1102502);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });

  // The load-bearing part: a joiner arrives standing. If that ever stopped
  // being true the countdown would be right to keep running, and this test
  // would be asserting the wrong thing for the wrong reason.
  const joinerActor = world.actors.get(joiner.heroDoid);
  assert.equal(joinerActor.dead, undefined, "the joiner is not down");
  assert.ok(joinerActor.hitPoints > 0, "and arrives on health");

  assert.equal(world.floorFailingTimer, null, "so the countdown stops");
});

/**
 * The other half of the same rule, through the real leave path.
 *
 * Two players, one already down. The one still standing disconnects, which is
 * not a death and so was never a reason to check anything — but it leaves a
 * floor with nobody up on it. The countdown has to start, or the corpse left
 * behind waits for an ending that has no way to arrive.
 */
test("the last player standing leaving a match starts the defeat countdown", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2601, 1102601);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hostResult, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });
  const joiner = member(2602, 1102602);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {},
  });

  const world = host.world;
  // The host goes down; the joiner is still up, so nothing should be running.
  world.actors.get(host.heroDoid).dead = true;
  assert.ok(!world.floorFailingTimer, "one down out of two is not a wipe");

  leaveDungeonSession(joiner, { registry });

  assert.ok(world.floorFailingTimer, "the survivor leaving is one");
  clearFloorFailing(world.contextFor(host));
});

test("two simultaneous late joins serialize and receive each other's remote objects", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2701, 1102701);
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  const first = member(2702, 1102702);
  const second = member(2703, 1102703);
  const firstResult = registry.resolve({ session: first, mapNodeId: 50082 });
  const secondResult = registry.resolve({ session: second, mapNodeId: 50082 });
  const yieldOnce = async () => new Promise((resolve) => setImmediate(resolve));
  const options = {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: yieldOnce,
  };

  await Promise.all([
    joinDungeonMatch(first, firstResult, { mapNodeId: 50082 }, options),
    joinDungeonMatch(second, secondResult, { mapNodeId: 50082 }, options),
  ]);

  const firstObjects = first.sent.map(frameHead);
  const secondObjects = second.sent.map(frameHead);
  for (const [recipient, frames, peer] of [
    [first, firstObjects, second],
    [second, secondObjects, first],
  ]) {
    assert.equal(
      frames.some(({ clid, doid }) => clid === CLID.PlayerGameObject && doid === peer.playerDoid),
      true,
      `${recipient.accountId} sees peer ${peer.accountId}'s player object`
    );
    assert.equal(
      frames.some(({ clid, doid }) => clid === CLID.HeroGameObject && doid === peer.heroDoid),
      true,
      `${recipient.accountId} sees peer ${peer.accountId}'s hero object`
    );
  }
  assert.equal(host.world.liveMembers.size, 3);
  assert.equal(host.world.playerActors.size, 3);
});

test("disconnect during late-join asset wait rolls every pending world mutation back", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2801, 1102801);
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  const joiner = member(2802, 1102802);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  let enteredWait;
  const waiting = new Promise((resolve) => {
    enteredWait = resolve;
  });
  let continueJoin;
  const blocked = new Promise((resolve) => {
    continueJoin = resolve;
  });
  const joining = joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {
      enteredWait();
      await blocked;
    },
  });

  await waiting;
  const world = host.world;
  assert.equal(world.actors.has(joiner.heroDoid), true, "the pending mutation is installed");
  assert.equal(
    world.playerActors.has(joiner.heroDoid),
    false,
    "prepared is not the same as active party member"
  );
  joiner.closed = true;
  leaveDungeonSession(joiner, { registry });
  continueJoin();

  await assert.rejects(joining, /disconnected during entry/);
  assert.equal(world.actors.has(joiner.heroDoid), false);
  assert.equal(world.objects.has(joiner.heroDoid), false);
  assert.equal(world.objects.has(joiner.playerDoid), false);
  assert.equal(world.playerActors.has(joiner.heroDoid), false);
  assert.equal(world.liveMembers.has(joiner), false);
  assert.equal(hosted.match.members.has(joiner), false);
});

test("late join stays broadcast-inactive until its ordered snapshot is complete", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(2901, 1102901);
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  const joiner = member(2902, 1102902);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  const npcDoid = [...host.world.objects].find(
    ([, clid]) => clid === CLID.DistributedNPCGameObject
  )[0];
  const liveUpdate = hitPointsUpdate(npcDoid, CLID.DistributedNPCGameObject, 77);
  await joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {
      host.world.contextFor(host).send(liveUpdate);
      assert.equal(
        joiner.sent.includes(liveUpdate),
        false,
        "a joiner without its floor must not receive live world traffic"
      );
    },
  });
});

test("a run finishing during asset replay cannot activate the pending joiner", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(3001, 1103001);
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  const joiner = member(3002, 1103002);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  let enteredWait;
  const waiting = new Promise((resolve) => {
    enteredWait = resolve;
  });
  let continueJoin;
  const blocked = new Promise((resolve) => {
    continueJoin = resolve;
  });
  const joining = joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {
      enteredWait();
      await blocked;
    },
  });

  await waiting;
  registry.finish(joined.match);
  continueJoin();
  await assert.rejects(joining, /no longer accepts joins/);
  const joinerHeroDoid = joiner.heroDoid;
  leaveDungeonSession(joiner, { registry });
  assert.equal(host.world.liveMembers.has(joiner), false);
  assert.equal(host.world.playerActors.has(joinerHeroDoid), false);
});

test("a pending joiner that requests exit cannot be reattached after asset replay", async () => {
  const registry = new DungeonMatchRegistry();
  const host = member(3101, 1103101);
  const hosted = registry.resolve({ session: host, mapNodeId: 50082 });
  await joinDungeonMatch(host, hosted, { mapNodeId: 50082 }, {
    buildFirstMember: buildFixtureWorld,
  });

  const joiner = member(3102, 1103102);
  const joined = registry.resolve({ session: joiner, mapNodeId: 50082 });
  let enteredWait;
  const waiting = new Promise((resolve) => {
    enteredWait = resolve;
  });
  let continueJoin;
  const blocked = new Promise((resolve) => {
    continueJoin = resolve;
  });
  const joining = joinDungeonMatch(joiner, joined, { mapNodeId: 50082 }, {
    prepareMember: prepareFixture,
    beginManaRegen: async () => () => {},
    grantArrivalBuff: async () => null,
    waitForAssets: async () => {
      enteredWait();
      await blocked;
    },
  });

  await waiting;
  leaveDungeonSession(joiner, { registry });
  continueJoin();
  await assert.rejects(joining, /no longer accepts joins/);
  assert.equal(host.world.liveMembers.has(joiner), false);
  assert.equal(joined.match.members.has(joiner), false);
  assert.equal(joiner.world, null);
});

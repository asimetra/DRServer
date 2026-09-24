import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster } from "../src/gamemaster.js";
import {
  activeInfiniteModifiers,
  infiniteDefinitionForNode,
  infiniteFloorGold,
  infiniteMapDetails,
  infiniteModifierIdsForNode,
  infiniteProgressFor,
  infiniteRewards,
} from "../src/infinite.js";
import { awardInfiniteFloor, noteInfiniteFloorReached } from "../src/socket/rewards.js";
import {
  dungeonFloorNumber,
  dungeonFloorGenerate,
  infiniteRewardDataUpdate,
  matchMakerGenerate,
} from "../src/socket/objects.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

const readVisible = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  reader.u32();
  reader.u32();
  const clid = reader.u16();
  const doid = reader.u32();
  return { reader, clid, doid };
};

test("MatchMaker publishes four stable weekly modifiers for all nine Infinite nodes", async () => {
  const gm = await loadGameMaster();
  const details = infiniteMapDetails(gm, { epoch: 2957 });
  assert.equal(details.length, 9);
  for (const detail of details) {
    assert.equal(detail.epoch, 2957);
    assert.equal(detail.modifiers.length, 4);
    assert.equal(new Set(detail.modifiers).size, 4);
  }
  assert.deepEqual(details, infiniteMapDetails(gm, { epoch: 2957 }));

  const { reader, clid } = readVisible(matchMakerGenerate(900, details));
  assert.equal(clid, CLID.MatchMaker);
  const bytes = reader.u16();
  assert.equal(bytes, 9 * 24);
  for (const detail of details) {
    assert.equal(reader.u32(), detail.epoch);
    assert.equal(reader.u32(), detail.nodeId);
    assert.deepEqual([reader.u32(), reader.u32(), reader.u32(), reader.u32()], detail.modifiers);
  }
  assert.equal(reader.eof(), true);
});

test("MatchMaker keeps every Infinite detail at exactly four modifier words", () => {
  const details = [
    { epoch: 3000, nodeId: 50150, modifiers: [11, 12] },
    { epoch: 3000, nodeId: 50151, modifiers: [21, 22, 23, 24, 25] },
  ];
  const { reader } = readVisible(matchMakerGenerate(900, details));

  assert.equal(reader.u16(), 2 * 24);
  assert.deepEqual(
    [reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32()],
    [3000, 50150, 11, 12, 0, 0],
    "a short modifier row shifted the following node"
  );
  assert.deepEqual(
    [reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32()],
    [3000, 50151, 21, 22, 23, 24],
    "a long modifier row changed the fixed struct width"
  );
  assert.equal(reader.eof(), true);
});

test("Infinite modifiers unlock on their authored floors and mark only the new one", async () => {
  const gm = await loadGameMaster();
  const node = gm.raw.MapPage.find((row) => row.Id === 50150);
  const definition = infiniteDefinitionForNode(gm, node);
  const modifiers = infiniteModifierIdsForNode(gm, node, 2957);

  assert.deepEqual(activeInfiniteModifiers(gm, definition, modifiers, 3), []);
  assert.deepEqual(
    activeInfiniteModifiers(gm, definition, modifiers, 4).map((row) => row.newThisFloor),
    [1]
  );
  assert.deepEqual(
    activeInfiniteModifiers(gm, definition, modifiers, 8).map((row) => row.newThisFloor),
    [0, 1]
  );

  const floor = { tileLibrary: "tiles.json", tiles: [] };
  const active = activeInfiniteModifiers(gm, definition, modifiers, 8);
  const { reader } = readVisible(dungeonFloorGenerate({
    doid: 901,
    mapNodeId: node.Id,
    floor,
    activeDungeonModifiers: active.map((row) => ({
      id: row.Id,
      newThisFloor: row.newThisFloor,
    })),
  }));
  reader.u32();
  reader.utf();
  reader.utf();
  assert.equal(reader.u16(), 0); // tiles byte length
  reader.u8();
  reader.utf();
  reader.utf();
  assert.equal(reader.u16(), 2000);
  assert.equal(reader.u16(), 10); // two five-byte modifier records
  assert.deepEqual([reader.u32(), reader.u8()], [active[0].Id, 0]);
  assert.deepEqual([reader.u32(), reader.u8()], [active[1].Id, 1]);
});

test("floor wire numbers carry both the room and the 55-room run length", () => {
  assert.equal(dungeonFloorNumber(2, 0), 2000);
  assert.equal(dungeonFloorNumber(2, 1), 2001);
  assert.equal(dungeonFloorNumber(55, 0), 55000);
  assert.equal(dungeonFloorNumber(55, 3), 55003);
  assert.equal(dungeonFloorNumber(55, 54), 55054);
});

test("Infinite reward data follows the captured avatar/score/gold/reward layout", async () => {
  const gm = await loadGameMaster();
  const definition = gm.raw.InfiniteDungeons[0];
  const rewards = infiniteRewards(definition, 3);
  assert.equal(infiniteFloorGold(definition, 3), 1200);
  assert.deepEqual(rewards.map((row) => row.status), [3, 0, 0, 0]);

  const frame = infiniteRewardDataUpdate(700, {
    avatarDoid: 1_100_334_245,
    startScore: 0,
    goldReward: 1200,
    rewards,
  });
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), 700);
  assert.equal(reader.u16(), 218);
  assert.equal(reader.u32(), 1_100_334_245);
  assert.equal(reader.u16(), 0);
  assert.equal(reader.u32(), 1200);
  assert.equal(reader.u16(), 28);
  assert.deepEqual([reader.u32(), reader.u16(), reader.u8()], [30104, 3, 3]);
});

test("cleared Infinite floors pay capped coins and authored milestones once", async () => {
  const gm = await loadGameMaster();
  const account = { id: 50, basic_currency: 1000, premium_currency: 0, trophies: 0 };
  const session = {
    id: 50,
    playerDoid: 50,
    heroDoid: 500,
    mapNodeId: 50150,
    dungeonAvatar: { id: 1200 },
    infiniteEpoch: 2957,
    infiniteDefinition: gm.raw.InfiniteDungeons[0],
    dungeonAccount: account,
    dungeonRewards: { gold: 0, gems: 0, xp: 0 },
    dungeonTreasures: [],
    persistDungeonAccount: async () => {},
    send: () => {},
  };

  session.floorIndex = 0;
  assert.equal(awardInfiniteFloor(session).gold, 600);
  assert.equal(awardInfiniteFloor(session), null, "one floor paid twice");
  session.floorIndex = 2;
  assert.equal(awardInfiniteFloor(session).reward, 30104);
  session.floorIndex = 19;
  assert.equal(awardInfiniteFloor(session).gems, 25);
  session.floorIndex = 24;
  const last = awardInfiniteFloor(session);
  assert.equal(last.gold, 3000, "coin cap was ignored");
  assert.equal(last.trophy, 1);
  await session.rewardSavePromise;

  assert.equal(account.basic_currency, 1000 + 600 + 1200 + 3000 + 3000);
  assert.equal(account.premium_currency, 25);
  assert.equal(account.trophies, 1);
  assert.deepEqual(session.dungeonTreasures, [{ dooberType: 30104, chestId: 60005 }]);
  const progress = infiniteProgressFor(account, {
    nodeId: 50150,
    avatarDoid: 1200,
    epoch: 2957,
  });
  assert.equal(progress.score, 25);
  assert.deepEqual(progress.claimed, [30104]);
  assert.deepEqual(
    infiniteRewards(session.infiniteDefinition, 4, { alreadyClaimed: progress.claimed })
      .map((row) => row.status),
    [1, 0, 0, 0],
    "a new run offered an already claimed milestone again"
  );
});

test("entering an Infinite room records it even when that room is lost", async () => {
  const gm = await loadGameMaster();
  const account = { id: 51, infinite_progress: {} };
  const saved = [];
  const session = {
    id: 51,
    heroDoid: 501,
    mapNodeId: 50150,
    floorIndex: 3,
    dungeonAvatar: { id: 1201 },
    infiniteEpoch: 2957,
    infiniteDefinition: gm.raw.InfiniteDungeons[0],
    dungeonAccount: account,
    persistDungeonAccount: async () => saved.push(
      account.infinite_progress["50150"]["1201"].score
    ),
  };

  assert.equal(noteInfiniteFloorReached(session), 4);
  await session.rewardSavePromise;
  assert.deepEqual(saved, [4]);
  assert.equal(
    infiniteProgressFor(account, {
      nodeId: 50150,
      avatarDoid: 1201,
      epoch: 2957,
    }).score,
    4,
    "a defeat on room four must remain a score of four"
  );
});

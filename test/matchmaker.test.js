import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEntryResponse,
  buildExitComplete,
  ENTRY_ERROR,
  FLID,
  handleField,
  entryErrorCodeFor,
  rememberMatchMakerGroup,
} from "../src/socket/matchmaker.js";
import {
  heroGenerate,
  matchMakerGenerate,
  playerGenerate,
  playerOwnerGenerate,
} from "../src/socket/objects.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

test("MatchMaker generate contains the required empty detail list", () => {
  const reader = new PacketReader(matchMakerGenerate(9001).subarray(2));

  assert.equal(reader.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u16(), CLID.MatchMaker);
  assert.equal(reader.u32(), 9001);
  assert.equal(reader.u16(), 0);
  assert.equal(reader.eof(), true);
});

test("PlayerGameObjectOwner generate matches the production owner layout", () => {
  const reader = new PacketReader(
    playerOwnerGenerate({
      doid: 12345,
      zone: 10,
      screenName: "Player1",
      basicCurrency: 1010,
    }).subarray(2)
  );

  assert.equal(reader.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP);
  assert.equal(reader.u16(), CLID.PlayerGameObject);
  assert.equal(reader.u32(), 12345);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u32(), 10);
  assert.equal(reader.utf(), "Player1");
  assert.equal(reader.u32(), 1010);
  assert.equal(reader.eof(), true);
});

test("remote player/hero generates use visible rather than owner objects", () => {
  const player = new PacketReader(
    playerGenerate({
      doid: 12346,
      parent: 400,
      zone: 10,
      screenName: "Peer",
      basicCurrency: 9999, // owner-only and deliberately absent below
    }).subarray(2)
  );
  assert.equal(player.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(player.u32(), 400);
  assert.equal(player.u32(), 10);
  assert.equal(player.u16(), CLID.PlayerGameObject);
  assert.equal(player.u32(), 12346);
  assert.equal(player.utf(), "Peer");
  assert.equal(player.eof(), true, "remote PlayerGameObject has no basicCurrency field");

  const hero = new PacketReader(
    heroGenerate({
      doid: 22346,
      parent: 401,
      zone: 10,
      heroType: 101,
      skinType: 151,
      playerId: 12346,
      screenName: "Peer",
      position: { x: 10, y: 20 },
    }).subarray(2)
  );
  assert.equal(hero.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(hero.u32(), 401);
  assert.equal(hero.u32(), 10);
  assert.equal(hero.u16(), CLID.HeroGameObject);
  assert.equal(hero.u32(), 22346);
  assert.equal(hero.u32(), 101);
  assert.equal(hero.f32(), 10);
  assert.equal(hero.f32(), 20);
});

test("entry response uses the client field layout", () => {
  const reader = new PacketReader(buildEntryResponse(9001, 105, 77).subarray(2));

  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), 9001);
  assert.equal(reader.u16(), FLID.ClientRequestEntryResponce);
  assert.equal(reader.u16(), 105);
  assert.equal(reader.u32(), 77);
  assert.equal(reader.eof(), true);
});

test("expected entry refusals use the messages already shipped in the client", () => {
  assert.equal(
    entryErrorCodeFor({ error: "target_not_found", source: "friend" }),
    ENTRY_ERROR.FRIEND_NOT_FOUND
  );
  assert.equal(
    entryErrorCodeFor({ error: "friend_full", source: "friend" }),
    ENTRY_ERROR.FRIEND_DUNGEON_FULL
  );
  assert.equal(entryErrorCodeFor({ error: "content_not_completed" }), ENTRY_ERROR.UNAUTHORIZED_MAP);
  assert.equal(entryErrorCodeFor({ error: "ultimate_in_progress" }), ENTRY_ERROR.ULTIMATE_IN_PROGRESS);
  assert.equal(entryErrorCodeFor({ error: "bad_map_node" }), ENTRY_ERROR.BAD_MAP_NODE);
  assert.equal(entryErrorCodeFor({ error: "unexpected" }), ENTRY_ERROR.INTERNAL);
});

test("an accepted match persists its cohort for server-driven doorway entries", () => {
  const session = {};
  assert.equal(rememberMatchMakerGroup(session, { group: "region:eu" }), "region:eu");
  assert.equal(session.matchMakerGroup, "region:eu");
});

test("joining a friend who already left returns Friend Not Found, not Internal Error", async () => {
  const sent = [];
  const session = {
    id: 70,
    accountId: 1000000005,
    matchMakerDoid: 9001,
    send: (frame) => sent.push(frame),
  };
  const request = new PacketWriter()
    .utf("{}")
    .u32(0)
    .u32(0)
    .u32(1999999999)
    .u32(0)
    .u8(0)
    .utf("")
    .body();

  assert.equal(handleField(session, FLID.ClientRequestEntry, new PacketReader(request)), true);
  await session.entryPromise;

  const response = new PacketReader(sent.at(-1).subarray(2));
  assert.equal(response.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(response.u32(), session.matchMakerDoid);
  assert.equal(response.u16(), FLID.ClientRequestEntryResponce);
  assert.equal(response.u16(), ENTRY_ERROR.FRIEND_NOT_FOUND);
});

test("an active session cannot enter its current dungeon a second time", () => {
  const sent = [];
  const session = {
    id: 71,
    accountId: 1000000005,
    matchMakerDoid: 9001,
    dungeonActive: true,
    send: (frame) => sent.push(frame),
  };
  const request = new PacketWriter()
    .utf("{}")
    .u32(0)
    .u32(50082)
    .u32(0)
    .u32(0)
    .u8(0)
    .utf("")
    .body();

  assert.equal(handleField(session, FLID.ClientRequestEntry, new PacketReader(request)), true);
  assert.equal(session.entryPromise, undefined, "no second admission/build starts");

  const response = new PacketReader(sent[0].subarray(2));
  assert.equal(response.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(response.u32(), session.matchMakerDoid);
  assert.equal(response.u16(), FLID.ClientRequestEntryResponce);
  assert.equal(response.u16(), ENTRY_ERROR.GAME_NOT_ENTERABLE);
});

test("exit completion matches the production response payload", () => {
  const reader = new PacketReader(buildExitComplete(9001).subarray(2));

  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), 9001);
  assert.equal(reader.u16(), FLID.ClientExitComplete);
  assert.equal(reader.u16(), 1);
  assert.equal(reader.eof(), true);
});

test("early exit flushes rewards before acknowledging and clearing dungeon state", async () => {
  const sent = [];
  let triggerStops = 0;
  let aiStops = 0;
  let finishSaving;
  const session = {
    id: 7,
    matchMakerDoid: 9001,
    dungeonActive: true,
    areaDoid: 4001,
    floorDoid: 4002,
    heroDoid: 4003,
    playerDoid: 42,
    mapNodeId: 50002,
    floorCleared: false,
    objects: new Map([
      [9001, CLID.MatchMaker],
      [4001, CLID.DistributedDungionArea],
      [4002, CLID.DistributedDungeonFloor],
      [4003, CLID.HeroGameObject],
      [4004, CLID.DistributedNPCGameObject],
      [42, CLID.PlayerGameObject],
    ]),
    actors: new Map([[4003, { hitPoints: 100 }]]),
    doobers: new Map([[4100, {}]]),
    stopTriggers: () => triggerStops++,
    stopAi: () => aiStops++,
    send: (frame) => sent.push(frame),
    rewardSavePromise: new Promise((resolve) => {
      finishSaving = resolve;
    }),
  };
  const request = new PacketWriter().u32(0).body();

  assert.equal(handleField(session, FLID.RequestExit, new PacketReader(request)), true);
  assert.equal(sent.length, 0);
  finishSaving();
  await session.exitPromise;
  assert.equal(triggerStops, 1);
  assert.equal(aiStops, 1);
  assert.equal(session.dungeonActive, false);
  assert.equal(session.dungeonEpoch, 1);
  assert.deepEqual([...session.objects.keys()], [9001]);
  assert.equal(session.actors.size, 0);
  assert.equal(session.doobers.size, 0);
  assert.equal("areaDoid" in session, false);
  assert.equal("floorDoid" in session, false);
  assert.equal("heroDoid" in session, false);
  assert.equal("playerDoid" in session, false);

  const disabled = sent.slice(0, -1).map((frame) => {
    const reader = new PacketReader(frame.subarray(2));
    return { opcode: reader.u16(), doid: reader.u32(), eof: reader.eof() };
  });
  assert.deepEqual(disabled, [
    { opcode: OP.CLIENT_OBJECT_DISABLE_OWNER_RESP, doid: 4003, eof: true },
    { opcode: OP.CLIENT_OBJECT_DISABLE_RESP, doid: 4004, eof: true },
    { opcode: OP.CLIENT_OBJECT_DISABLE_RESP, doid: 4002, eof: true },
    { opcode: OP.CLIENT_OBJECT_DISABLE_RESP, doid: 4001, eof: true },
    { opcode: OP.CLIENT_OBJECT_DISABLE_OWNER_RESP, doid: 42, eof: true },
  ]);

  const response = new PacketReader(sent.at(-1).subarray(2));
  assert.equal(response.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(response.u32(), 9001);
  assert.equal(response.u16(), FLID.ClientExitComplete);
  assert.equal(response.u16(), 1);
  assert.equal(response.eof(), true);
});

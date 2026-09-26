import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A real dungeon, run in a real match worker, driven from this thread the way
 * the socket layer drives it: a MatchMaker entry, the client's two loading
 * signals, an RPC while the run is on, an exit — and a worker killed mid-run.
 *
 * What is asserted is what the client and the account store would see: the
 * order of frames against the MatchMaker's own answers, which thread an RPC
 * ran in, and what storage holds once the lease has come back.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-match-worker-"));

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");
const { buildEntryResponse, buildExitComplete } = await import("../src/socket/matchmaker.js");
const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount } = await import("../src/accounts.js");

const MAP_NODE = 50002;
const MATCHMAKER_DOID = 11;
const REQUEST_HERO = 184;
const REQUEST_ENTRY = 185;

const pool = new MatchWorkerPool({ size: 1, loadReportMs: 0 });
const restore = installWorkerPool(pool, { installExecutor: installMatchExecutor });
await pool.ready;
test.after(async () => {
  await pool.close();
  restore();
});

let nextSessionId = 1;

/** A connection as the socket layer builds one, writing into an array. */
const connect = (accountId) => {
  const sent = [];
  const session = new MemberSession({
    id: nextSessionId++,
    accountId,
    authenticated: true,
    matchMakerDoid: MATCHMAKER_DOID,
    presenceDoid: 12,
    objects: new Map(),
    actors: new Map(),
    closed: false,
    send: (frame) => {
      sent.push(Buffer.from(frame));
      return true;
    },
  });
  session.close = () => {
    session.closed = true;
  };
  return { session, sent };
};

const opcodeOf = (frame) => frame.readUInt16LE(2);

/** clid of an object created by this frame, or null. */
const createdClid = (frame) => {
  switch (opcodeOf(frame)) {
    case OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP:
      return frame.readUInt16LE(12);
    case OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP:
      return frame.readUInt16LE(4);
    default:
      return null;
  }
};

const createdDoid = (frame) =>
  opcodeOf(frame) === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP
    ? frame.readUInt32LE(6)
    : frame.readUInt32LE(14);

/**
 * Doids the server issued, as against the ids a player (its account id) or a
 * hero and its items (persistent ids) carry.
 */
const issuedDoids = (sent) =>
  sent
    .filter((frame) => createdClid(frame) !== null)
    .map(createdDoid)
    .filter((doid) => doid < 1_000_000_000);

const indexOfCreate = (sent, clid) => sent.findIndex((frame) => createdClid(frame) === clid);

const waitFor = async (check, what, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const fieldPacket = (doid, fieldId) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(fieldId).frame().subarray(2);

/** MatchMaker entry, answered as matchmaker.js answers it, with the client's loading signals. */
const enter = async ({ session, sent }, { friendId = 0 } = {}) => {
  const request = { mapNodeId: MAP_NODE, friendId, mapId: 0, friendOnly: 0, matchMakerGroup: "" };
  const result = dungeonMatches.resolve({
    session,
    mapNodeId: MAP_NODE,
    friendId,
    group: "",
    eligibleForExplicitJoin: true,
  });
  assert.ok(result.match, "admitted");
  const joined = matchExecutor.join(session, result, request, {
    onPlayerReady: () => session.send(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE)),
  });
  const player = await waitFor(
    () => sent.find((frame) => createdClid(frame) === CLID.PlayerGameObject),
    "the owner player"
  );
  const playerDoid = createdDoid(player);
  assert.ok(matchExecutor.forward(session, fieldPacket(playerDoid, REQUEST_ENTRY)));
  assert.ok(matchExecutor.forward(session, fieldPacket(playerDoid, REQUEST_HERO)));
  await joined;
  return result.match;
};

const isEntryAnswer = (frame) =>
  frame.equals(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE));

test("a worker's dungeon reaches the client in the order a single thread sends it", async () => {
  const client = connect(1000000101);
  const match = await enter(client);
  const { sent } = client;

  const player = indexOfCreate(sent, CLID.PlayerGameObject);
  const answer = sent.findIndex(isEntryAnswer);
  const area = indexOfCreate(sent, CLID.DistributedDungionArea);
  const floor = indexOfCreate(sent, CLID.DistributedDungeonFloor);
  const hero = indexOfCreate(sent, CLID.HeroGameObject);
  assert.ok(player >= 0 && answer > player, "297 follows the owner player");
  assert.ok(area > answer, "the area follows 297");
  assert.ok(floor > area && hero > floor, "floor, then hero");
  assert.equal(pool.ownerOf(1000000101)?.index, 0, "the account is leased to the worker");
  assert.equal(pool.workers[0].matches.has(match.id), true);

  // Every doid the worker issued is in its own lane: odd, with one worker.
  const issued = issuedDoids(sent);
  assert.ok(issued.length > 10);
  assert.ok(issued.every((doid) => doid % 2 === 1));

  await matchExecutor.leave(client.session, { notifyClient: true });
  client.session.send(buildExitComplete(MATCHMAKER_DOID));
  const exit = sent.length - 1;
  const disables = sent
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) =>
      [OP.CLIENT_OBJECT_DISABLE_RESP, OP.CLIENT_OBJECT_DISABLE_OWNER_RESP].includes(opcodeOf(frame))
    );
  assert.ok(disables.length >= 4, "the run is taken down");
  assert.ok(disables.every(({ index }) => index < exit), "before ClientExitComplete");
  assert.equal(dungeonMatches.matches.has(match.id), false, "the registry let the match go");
  await waitFor(() => !pool.ownerOf(1000000101), "the lease to come back");
});

test("an RPC for an account in a worker's dungeon changes the object the run holds", async () => {
  const accountId = 1000000102;
  const client = connect(accountId);
  await enter(client);

  await dispatch("account", "AlterAttribute", [accountId, "token", "volume", "7"]);
  // Read here while the lease is out: a copy of the worker's live object.
  const during = await loadAccount(accountId);
  assert.equal(during.account_attributes.find((row) => row.name === "volume")?.value, "7");
  await assert.rejects(
    (await import("../src/accounts.js")).saveAccount(during),
    /is in a dungeon on match worker/,
    "a copy of a leased account cannot be written back from here"
  );

  await matchExecutor.leave(client.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(accountId), "the lease to come back");
  const after = await loadAccount(accountId);
  assert.equal(after.account_attributes.find((row) => row.name === "volume")?.value, "7");
});

test("a player placed in a running match lands on its worker and both see each other", async () => {
  const host = connect(1000000104);
  const match = await enter(host);
  const hostHero = createdDoid(host.sent.find((frame) => createdClid(frame) === CLID.HeroGameObject));
  const before = host.sent.length;

  const friend = connect(1000000105);
  assert.equal(await enter(friend, { friendId: 1000000104 }), match, "the friend's match, not a new one");
  assert.equal(pool.workers[0].matches.get(match.id), 2);

  // The joiner is replayed the world, host's hero included, after its own floor.
  const replayedHost = friend.sent.findIndex(
    (frame) => createdClid(frame) === CLID.HeroGameObject && createdDoid(frame) === hostHero
  );
  assert.ok(replayedHost > indexOfCreate(friend.sent, CLID.DistributedDungeonFloor));
  assert.ok(friend.sent.findIndex(isEntryAnswer) > indexOfCreate(friend.sent, CLID.PlayerGameObject));
  // And the host is told about the newcomer.
  const toHost = host.sent.slice(before).map(createdClid);
  assert.ok(toHost.includes(CLID.PlayerGameObject) && toHost.includes(CLID.HeroGameObject));

  await matchExecutor.leave(friend.session, { notifyClient: true });
  assert.equal(dungeonMatches.matches.has(match.id), true, "the host is still playing");
  await matchExecutor.leave(host.session, { notifyClient: true });
  assert.equal(dungeonMatches.matches.has(match.id), false);
});

/**
 * The whole way in, as the socket layer takes it: the MatchMaker field, the
 * server's own friendship and progression checks, then the worker. The test
 * above places the player directly; this one asks.
 */
test("through the MatchMaker, a friend follows a private run onto its worker and a stranger is told it is not there", async () => {
  const { saveAccount } = await import("../src/accounts.js");
  const { ENTRY_ERROR, FLID, handleField } = await import("../src/socket/matchmaker.js");
  const { PacketReader } = await import("../src/socket/packet.js");
  const [hostId, friendId, strangerId] = [1000000111, 1000000112, 1000000113];
  for (const [id, friends] of [[hostId, [friendId]], [friendId, [hostId]], [strangerId, []]]) {
    const account = await loadAccount(id);
    account.ingame_friends = JSON.stringify(friends);
    await saveAccount(account);
  }
  const ask = (client, { mapNodeId = 0, friend = 0, mapId = 0, friendOnly = 0 }) =>
    handleField(
      client.session,
      FLID.ClientRequestEntry,
      new PacketReader(
        new PacketWriter().utf("{}").u32(0).u32(mapNodeId).u32(friend).u32(mapId).u8(friendOnly).utf("").body()
      )
    );
  /** The client's two loading signals, once its owner player exists. */
  const load = async ({ session, sent }) => {
    const player = await waitFor(
      () => sent.find((frame) => createdClid(frame) === CLID.PlayerGameObject),
      "the owner player"
    );
    matchExecutor.forward(session, fieldPacket(createdDoid(player), REQUEST_ENTRY));
    matchExecutor.forward(session, fieldPacket(createdDoid(player), REQUEST_HERO));
    await session.entryPromise;
  };
  const lastAnswer = ({ sent }) => {
    const reader = new PacketReader(sent.at(-1).subarray(2));
    reader.u16();
    reader.u32();
    assert.equal(reader.u16(), FLID.ClientRequestEntryResponce);
    return reader.u16();
  };

  const host = connect(hostId);
  ask(host, { mapNodeId: MAP_NODE, friendOnly: 1 });
  await load(host);
  const match = dungeonMatches.matchByAccount.get(hostId);
  assert.ok(match?.private, "a private run");

  const stranger = connect(strangerId);
  ask(stranger, { friend: hostId });
  await stranger.session.entryPromise;
  assert.equal(lastAnswer(stranger), ENTRY_ERROR.FRIEND_NOT_FOUND);
  ask(stranger, { mapId: match.id });
  await stranger.session.entryPromise;
  assert.equal(lastAnswer(stranger), ENTRY_ERROR.MAP_NOT_FOUND);

  const friend = connect(friendId);
  ask(friend, { friend: hostId });
  await load(friend);
  assert.equal(dungeonMatches.matchByAccount.get(friendId), match);
  assert.equal(pool.workers[0].matches.get(match.id), 2, "both on the run's worker");
  assert.equal(match.members.size, 2);

  await matchExecutor.leave(friend.session, { notifyClient: true });
  await matchExecutor.leave(host.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(hostId) && !pool.ownerOf(friendId), "both leases back");
});

test("a worker that dies sends its players home and is replaced", async () => {
  const accountId = 1000000103;
  const client = connect(accountId);
  const match = await enter(client);
  const dead = pool.workers[0];
  const highest = dead.highestDoid;
  const before = client.sent.length;

  await dead.thread.terminate();
  await waitFor(() => pool.workers[0] !== dead, "a replacement");
  await pool.workers[0].ready.promise;

  const after = client.sent.slice(before);
  const disables = after.filter((frame) =>
    [OP.CLIENT_OBJECT_DISABLE_RESP, OP.CLIENT_OBJECT_DISABLE_OWNER_RESP].includes(opcodeOf(frame))
  );
  assert.ok(disables.length >= 4, "everything the dead worker created is taken down");
  const lastDisable = after.lastIndexOf(disables.at(-1));
  assert.ok(after.at(-1).equals(buildExitComplete(MATCHMAKER_DOID)), "then home");
  assert.ok(lastDisable < after.length - 1);
  // The owner hero goes first and the owner player last, as in any teardown.
  assert.equal(opcodeOf(disables[0]), OP.CLIENT_OBJECT_DISABLE_OWNER_RESP);
  assert.equal(opcodeOf(disables.at(-1)), OP.CLIENT_OBJECT_DISABLE_OWNER_RESP);

  assert.equal(pool.ownerOf(accountId), null, "the lease is back");
  assert.equal(dungeonMatches.matches.has(match.id), false, "the match is closed");
  assert.equal(client.session.matchRoute, undefined);

  // The replacement numbers its objects above anything the old one sent.
  const again = connect(accountId);
  await enter(again);
  const doids = issuedDoids(again.sent);
  assert.ok(highest > 1000 && doids.length > 10);
  assert.ok(doids.every((doid) => doid > highest && doid % 2 === 1));
  await matchExecutor.leave(again.session, { notifyClient: true });
});

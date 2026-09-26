import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The awkward cases of running matches in workers: a worker that dies or hangs
 * half way through something, a message it cannot handle, a client that keeps
 * talking while it leaves, and one that talks faster than the worker listens.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-match-worker-edges-"));

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");
const { buildEntryResponse, buildExitComplete } = await import("../src/socket/matchmaker.js");
const { loadAccount, withAccountLock } = await import("../src/accounts.js");
await import("../src/rpc-handlers.js");

const MAP_NODE = 50002;
const MATCHMAKER_DOID = 11;

const pool = new MatchWorkerPool({
  size: 1,
  loadReportMs: 0,
  workerUrl: new URL("./fixtures/stalling-match-worker.js", import.meta.url),
  watchdogMs: 100,
  hangTimeoutMs: 1000,
});
const restore = installWorkerPool(pool, { installExecutor: installMatchExecutor });
await pool.ready;
test.after(async () => {
  await pool.close();
  restore();
});

let nextSessionId = 1;
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
  session.pauseForWorker = (paused) => {
    session.pausedForWorker = paused;
  };
  session.close = (why) => {
    session.closed = true;
    session.closedBecause = why;
    matchExecutor.leave(session);
  };
  return { session, sent };
};

const createdClid = (frame) => {
  switch (frame.readUInt16LE(2)) {
    case OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP:
      return frame.readUInt16LE(12);
    case OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP:
      return frame.readUInt16LE(4);
    default:
      return null;
  }
};

const waitFor = async (check, what, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const field = (doid, fieldId, pad = 0) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(fieldId)
    .raw(Buffer.alloc(pad))
    .frame()
    .subarray(2);

const enter = async ({ session, sent }, mapNodeId = MAP_NODE) => {
  const result = dungeonMatches.resolve({ session, mapNodeId, group: "" });
  const joined = matchExecutor.join(session, result, { mapNodeId }, {
    onPlayerReady: () => session.send(buildEntryResponse(MATCHMAKER_DOID, 0, mapNodeId)),
  });
  const player = await waitFor(
    () => sent.find((frame) => createdClid(frame) === CLID.PlayerGameObject),
    "the owner player"
  );
  const playerDoid = player.readUInt32LE(6);
  matchExecutor.forward(session, field(playerDoid, 185));
  matchExecutor.forward(session, field(playerDoid, 184));
  await joined;
  return { match: result.match, playerDoid };
};

test("a lease asked for by a worker that dies meanwhile is not left behind", async () => {
  const gone = { index: 9, alive: true };
  const leasing = pool.lease(gone, 1000000701);
  gone.alive = false;
  await assert.rejects(leasing, /match worker 9 is gone/);
  assert.equal(pool.ownerOf(1000000701), null);
  // And one left by a dead worker does not hold up the next.
  const { deferred } = await import("../src/socket/worker-channel.js");
  pool.leases.set(1000000702, { worker: gone, released: deferred() });
  assert.equal(pool.ownerOf(1000000702), null);
  const live = pool.workers[0];
  const account = await pool.lease(live, 1000000702);
  assert.equal(account.id, 1000000702);
  pool.releaseLease(live, 1000000702);
});

test("a lock granted to a worker that died waiting for it is handed back", async () => {
  let release;
  const held = withAccountLock(1000000703, () => new Promise((resolve) => (release = resolve)));
  await waitFor(() => release, "the lock to be held");
  const gone = { index: 9, alive: true };
  const borrowing = pool.borrowLock(gone, 1000000703);
  gone.alive = false;
  release();
  await held;
  await assert.rejects(borrowing, /match worker 9 is gone/);
  assert.equal(await withAccountLock(1000000703, async () => "free"), "free");
});

test("a message the worker cannot handle fails that entry and nothing else", async () => {
  const worker = pool.workers[0];
  const { session } = connect(1000000704);
  session.matchGeneration = 0;
  const route = {
    worker,
    gen: 1,
    session,
    matchId: -1,
    joined: (await import("../src/socket/worker-channel.js")).deferred(),
    left: (await import("../src/socket/worker-channel.js")).deferred(),
    leaving: false,
    entered: false,
    objects: new Map(),
  };
  worker.routes.set(session.id, route);
  session.matchRoute = route;
  // No match record: the worker's join throws before any dungeon code runs.
  worker.channel.post({ t: "join", sid: session.id, gen: 1, member: { accountId: 1000000704 } });
  await assert.rejects(route.joined.promise, /match worker 0/);
  assert.equal(pool.workers[0], worker, "the worker is still the same one");
  assert.equal(worker.alive, true);
  worker.routes.delete(session.id);
});

test("a player leaving is still heard until the run has actually ended", async () => {
  const client = connect(1000000705);
  const { playerDoid } = await enter(client);
  const leaving = matchExecutor.leave(client.session, { notifyClient: true });
  // Between RequestExit and the last frame the dungeon still owns the packets,
  // as it does in one thread; the bare connection never sees them.
  assert.equal(matchExecutor.forward(client.session, field(playerDoid, 999)), true);
  await leaving;
  assert.equal(matchExecutor.forward(client.session, field(playerDoid, 999)), false);
  assert.equal(client.session.reportedHeroPosition, undefined);
});

test("a client sending faster than its worker keeps up is cut off like a full socket queue", async () => {
  const client = connect(1000000706);
  const { playerDoid } = await enter(client);
  // Two megabytes of dungeon packets in one go, far past what one session may
  // have waiting.
  const big = field(playerDoid, 999, 60_000);
  let forwarded = 0;
  while (!client.session.closed && forwarded < 40) {
    matchExecutor.forward(client.session, big);
    forwarded++;
  }
  assert.equal(client.session.closed, true, "closed");
  assert.match(client.session.closedBecause, /queue saturated/);
  assert.ok(forwarded < 40);
  await waitFor(() => !client.session.matchRoute, "the route to end");
});

test("an honest backlog stops the reading and lets it go again once handled", async () => {
  const client = connect(1000000708);
  const { playerDoid } = await enter(client);
  for (let i = 0; i < 100; i++) matchExecutor.forward(client.session, field(playerDoid, 999));
  assert.equal(client.session.pausedForWorker, true);
  assert.equal(client.session.closed, false);
  await waitFor(() => client.session.pausedForWorker === false, "the worker to catch up");
  await matchExecutor.leave(client.session, { notifyClient: true });
});

test("a door out of a worker's dungeon takes everything down before the next one starts", async () => {
  const client = connect(1000000709);
  const { match: first } = await enter(client);
  const worker = pool.workers[0];
  const route = client.session.matchRoute;
  const before = client.sent.length;

  // What the worker asks for when a hero steps into a doorway trigger.
  const crossing = pool.handleCall(worker, "door", {
    sid: client.session.id,
    gen: route.gen,
    destination: MAP_NODE,
  });
  // The client answers the new floor's loading signals once it has its player.
  const player = await waitFor(
    () => client.sent.slice(before).find((frame) => createdClid(frame) === CLID.PlayerGameObject),
    "the next dungeon's player"
  );
  const playerDoid = player.readUInt32LE(6);
  matchExecutor.forward(client.session, field(playerDoid, 185));
  matchExecutor.forward(client.session, field(playerDoid, 184));
  assert.equal(await crossing, true);

  const after = client.sent.slice(before);
  const lastDisable = after.findLastIndex((frame) =>
    [OP.CLIENT_OBJECT_DISABLE_RESP, OP.CLIENT_OBJECT_DISABLE_OWNER_RESP].includes(frame.readUInt16LE(2))
  );
  const newPlayer = after.indexOf(player);
  assert.ok(lastDisable >= 0 && lastDisable < newPlayer, "the old run is gone before the new one arrives");
  assert.ok(after.findIndex((frame) => frame.equals(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE))) > newPlayer);
  assert.notEqual(client.session.dungeonMatch, first);
  assert.equal(dungeonMatches.matches.has(first.id), false);
  assert.equal(client.session.matchRoute.gen, route.gen + 1);
  await matchExecutor.leave(client.session, { notifyClient: true });
});

test("a worker that stops answering is replaced and its players sent home", async () => {
  const client = connect(1000000707);
  await enter(client);
  const stuck = pool.workers[0];
  const before = client.sent.length;
  stuck.thread.postMessage({ t: "test.stall" });
  await waitFor(() => pool.workers[0] !== stuck, "the stuck worker to be replaced", 10_000);
  await pool.workers[0].ready.promise;
  const after = client.sent.slice(before);
  assert.ok(after.at(-1).equals(buildExitComplete(MATCHMAKER_DOID)), "sent home");
  assert.equal(pool.ownerOf(1000000707), null);
});

test("a second login on the same account takes the run over without two live copies", async () => {
  const accountId = 1000000710;
  const first = connect(accountId);
  await enter(first);
  // Displaced: the old socket closes, and the new one enters at once — before
  // the worker has even heard that the first one left.
  first.session.close("signed in from somewhere else");
  const second = connect(accountId);
  await enter(second);
  assert.equal(pool.ownerOf(accountId), pool.workers[0]);
  await waitFor(() => !first.session.matchRoute, "the first run to end");
  await (await import("../src/rpc.js")).dispatch("account", "AlterAttribute", [accountId, "t", "who", "second"]);
  await matchExecutor.leave(second.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(accountId), "the lease to come back");
  const stored = await loadAccount(accountId);
  assert.equal(stored.account_attributes.find((row) => row.name === "who")?.value, "second");
});

test("a connection lost half way through loading leaves nothing behind", async () => {
  const accountId = 1000000711;
  const { session, sent } = connect(accountId);
  const result = dungeonMatches.resolve({ session, mapNodeId: MAP_NODE, group: "" });
  const joined = matchExecutor.join(session, result, { mapNodeId: MAP_NODE }, {
    onPlayerReady: () => session.send(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE)),
  });
  await waitFor(() => sent.find((frame) => createdClid(frame) === CLID.PlayerGameObject), "the player");
  // Never sends its loading signals; the socket drops instead.
  session.close("socket closed");
  await assert.rejects(joined);
  await waitFor(() => !session.matchRoute, "the route to end");
  await waitFor(() => !pool.ownerOf(accountId), "the lease to come back");
  assert.equal(dungeonMatches.matches.has(result.match.id), false);
  assert.equal(pool.workers[0].matches.has(result.match.id), false);
});

test("a connection lost before its account even arrives does not keep the account", async () => {
  const accountId = 1000000714;
  const { session } = connect(accountId);
  const result = dungeonMatches.resolve({ session, mapNodeId: MAP_NODE, group: "" });
  const joined = matchExecutor.join(session, result, { mapNodeId: MAP_NODE }, {
    onPlayerReady: () => session.send(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE)),
  });
  // Gone in the same breath: the worker hears the leave while the lease for
  // the account is still on its way to it.
  session.close("socket closed");
  await assert.rejects(joined);
  await waitFor(() => !pool.ownerOf(accountId), "the lease to come back", 10_000);
  // And the account is free for the next entry, on any worker.
  const again = connect(accountId);
  await enter(again);
  await matchExecutor.leave(again.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(accountId), "the second lease to come back");
});

test("security strikes follow the connection from one worker run to the next", async () => {
  const client = connect(1000000713);
  const forged = (playerDoid) => field(playerDoid, 171);
  const first = await enter(client);
  matchExecutor.forward(client.session, forged(first.playerDoid));
  matchExecutor.forward(client.session, forged(first.playerDoid));
  await matchExecutor.leave(client.session, { notifyClient: true });
  assert.equal(client.session.closed, false, "two strikes are not yet a pattern");

  // A fresh run must not mean a fresh count.
  const second = await enter(client);
  matchExecutor.forward(client.session, forged(second.playerDoid));
  await waitFor(() => client.session.closed, "the third strike to end the connection");
  assert.match(client.session.closedBecause, /security policy: combat\.forged_attacker/);
});

/** Ultimate is entered only by a hero that has cleared every normal node. */
const clearEveryNormalNode = async (accountId) => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const { setMapNodeBit } = await import("../src/map-progress.js");
  const { saveAccount } = await import("../src/accounts.js");
  const gameMaster = await loadGameMaster();
  const account = await loadAccount(accountId);
  const avatar = account.account_avatars.find((row) => row.id === account.active_avatar);
  avatar.completed_mapnode_mask = gameMaster.raw.MapPage
    .filter((node) => node.NodeType === "DUNGEON" || node.NodeType === "BOSS")
    .reduce((mask, node) => setMapNodeBit(mask, node.BitIndex), "");
  await saveAccount(account);
};

test("a hero switched after admission is refused on the worker, with the client's own reason", async () => {
  const { EntryRefusedError } = await import("../src/socket/match-entry.js");
  const { entryErrorCodeFor, ENTRY_ERROR } = await import("../src/socket/matchmaker.js");
  const { session } = connect(1000000717);
  // Admitted as if the entry check had passed — as it would have for the hero
  // active then — and the run's own hold finds a hero that has cleared nothing.
  const result = dungeonMatches.resolve({ session, mapNodeId: 50150, group: "" });
  assert.ok(result.match);
  await assert.rejects(matchExecutor.join(session, result, { mapNodeId: 50150 }, {}), (problem) =>
    problem instanceof EntryRefusedError &&
    entryErrorCodeFor({ error: problem.reason }) === ENTRY_ERROR.UNAUTHORIZED_MAP
  );
  await matchExecutor.leave(session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(1000000717), "the refused account handed back");
});

test("stopping the server settles every run still in a worker, including one still leaving", async () => {
  const accountId = 1000000712;
  const client = connect(accountId);
  await enter(client);
  await (await import("../src/rpc.js")).dispatch("account", "AlterAttribute", [accountId, "t", "last", "words"]);

  // A second player asks to leave while their reward is still being written:
  // an Ultimate records the room reached on entry, and the disk is slow.
  pool.workers[0].thread.postMessage({ t: "test.slowWrites", ms: 1500 });
  const exiting = connect(1000000716);
  await clearEveryNormalNode(1000000716);
  await enter(exiting, 50150);
  let exited = false;
  matchExecutor.leave(exiting.session, { notifyClient: true }).then(() => {
    exited = true;
  });

  // As shutdown.js does: sockets close first, then the workers drain.
  client.session.close("server shutting down");
  assert.equal(await pool.close(), true);
  assert.equal(exited, true, "the exit finished before the worker was stopped");
  const stored = await loadAccount(accountId);
  assert.equal(stored.account_attributes.find((row) => row.name === "last")?.value, "words");
  assert.equal(pool.workers.every((worker) => worker.alive === false), true);
});

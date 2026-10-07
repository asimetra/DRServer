import assert from "node:assert/strict";
import test from "node:test";

import { MatchWorkerPool } from "../src/socket/match-worker-pool.js";
import { RANKED_WORKER, rankedStarted, rankedWaiting } from "../src/ranked/remote.js";
import { noteSeatModes, seatRuns } from "../src/modes/seat.js";
import { config } from "../src/config.js";
import { createStockClientAdapter, stockClientEntryHooks } from "../src/ranked/stock-client/adapter.js";
import { createRankedService } from "../src/ranked/index.js";
import { createRecords } from "../src/ranked/records.js";
import { createSpec, fixedPicker } from "../src/ranked/race-spec.js";
import { systemFriendRow, SYSTEM_FRIEND_ID } from "../src/ranked/stock-client/system-friend.js";
import { createGracefulShutdown } from "../src/shutdown.js";
import { installModeHooks } from "../src/modes/hooks.js";
import { ONE_LIFE_RUN_RULES } from "../src/modes/one-life/index.js";

/**
 * Ranked with match workers on: every ranked run on one worker, which runs the
 * queue and the races, and the main thread answering only on connections.
 * The pool's own methods, against workers that are only their bookkeeping.
 */
const worker = (index, { matches = 0, alive = true } = {}) => ({
  index,
  alive,
  started: true,
  stalled: false,
  matches: new Map(Array.from({ length: matches }, (_, n) => [`m${index}-${n}`, 1])),
  routes: new Map(),
});
const poolOf = (...workers) => ({ workers });
const workerFor = (pool, match) => MatchWorkerPool.prototype.workerFor.call(pool, match);

/**
 * The main thread's ranked hooks, which say its rules there (`together`) as
 * the pool picks a worker, and one life's, whose runs are anybody's.
 */
const withModes = (t) => {
  const ranked = installModeHooks("ranked", { modeRules: stockClientEntryHooks({ settings: { lobbyNode: 50003 }, waiting: () => 0 }).modeRules });
  const onelife = installModeHooks("onelife", { modeRules: (mode) => (mode === "onelife" ? ONE_LIFE_RUN_RULES : null) });
  t.after(() => (ranked(), onelife()));
};

test("a ranked run goes to the ranked worker however busy it is; anything else, to the least busy", (t) => {
  withModes(t);
  const home = worker(RANKED_WORKER, { matches: 5 });
  const quiet = worker(RANKED_WORKER + 1);
  const pool = poolOf(home, quiet);

  assert.equal(workerFor(pool, { id: 1, mode: "ranked" }), home, "both racers must share the thread that starts them");
  assert.equal(workerFor(pool, { id: 2 }), quiet, "an ordinary run still goes by load");
});

test("a mode whose runs are not together goes by load like any run, and does not wait on the seat", (t) => {
  withModes(t);
  const home = worker(RANKED_WORKER, { matches: 5 });
  const quiet = worker(RANKED_WORKER + 1);
  assert.equal(workerFor(poolOf(home, quiet), { id: 3, mode: "onelife" }), quiet, "one life's runs are anybody's");
  const down = worker(RANKED_WORKER, { alive: false });
  assert.equal(workerFor(poolOf(down, quiet), { id: 4, mode: "onelife" }), quiet, "the seat being down is not its business");
});

test("a ranked worker still loading, or not answering, refuses a ranked run rather than holding it", (t) => {
  withModes(t);
  const loading = { ...worker(RANKED_WORKER), started: false };
  assert.throws(() => workerFor(poolOf(loading, worker(1)), { id: 1, mode: "ranked" }), /not answering/);
  const stalled = { ...worker(RANKED_WORKER), stalled: true };
  assert.throws(() => workerFor(poolOf(stalled, worker(1)), { id: 1, mode: "ranked" }), /not answering/);
  assert.equal(workerFor(poolOf(stalled, worker(1)), { id: 2 }).index, 1, "an ordinary run goes elsewhere");
});

test("with the ranked worker down, a ranked run is refused, not sent where ranked is not", (t) => {
  withModes(t);
  const pool = poolOf(worker(RANKED_WORKER, { alive: false }), worker(RANKED_WORKER + 1));
  assert.throws(() => workerFor(pool, { id: 1, mode: "ranked" }), /seating ranked .* not running/);
  assert.equal(workerFor(pool, { id: 2 }).index, RANKED_WORKER + 1);
});

test("the main thread's MATCHMAKER line shows the count the ranked worker reports", (t) => {
  t.after(() => noteSeatModes([]));
  const onMessage = (from, message) => MatchWorkerPool.prototype.onMessage.call(poolOf(), from, message);

  onMessage(worker(RANKED_WORKER), { t: "mode", mode: "ranked", data: { waiting: 3 } });
  assert.equal(rankedWaiting(), 3);
  onMessage(worker(RANKED_WORKER + 1), { t: "mode", mode: "ranked", data: { waiting: 9 } });
  assert.equal(rankedWaiting(), 3, "only the seat runs a together mode, so only it has a count to give");

  const settings = { lobbyNode: 50003 };
  const hooks = stockClientEntryHooks({ settings, waiting: rankedWaiting });
  assert.deepEqual(hooks.friendList([])[0], systemFriendRow({ waiting: 3, where: 50003 }));
});

test("a lobby is planned from the request's own mark, on a thread that never saw the JOIN", async () => {
  // The JOIN is routed on the main thread; the run is built on the ranked
  // worker, whose adapter therefore never had `routeEntry` called on it.
  const service = createRankedService({
    records: createRecords({ storage: "memory" }),
    picker: fixedPicker(createSpec({ mapNodeId: 50006, seed: 1 })),
    rules: { countdownMs: 5000, maxDurationMs: 60_000, forfeitWindowMs: 10_000, drawWindowMs: 1000 },
    start: async () => {},
  });
  const adapter = createStockClientAdapter({
    service,
    settings: { lobbyNode: 50003, lobbyFloor: "castle/arena/lobby.json", lobbyIdleMs: 60_000 },
    sessionOf: () => null,
    say: () => {},
    raceFloors: async () => [],
    completeFloor: () => true,
  });

  const routed = stockClientEntryHooks({ settings: { lobbyNode: 50003 }, waiting: () => 0 }).routeEntry(
    { accountId: 7 },
    { mapNodeId: 0, friendId: SYSTEM_FRIEND_ID, mapId: 0 }
  );
  assert.equal(routed.mode, "ranked");

  const plan = await adapter.hooks.planFor({ accountId: 7, modeEntry: routed.mode }, routed.mapNodeId);
  assert.deepEqual(plan.floors, [{ authored: "castle/arena/lobby.json", quiet: { npc: [] } }]);
  assert.equal(await adapter.hooks.planFor({ accountId: 8 }, 50003), null, "an unmarked run of the node is its own");
});

test("stopping ranked asks the ranked worker, and a dead one is not waited on", async () => {
  const asked = [];
  const home = { ...worker(RANKED_WORKER), channel: { call: async (op) => (asked.push(op), true) } };
  assert.equal(await MatchWorkerPool.prototype.stopSeatModes.call(poolOf(home, worker(1)), undefined), true);
  assert.deepEqual(asked, ["modesStop"]);

  const dead = { ...worker(RANKED_WORKER, { alive: false }), channel: { call: async () => assert.fail("asked") } };
  assert.equal(await MatchWorkerPool.prototype.stopSeatModes.call(poolOf(dead), undefined), false);
});

test("a ranked worker that never answers the stop is given up on, within the drain's time", async () => {
  const home = { ...worker(RANKED_WORKER), channel: { call: () => new Promise(() => {}) } };
  const pool = { ...poolOf(home), drainTimeoutMs: 20 };
  assert.equal(await MatchWorkerPool.prototype.stopSeatModes.call(pool, undefined), false);
});

test("a shutdown closes the sessions even when what runs before them never finishes", async () => {
  const events = [];
  const shutdown = createGracefulShutdown({
    servers: () => [],
    beforeSessions: () => new Promise(() => events.push("stuck")),
    beforeSessionsMs: 20,
    sessions: () => [{ id: 1, close: () => events.push("session closed") }],
  });
  await shutdown("SIGTERM");
  assert.deepEqual(events, ["stuck", "session closed"]);
});

test("a shutdown ends ranked's races before any connection closes", async () => {
  const events = [];
  const shutdown = createGracefulShutdown({
    servers: () => [],
    beforeSessions: async () => events.push("races void"),
    sessions: () => [{ id: 1, close: () => events.push("session closed") }],
  });
  await shutdown("SIGTERM");
  assert.deepEqual(events, ["races void", "session closed"]);
});

test("what a ranked run needs crosses to the worker: the request's mark, the match's, the client's strings", async () => {
  const { matchSnapshot, memberSnapshot, requestSnapshot } = await import("../src/socket/match-worker-pool.js");
  assert.equal(requestSnapshot({ mapNodeId: 50003, mode: "ranked" }).mode, "ranked");
  assert.equal(requestSnapshot({ mapNodeId: 50003 }).mode, null);
  assert.equal(matchSnapshot({ id: 1, mapNodeId: 50003, mode: "ranked" }).mode, "ranked");
  assert.equal(memberSnapshot({ accountId: 7, uiStrings: "f833e9e5" }).uiStrings, "f833e9e5");
  assert.equal(memberSnapshot({ accountId: 7 }).uiStrings, null);
});

test("the hooks are handed a world's context, not its raw member, and must not bind it again", async () => {
  // gameplay-fields.js passes `contextFor(member)`; chat.js passes whatever the
  // field handler holds. Binding a context again throws on the proxy, and the
  // guard turned that into a lobby entry that never queued.
  const { createMatchWorld } = await import("../src/socket/match-world.js");
  const raw = {
    id: 1,
    accountId: 7,
    heroPosition: { x: 150, y: 150 },
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid: () => 9001,
  };
  const world = createMatchWorld({ id: 41, members: new Set([raw]) }, raw);
  const context = world.contextFor(raw);

  const relayed = [];
  const service = createRankedService({
    records: createRecords({ storage: "memory" }),
    picker: fixedPicker(createSpec({ mapNodeId: 50006, seed: 1 })),
    rules: { countdownMs: 5000, maxDurationMs: 60_000, forfeitWindowMs: 10_000, drawWindowMs: 1000 },
    start: async () => {},
  });
  const adapter = createStockClientAdapter({
    service,
    settings: { lobbyNode: 50003, lobbyFloor: "lobby.json", lobbyIdleMs: 60_000, ring: { x0: 100, y0: 100, x1: 200, y1: 200 } },
    sessionOf: (id) => (id === 7 ? raw : { accountId: id, send: () => {} }),
    say: () => {},
    relay: (speaker, line) => relayed.push(line),
    raceFloors: async () => [],
    completeFloor: () => true,
  });
  await adapter.hooks.planFor({ accountId: 7, modeEntry: "ranked" }, 50003);
  await adapter.hooks.planFor({ accountId: 8, modeEntry: "ranked" }, 50003);

  assert.doesNotThrow(() => adapter.hooks.heroRequested(context));
  assert.equal(service.statusOf(7).state, "queued", "in the ring at entry, so queued at entry");
  assert.doesNotThrow(() => adapter.hooks.heroEvent(context, { type: "said", line: "hi" }));
  assert.deepEqual(relayed, ["hi"]);
});

test("the main thread knows ranked's rules: no unlock check, nobody follows a racer in, one seat", () => {
  const rules = stockClientEntryHooks({ settings: { lobbyNode: 50003 }, waiting: () => 0 }).modeRules("ranked");
  assert.equal(rules.unlockCheck, false, "the lobby is open to every hero");
  assert.equal(rules.joinable, false, "a friend cannot JOIN a racer's run");
  assert.equal(rules.together, true);
  assert.equal(stockClientEntryHooks({ settings: { lobbyNode: 50003 }, waiting: () => 0 }).modeRules("onelife"), null);
});

test("the seat says which modes it runs as it is ready, and they are gone with it", (t) => {
  const was = config.matchWorkerCount;
  config.matchWorkerCount = 2;
  t.after(() => {
    config.matchWorkerCount = was;
    noteSeatModes([]);
  });
  const pool = { ...poolOf(), workers: [] };
  const seat = { ...worker(RANKED_WORKER), ready: { resolve: () => {} }, startupTimer: null };
  MatchWorkerPool.prototype.onMessage.call(pool, seat, { t: "ready", modes: ["onelife", "ranked"] });
  assert.equal(seatRuns("ranked"), true);
  assert.equal(rankedStarted(), true);
  const other = { ...worker(RANKED_WORKER + 1), ready: { resolve: () => {} }, startupTimer: null };
  MatchWorkerPool.prototype.onMessage.call(pool, other, { t: "ready", modes: [] });
  assert.equal(seatRuns("ranked"), true, "another worker's word is not the seat's");

  MatchWorkerPool.prototype.onMessage.call(pool, seat, { t: "mode", mode: "ranked", data: { waiting: 4 } });
  noteSeatModes([]);
  assert.equal(seatRuns("ranked"), false, "the seat gone, its modes with it");
  assert.equal(rankedWaiting(), 0, "and what they said");
});

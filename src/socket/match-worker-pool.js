/**
 * The main thread's half of running matches in workers.
 *
 * The pool owns the threads and everything the main thread keeps for them: which
 * worker runs which match, which session is routed where, which accounts are
 * leased out, and which account locks a worker has borrowed. The executor at the
 * bottom is what the MatchMaker and doors talk to; it has the same two methods
 * as the local one, and the difference is only where the dungeon runs.
 *
 * Ordering is the whole difficulty and is kept in one place: a worker's frames
 * for a session arrive as one ordered stream with control markers in it, and
 * this side writes them in that order — so the MatchMaker's own answers
 * (297, ClientExitComplete) land exactly between the frames the client needs
 * them between.
 *
 * The messages, all of them (worker-channel.js carries calls and their answers;
 * both threads are the same code, so there is no version to agree on):
 *
 *   main -> worker   join, packet, leave             a session's run
 *                    presence, presence.all          the online roll, copied
 *                    written                         output that reached the sockets
 *                    unhold                          a lock lent to another worker, back
 *                    call rpc | op                   a transaction for an account held there
 *                    call account | hold | patch     a copy, a lock, a write-through
 *                    call say | ping | drain         chat, liveness, stopping
 *   worker -> main   out                             frames and markers, with acks
 *                    ready, presence, match,
 *                    release, unlock                 lifecycle and bookkeeping
 *                    friendship                      a friendship made or ended there
 *                    call lease | lock | patch |
 *                         objectId | recordRuns |
 *                         say | door | account       what a dungeon asks of the server
 *
 * Accounts: one in a dungeon is leased to that worker. RPCs and internal-API
 * writes that need it run there (rpc.js, account-operations.js); a transaction
 * that needs an account in a dungeon on another worker as well borrows that
 * worker's lock and writes back only the fields it changed (borrowLock). A
 * worker that dies loses whatever its players earned since their last save, as
 * a crashed process would.
 */
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { error, info, warn } from "../log.js";
import {
  AccountLeasedError,
  installAccountOwnership,
  loadAccount,
  nextObjectIdAbove,
  withThreadAccountLock,
} from "../accounts.js";
import { dispatch, installRpcForwarder } from "../rpc.js";
import { installAccountOperationForwarder } from "../account-operations.js";
import { invalidateMarketBrowse } from "../market.js";
import { recordRuns } from "../leaderboard.js";
import { dungeonMatches } from "./matches.js";
import { buildExitComplete } from "./matchmaker.js";
import { disablePriority } from "./match-runtime.js";
import { objectDisable } from "./objects.js";
import { OP } from "./opcodes.js";
import {
  friendshipChanged,
  observePresence,
  presenceEntries,
  setPresenceLocation,
} from "./presence.js";
import { RULE, noteViolation } from "./security-events.js";
import { createWorkerChannel, deferred } from "./worker-channel.js";

/** How long a new lease waits for the previous run of the same account to hand it back. */
const LEASE_HANDOVER_TIMEOUT_MS = 15_000;

/** Where doids begin; a replacement worker starts above everything its predecessor sent. */
const FIRST_DOID = 1000;

/** How often the spread of work across the workers is written to the log. */
const LOAD_REPORT_MS = 30_000;

/**
 * How often each worker is asked whether it is still there, and how long an
 * unanswered question may stand before the worker is taken to be stuck. The
 * heartbeat is answered here, so a worker caught in a loop would otherwise
 * leave its players connected to a dungeon that never moves again — and, once
 * their forwarded packets back up, with their reading paused, heartbeats
 * included. A floor build takes well under a second; five is far past anything
 * honest and well inside what a client waits for a heartbeat.
 */
const WATCHDOG_MS = 1_000;
const HANG_TIMEOUT_MS = 5_000;

/**
 * Starting and stopping. A worker loads the GameMaster and every module a
 * dungeon needs before it says it is ready, which takes a second or two; one
 * that has not in thirty has failed. A replacement that keeps failing to start
 * is retried with a doubling wait and then left down, rather than restarted as
 * fast as it can fail. A stop waits this long for a worker to settle its runs
 * and writes, then ends it regardless — a stuck worker must not hold a restart.
 */
const STARTUP_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = 500;
const MAX_RESTART_BACKOFF_MS = 30_000;
const MAX_START_FAILURES = 5;
const DRAIN_TIMEOUT_MS = 10_000;

/**
 * What one session may have forwarded and not yet handled — the socket
 * layer's own backlog bound (socket/index.js), which forwarding would
 * otherwise escape: the socket queue empties the moment a packet is handed on.
 */
const MAX_FORWARDED_PACKETS = 256;
const MAX_FORWARDED_BYTES = 1 << 20;
/** Reading stops above this many waiting and resumes at or below it, as the socket queue does. */
const RESUME_FORWARDED_AT = 64;

const updateForwardedFlow = (route) => {
  route.session.pauseForWorker?.(route.forwardedPackets > RESUME_FORWARDED_AT);
};

const matchSnapshot = (match) => ({
  id: match.id,
  mapNodeId: match.mapNodeId,
  group: match.group ?? "",
  private: Boolean(match.private),
  floorIndex: Number(match.floorIndex ?? 0),
});

const memberSnapshot = (session) => ({
  accountId: session.accountId,
  matchMakerDoid: session.matchMakerDoid,
  presenceDoid: session.presenceDoid,
  matchMakerGroup: session.matchMakerGroup ?? "",
  infiniteEpoch: session.infiniteEpoch,
  // The connection's strikes, so leaving and re-entering does not reset them.
  securityStrikes: [...(session.securityStrikes ?? [])],
});

/**
 * The connection's strikes as the run left them. Taken whole: the worker began
 * from this connection's own, and nothing here strikes a connection while its
 * run is out — every rule that counts strikes judges a dungeon packet, and those
 * all went to the worker.
 */
const returnStrikes = (session, strikes) => {
  // A "left" for a run the worker never had carries none, and changes nothing.
  if (Array.isArray(strikes)) session.securityStrikes = new Map(strikes);
};

const requestSnapshot = (request = {}) => ({
  demographics: String(request.demographics ?? ""),
  sCode: Number(request.sCode ?? 0),
  mapNodeId: Number(request.mapNodeId ?? 0),
  friendId: Number(request.friendId ?? 0),
  mapId: Number(request.mapId ?? 0),
  friendOnly: Number(request.friendOnly ?? 0),
  matchMakerGroup: String(request.matchMakerGroup ?? ""),
});

export class MatchWorkerPool {
  constructor({
    size,
    workerUrl = new URL("./match-worker-thread.js", import.meta.url),
    registry = dungeonMatches,
    walkThrough = async (session, destination) =>
      (await import("./doors.js")).walkThrough(session, destination),
    unref = false,
    loadReportMs = LOAD_REPORT_MS,
    watchdogMs = WATCHDOG_MS,
    hangTimeoutMs = HANG_TIMEOUT_MS,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    restartBackoffMs = RESTART_BACKOFF_MS,
    maxStartFailures = MAX_START_FAILURES,
    drainTimeoutMs = DRAIN_TIMEOUT_MS,
  } = {}) {
    this.size = Math.max(1, Math.trunc(Number(size) || 1));
    this.stride = this.size + 1;
    this.registry = registry;
    this.walkThrough = walkThrough;
    this.closed = false;
    /** accountId -> { worker, released: deferred } */
    this.leases = new Map();
    /** token -> { worker, release } */
    this.borrowedLocks = new Map();
    this.nextLockToken = 1;
    this.workerUrl = workerUrl;
    this.unrefWorkers = unref;
    this.startupTimeoutMs = startupTimeoutMs;
    this.restartBackoffMs = restartBackoffMs;
    this.maxStartFailures = maxStartFailures;
    this.drainTimeoutMs = drainTimeoutMs;
    /** How many threads have been started, replacements included. */
    this.spawned = 0;
    /** Per slot: replacements in a row that died before they were ready. */
    this.startFailures = new Array(this.size).fill(0);
    this.respawnTimers = new Set();
    this.workers = Array.from({ length: this.size }, (_, index) => this.spawn(index));
    this.everReady = false;
    this.ready = Promise.all(this.workers.map((worker) => worker.ready.promise)).then(() => {
      this.everReady = true;
      return this;
    });
    this.loadReport = loadReportMs > 0 ? setInterval(() => this.reportLoad(), loadReportMs) : null;
    this.loadReport?.unref?.();
    this.hangTimeoutMs = hangTimeoutMs;
    this.watchdog = watchdogMs > 0 ? setInterval(() => this.checkWorkers(), watchdogMs) : null;
    this.watchdog?.unref?.();
  }

  /** Asks each worker in turn; one that has not answered in time is stopped and recovered. */
  checkWorkers() {
    const now = Date.now();
    for (const worker of this.workers) {
      if (!worker.alive || !worker.started || worker.stalled) continue;
      if (worker.pingSentAt) {
        if (now - worker.pingSentAt <= this.hangTimeoutMs) continue;
        worker.stalled = true;
        error(`match worker ${worker.index} has not answered for ${now - worker.pingSentAt} ms; stopping it`);
        void worker.thread.terminate();
        continue;
      }
      worker.pingSentAt = now;
      worker.channel.call("ping").then(
        () => {
          worker.pingSentAt = 0;
        },
        () => {}
      );
    }
  }

  spawn(index, { start = FIRST_DOID } = {}) {
    this.spawned += 1;
    const thread = new Worker(this.workerUrl, {
      // `attempt` counts every thread this pool has started, replacements included.
      workerData: { index, stride: this.stride, start, attempt: this.spawned },
    });
    const worker = {
      index,
      thread,
      ready: deferred(),
      /** sessionId -> route */
      routes: new Map(),
      /** matchId -> members routed here */
      matches: new Map(),
      /**
       * The highest doid this worker had issued at its last flush, as it
       * reports — and at least everything below where it was told to start,
       * so a replacement that dies unready still passes the mark on.
       */
      highestDoid: start - 1,
      alive: true,
    };
    // Nobody waits on a replacement's readiness but its own log line.
    worker.ready.promise.catch(() => {});
    worker.startupTimer = setTimeout(() => {
      if (worker.started || !worker.alive) return;
      error(`match worker ${index} did not start in ${this.startupTimeoutMs} ms; stopping it`);
      worker.ready.reject(new Error(`match worker ${index} did not start in ${this.startupTimeoutMs} ms`));
      void thread.terminate();
    }, this.startupTimeoutMs);
    worker.startupTimer.unref?.();
    worker.channel = createWorkerChannel({
      port: thread,
      handle: (op, args) => this.handleCall(worker, op, args),
      onMessage: (message) => this.onMessage(worker, message),
    });
    thread.on("message", worker.channel.receive);
    // Queued now, so the worker reads who is online before any join it is sent.
    worker.channel.post({ t: "presence.all", entries: presenceEntries() });
    thread.on("error", (problem) => error(`match worker ${index} failed: ${problem.stack ?? problem}`));
    thread.on("exit", (code) => {
      worker.alive = false;
      clearTimeout(worker.startupTimer);
      worker.channel.failAll(new Error(`match worker ${index} exited`));
      if (!worker.started) {
        worker.ready.reject(new Error(`match worker ${index} exited with code ${code} before it was ready`));
      }
      if (this.closed) return;
      error(`match worker ${index} exited with code ${code}`);
      this.recover(worker);
    });
    if (this.unrefWorkers) thread.unref();
    return worker;
  }

  /**
   * A worker is gone, and with it every dungeon it ran.
   *
   * Its players are still connected. Each is told to take down everything the
   * dead worker had given it — in the teardown order the client needs, from the
   * objects this thread saw pass — and is then sent home: a run in progress
   * gets ClientExitComplete, which the client obeys unasked, and an entry in
   * progress fails the way any failed entry does. Nobody on another worker
   * notices. The accounts go back to storage as last saved, and a fresh worker
   * takes the dead one's place, numbering its objects above anything the old
   * one sent so no client can confuse the two.
   */
  recover(worker) {
    const routes = [...worker.routes.values()];
    for (const route of routes) this.evacuate(worker, route);
    for (const [accountId, lease] of [...this.leases]) {
      if (lease.worker === worker) this.releaseLease(worker, accountId);
    }
    for (const [token, borrowed] of [...this.borrowedLocks]) {
      // Its own borrowings go back; holds it kept for others simply vanish with it.
      if (borrowed.worker === worker) this.returnLock(token);
      else if (borrowed.holder === worker) this.borrowedLocks.delete(token);
    }
    for (const matchId of [...worker.matches.keys()]) {
      const match = this.registry.matches.get(matchId);
      if (match) this.registry.close(match);
    }
    worker.matches.clear();
    warn(`match worker ${worker.index}: returned ${routes.length} player(s) to town`);

    this.replace(worker);
  }

  /**
   * A fresh thread in the dead one's slot. Not while the pool is still starting
   * — a first start that fails is the operator's to see, not to paper over — and
   * not faster than a doubling wait while replacements keep dying unready, up to
   * a limit past which the slot stays down and its share of new matches goes to
   * the others.
   */
  replace(worker) {
    if (!this.everReady) return;
    const failures = worker.started ? 0 : this.startFailures[worker.index] + 1;
    this.startFailures[worker.index] = failures;
    if (failures >= this.maxStartFailures) {
      error(
        `match worker ${worker.index}: ${failures} replacements in a row failed to start; ` +
          "leaving the slot down"
      );
      return;
    }
    const start = FIRST_DOID +
      Math.ceil(Math.max(0, worker.highestDoid + 1 - FIRST_DOID) / this.stride) * this.stride;
    const delay = failures
      ? Math.min(MAX_RESTART_BACKOFF_MS, this.restartBackoffMs * 2 ** (failures - 1))
      : 0;
    const timer = setTimeout(() => {
      this.respawnTimers.delete(timer);
      if (this.closed) return;
      const replacement = this.spawn(worker.index, { start });
      this.workers[worker.index] = replacement;
      replacement.ready.promise.then(() => info(`match worker ${worker.index}: replaced`), () => {});
    }, delay);
    this.respawnTimers.add(timer);
  }

  evacuate(worker, route) {
    const { session } = route;
    const wasRunning = route.entered && !route.leaving;
    if (!session.closed) {
      const teardown = [...route.objects.entries()].sort(
        ([doidA, a], [doidB, b]) => disablePriority(a.clid) - disablePriority(b.clid) || doidA - doidB
      );
      for (const [doid, { owner }] of teardown) session.send(objectDisable(doid, owner));
    }
    route.objects.clear();
    if (!route.leaving) {
      route.leaving = true;
      this.registry.remove(session);
    }
    this.settleLeft(worker, route, route.gen);
    if (wasRunning && !session.closed) session.send(buildExitComplete(session.matchMakerDoid));
  }

  // --- Assignment ------------------------------------------------------------------

  /**
   * The worker a match runs on, chosen once when its first member arrives and
   * kept for as long as anyone is in it: every member of a match must be in the
   * same thread as its world. New matches go to the worker running the fewest,
   * which is what keeps the threads' loads even — a match is the unit of work.
   */
  workerFor(match) {
    const assigned = this.workers.find((worker) => worker.matches.has(match.id));
    if (assigned) return assigned;
    const live = this.workers.filter((worker) => worker.alive);
    if (!live.length) throw new Error("no match worker is running");
    // A replacement still loading would win on load alone — it has no matches —
    // and hold the new entry in its start-up queue, or lose it if it never
    // starts. Ready workers first; a loading one only when there is no other.
    const ready = live.filter((worker) => worker.started && !worker.stalled);
    return (ready.length ? ready : live).reduce((best, worker) => {
      if (worker.matches.size !== best.matches.size) {
        return worker.matches.size < best.matches.size ? worker : best;
      }
      return worker.routes.size < best.routes.size ? worker : best;
    });
  }

  noteMember(worker, matchId, delta) {
    const count = (worker.matches.get(matchId) ?? 0) + delta;
    if (count > 0) worker.matches.set(matchId, count);
    else worker.matches.delete(matchId);
  }

  /**
   * How the load is spread: matches and members per worker, and how busy each
   * worker's event loop was since the last time this was asked.
   */
  distribution() {
    return this.workers.map((worker) => {
      const now = worker.alive ? worker.thread.performance.eventLoopUtilization() : null;
      const busy = now && worker.lastUtilization
        ? worker.thread.performance.eventLoopUtilization(now, worker.lastUtilization).utilization
        : now?.utilization ?? 0;
      worker.lastUtilization = now;
      return {
        index: worker.index,
        alive: worker.alive,
        matches: worker.matches.size,
        members: worker.routes.size,
        busy,
      };
    });
  }

  reportLoad() {
    const spread = this.distribution();
    if (!spread.some((worker) => worker.members > 0 || worker.busy > 0.01)) return;
    const now = performance.eventLoopUtilization();
    const main = this.lastMainUtilization
      ? performance.eventLoopUtilization(now, this.lastMainUtilization).utilization
      : now.utilization;
    this.lastMainUtilization = now;
    info(
      `match workers: main ${Math.round(main * 100)}% busy | ` +
        spread
          .map((worker) =>
            `#${worker.index}${worker.alive ? "" : " (down)"} ${worker.matches} matches ` +
              `${worker.members} players ${Math.round(worker.busy * 100)}% busy`
          )
          .join(" | ")
    );
  }

  // --- Messages from a worker ---------------------------------------------------------

  onMessage(worker, message) {
    switch (message?.t) {
      case "out":
        return this.writeStreams(worker, message);
      case "ready":
        worker.started = true;
        clearTimeout(worker.startupTimer);
        return worker.ready.resolve(worker);
      case "release":
        return this.releaseLease(worker, message.accountId);
      case "unlock":
        return this.returnLock(message.token);
      case "presence": {
        const route = this.routeOf(worker, message);
        if (route) setPresenceLocation(route.session, message.mapNodeId);
        return undefined;
      }
      case "match":
        return this.updateMatch(message);
      case "friendship":
        return friendshipChanged(message.first, message.second, message.made === true);
      default:
        return warn(`match worker ${worker.index}: unknown message ${message?.t}`);
    }
  }

  routeOf(worker, { sid, gen }) {
    const route = worker.routes.get(sid);
    return route && route.gen === gen ? route : null;
  }

  /**
   * Writes one flush of a worker's output.
   *
   * Frames are views into the one transferred buffer, so nothing is copied on
   * this side. A stream whose generation is no longer the session's current one
   * belongs to a run the session has left; its frames are dropped and only its
   * markers still count.
   */
  writeStreams(worker, { buffer, streams, acks = [], doid }) {
    if (doid > worker.highestDoid) worker.highestDoid = doid;
    for (const [sid, gen, packets, bytes] of acks) {
      const route = this.routeOf(worker, { sid, gen });
      if (!route) continue;
      route.forwardedPackets = Math.max(0, route.forwardedPackets - packets);
      route.forwardedBytes = Math.max(0, route.forwardedBytes - bytes);
      updateForwardedFlow(route);
    }
    let at = 0;
    const written = [];
    for (const [sid, gen, items] of streams) {
      let bytes = 0;
      const route = this.routeOf(worker, { sid, gen });
      const session = route?.session;
      const socket = session?.socket;
      const corked = typeof socket?.cork === "function" && items.length > 1;
      if (corked) socket.cork();
      try {
        for (const item of items) {
          if (typeof item === "number") {
            const frame = Buffer.from(buffer, at, item);
            at += item;
            bytes += item;
            if (!route) continue;
            trackObject(route, frame);
            if (!session.closed) session.send(frame);
            continue;
          }
          this.control(worker, route, { sid, gen }, item);
        }
      } finally {
        if (corked) socket.uncork?.();
      }
      if (bytes) written.push([sid, gen, bytes]);
    }
    if (written.length) this.acknowledgeOutput(worker, written);
  }

  /**
   * Tells a worker its frames are out of the queue between the threads and in
   * the sockets, where the socket's own bound takes over. One message per flush.
   */
  acknowledgeOutput(worker, written) {
    if (worker.alive) worker.channel.post({ t: "written", acks: written });
  }

  control(worker, route, { sid, gen }, marker) {
    switch (marker?.c) {
      case "ready":
        return route?.onPlayerReady?.();
      case "joined":
        if (route) route.entered = true;
        return route?.joined.resolve({ lateJoin: marker.lateJoin });
      case "failed":
        return route?.joined.reject(new Error(`match worker ${worker.index}: ${marker.message}`));
      case "left": {
        const leaving = route ?? worker.routes.get(sid);
        if (leaving?.gen === gen) returnStrikes(leaving.session, marker.strikes);
        return this.settleLeft(worker, leaving, gen);
      }
      case "close":
        return route?.session.close?.(marker.why, { flush: marker.flush });
      case "terminate":
        return route?.session.close?.(`security policy: ${marker.reason}`);
      default:
        return warn(`match worker ${worker.index}: unknown marker ${marker?.c}`);
    }
  }

  settleLeft(worker, route, gen) {
    if (!route || route.gen !== gen) return;
    route.joined.reject(new Error("left the match before entering it"));
    route.joined.promise.catch(() => {});
    if (worker.routes.get(route.session.id) === route) worker.routes.delete(route.session.id);
    if (route.session.matchRoute === route) delete route.session.matchRoute;
    route.session.pauseForWorker?.(false);
    this.noteMember(worker, route.matchId, -1);
    route.left.resolve(true);
  }

  updateMatch({ id, floorIndex, state }) {
    const match = this.registry.matches.get(Number(id));
    if (!match) return;
    if (floorIndex !== undefined) match.floorIndex = floorIndex;
    if (state === "finished") this.registry.finish(match);
    else if (state === "failed" && match.state !== "closed") match.state = "failed";
  }

  // --- Calls from a worker --------------------------------------------------------------

  handleCall(worker, op, args) {
    switch (op) {
      case "lease":
        return this.lease(worker, args);
      case "lock":
        return this.borrowLock(worker, args);
      case "patch":
        return this.patchHeld(worker, args);
      case "account": {
        // A worker reading an account it does not hold: the live copy, if the
        // account is in a dungeon on another worker; storage otherwise.
        const owner = this.ownerOf(args);
        if (!owner || owner === worker) return null;
        return owner.channel.call("account", args).catch(() => null);
      }
      case "market":
        return invalidateMarketBrowse();
      case "objectId":
        return nextObjectIdAbove(args);
      case "recordRuns":
        return recordRuns(args);
      case "say":
        return this.sayEverywhere(args);
      case "door": {
        const route = this.routeOf(worker, args);
        if (!route) return false;
        return this.walkThrough(route.session, args.destination);
      }
      default:
        throw new Error(`unknown match worker call ${op}`);
    }
  }

  /**
   * Hands an account to the worker whose dungeon is starting with it.
   *
   * Read under this thread's lock for the account, so an RPC already changing
   * it finishes first and its change is in what the worker receives; from the
   * moment the lease is recorded every later RPC is sent to the worker instead.
   * An account still leased to another worker — a player who walked out of one
   * dungeon and straight into another — waits for that lease to come back.
   */
  async lease(worker, accountId) {
    const id = Number(accountId);
    const deadline = Date.now() + LEASE_HANDOVER_TIMEOUT_MS;
    for (;;) {
      // Decided entirely under the account's lock: looked at outside it, two
      // workers asking in the same turn both saw it free and both got a copy.
      const outcome = await withThreadAccountLock(id, async () => {
        const current = this.leases.get(id);
        if (current && !current.worker.alive) this.releaseLease(current.worker, id);
        const holder = this.leases.get(id);
        // Already this worker's: a second member of the same account there. It
        // holds the object; nothing needs sending.
        if (holder?.worker === worker) return { account: null };
        if (holder) return { wait: holder };
        const account = await loadAccount(id);
        // Died while the account was being read: recording the lease now would
        // leave it with nobody, and every later call for the account waiting on it.
        if (!worker.alive) throw new Error(`match worker ${worker.index} is gone`);
        this.leases.set(id, { worker, released: deferred() });
        return { account };
      });
      if (!outcome.wait) return outcome.account;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`account ${id} is still leased to match worker ${outcome.wait.worker.index}`);
      }
      await Promise.race([
        outcome.wait.released.promise,
        new Promise((resolve) => setTimeout(resolve, remaining).unref?.()),
      ]);
    }
  }

  releaseLease(worker, accountId) {
    const id = Number(accountId);
    const lease = this.leases.get(id);
    if (!lease || lease.worker !== worker) return;
    this.leases.delete(id);
    lease.released.resolve();
  }

  ownerOf(accountId) {
    const worker = this.leases.get(Number(accountId))?.worker;
    return worker?.alive ? worker : null;
  }

  /** A worker working on an account it does not hold takes this thread's lock for it. */
  /**
   * A worker's transaction needs an account it does not hold. In town, the lock
   * is this thread's. In a dungeon on another worker, that worker takes its own
   * lock for it and sends a copy of the live object; the borrower's changes go
   * back as a patch (see match-worker-thread.js). A lease that is handed back
   * while this is being arranged falls through to the town case.
   */
  async borrowLock(worker, accountId) {
    const id = Number(accountId);
    for (;;) {
      const lease = this.leases.get(id);
      if (!lease?.worker.alive) return this.borrowTownLock(worker, id);
      if (lease.worker === worker) throw new AccountLeasedError(id, worker.index);
      const token = this.nextLockToken++;
      const snapshot = await lease.worker.channel.call("hold", { token, id });
      if (snapshot) {
        if (!worker.alive) {
          lease.worker.channel.post({ t: "unhold", token });
          throw new Error(`match worker ${worker.index} is gone`);
        }
        this.borrowedLocks.set(token, { worker, holder: lease.worker, release: () => {} });
        return { token, snapshot };
      }
      await lease.released.promise;
    }
  }

  borrowTownLock(worker, id) {
    return new Promise((granted, refused) => {
      withThreadAccountLock(id, () => {
        // Died while waiting its turn: the lock goes straight back.
        if (!worker.alive) {
          refused(new Error(`match worker ${worker.index} is gone`));
          return undefined;
        }
        return new Promise((release) => {
          const token = this.nextLockToken++;
          this.borrowedLocks.set(token, { worker, release });
          granted({ token });
        });
      }).catch(refused);
    });
  }

  returnLock(token) {
    const borrowed = this.borrowedLocks.get(token);
    if (!borrowed) return;
    this.borrowedLocks.delete(token);
    borrowed.release();
    if (borrowed.holder?.alive) borrowed.holder.channel.post({ t: "unhold", token });
  }

  /** A borrower's changes to an account held on another worker, passed on to it. */
  patchHeld(worker, { token, changes, before }) {
    const borrowed = this.borrowedLocks.get(token);
    if (!borrowed?.holder || borrowed.worker !== worker) {
      throw new Error(`match worker ${worker.index} holds no lock ${token} on another worker`);
    }
    if (!borrowed.holder.alive) throw new Error(`match worker ${borrowed.holder.index} is gone`);
    return borrowed.holder.channel.call("patch", { token, changes, before });
  }

  async sayEverywhere({ account, name, text, sid }) {
    const answers = await Promise.allSettled(
      this.workers
        .filter((worker) => worker.alive)
        .map((worker) => worker.channel.call("say", { account, name, text }))
    );
    const heard = answers.reduce(
      (sum, answer) => sum + (answer.status === "fulfilled" ? Number(answer.value) || 0 : 0),
      0
    );
    info(`[${sid ?? "?"}] global: ${name}: ${text} (${heard} heard)`);
    return heard;
  }

  // --- RPCs for leased accounts -------------------------------------------------------

  /**
   * Runs an RPC on the worker holding its account. `own` marks a call sent for
   * its own account, which the worker may answer with "not any more"; it is
   * then dispatched again here, where the returned lease now is.
   */
  async forwardRpc(worker, { service, method, params, accountId, own }) {
    const answer = await worker.channel.call("rpc", { service, method, params, accountId, own });
    if (answer?.retry) return dispatch(service, method, params, null);
    return answer?.value;
  }

  // --- Lifecycle ------------------------------------------------------------------------

  /**
   * Stops one worker as a crash would, for an operator — to take a misbehaving
   * one out, or to see that its players really are sent home and replaced.
   * Everything after is the ordinary recovery.
   */
  restartWorker(index) {
    const worker = this.workers[Number(index)];
    if (!worker) return { error: "no such worker" };
    if (!worker.alive) return { error: "that worker is not running" };
    const players = worker.routes.size;
    warn(`match worker ${worker.index}: restart asked for, with ${players} player(s) on it`);
    void worker.thread.terminate();
    return { index: worker.index, players, matches: worker.matches.size };
  }

  /** A worker's drain, or the end of the wait for it — whichever comes first. */
  async drainWithin(worker) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve("late"), this.drainTimeoutMs);
    });
    try {
      const outcome = await Promise.race([worker.channel.call("drain"), late]);
      if (outcome === "late") {
        error(`match worker ${worker.index} did not settle in ${this.drainTimeoutMs} ms; stopping it anyway`);
      }
    } catch (problem) {
      warn(`match worker ${worker.index} could not settle: ${problem.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.loadReport);
    clearInterval(this.watchdog);
    for (const timer of this.respawnTimers) clearTimeout(timer);
    this.respawnTimers.clear();
    await Promise.allSettled(
      this.workers
        .filter((worker) => worker.alive && worker.started)
        .map((worker) => this.drainWithin(worker))
    );
    for (const token of [...this.borrowedLocks.keys()]) this.returnLock(token);
    await Promise.allSettled(this.workers.map((worker) => worker.thread.terminate()));
    return true;
  }
}

/**
 * Notes what a frame creates or takes down on the client, so a worker that dies
 * can have its objects taken down for it. Two bytes of opcode per frame.
 * (A doid here can be an account id — the player object's is — so the dead
 * worker's high-water mark comes from the worker itself, not from these.)
 */
const trackObject = (route, frame) => {
  if (frame.length < 8) return;
  switch (frame.readUInt16LE(2)) {
    case OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP:
    case OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_RESP: {
      if (frame.length < 18) return;
      const doid = frame.readUInt32LE(14);
      route.objects.set(doid, { clid: frame.readUInt16LE(12), owner: false });
      return;
    }
    case OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP: {
      if (frame.length < 10) return;
      const doid = frame.readUInt32LE(6);
      route.objects.set(doid, { clid: frame.readUInt16LE(4), owner: true });
      return;
    }
    case OP.CLIENT_OBJECT_DISABLE_RESP:
    case OP.CLIENT_OBJECT_DISABLE_OWNER_RESP:
    case OP.CLIENT_OBJECT_DELETE_RESP:
      route.objects.delete(frame.readUInt32LE(4));
      return;
    default:
  }
};

/**
 * The MatchMaker's view of workers: join, leave, and whether a packet belongs
 * to a dungeon running elsewhere. Same contract as LocalMatchExecutor.
 */
export class WorkerMatchExecutor {
  constructor(pool, { registry = dungeonMatches } = {}) {
    this.pool = pool;
    this.registry = registry;
  }

  async join(session, result, request, options = {}) {
    const match = result?.match;
    if (!match) throw new Error("joinDungeonMatch needs an admitted match");
    // A door leaves one match and joins the next. The next may be on another
    // worker, so its first frame must wait until the old one's last has landed.
    const previous = session.matchRoute;
    if (previous) {
      if (!previous.leaving) this.leave(session, { notifyClient: true });
      await previous.left.promise;
    }
    if (session.closed) throw new Error(`session ${session.id} closed before entering match ${match.id}`);

    const worker = this.pool.workerFor(match);
    const gen = (session.matchGeneration ?? 0) + 1;
    session.matchGeneration = gen;
    const route = {
      worker,
      gen,
      session,
      matchId: match.id,
      onPlayerReady: options.onPlayerReady,
      joined: deferred(),
      left: deferred(),
      leaving: false,
      entered: false,
      /** doid -> { clid, owner } for everything the client holds from this run. */
      objects: new Map(),
      /** Forwarded and not yet reported handled; see MAX_FORWARDED_*. */
      forwardedPackets: 0,
      forwardedBytes: 0,
    };
    worker.routes.set(session.id, route);
    session.matchRoute = route;
    this.pool.noteMember(worker, match.id, 1);
    worker.channel.post({
      t: "join",
      sid: session.id,
      gen,
      member: memberSnapshot(session),
      match: matchSnapshot(match),
      privileged: match.privilegedMembers?.has(session) === true,
      request: requestSnapshot(request),
    });
    return route.joined.promise;
  }

  /**
   * Leaves at once as far as this thread is concerned — out of the registry,
   * no more packets forwarded — and resolves when the worker has sent the last
   * frame of the run, which is when ClientExitComplete may follow.
   */
  leave(session, { notifyClient = false } = {}) {
    const route = session?.matchRoute;
    if (!route) {
      if (session) this.registry.remove(session);
      return Promise.resolve(false);
    }
    if (route.leaving) return route.left.promise;
    route.leaving = true;
    this.registry.remove(session);
    if (!route.worker.alive) {
      this.pool.settleLeft(route.worker, route, route.gen);
      return route.left.promise;
    }
    route.worker.channel.post({
      t: "leave",
      sid: session.id,
      gen: route.gen,
      notify: notifyClient === true,
      closed: session.closed === true,
    });
    return route.left.promise;
  }

  /**
   * Sends a dungeon packet to the worker running this session's match, if there
   * is one. Still true while the session is leaving: until the run's last frame
   * the dungeon owns its packets, as it does in one thread while RequestExit
   * waits for the reward to be written.
   */
  forward(session, body) {
    const route = session?.matchRoute;
    if (!route || !route.worker.alive) return false;
    if (
      route.forwardedPackets >= MAX_FORWARDED_PACKETS ||
      route.forwardedBytes + body.length > MAX_FORWARDED_BYTES
    ) {
      noteViolation(
        session,
        RULE.trafficRate,
        `${route.forwardedPackets} packets / ${route.forwardedBytes} bytes waiting on match worker ${route.worker.index}`
      );
      session.close?.("queue saturated");
      return true;
    }
    route.forwardedPackets += 1;
    route.forwardedBytes += body.length;
    updateForwardedFlow(route);
    // A copy of exactly this packet: the body is a view into a larger socket
    // chunk, and sending the view would clone the whole chunk.
    const copy = new Uint8Array(body);
    route.worker.channel.post({ t: "packet", sid: session.id, gen: route.gen, body: copy }, [copy.buffer]);
    return true;
  }
}

/**
 * Installs everything the main thread needs to run matches in `pool`: the
 * executor, the account policy, RPC forwarding and presence copies. Returns a
 * function that puts the single-thread behaviour back.
 */
export const installWorkerPool = (pool, { installExecutor }) => {
  const executor = new WorkerMatchExecutor(pool, { registry: pool.registry });
  const restoreExecutor = installExecutor(executor);
  const previousOwnership = installAccountOwnership({
    lock: (id, work, local) => {
      const owner = pool.ownerOf(id);
      if (owner) throw new AccountLeasedError(id, owner.index);
      return local(id, work);
    },
    inPlayElsewhere: (id) => Boolean(pool.ownerOf(id)),
    load: async (id) => {
      const owner = pool.ownerOf(id);
      if (!owner?.alive) return null;
      return owner.channel.call("account", id).catch(() => null);
    },
    beforeSave: (ids) => {
      for (const id of ids) {
        const owner = pool.ownerOf(id);
        if (owner) throw new AccountLeasedError(id, owner.index);
      }
    },
  });
  const previousForwarder = installRpcForwarder({
    ownerOf: (accountId) => pool.ownerOf(accountId),
    forward: (owner, service, method, params, { accountId, own }) => {
      const worker = typeof owner === "number" ? pool.workers[owner] : owner;
      if (!worker?.alive) throw new Error(`match worker ${owner} is not running`);
      return pool.forwardRpc(worker, { service, method, params, accountId, own });
    },
  });
  const previousOperations = installAccountOperationForwarder((owner, name, args) => {
    const worker = typeof owner === "number" ? pool.workers[owner] : owner;
    if (!worker?.alive) throw new Error(`match worker ${owner} is not running`);
    return worker.channel.call("op", { name, args });
  });
  const previousObserver = observePresence((accountId, where) => {
    for (const worker of pool.workers) {
      if (worker.alive) worker.channel.post({ t: "presence", accountId, where });
    }
  });
  return () => {
    installExecutor(restoreExecutor);
    installAccountOwnership(previousOwnership);
    installRpcForwarder(previousForwarder);
    installAccountOperationForwarder(previousOperations);
    observePresence(previousObserver);
  };
};

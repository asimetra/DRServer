/**
 * A match worker: whole dungeons, run in their own thread.
 *
 * The main thread keeps every socket, login, the MatchMaker and presence. When
 * it admits a player to a match assigned here it sends `join`; from then on it
 * forwards that player's dungeon packets, and writes back — in order — the
 * frames this thread produces for them. Everything between is the ordinary
 * dungeon code, unchanged: `joinDungeonMatch`, `handleGameplayField` and
 * `leaveDungeonSession` run against a member object that looks to them exactly
 * like a connection, except that its `send` fills an outbox instead of a
 * socket.
 *
 * What the dungeon asks of the server around it goes through the match host
 * (match-host.js), which here turns each request into a message to the main
 * thread. The one thing kept here instead is the account: a player's account
 * is leased to this worker for the length of the run, so the live object the
 * run changes, the saves that write it and the RPCs that act on it all happen
 * in one thread, as they would without workers.
 */
import { parentPort, workerData } from "node:worker_threads";

import { config } from "../config.js";
import { error, info, warn } from "../log.js";
import {
  accountWritesSettled,
  closeAccountStorage,
  installAccountOwnership,
  loadAccount,
  nextObjectId,
  saveAccount,
  waitForAccountWrites,
  withThreadAccountLock,
} from "../accounts.js";
import { heldAccount, holdAccount, releaseAccount } from "../account-registry.js";
import { dispatch } from "../rpc.js";
import "../rpc-handlers.js";
import { runAccountOperation } from "../account-operations.js";
// Their account operations, so a transaction sent here by name finds them.
import { observeMarketWrites } from "../market.js";
import "../trade.js";
import { MalformedPacketError, PacketReader } from "./packet.js";
import { MemberSession } from "./member-session.js";
import { installMatchHost } from "./match-host.js";
import { joinDungeonMatch, leaveDungeonSession } from "./match-runtime.js";
import { handleGameplayField } from "./gameplay-fields.js";
import { dungeonMatches } from "./matches.js";
import { registerBuiltinCommands } from "./command-set.js";
import { createDistributedObjectIdAllocator } from "./doids.js";
import { deliverGlobalLine } from "./global-chat.js";
import { mirrorPresence } from "./presence.js";
import { RULE, flushViolations, noteViolation } from "./security-events.js";
import { createWorkerChannel, deferred } from "./worker-channel.js";

if (!parentPort) throw new Error("the match worker needs a parent port");

const workerIndex = Number(workerData?.index ?? 0);
const label = `match worker ${workerIndex}`;

/**
 * Doids from this worker's own lane of the id space. The main thread takes lane
 * zero; worker k takes lane k + 1, so no two threads can issue the same doid.
 */
const allocateFromLane = createDistributedObjectIdAllocator({
  start: Number(workerData?.start ?? 1000),
  offset: workerIndex + 1,
  stride: Number(workerData?.stride ?? workerIndex + 2),
  onLocalRangeSkipped: ({ from, to }) =>
    warn(`${label}: distributed object ids reached ${from}; skipped client-local range to ${to}`),
});

/** The highest doid issued so far, reported with every flush for a replacement to start above. */
let highestIssued = 0;
const allocateDistributedObjectId = () => {
  highestIssued = allocateFromLane();
  return highestIssued;
};

// --- The outbox --------------------------------------------------------------

/**
 * Frames and control markers per member, in the order they were produced.
 *
 * Flushed once per turn of the event loop as one message: every frame goes into
 * one freshly allocated buffer whose memory is transferred rather than copied,
 * and each member's list says how long each frame is, with control markers —
 * "the owner player exists", "joined", "left" — in their place between them.
 * The main thread walks the lists in the same order, which is what keeps a
 * MatchMaker answer between the frames it has to sit between.
 */
const pendingStreams = new Map();
let pendingBytes = 0;
let flushScheduled = false;

/**
 * Packets handled since the last flush, per member, reported back so the main
 * thread knows how much it has forwarded that is still waiting here. That is
 * what lets it keep the socket layer's per-session backlog bound, which a
 * forwarded packet would otherwise escape: the main thread's own queue empties
 * the moment a packet is handed on.
 */
const pendingAcks = new Map();

const acknowledge = (member, bytes) => {
  const ack = pendingAcks.get(member);
  if (ack) {
    ack.packets += 1;
    ack.bytes += bytes;
  } else {
    pendingAcks.set(member, { packets: 1, bytes });
  }
  scheduleFlush();
};

const streamFor = (member) => {
  let stream = pendingStreams.get(member);
  if (!stream) {
    stream = { sid: member.id, gen: member.generation, items: [] };
    pendingStreams.set(member, stream);
  }
  return stream;
};

const scheduleFlush = () => {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(flushOutbox);
};

/**
 * The socket's own output bound, kept from here: what a session has been sent
 * and the main thread has not yet reported written counts against the same
 * limit as a socket's buffer. Without it the message queue between the threads
 * would be the one place a session's output could pile up without limit — a
 * main thread that fell behind would never see it until it was too late.
 */
const enqueueFrame = (member, frame) => {
  if (member.outputSaturated) return false;
  member.unwritten = (member.unwritten ?? 0) + frame.length;
  if (member.unwritten > config.maxOutboundBufferBytes) {
    member.outputSaturated = true;
    warn(
      `${label}: [${member.id}] outbound buffer saturated: ` +
        `${member.unwritten} bytes not yet written > ${config.maxOutboundBufferBytes}`
    );
    enqueueControl(member, { c: "close", why: "outbound buffer saturated", flush: false });
    return false;
  }
  streamFor(member).items.push(frame);
  pendingBytes += frame.length;
  scheduleFlush();
  return true;
};

/** The main thread wrote what it was sent; it no longer counts against the bound. */
const outputWritten = (acks) => {
  for (const [sid, gen, bytes] of acks ?? []) {
    const member = current({ sid, gen });
    if (member) member.unwritten = Math.max(0, (member.unwritten ?? 0) - bytes);
  }
};

/** Control markers are delivered even for a closed member: they are how it ends. */
const enqueueControl = (member, control) => {
  streamFor(member).items.push(control);
  scheduleFlush();
};

function flushOutbox() {
  flushScheduled = false;
  if (!pendingStreams.size && !pendingAcks.size) return;
  const streams = [...pendingStreams.values()];
  pendingStreams.clear();
  const buffer = new ArrayBuffer(pendingBytes);
  const bytes = new Uint8Array(buffer);
  pendingBytes = 0;
  let at = 0;
  const encoded = streams.map(({ sid, gen, items }) => [
    sid,
    gen,
    items.map((item) => {
      if (!(item instanceof Uint8Array)) return item;
      bytes.set(item, at);
      at += item.length;
      return item.length;
    }),
  ]);
  const acks = [...pendingAcks].map(([member, { packets, bytes }]) => [
    member.id,
    member.generation,
    packets,
    bytes,
  ]);
  pendingAcks.clear();
  parentPort.postMessage({ t: "out", buffer, streams: encoded, acks, doid: highestIssued }, [buffer]);
}

// --- Talking to the main thread -------------------------------------------------

const members = new Map();

const channel = createWorkerChannel({
  port: parentPort,
  beforePost: flushOutbox,
  handle: (op, args) => {
    switch (op) {
      case "rpc":
        return runForwardedRpc(args);
      case "op":
        return runAccountOperation(args.name, args.args, { forwarded: true });
      case "hold":
        return holdForElsewhere(args);
      case "patch":
        return patchForElsewhere(args);
      case "account":
        return liveForElsewhere(Number(args));
      case "ping":
        return true;
      case "say":
        return deliverGlobalLine(args, [...members.values()].filter((member) => !member.closed));
      case "drain":
        return drain();
      default:
        throw new Error(`${label}: unknown call ${op}`);
    }
  },
  onMessage: (message) => {
    try {
      return handleMessage(message);
    } catch (problem) {
      // One message this thread cannot handle must not take down every
      // dungeon on it. An entry that fails here fails like any other.
      error(`${label}: could not handle ${message?.t}: ${problem?.stack ?? problem}`);
      if (message?.t === "join") abandonJoin(message, problem);
      return undefined;
    }
  },
});
parentPort.on("message", channel.receive);

function handleMessage(message) {
  switch (message?.t) {
    case "join":
      return join(message);
    case "packet":
      return packet(message);
    case "leave":
      return leave(message);
    case "presence":
      return mirrorPresence(message.accountId, message.where);
    case "unhold":
      return releaseForElsewhere(message.token);
    case "written":
      return outputWritten(message.acks);
    case "presence.all":
      for (const [accountId, where] of message.entries ?? []) mirrorPresence(accountId, where);
      return undefined;
    default:
      return warn(`${label}: unknown message ${message?.t}`);
  }
}

// --- Accounts ---------------------------------------------------------------------

/**
 * Every save a member of this worker has queued, by account, so a lease is only
 * handed back once the account is written down. Filled from the member's own
 * `rewardSavePromise`, which is where every dungeon save announces itself.
 */
const pendingSaves = new Map();

const trackSave = (accountId, promise) => {
  if (!promise || typeof promise.then !== "function") return;
  const key = Number(accountId);
  const saves = pendingSaves.get(key) ?? new Set();
  pendingSaves.set(key, saves);
  saves.add(promise);
  const forget = () => {
    saves.delete(promise);
    if (!saves.size && pendingSaves.get(key) === saves) pendingSaves.delete(key);
  };
  promise.then(forget, forget);
};

/** Accounts whose last holder here has let go and whose lease is on its way back. */
const releasing = new Map();

/** Leases asked for and not yet answered, so a read meanwhile can wait for the object. */
const acquiring = new Map();

const acquireLease = async (accountId) => {
  const id = Number(accountId);
  await releasing.get(id);
  const held = heldAccount(id);
  if (held) return holdAccount(held);
  const asking = channel.call("lease", id);
  acquiring.set(id, asking);
  let account;
  try {
    account = await asking;
  } finally {
    if (acquiring.get(id) === asking) acquiring.delete(id);
  }
  // Another member here may have taken it while the lease was on its way.
  const live = heldAccount(id) ?? account;
  if (!live) throw new Error(`account ${id} is leased to this worker but nothing here holds it`);
  return holdAccount(live);
};

/**
 * The live object, for the main thread reading an account leased here. The
 * lease is recorded there before the object arrives here, so a read in that
 * gap waits for it; one mid-release waits for storage to be current instead.
 */
const liveForElsewhere = async (id) => {
  await acquiring.get(id)?.catch(() => {});
  // The object is held a microtask after the lease answer lands.
  await Promise.resolve();
  await releasing.get(id);
  return heldAccount(id) ?? null;
};

const releaseLease = (accountId) => {
  const id = Number(accountId);
  if (!releaseAccount(id)) return false;
  const handingBack = (async () => {
    // Saves announce themselves synchronously but start a turn later; one turn
    // is enough for every save queued by the teardown that got here to exist.
    await new Promise((resolve) => setImmediate(resolve));
    while (pendingSaves.has(id)) await Promise.allSettled([...pendingSaves.get(id)]);
    await accountWritesSettled(id);
  })()
    .catch((problem) => warn(`${label}: account ${id} writes failed before release: ${problem.message}`))
    .then(() => {
      // Held again meanwhile (a door on this worker): the lease stays here.
      if (!heldAccount(id)) channel.post({ t: "release", accountId: id });
    })
    .finally(() => {
      if (releasing.get(id) === handingBack) releasing.delete(id);
    });
  releasing.set(id, handingBack);
  return true;
};

/**
 * Accounts in a dungeon on another worker, locked from here: a copy of the live
 * object there, what each of its top-level fields held when the copy was made,
 * and the token that keeps the other worker's lock for it.
 */
const remoteCopies = new Map();

/** Copies of live objects on other workers, handed out for reading only. */
const readCopies = new WeakSet();

/** Field by field, as JSON, so a change is a difference in text. */
const fieldsOf = (account) =>
  new Map(Object.keys(account).map((key) => [key, JSON.stringify(account[key]) ?? null]));

/**
 * Sends what this worker changed on a copy to the worker holding the account.
 * Only the changed fields go, each with what it held before, and the holder
 * refuses if any of them has moved since — which nothing should have: its lock
 * has been held all along, and the fields these transactions touch (friends,
 * requests, gifts) are ones a dungeon never writes.
 */
const patchRemote = async (remote) => {
  const now = fieldsOf(remote.copy);
  const changes = [];
  const before = [];
  for (const key of new Set([...now.keys(), ...remote.baseline.keys()])) {
    const was = remote.baseline.get(key) ?? null;
    const is = now.get(key) ?? null;
    if (was === is) continue;
    changes.push([key, is]);
    before.push([key, was]);
  }
  if (!changes.length) return;
  await channel.call("patch", { token: remote.token, changes, before });
  remote.baseline = now;
};

/**
 * Locks for accounts this worker does not hold belong to whoever does: the main
 * thread for an account in town, another worker for one in a dungeon there. They
 * are borrowed for the length of the work. Without that, an RPC here and one
 * there could both read-modify-write the same account.
 */
installAccountOwnership({
  lock: async (id, work, local) => {
    await releasing.get(id);
    if (heldAccount(id)) return local(id, work);
    const grant = await channel.call("lock", id);
    if (grant.snapshot) {
      remoteCopies.set(id, { copy: grant.snapshot, baseline: fieldsOf(grant.snapshot), token: grant.token });
    }
    try {
      return await local(id, work);
    } finally {
      if (remoteCopies.get(id)?.token === grant.token) remoteCopies.delete(id);
      channel.post({ t: "unlock", token: grant.token });
    }
  },
  /**
   * Reading an account this worker does not hold. Under a borrowed lock it is
   * the working copy; otherwise, for one in a dungeon on another worker, a copy
   * of the live object there — newer than storage, as the live object would be
   * in one thread. Such a read copy may not be written back from here.
   */
  load: async (id) => {
    const working = remoteCopies.get(id)?.copy;
    if (working) return working;
    const elsewhere = await channel.call("account", id);
    if (elsewhere) readCopies.add(elsewhere);
    return elsewhere ?? null;
  },
  isRemoteCopy: (account) => remoteCopies.get(Number(account?.id))?.copy === account,
  divertSave: async (accounts) => {
    const here = [];
    for (const account of accounts) {
      if (readCopies.has(account)) {
        throw new Error(
          `${label}: account ${account.id} was read from another worker without its lock and cannot be written from here`
        );
      }
      const remote = remoteCopies.get(Number(account.id));
      if (remote?.copy === account) await patchRemote(remote);
      else here.push(account);
    }
    return here;
  },
  nextObjectIdAbove: (floor) => channel.call("objectId", floor),
});

/**
 * The other side: another worker has this worker's account locked. The lock is
 * this thread's own, so RPCs for the account wait here as they would for any
 * transaction; the copy it was given is the live object as it stands.
 */
const remoteHolds = new Map();

const holdForElsewhere = async ({ token, id }) => {
  await releasing.get(id);
  if (!heldAccount(id)) return null;
  return new Promise((granted, refused) => {
    withThreadAccountLock(id, () => {
      const live = heldAccount(id);
      if (!live) {
        granted(null);
        return undefined;
      }
      return new Promise((release) => {
        remoteHolds.set(token, { id, release });
        granted(live);
      });
    }).catch(refused);
  });
};

/**
 * The only fields another worker may write through a hold: who is a friend,
 * who asked to be, who is blocked. They carry no value, a dungeon never writes
 * them, and each side of such a change stands on its own — so applying it here,
 * apart from the other account's write, cannot leave value on one side only.
 * Anything else is refused whole, before any of it is applied.
 */
const FIELDS_WRITABLE_FROM_ELSEWHERE = new Set(["ingame_friends", "friend_requests", "ignore_friends"]);

const patchForElsewhere = async ({ token, changes, before }) => {
  const hold = remoteHolds.get(token);
  const live = hold && heldAccount(hold.id);
  if (!live) throw new Error(`${label}: no hold ${token} to write through`);
  const refused = changes.map(([key]) => key).filter((key) => !FIELDS_WRITABLE_FROM_ELSEWHERE.has(key));
  if (refused.length) {
    throw new Error(`${label}: account ${hold.id} cannot be changed from another worker: ${refused.join(", ")}`);
  }
  for (const [key, was] of before) {
    if ((JSON.stringify(live[key]) ?? null) !== was) {
      throw new Error(`${label}: account ${hold.id} field ${key} changed while locked elsewhere`);
    }
  }
  for (const [key, is] of changes) {
    if (is === null) delete live[key];
    else live[key] = JSON.parse(is);
  }
  await saveAccount(live);
  return true;
};

const releaseForElsewhere = (token) => {
  const hold = remoteHolds.get(token);
  if (!hold) return;
  remoteHolds.delete(token);
  hold.release();
};

/**
 * An RPC whose account is in a dungeon here.
 *
 * `own` says the call was sent because of its own account. If the run has
 * ended and the lease is on its way back, the answer is "ask again at home",
 * which the main thread does once the lease has arrived.
 */
const runForwardedRpc = async ({ service, method, params, accountId, own }) => {
  if (own) {
    await releasing.get(Number(accountId));
    if (!heldAccount(accountId)) return { retry: true };
  }
  return { value: await dispatch(service, method, params, null, { forwarded: true }) };
};

// --- The match host -----------------------------------------------------------------

const memberOf = (session) => session?.member ?? session;

/**
 * The copy of a match's record, reporting the two things the main thread's
 * registry decides admission by: how deep the run is and whether it failed.
 */
const adoptMatch = (details) => {
  const existing = dungeonMatches.matches.get(Number(details.id));
  if (existing) return existing;
  const match = dungeonMatches.adopt({
    id: details.id,
    mapNodeId: details.mapNodeId,
    group: details.group,
    privateMatch: details.private,
    floorIndex: details.floorIndex,
  });
  let floorIndex = match.floorIndex;
  let state = match.state;
  Object.defineProperties(match, {
    floorIndex: {
      enumerable: true,
      get: () => floorIndex,
      set: (value) => {
        if (value === floorIndex) return;
        floorIndex = value;
        channel.post({ t: "match", id: match.id, floorIndex });
      },
    },
    state: {
      enumerable: true,
      get: () => state,
      set: (value) => {
        if (value === state) return;
        state = value;
        channel.post({ t: "match", id: match.id, state });
      },
    },
  });
  return match;
};

installMatchHost({
  kind: "worker",
  acquireAccount: (accountId) => acquireLease(accountId),
  releaseAccount: (accountId) => releaseLease(accountId),
  loadAccount: (accountId) => loadAccount(accountId),
  saveAccount: (account) => saveAccount(account),
  nextObjectId: (account) => nextObjectId(account),
  setPresenceLocation: (session, mapNodeId) => {
    const member = memberOf(session);
    if (!member?.id) return;
    channel.post({ t: "presence", sid: member.id, gen: member.generation, mapNodeId: Number(mapNodeId) || 0 });
  },
  matchFinished: (match) => dungeonMatches.finish(match),
  recordRuns: (runs) => channel.call("recordRuns", runs.filter(Boolean)),
  sayGlobally: async (speaker, text) => {
    const member = memberOf(speaker);
    const account = Number(member?.accountId ?? 0);
    const name = speaker?.dungeonAccount?.name ?? `Player${account || "?"}`;
    return channel.call("say", { sid: member?.id, account, name, text });
  },
  walkThrough: (session, destination) => {
    const member = memberOf(session);
    return channel.call("door", { sid: member.id, gen: member.generation, destination });
  },
});

registerBuiltinCommands();

// A sale here changes the list the main thread serves; it is told to forget it.
observeMarketWrites(() => void channel.call("market").catch(() => {}));

// --- Members --------------------------------------------------------------------------

const createMember = ({ sid, gen, member: details }) => {
  const member = new MemberSession({
    id: sid,
    generation: gen,
    accountId: details.accountId,
    authenticated: true,
    matchMakerDoid: details.matchMakerDoid,
    presenceDoid: details.presenceDoid,
    matchMakerGroup: details.matchMakerGroup,
    objects: new Map(),
    actors: new Map(),
    closed: false,
    queue: [],
    draining: false,
    allocateDoid(clid) {
      const doid = allocateDistributedObjectId();
      if (clid !== undefined) this.objects.set(doid, clid);
      return doid;
    },
  });
  if (details.infiniteEpoch !== undefined) member.infiniteEpoch = details.infiniteEpoch;
  if (details.securityStrikes?.length) member.securityStrikes = new Map(details.securityStrikes);
  member.send = (frame) => {
    if (member.closed) return false;
    return enqueueFrame(member, frame);
  };
  member.close = (why, { flush = false } = {}) =>
    enqueueControl(member, { c: "close", why: String(why ?? "closed"), flush: Boolean(flush) });

  watchSaves(member);
  member.gone = deferred();
  return member;
};

/**
 * Every save of the run announces itself on `rewardSavePromise`, so the lease
 * waits for it. Leaving deletes the field — and this watcher with it — so a
 * second teardown installs it again first.
 */
const watchSaves = (member) => {
  let rewardSavePromise;
  Object.defineProperty(member, "rewardSavePromise", {
    configurable: true,
    enumerable: true,
    get: () => rewardSavePromise,
    set: (promise) => {
      rewardSavePromise = promise;
      trackSave(member.accountId, promise);
    },
  });
};

const join = (message) => {
  const previous = members.get(message.sid);
  if (previous && !previous.leaving) {
    // The main thread waits for a leave before joining again, so this is a
    // lost message rather than a door. The old run must not linger in a world.
    warn(`${label}: session ${message.sid} joined again before leaving generation ${previous.generation}`);
    previous.leaving = true;
    previous.closed = true;
    previous.queue.length = 0;
    finishLeaving(previous, false);
  }
  const match = adoptMatch(message.match);
  const member = createMember(message);
  members.set(message.sid, member);
  dungeonMatches.attach(match, member, { privileged: message.privileged === true });

  member.entry = (async () => {
    try {
      const result = await joinDungeonMatch(member, { match }, message.request, {
        onPlayerReady: () => enqueueControl(member, { c: "ready" }),
      });
      enqueueControl(member, { c: "joined", lateJoin: Boolean(result?.lateJoin) });
    } catch (problem) {
      enqueueControl(member, { c: "failed", message: problem?.stack ?? String(problem) });
    } finally {
      if (member.left) clearAfterEntry(member);
    }
  })();
};

/**
 * What an entry still in flight took after its member had already left.
 *
 * Leaving does not wait for an entry, and the entry carries on until it next
 * checks: by then it may have taken the account's lease, or a world. In one
 * thread the MatchMaker's own failure path leaves a second time and puts those
 * down; here that second leave never reaches the worker — the route ended with
 * the first — so it happens here, silently, since the client has been told
 * everything it is going to be.
 */
const clearAfterEntry = (member) => {
  watchSaves(member);
  try {
    leaveDungeonSession(member, { notifyClient: false });
  } catch (problem) {
    error(`${label}: [${member.id}] clearing an abandoned entry failed: ${problem?.stack ?? problem}`);
  }
};

/** A join that failed before its dungeon code ran: nothing of it may stay here. */
const abandonJoin = ({ sid, gen }, problem) => {
  const member = members.get(sid);
  if (member?.generation === gen) {
    member.closed = true;
    members.delete(sid);
    member.dungeonMatch && dungeonMatches.remove(member);
  }
  enqueueControl({ id: sid, generation: gen }, { c: "failed", message: problem?.stack ?? String(problem) });
};

const current = ({ sid, gen }) => {
  const member = members.get(sid);
  return member && member.generation === gen ? member : null;
};

/** One job at a time per member, in arrival order — the socket drain loop, here. */
const runQueue = async (member) => {
  if (member.draining) return;
  member.draining = true;
  try {
    while (member.queue.length) {
      const { run, bytes } = member.queue.shift();
      try {
        await run();
      } catch (problem) {
        if (problem instanceof MalformedPacketError) {
          noteViolation(member, RULE.malformedFrame, `${problem.message}`);
          member.queue.length = 0;
          member.close("truncated payload");
          return;
        }
        error(`${label}: [${member.id}] failed handling packet: ${problem?.stack ?? problem}`);
      } finally {
        if (bytes) acknowledge(member, bytes);
      }
      if (member.terminationRequested && !member.terminationSent) {
        member.terminationSent = true;
        member.queue.length = 0;
        enqueueControl(member, { c: "terminate", reason: member.terminationRequested.reason });
        return;
      }
    }
  } finally {
    member.draining = false;
  }
};

const handlePacket = (member, body) => {
  const reader = new PacketReader(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  reader.u16();
  const doid = reader.u32();
  const fieldId = reader.u16();
  return handleGameplayField(member, doid, fieldId, reader);
};

const packet = (message) => {
  const member = current(message);
  if (!member || member.closed) return;
  member.queue.push({ run: () => handlePacket(member, message.body), bytes: message.body.byteLength });
  void runQueue(member);
};

const finishLeaving = (member, notifyClient) => {
  if (member.left) return;
  member.left = true;
  try {
    leaveDungeonSession(member, { notifyClient });
  } catch (problem) {
    error(`${label}: [${member.id}] leave failed: ${problem?.stack ?? problem}`);
  }
  flushViolations(member);
  member.closed = true;
  member.queue.length = 0;
  member.gone.resolve();
  if (members.get(member.id) === member) members.delete(member.id);
  enqueueControl(member, { c: "left", strikes: [...(member.securityStrikes ?? [])] });
};

/**
 * Two ways out, as on the socket. A connection that closed is gone at once and
 * hears nothing more. A player asking to leave is answered in turn, after what
 * they sent before it and after their reward has been written down — which is
 * what RequestExit waits for without workers.
 */
const leave = (message) => {
  const member = current(message);
  if (!member) {
    // Nothing here under that generation: say so, or the main thread waits.
    enqueueControl({ id: message.sid, generation: message.gen }, { c: "left" });
    return;
  }
  if (member.leaving) return;
  member.leaving = true;
  if (message.closed) {
    member.closed = true;
    member.queue.length = 0;
    finishLeaving(member, false);
    return;
  }
  // In turn after what was sent before it, and then — as MatchMaker does in one
  // thread — the dungeon keeps handling whatever arrives while the reward is
  // written, and the run ends when the write lands.
  member.queue.push({
    bytes: 0,
    run: () => {
      Promise.resolve(member.rewardSavePromise)
        .catch((problem) =>
          warn(`${label}: [${member.id}] exiting after reward persistence failed: ${problem.message}`)
        )
        .then(() => finishLeaving(member, message.notify === true));
    },
  });
  void runQueue(member);
};

/** Everything settled and written, for a server that is stopping. */
const drain = async () => {
  const everyone = [...members.values()];
  for (const member of everyone) {
    if (!member.leaving) leave({ sid: member.id, gen: member.generation, closed: true });
  }
  // One already on its way out may be waiting for its reward to be written;
  // its own leave still has a save to queue, and storage must outlast it.
  await Promise.allSettled(everyone.map((member) => member.gone.promise));
  await Promise.allSettled(everyone.map((member) => member.entry));
  while (releasing.size) await Promise.allSettled([...releasing.values()]);
  await waitForAccountWrites();
  await closeAccountStorage();
  flushOutbox();
  return true;
};

process.on("unhandledRejection", (problem) =>
  error(`${label}: unhandled rejection: ${problem?.stack ?? problem}`)
);

info(`${label} ready`);
channel.post({ t: "ready" });

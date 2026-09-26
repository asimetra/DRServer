import net from "node:net";
import { config, invalidModes } from "../config.js";
import { tokenProblem } from "../auth.js";
import { error, info, singleLine, truncate, unimplemented, warn } from "../log.js";
import { CLID, DC_HASH, OP, opcodeName } from "./opcodes.js";
import { MalformedPacketError, PacketReader, drainFrames } from "./packet.js";
import { closeSessionCapture, recordReceived, recordSent } from "./capture.js";
import { heartbeat, logoutResponse, matchMakerGenerate } from "./objects.js";
import * as matchMaker from "./matchmaker.js";
import { matchExecutor } from "./match-runtime.js";
import { MemberSession } from "./member-session.js";
import { registerBuiltinCommands } from "./command-set.js";
import { RULE, flushViolations, noteTraffic, noteViolation } from "./security-events.js";
import {
  FLID_ADD_FRIENDS,
  enterPresence,
  handleAddFriends,
  leavePresence,
  presenceGenerate,
  sessionHolding,
  watchFriends,
} from "./presence.js";
import { listAccountIds, loadAccount } from "../accounts.js";
import { friendIdsOf } from "../social.js";
import { createDistributedObjectIdAllocator } from "./doids.js";
import { loadGameMaster } from "../gamemaster.js";
import { infiniteMapDetails } from "../infinite.js";
import { handleGameplayField } from "./gameplay-fields.js";

const MAX_LOGIN_VERSION_LENGTH = 128;

/** doids handed out to distributed objects; 0 means "no parent". */
const allocateDistributedObjectId = createDistributedObjectIdAllocator({
  // Lane zero of the id space when match workers take the others; see doids.js.
  stride: config.matchWorkerCount > 0 ? config.matchWorkerCount + 1 : 1,
  onLocalRangeSkipped: ({ from, to }) =>
    warn(`distributed object ids reached ${from}; skipped client-local range to ${to}`),
});

const describe = (session) =>
  `[${session.id}${session.accountId ? ` acct=${session.accountId}` : ""}]`;

/**
 * DcSocket.BuildPacketLogin:
 *   utf token, utf version, u32 dcHash, u32 4, u32 accountId,
 *   u32 networkId, u32 nodeRules
 */
const handleLogin = async (session, reader) => {
  if (session.authenticated) {
    warn(`${describe(session)} refused a second login on the same connection`);
    session.close?.("duplicate login", { flush: true });
    return;
  }

  const login = {
    token: reader.utf(),
    version: reader.utf(),
    dcHash: reader.u32(),
    constant: reader.u32(),
    accountId: reader.u32(),
    networkId: reader.u32(),
    nodeRules: reader.u32(),
  };

  if (login.version.length > MAX_LOGIN_VERSION_LENGTH) {
    warn(`[${session.id}] refused an oversized login version (${login.version.length} characters)`);
    session.close?.("invalid login version", { flush: true });
    return;
  }

  /**
   * One account, one session — noted here, acted on at the end.
   *
   * Two clients on one account is not a second player, it is one character
   * driven from two places. Each socket generates its own hero, its own doids
   * and its own dungeon while both write to the same stored account, so the
   * gold and inventory each is holding are divergent copies of one row and
   * whichever saves last wins. Presence is keyed by account and cannot hold
   * two answers either, so the friends panel is told whichever arrived last.
   */
  /**
   * The same pair the HTTP side checks, arriving the other way — the login
   * packet's first field is the token and its fifth is the account it claims.
   * Nothing below this depends on a name or a password, because the client has
   * neither: holding a token issued for this account is the whole claim.
   */
  const problem = config.authEnabled === false ? null : tokenProblem(login.accountId, login.token);
  if (problem) {
    warn(`[${session.id}] refused account ${login.accountId} — ${problem}`);
    session.close?.("invalid validation token", { flush: true });
    return;
  }

  const displaced = sessionHolding(login.accountId);
  session.completeAuthentication(login.accountId, login.token);
  // Claim the account before the first awaited content load. Otherwise two
  // sockets logging in together both observe "nobody here", then both become
  // present after GameMaster resolves and neither displaces the other.
  enterPresence(session);
  // The newcomer enters presence first, so closing the old socket cannot flash
  // the shared account offline between the two connections.
  if (displaced && displaced !== session) {
    info(`${describe(session)} displacing session ${displaced.id} on account ${login.accountId}`);
    displaced.send(logoutResponse(60, "Signed in from somewhere else."));
    displaced.close("signed in from somewhere else", { flush: true });
  }

  info(
    `${describe(session)} login version=${singleLine(login.version)} account=${login.accountId} ` +
      `networkId=${login.networkId} nodeRules=${login.nodeRules}`
  );

  if (login.dcHash !== DC_HASH) {
    warn(
      `${describe(session)} DcHash mismatch: client sent ${login.dcHash}, ` +
        `expected ${DC_HASH} — client and server protocol definitions differ`
    );
  }

  // The client cannot finish loading until the MatchMaker object exists.
  const doid = session.allocateDoid(CLID.MatchMaker);
  session.matchMakerDoid = doid;
  let infiniteDetails = [];
  try {
    infiniteDetails = infiniteMapDetails(await loadGameMaster());
    session.infiniteEpoch = infiniteDetails[0]?.epoch;
  } catch (problem) {
    warn(`${describe(session)} could not load Infinite details: ${problem.message}`);
  }
  if (session.closed) return;
  session.send(matchMakerGenerate(doid, infiniteDetails));
  info(`${describe(session)} generated MatchMaker doid=${doid}`);

  /**
   * And the object the friends panel reads its state off. `FriendInfo` asks
   * this for whether somebody is online and which dungeon they are in; none of
   * it comes from the friend list payload.
   */
  const presenceDoid = session.allocateDoid(CLID.PresenceManager);
  session.presenceDoid = presenceDoid;
  session.send(presenceGenerate(presenceDoid));

  /**
   * And then his friends, unasked. Last, because it is the only part that waits
   * on storage and nothing above it should be held up behind a disk read.
   */
  return tellHimAboutHisFriends(session);
};

/**
 * Reads the friend list off the account and hands it to presence.
 *
 * Failing here costs the friends panel its online dots and nothing else, so it
 * is logged rather than allowed to take the login down with it.
 */
const tellHimAboutHisFriends = async (session) => {
  try {
    /**
     * Only if there is already an account to read. `loadAccount` makes one for
     * any id it has not seen and writes it out, and a socket login has no
     * business creating an account as a side effect of wanting a friend list —
     * the RPC login has already made it by the time this runs. It also stops a
     * test that logs in with an invented id from leaving a row behind.
     */
    const known = new Set(await listAccountIds());
    if (!known.has(Number(session.accountId))) return;

    const friends = friendIdsOf(await loadAccount(session.accountId));
    if (!friends.length || session.closed) return;
    const watching = watchFriends(session, friends);
    info(`${describe(session)} watching ${watching} friend(s) for presence`);
  } catch (problem) {
    warn(`${describe(session)} could not read the friend list: ${problem.message}`);
  }
};

/** Echoes the client's timestamp so it can measure round-trip time. */
const handleHeartbeat = (session, reader) => {
  const timestamp = reader.utf();
  const problem = config.authEnabled === false
    ? null
    : tokenProblem(session.accountId, session.token);
  if (problem) {
    warn(`${describe(session)} token no longer valid — ${problem}`);
    session.close?.("validation token no longer valid", { flush: true });
    return;
  }
  session.send(heartbeat(timestamp));
};

/** DcNetworkClass.Prepare_FieldUpdate: u32 doid, u16 fieldId, then arguments. */
const handleFieldUpdate = (member, reader, body) => {
  const doid = reader.u32();
  const fieldId = reader.u16();

  if (doid === member.matchMakerDoid && matchMaker.handleField(member, fieldId, reader)) {
    return;
  }

  // Presence belongs to the connection. It is still held back while a late
  // join is replaying its floor, exactly as it was when it sat below the
  // activation check with the gameplay fields.
  if (doid === member.presenceDoid && fieldId === FLID_ADD_FRIENDS) {
    if (member.world && !member.world.isActiveMember(member)) return;
    return handleAddFriends(member.world?.contextFor(member) ?? member, reader);
  }

  // A dungeon running in a match worker gets its packets there, whole.
  if (matchExecutor.forward(member, body)) return undefined;
  return handleGameplayField(member, doid, fieldId, reader);
};

/**
 * How many packets a session may have waiting, and where reading resumes.
 *
 * The queue is the whole point of the ordering fix and would be a new place to
 * put unbounded memory if it had no ceiling. Honest play peaks at 144 packets
 * in a second and 78 a second sustained, so 256 waiting is already far more
 * than arrives while one is being handled.
 */
const MAX_QUEUED_PACKETS = 256;
const RESUME_QUEUE_AT = 64;

/**
 * And a ceiling in bytes, because a count is not a memory bound: 256 frames of
 * the maximum a `u16` can declare is about 16 MiB a session.
 */
const MAX_QUEUED_BYTES = 1 << 20;

let activeSocketCount = 0;
const activeSocketsByAddress = new Map();
const connectedSessions = new Set();

/** Every admitted game connection, including sockets still on the login screen. */
export const activeSocketSessions = () => [...connectedSessions];

const handlePacket = (session, body) => {
  const reader = new PacketReader(body);
  const opcode = reader.u16();

  switch (opcode) {
    case OP.CLIENT_LOGIN_DUNGEONBUSTER:
      return handleLogin(session, reader);
    case OP.CLIENT_HEART_BEAT:
      return handleHeartbeat(session, reader);
    case OP.CLIENT_OBJECT_UPDATE_FIELD:
      return handleFieldUpdate(session, reader, body);
    case OP.CLIENT_LOGOUT:
      info(`${describe(session)} logout requested`);
      return session.close("logout requested", { flush: true });
    default:
      if (!noteViolation(session, RULE.unknownOpcode, `${opcodeName(opcode)}`)) return undefined;
      return unimplemented(
        `socket ${opcodeName(opcode)}`,
        `${body.length} bytes ${truncate(body.toString("hex"))}`
      );
  }
};

let nextSessionId = 1;

export const onConnection = (socket) => {
  const remoteAddress = String(socket.remoteAddress ?? "unknown");
  const addressCount = activeSocketsByAddress.get(remoteAddress) ?? 0;
  if (
    activeSocketCount >= config.maxSocketConnections ||
    addressCount >= config.maxSocketConnectionsPerIp
  ) {
    warn(
      `socket refused from ${remoteAddress}: connection limit ` +
        `(global ${activeSocketCount}/${config.maxSocketConnections}, ` +
        `address ${addressCount}/${config.maxSocketConnectionsPerIp})`
    );
    socket.destroy();
    return null;
  }

  activeSocketCount += 1;
  activeSocketsByAddress.set(remoteAddress, addressCount + 1);
  let admissionReleased = false;
  const releaseAdmission = () => {
    if (admissionReleased) return;
    admissionReleased = true;
    activeSocketCount = Math.max(0, activeSocketCount - 1);
    const remaining = (activeSocketsByAddress.get(remoteAddress) ?? 1) - 1;
    if (remaining > 0) activeSocketsByAddress.set(remoteAddress, remaining);
    else activeSocketsByAddress.delete(remoteAddress);
  };
  socket.once("close", releaseAdmission);

  const session = new MemberSession({
    id: nextSessionId++,
    socket,
    accountId: null,
    authenticated: false,
    token: null,
    /**
     * doid -> class id for everything we generated. Relaying a message to an
     * object means knowing its class, because the same logical field has a
     * different id per class (ReceiveCombatResult is 160 on a hero, 144 on an
     * NPC).
     */
    objects: new Map(),
    /** doid -> mutable actor state (hit points) for things we can damage. */
    actors: new Map(),
    /** Packets waiting their turn, and whether the one loop is running. */
    queue: [],
    queuedBytes: 0,
    draining: false,
    closed: false,
    /**
     * Two independent reasons to stop reading, tracked apart.
     *
     * They shared raw `pause()` and `resume()` calls, so each cancelled the
     * other: a full write buffer paused the socket, then the queue drained
     * below its low mark and resumed it before the writable `drain` ever
     * arrived. The ordering queue silently switched off the slow-reader
     * protection it was added next to.
     */
    pausedForQueue: false,
    pausedForWrite: false,
    /** And a third with match workers: its dungeon packets waiting there. */
    pausedForWorker: false,
    allocateDoid(clid) {
      const doid = allocateDistributedObjectId();
      if (clid !== undefined) this.objects.set(doid, clid);
      return doid;
    },
    /**
     * Honours backpressure. `socket.write` returning false means the kernel
     * buffer is full and Node is now holding the rest in memory — ignoring that
     * is how a slow or deliberately unresponsive reader turns this server's
     * output into unbounded allocation. Reading stops until it drains, which
     * also stops us generating more to send.
     */
    send: (frame) => {
      if (session.closed || socket.destroyed) return false;
      const bufferedBytes = Number(socket.writableLength ?? 0);
      if (bufferedBytes + frame.length > config.maxOutboundBufferBytes) {
        warn(
          `${describe(session)} outbound buffer saturated: ` +
            `${bufferedBytes} + ${frame.length} > ${config.maxOutboundBufferBytes}`
        );
        closeSession("outbound buffer saturated");
        return false;
      }
      recordSent(session, frame);
      if (!socket.write(frame)) {
        session.pausedForWrite = true;
        updateReadFlow();
      }
      return true;
    },
  });

  let loginDeadline = null;
  let forceCloseDeadline = null;

  /**
   * Ends it, once, and stops the loop wherever it is.
   *
   * The close handler tears the dungeon down but the queue used to keep going:
   * a chunk holding a logout followed by ten more packets processed all ten
   * after the socket was gone, and after the violation counters had been
   * flushed.
   */
  const closeSession = (why, { flush = false } = {}) => {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(loginDeadline);
    loginDeadline = null;
    session.queue.length = 0;
    session.queuedBytes = 0;
    leavePresence(session);
    // `socket.end()` may wait indefinitely for a slow peer before emitting
    // close. Release the match/world now so a displaced or logging-out player
    // cannot keep a ghost room and all of its timers alive during that wait.
    matchExecutor.leave(session);
    buffered = Buffer.alloc(0);
    info(`${describe(session)} closing: ${why}`);
    /**
     * `destroy` drops anything Node is still holding, which is what a session
     * being cut off deserves. It is the wrong end for a session whose last
     * frame is the explanation of why it is ending: `end` sends what is queued
     * and then the FIN, and because these sockets are not half-open the reply
     * FIN destroys this side.
     */
    if (flush) {
      socket.end();
      if (!socket.destroyed) {
        forceCloseDeadline = setTimeout(() => {
          forceCloseDeadline = null;
          if (!socket.destroyed) socket.destroy();
        }, config.socketCloseGraceMs);
        forceCloseDeadline.unref?.();
      }
    } else {
      socket.destroy();
    }
  };

  /** So one session can end another — a second login on the same account. */
  session.close = closeSession;
  connectedSessions.add(session);
  socket.once("close", () => connectedSessions.delete(session));

  session.completeAuthentication = (accountId, token) => {
    session.accountId = accountId;
    session.token = token;
    session.authenticated = true;
    clearTimeout(loginDeadline);
    loginDeadline = null;
    socket.setTimeout?.(config.socketIdleTimeoutMs);
  };

  /** Reading runs only when neither reason to stop is active. */
  const updateReadFlow = () => {
    if (session.pausedForQueue || session.pausedForWrite || session.pausedForWorker) socket.pause();
    else socket.resume();
  };

  session.pauseForWorker = (paused) => {
    if (session.pausedForWorker === paused) return;
    session.pausedForWorker = paused;
    updateReadFlow();
  };

  info(`${describe(session)} connected from ${socket.remoteAddress}`);
  let buffered = Buffer.alloc(0);

  socket.setKeepAlive?.(true, 30_000);
  loginDeadline = setTimeout(() => {
    loginDeadline = null;
    if (!session.authenticated) closeSession("login timeout");
  }, config.socketLoginTimeoutMs);
  loginDeadline.unref?.();

  /**
   * One packet at a time, in the order it arrived.
   *
   * TCP delivers bytes in order and this threw that away: a handler was started
   * and the loop moved straight on to the next packet, so anything after the
   * first `await` interleaved. Two consequences, both reproducible:
   *
   * A hit whose choreography came first on the wire could reach `castAccepted`
   * before the choreography reached `noteCast`, and be refused for having no
   * cast behind it — honest damage dropped by the rule meant to protect it.
   *
   * And five proposals of a twenty-second cooldown in one chunk all read
   * `isOffCooldown` before any of them wrote one. Serially one is accepted;
   * concurrently all five were, Mana and all.
   *
   * A single drain loop per session fixes both, and costs nothing: the work was
   * always going to happen, it just happens in order now.
   */
  const drain = async () => {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.queue.length && !session.closed) {
        const body = session.queue.shift();
        session.queuedBytes -= body.length;
        try {
          await handlePacket(session, body);
        } catch (err) {
          /**
           * A read that ran off the end of the packet is a protocol fault, not
           * a bug in a handler: the frame was well formed at its length prefix
           * and did not carry what its opcode requires. There is nothing to
           * interpret, and 256 of them used to be 256 full stacks.
           */
          if (err instanceof MalformedPacketError) {
            noteViolation(session, RULE.malformedFrame, `${err.message}`);
            closeSession("truncated payload");
            return;
          }
          error(
            `${describe(session)} failed handling packet ` +
              `${truncate(body.toString("hex"))}: ${err.stack ?? err}`
          );
        }
        if (session.terminationRequested) {
          closeSession(`security policy: ${session.terminationRequested.reason}`);
          return;
        }
        // Checked again: the handler may have ended the session itself.
        if (session.closed) return;
        if (session.queue.length <= RESUME_QUEUE_AT) {
          session.pausedForQueue = false;
          updateReadFlow();
        }
      }
    } finally {
      session.draining = false;
    }
  };

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const { packets, rest, malformed } = drainFrames(buffered);
    buffered = rest;
    noteTraffic(session, packets.length);

    for (const body of packets) {
      recordReceived(session, body);
      session.queue.push(body);
      session.queuedBytes += body.length;
    }

    /**
     * Bounded, and the bound is enforced rather than reported. Reading stops
     * while the backlog drains, and a client that keeps it full past the
     * ceiling is not waiting for us — it is filling us.
     */
    if (session.queue.length > MAX_QUEUED_PACKETS || session.queuedBytes > MAX_QUEUED_BYTES) {
      noteViolation(
        session,
        RULE.trafficRate,
        `${session.queue.length} packets / ${session.queuedBytes} bytes queued`
      );
      closeSession("queue saturated");
      return;
    }
    if (session.queue.length > RESUME_QUEUE_AT) {
      session.pausedForQueue = true;
      updateReadFlow();
    }
    drain();

    /**
     * A length that cannot be a frame desynchronises the stream, and nothing
     * after it can be read — so the connection is ended rather than guessed at.
     * This is the audit's own "close immediately" category: malformed frame
     * length and parser underflow, which no honest client produces.
     */
    if (malformed) {
      noteViolation(session, RULE.malformedFrame, "declared frame length below an opcode");
      closeSession("malformed frame length");
    }
  });

  socket.on("drain", () => {
    session.pausedForWrite = false;
    updateReadFlow();
  });
  socket.on("error", (err) => warn(`${describe(session)} socket error: ${err.message}`));
  socket.on("timeout", () => closeSession("idle timeout"));
  socket.on("close", () => {
    clearTimeout(loginDeadline);
    clearTimeout(forceCloseDeadline);
    loginDeadline = null;
    forceCloseDeadline = null;
    socket.setTimeout?.(0);
    session.closed = true;
    session.queue.length = 0;
    session.queuedBytes = 0;
    leavePresence(session);
    matchExecutor.leave(session);
    // Whatever a rule was still counting goes out with the session, since the
    // tail is the part that says whether it fired once or constantly.
    flushViolations(session);
    closeSessionCapture(session).catch((problem) =>
      warn(`${describe(session)} could not close capture: ${problem.message}`)
    );
    info(`${describe(session)} disconnected`);
  });

  // Handed back so a test can dress the session the way a dungeon would and
  // then drive the dispatcher itself; nothing in the server reads it.
  return session;
};

export const start = () => {
  // Registered here rather than on import so a test can build its own registry
  // without the shipped commands already occupying the names.
  registerBuiltinCommands();
  const server = net.createServer(onConnection);
  server.maxConnections = config.maxSocketConnections;

  server.listen(config.gameSocketPort, config.host, () => {
    info(`game socket listening on ${config.host}:${config.gameSocketPort}`);
    // Said out loud, because "is this protecting anything" should not need a
    // reading of the source or a guess about which environment variable won.
    info(
      `enforcement: cast=${config.castMode} placement=${config.placementMode} ` +
        `reach=${config.reachMode}`
    );
    for (const spelling of invalidModes) {
      warn(`enforcement: "${spelling}" is not a mode — that rule is off`);
    }
  });

  return server;
};

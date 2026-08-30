import net from "node:net";
import { config, invalidModes } from "../config.js";
import { tokenProblem } from "../auth.js";
import { error, info, truncate, unimplemented, warn } from "../log.js";
import { CLID, DC_HASH, OP, opcodeName } from "./opcodes.js";
import { MalformedPacketError, PacketReader, PacketWriter, drainFrames } from "./packet.js";
import { closeSessionCapture, recordReceived, recordSent } from "./capture.js";
import { heartbeat, logoutResponse, matchMakerGenerate } from "./objects.js";
import * as matchMaker from "./matchmaker.js";
import { leaveDungeonSession } from "./match-runtime.js";
import { handleProposeCombatResults, FLID_PROPOSE_COMBAT_RESULTS } from "./combat.js";
import { handleProposeCreateNPC, FLID_PROPOSE_CREATE_NPC } from "./placeables.js";
import { collectNearby, FLID_HERO_POSITION } from "./pickups.js";
import { updateProximityTriggers } from "./triggers.js";
import { checkFloorExit } from "./dungeon.js";
import {
  FLID_PROPOSE_REVIVE,
  FLID_PROPOSE_SELF_REVIVE,
  handleProposeRevive,
  handleProposeSelfRevive,
} from "./revive.js";
import {
  FLID_PROPOSE_ATTACK_CHOREOGRAPHY,
  FLID_STOP_CHOREOGRAPHY,
  handleProposeAttackChoreography,
  remoteAttackChoreography,
  remoteStopChoreography,
} from "./buster.js";
import { isPlausiblePosition } from "./coordinates.js";
import { FLID_PLAYER_CHAT, FLID_PLAYER_TYPING, handleChat, handleTyping } from "./chat.js";
import {
  FLID_DROP_CHEST,
  FLID_OPEN_CHEST,
  FLID_TAKE_CHEST,
  handleDropChest,
  handleOpenChest,
  handleTakeChest,
} from "./summary-chests.js";
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
import {
  collisionPointOf,
  hasLineOfSight,
  isPositionBlocked,
  isOnAuthoredTile,
  segmentStaysOnAuthoredTiles,
} from "./navigation.js";

const FLID_HERO_HEADING = 148;
/** Bounds attacker-selected sampling work while covering every authored hero move. */
const MOVEMENT_WALL_AUDIT_MAX_DISTANCE = 1000;
const MOVEMENT_CREDIT_CAP = 1000;
const MOVEMENT_CREDIT_PER_MS = 1; // 1000 world units/second, above known buffed walking.
/**
 * One unexplained owner-position step may not exceed the game's own movement.
 * Captured native play tops out at 441 units and the largest authored player
 * auto-move is 800. Kept at 1000 for headroom; rejected for gameplay but never
 * treated as account/session proof because future movement grants may widen it.
 */
const MAX_UNGRANTED_MOVEMENT_STEP = 1000;

/** doids handed out to distributed objects; 0 means "no parent". */
let nextDoid = 1000;

const describe = (session) =>
  `[${session.id}${session.accountId ? ` acct=${session.accountId}` : ""}]`;

/**
 * DcSocket.BuildPacketLogin:
 *   utf token, utf version, u32 dcHash, u32 4, u32 accountId,
 *   u32 networkId, u32 nodeRules
 */
const handleLogin = (session, reader) => {
  const login = {
    token: reader.utf(),
    version: reader.utf(),
    dcHash: reader.u32(),
    constant: reader.u32(),
    accountId: reader.u32(),
    networkId: reader.u32(),
    nodeRules: reader.u32(),
  };

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
  const displaced = sessionHolding(login.accountId);

  session.accountId = login.accountId;

  info(
    `${describe(session)} login version=${login.version} account=${login.accountId} ` +
      `networkId=${login.networkId} nodeRules=${login.nodeRules}`
  );

  /**
   * The same pair the HTTP side checks, arriving the other way — the login
   * packet's first field is the token and its fifth is the account it claims.
   * Nothing below this depends on a name or a password, because the client has
   * neither: holding a token issued for this account is the whole claim.
   */
  const problem = config.authEnabled === false ? null : tokenProblem(login.accountId, login.token);
  if (problem) {
    warn(`${describe(session)} refused account ${login.accountId} — ${problem}`);
    session.close?.("invalid validation token", { flush: true });
    return;
  }

  if (login.dcHash !== DC_HASH) {
    warn(
      `${describe(session)} DcHash mismatch: client sent ${login.dcHash}, ` +
        `expected ${DC_HASH} — client and server protocol definitions differ`
    );
  }

  // The client cannot finish loading until the MatchMaker object exists.
  const doid = session.allocateDoid(CLID.MatchMaker);
  session.matchMakerDoid = doid;
  session.send(matchMakerGenerate(doid));
  info(`${describe(session)} generated MatchMaker doid=${doid}`);

  /**
   * And the object the friends panel reads its state off. `FriendInfo` asks
   * this for whether somebody is online and which dungeon they are in; none of
   * it comes from the friend list payload.
   */
  const presenceDoid = session.allocateDoid(CLID.PresenceManager);
  session.presenceDoid = presenceDoid;
  session.send(presenceGenerate(presenceDoid));
  enterPresence(session);

  /**
   * And only now is whoever was on this account put off it.
   *
   * After rather than before, and the order is the whole point. Closing him
   * first takes the account off the roll, so every friend watching is told he
   * went offline and then, a moment later, that he came back — the blink a
   * friends list shows when somebody reconnects. Letting the newcomer take the
   * account first means `leavePresence` finds it still held and says nothing.
   *
   * The newcomer wins rather than being refused, because the common case is a
   * reconnect: a client that crashed or lost its network leaves a socket this
   * server cannot tell is dead, and refusing would lock the player out of his
   * own account until it timed out.
   *
   * Code 60 is the one the client acts on. `Process_CLIENT_LOGOUT_RESP` calls
   * `unconfigureListeners` and enters the socket error state with the text, so
   * the displaced player is told what happened instead of watching a screen
   * that has quietly stopped. Every other code it merely logs.
   */
  if (displaced && displaced !== session) {
    info(`${describe(session)} displacing session ${displaced.id} on account ${login.accountId}`);
    displaced.send(logoutResponse(60, "Signed in from somewhere else."));
    displaced.close("signed in from somewhere else", { flush: true });
  }

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
  session.send(heartbeat(timestamp));
};

/** DcNetworkClass.Prepare_FieldUpdate: u32 doid, u16 fieldId, then arguments. */
const handleFieldUpdate = (member, reader) => {
  const doid = reader.u32();
  const fieldId = reader.u16();

  if (doid === member.matchMakerDoid && matchMaker.handleField(member, fieldId, reader)) {
    return;
  }

  // Gameplay state reads shared maps through the member's world context while
  // login, MatchMaker and socket lifecycle remain on the raw connection session.
  // Admission and snapshot activation are separate states. An owner may begin
  // sending position/attack fields as soon as its hero object exists, while
  // the rest of its floor is still being replayed. Processing those fields via
  // `contextFor(member)` would activate it implicitly and leak live traffic
  // before the ordered snapshot is complete.
  if (member.world && !member.world.isActiveMember(member)) return;
  const session = member.world?.contextFor(member) ?? member;

  if (doid === session.heroDoid && fieldId === FLID_HERO_POSITION) {
    // The hero broadcasts its position constantly; that stream is also how we
    // notice it has walked over something collectable.
    const position = { x: reader.f32(), y: reader.f32() };
    /**
     * A coordinate that is not a number is not a place.
     *
     * This one is worth refusing rather than counting, because it is about the
     * shape of the message and not about our reading of the game: no amount of
     * lag turns a position into NaN. The official client sent 34850 of them
     * across 54 captures, none non-finite, none past a million, and all inside
     * 0..8946 — a floor is ten tiles of nine hundred.
     *
     * Left unchecked it poisons everything downstream at once, since this is
     * the position pickups, proximity triggers, the floor exit, monster
     * targeting and the reach audit all read.
     */
    if (!isPlausiblePosition(position)) {
      noteViolation(session, RULE.implausibleCoordinate, `hero at ${position.x}, ${position.y}`);
      return;
    }
    /**
     * What the client most recently claimed is evidence, not authority.
     *
     * A client with its local props/collision removed can walk outside and keep
     * sending perfectly finite numbers. Writing those straight into
     * `heroPosition` lets the same claim collect loot, fire proximity logic and
     * reach an exit. Keep it separately so an invalid claim can be inspected
     * without becoming the position every gameplay system trusts.
     */
    session.reportedHeroPosition = position;
    session.reportedHeroPositionAt = Date.now();

    const hero = session.actors.get(session.heroDoid);
    const reportedBody = collisionPointOf(hero, position);
    const acceptedBody = collisionPointOf(hero, session.heroPosition);
    const movementDistance = acceptedBody
      ? Math.hypot(reportedBody.x - acceptedBody.x, reportedBody.y - acceptedBody.y)
      : 0;
    const claimAt = session.reportedHeroPositionAt;
    const elapsed = Math.max(0, claimAt - (session.movementCreditAt ?? claimAt));
    const movementCredit = Math.min(
      MOVEMENT_CREDIT_CAP,
      (session.movementCredit ?? MOVEMENT_CREDIT_CAP) + elapsed * MOVEMENT_CREDIT_PER_MS
    );
    // Every claim advances the refill clock, including a rejected one; rejected
    // packets cannot be used to bank more than the fixed reserve.
    session.movementCreditAt = claimAt;
    session.movementCredit = movementCredit;

    /**
     * These four reject the claim; the two geometry rules below only report.
     * `movementMode` decides whether rejecting still happens, and defaults to
     * `enforce` because that is how they shipped — the switch is for standing
     * them down deliberately, which a test harness needs and a server does not.
     */
    if (
      acceptedBody &&
      movementDistance > MAX_UNGRANTED_MOVEMENT_STEP
    ) {
      noteViolation(
        session,
        RULE.movementStepTooLarge,
        `hero claimed one step from ${Math.round(session.heroPosition.x)},` +
          `${Math.round(session.heroPosition.y)} to ${Math.round(position.x)},` +
          `${Math.round(position.y)}`
      );
      if (config.movementMode === "enforce") return;
    }
    if (acceptedBody && movementDistance > movementCredit) {
      noteViolation(
        session,
        RULE.movementBudgetExceeded,
        `hero movement needs ${Math.round(movementDistance)} with ` +
          `${Math.round(movementCredit)} available`
      );
      if (config.movementMode === "enforce") return;
    }

    /**
     * Authored-tile containment is intentionally narrower than wall collision.
     *
     * Across 34,868 captured native-client positions, none leaves the tiles the
     * floor laid. Wall colliders still disagree with a small honest share, so
     * they remain audit work; tile membership and continuity have a measured
     * exact answer and stop walking around the outside edge today.
     */
    if (session.navigation && !isOnAuthoredTile(session.navigation, reportedBody)) {
      noteViolation(
        session,
        RULE.movementEndpointOffTile,
        `hero claim ${Math.round(position.x)},${Math.round(position.y)} is outside authored tiles`
      );
      if (config.movementMode === "enforce") return;
    }
    if (
      session.navigation &&
      acceptedBody &&
      !segmentStaysOnAuthoredTiles(session.navigation, acceptedBody, reportedBody)
    ) {
      noteViolation(
        session,
        RULE.movementSegmentOffTile,
        `hero claim crossed an absent tile from ` +
          `${Math.round(session.heroPosition.x)},${Math.round(session.heroPosition.y)} to ` +
          `${Math.round(position.x)},${Math.round(position.y)}`
      );
      if (config.movementMode === "enforce") return;
    }

    /**
     * Wall/prop detection in shadow mode.
     *
     * The same generated navigation contains background walls, client-owned
     * LEProps, server-owned LENPC obstacles and the current gate state. It can
     * therefore see a locally deleted prop without knowing anything about the
     * client process. It is not a gameplay rejection yet: current native-client
     * replay still finds a small honest collider disagreement. Count it until
     * that data reaches zero, while the exact tile rule above contains the outer
     * edge exploit now.
     *
     * A distance cap is part of the security boundary. `hasLineOfSight` samples
     * along the segment; a client-chosen million-unit claim must not buy a
     * million-unit server loop. All authored hero auto-moves fit below 1000.
     */
    if (session.navigation && acceptedBody) {
      if (isPositionBlocked(session.navigation, reportedBody, 0)) {
        noteViolation(
          session,
          RULE.movementEndpointInsideGeometry,
          `hero claim ${Math.round(position.x)},${Math.round(position.y)} is inside active geometry`
        );
      } else {
        const distance = Math.hypot(
          reportedBody.x - acceptedBody.x,
          reportedBody.y - acceptedBody.y
        );
        if (
          distance <= MOVEMENT_WALL_AUDIT_MAX_DISTANCE &&
          !hasLineOfSight(session.navigation, acceptedBody, reportedBody, 0)
        ) {
          noteViolation(
            session,
            RULE.movementSegmentCrossedGeometry,
            `hero claim crossed active geometry over ${Math.round(distance)} units`
          );
        }
      }
    }
    /**
     * And when it arrived, because how old this is decides how much room a
     * claim made against it deserves. `broadcastTelemetry` runs on a 0.2 second
     * schedule and only sends when the position changed: a median of 208ms
     * apart across 54 official captures, but a p99 of 1043. See claimedReachOf.
     */
    session.heroPositionAt = Date.now();
    session.heroPosition = position;
    session.movementCredit = Math.max(0, movementCredit - movementDistance);
    if (hero) hero.position = position;
    if (session.world) {
      session.broadcast(
        new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
          .u32(session.heroDoid)
          .u16(FLID_HERO_POSITION)
          .f32(position.x)
          .f32(position.y)
          .frame(),
        { except: session.member }
      );
    }
    collectNearby(session, position);
    updateProximityTriggers(session, position);
    checkFloorExit(session, position);
    return;
  }

  if (doid === session.heroDoid && fieldId === FLID_HERO_HEADING) {
    const heading = reader.f32();
    session.heroHeading = heading;
    const hero = session.actors.get(session.heroDoid);
    if (hero) hero.heading = heading;
    if (session.world) {
      session.broadcast(
        new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
          .u32(session.heroDoid)
          .u16(FLID_HERO_HEADING)
          .f32(heading)
          .frame(),
        { except: session.member }
      );
    }
    return;
  }

  if (doid === session.presenceDoid && fieldId === FLID_ADD_FRIENDS) {
    return handleAddFriends(session, reader);
  }

  if (doid === session.heroDoid && fieldId === FLID_PROPOSE_REVIVE) {
    return handleProposeRevive(session, reader);
  }

  if (doid === session.heroDoid && fieldId === FLID_PROPOSE_SELF_REVIVE) {
    return handleProposeSelfRevive(session, reader);
  }

  /**
   * Every other owner proposal names the hero it came from; this one was routed
   * on the field id alone, so a modified client could send hit results in
   * somebody else's name.
   *
   * Deterministic, not a judgement: across 54 official captures the client
   * sends 60993 owner fields — 34818 positions, 13604 headings, 7023
   * choreographies, 5447 combat results, 69 revives and 32 placements — and
   * every single one carries the hero's own doid. There is no honest traffic on
   * the other side of this check.
   */
  if (fieldId === FLID_PROPOSE_COMBAT_RESULTS) {
    if (doid !== session.heroDoid) {
      noteViolation(session, RULE.forgedAttacker, `field 171 addressed to doid ${doid}`);
      return;
    }
    return handleProposeCombatResults(session, reader);
  }

  if (doid === session.heroDoid && fieldId === FLID_PROPOSE_CREATE_NPC) {
    return handleProposeCreateNPC(session, reader);
  }

  if (doid === session.heroDoid && fieldId === FLID_PROPOSE_ATTACK_CHOREOGRAPHY) {
    const choreography = Buffer.from(reader.rest());
    return handleProposeAttackChoreography(session, reader, {
      onAccepted: () => {
        if (!session.world) return;
        session.broadcast(
          remoteAttackChoreography(session.heroDoid, choreography),
          { except: session.member }
        );
      },
    });
  }

  if (doid === session.heroDoid && fieldId === FLID_STOP_CHOREOGRAPHY) {
    // Charge controllers stop their holding timeline locally on button-up.
    // Remote clients cannot observe that local call; the original server
    // forwards this empty field so they stop before playing the release attack.
    reader.rest();
    if (session.world) {
      session.broadcast(remoteStopChoreography(session.heroDoid), {
        except: session.member,
      });
    }
    return true;
  }

  // Chat is written on the speaker's own player object, which is also the only
  // object they are allowed to speak through.
  if (doid === session.playerDoid && fieldId === FLID_PLAYER_CHAT) {
    return handleChat(session, reader);
  }
  if (doid === session.playerDoid && fieldId === FLID_PLAYER_TYPING) {
    return handleTyping(session, reader);
  }

  // The report's chest buttons, addressed to the summary the server generated.
  if (doid === session.summaryDoid) {
    if (fieldId === FLID_TAKE_CHEST) return handleTakeChest(session, reader);
    if (fieldId === FLID_DROP_CHEST) return handleDropChest(session, reader);
    if (fieldId === FLID_OPEN_CHEST) return handleOpenChest(session, reader);
  }

  /**
   * Counted rather than narrated, like every other thing a client can repeat.
   * An unknown field is usually one of ours to implement, but the client
   * chooses how often it arrives, so one line per packet is a volume it sets.
   */
  const payload = reader.rest();
  if (noteViolation(session, RULE.unknownField, `doid=${doid} field=${fieldId}`)) {
    unimplemented(
      `field update doid=${doid} field=${fieldId}`,
      `${payload.length} bytes ${truncate(payload.toString("hex"))}`
    );
  }
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

const handlePacket = (session, body) => {
  const reader = new PacketReader(body);
  const opcode = reader.u16();

  switch (opcode) {
    case OP.CLIENT_LOGIN_DUNGEONBUSTER:
      return handleLogin(session, reader);
    case OP.CLIENT_HEART_BEAT:
      return handleHeartbeat(session, reader);
    case OP.CLIENT_OBJECT_UPDATE_FIELD:
      return handleFieldUpdate(session, reader);
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
  const session = {
    id: nextSessionId++,
    socket,
    accountId: null,
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
    allocateDoid(clid) {
      const doid = nextDoid++;
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
  };

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
    session.queue.length = 0;
    session.queuedBytes = 0;
    leavePresence(session);
    // `socket.end()` may wait indefinitely for a slow peer before emitting
    // close. Release the match/world now so a displaced or logging-out player
    // cannot keep a ghost room and all of its timers alive during that wait.
    leaveDungeonSession(session);
    buffered = Buffer.alloc(0);
    info(`${describe(session)} closing: ${why}`);
    /**
     * `destroy` drops anything Node is still holding, which is what a session
     * being cut off deserves. It is the wrong end for a session whose last
     * frame is the explanation of why it is ending: `end` sends what is queued
     * and then the FIN, and because these sockets are not half-open the reply
     * FIN destroys this side.
     */
    if (flush) socket.end();
    else socket.destroy();
  };

  /** So one session can end another — a second login on the same account. */
  session.close = closeSession;

  /** Reading runs only when neither reason to stop is active. */
  const updateReadFlow = () => {
    if (session.pausedForQueue || session.pausedForWrite) socket.pause();
    else socket.resume();
  };

  info(`${describe(session)} connected from ${socket.remoteAddress}`);
  let buffered = Buffer.alloc(0);

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
  socket.on("close", () => {
    session.closed = true;
    session.queue.length = 0;
    session.queuedBytes = 0;
    leavePresence(session);
    leaveDungeonSession(session);
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

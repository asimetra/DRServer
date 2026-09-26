import { config } from "../config.js";
import { truncate, unimplemented } from "../log.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
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
import { RULE, noteViolation } from "./security-events.js";
import {
  collisionPointOf,
  hasLineOfSight,
  isPositionBlocked,
  isOnAuthoredTile,
  segmentStaysOnAuthoredTiles,
} from "./navigation.js";
import { noteEntryHandshake } from "./entry-handshake.js";

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

/**
 * Everything a player sends about their own dungeon.
 *
 * Split out of socket/index.js, which keeps what belongs to the connection —
 * login, heartbeat, MatchMaker and presence — and hands the rest here. Nothing
 * below touches the socket or the server around it, which is what lets the same
 * function run wherever the player's match runs.
 */
export const handleGameplayField = (member, doid, fieldId, reader) => {
  // These two fields are the loading handshake itself, so a pending late join
  // must be allowed to send them before it becomes an active world member.
  if (doid === member.playerDoid && noteEntryHandshake(member, fieldId)) {
    reader.rest();
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

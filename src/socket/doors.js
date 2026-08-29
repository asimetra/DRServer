/**
 * A threshold you walk through.
 *
 * Interacting with a monster turned out to be the wrong shape for choosing
 * where to go: hitting a statue does not answer "what is this for", and a mob
 * cannot be labelled — an NPC has no name field. A door and somebody standing
 * next to it answer both without a word of interface. The keeper is the sign;
 * the door is the threshold.
 *
 * Going through one is an ordinary entry, not a trick. `enterDungeon` already
 * begins by tearing down whatever dungeon the session is in, so the same two
 * calls the matchmaker makes for a player picking a node off the map do the
 * whole job — which also means the destination is not bound by the hub's
 * preload the way a mid-run floor swap would be.
 */
import { error, info } from "../log.js";
import {
  ENTRY_ERROR,
  buildEntryResponse,
  entryErrorCodeFor,
  rememberMatchMakerGroup,
} from "./matchmaker.js";
import { joinDungeonMatch, leaveDungeonSession } from "./match-runtime.js";
import { resolveMatchEntry } from "./match-entry.js";

/**
 * The request a doorway makes on the player's behalf.
 *
 * Deliberately the same shape the client sends, so that entry sees no
 * difference between a door and the map screen: everything downstream —
 * progression, party matching, admission — is the code that already runs, and a
 * door cannot become a way around a rule by being a different path.
 */
const requestFor = (session, destination) => ({
  demographics: "",
  sCode: 0,
  mapNodeId: Number(destination),
  friendId: 0,
  mapId: 0,
  friendOnly: 0,
  matchMakerGroup: session.matchMakerGroup ?? "",
});

/**
 * Takes whoever entered the doorway to where it leads.
 *
 * Guarded against a second crossing, because a threshold is a place you can
 * stand: the proximity trigger fires once on entry, but a failed or slow
 * transition would leave the player standing in it, and the guard is what stops
 * a stutter from becoming two entries.
 */
export const walkThrough = async (
  session,
  destination,
  // Injected so a test can watch a crossing without running a dungeon entry.
  { resolve = resolveMatchEntry, join = joinDungeonMatch } = {}
) => {
  const node = Number(destination);
  if (!Number.isFinite(node) || node <= 0) return false;
  if (session.walkingThrough) return false;
  session.walkingThrough = true;

  const connection = session.member ?? session;
  try {
    /**
     * Off the old floor properly first.
     *
     * `enterDungeon` does call `leaveDungeon`, but that is the raw one: it
     * clears the member's own objects and knows nothing about the match. A
     * player crossing out of a hub is still on its roll and still in its world,
     * so joining the next dungeon built a second world around a session the
     * first one had not let go of — the client was told to build a floor while
     * still holding the last, and fell over doing it.
     *
     * This is the teardown the matchmaker uses when somebody leaves, which is
     * what walking out of a door is.
     */
    leaveDungeonSession(connection, { notifyClient: true });

    const request = requestFor(session, node);
    const result = await resolve(connection, request);

    if (!result.match) {
      // Answered the way a refused map click is answered, so the client shows
      // the popup it already owns instead of standing in a doorway that does
      // nothing.
      const code = entryErrorCodeFor(result);
      info(`[${session.id}] door to ${node} refused: ${result.error ?? "no match"}`);
      connection.send(buildEntryResponse(connection.matchMakerDoid, code));
      return false;
    }

    connection.send(buildEntryResponse(connection.matchMakerDoid, 0, result.match.mapNodeId));
    await join(connection, result, request);
    rememberMatchMakerGroup(connection, result.match);
    info(`[${session.id}] walked through to ${node}`);
    return true;
  } catch (problem) {
    error(`[${session.id}] door to ${node} failed: ${problem.stack ?? problem}`);
    leaveDungeonSession(connection, { notifyClient: true });
    connection.send(buildEntryResponse(connection.matchMakerDoid, ENTRY_ERROR.INTERNAL));
    return false;
  } finally {
    // Cleared on the *connection*, which outlives the floor context the door
    // was standing on — a fresh dungeon is a fresh set of triggers anyway.
    connection.walkingThrough = false;
  }
};

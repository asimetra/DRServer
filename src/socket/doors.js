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
import { matchExecutor } from "./match-runtime.js";
import { EntryRefusedError, checkDestination, resolveMatchEntry } from "./match-entry.js";

const joinMatch = (...args) => matchExecutor.join(...args);
const leaveMatch = (...args) => matchExecutor.leave(...args);

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
 * a stutter from becoming two entries. Checked, set and cleared on the
 * connection, which outlives the floor context the door was standing on.
 *
 * The destination is asked about before anything is left: a door that goes
 * nowhere for this hero leaves them standing on the floor they are on, rather
 * than out of it with nowhere to be.
 */
export const walkThrough = async (
  session,
  destination,
  // Injected so a test can watch a crossing without running a dungeon entry.
  {
    check = checkDestination,
    resolve = resolveMatchEntry,
    join = joinMatch,
    leave = leaveMatch,
  } = {}
) => {
  const node = Number(destination);
  if (!Number.isFinite(node) || node <= 0) return false;
  const connection = session.member ?? session;
  if (connection.walkingThrough) return false;
  connection.walkingThrough = true;

  let refusal;
  try {
    refusal = await check(connection, node);
  } catch (problem) {
    refusal = problem.message;
  }
  if (refusal) {
    info(`[${session.id}] door to ${node} refused before leaving: ${refusal}`);
    connection.walkingThrough = false;
    return false;
  }

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
    await leave(connection, { notifyClient: true });

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

    let accepted = false;
    await join(connection, result, request, {
      onPlayerReady: () => {
        if (accepted) return;
        accepted = true;
        connection.send(
          buildEntryResponse(connection.matchMakerDoid, 0, result.match.mapNodeId)
        );
      },
    });
    if (!accepted) throw new Error(`match ${result.match.id} did not create the owner player`);
    rememberMatchMakerGroup(connection, result.match);
    info(`[${session.id}] walked through to ${node}`);
    return true;
  } catch (problem) {
    // A hero switched since the check: refused with the client's own
    // sentence, as the matchmaker answers the same refusal.
    const refusal = problem instanceof EntryRefusedError
      ? entryErrorCodeFor({ error: problem.reason })
      : null;
    if (refusal) info(`[${session.id}] door to ${node} refused once held: ${problem.message}`);
    else error(`[${session.id}] door to ${node} failed: ${problem.stack ?? problem}`);
    await leave(connection, { notifyClient: true });
    connection.send(buildEntryResponse(connection.matchMakerDoid, refusal ?? ENTRY_ERROR.INTERNAL));
    return false;
  } finally {
    connection.walkingThrough = false;
  }
};

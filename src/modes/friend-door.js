/**
 * A mode's door on the friend list: how a player enters a mode.
 *
 * The stock client has no menu a server can add to, and no chat in town — but
 * every player has a friend list, and a friend who is online and in a dungeon
 * gets a JOIN button (LeaderboardFriendSlot). So a mode is a friend everybody
 * has: a row on every list, always online and "in" a dungeon, and JOIN on it is
 * the mode's own entry. Ranked's MATCHMAKER is one; a mode adds its own here
 * and merges the hooks it is given into its own (src/modes/README.md, "The
 * friend door").
 *
 * The id is reserved, below any account's (ACCOUNT_ID_FLOOR), so registration
 * never hands it out (isSystemAccount); it is never stored in an account, only
 * added to answers.
 */
import { tellSystemPresence } from "../socket/presence.js";
import { systemFriendRowOf } from "../social.js";

/** A door's id: under 1000, which no account, doid or client friend cast ever is. */
export const FRIEND_DOOR_ID_MOST = 999;

/** The core's presence for a door: says `id` is online at `where` to `session` (friendDoorHooks' default). */
export const tellPresence = (session, id, where) => tellSystemPresence(session, id, where);

/**
 * Above any real friend's trophies, so the client — which sorts online friends
 * by trophies and ignores the server's order — always puts a door first. A
 * player has a trophy a boss, a dozen at most; a door's `trophies` is its place
 * among the doors, higher first (MATCHMAKER 999, DELVE 998): two doors alike
 * would be in whatever order the client's sort leaves them, list to list.
 */
const PINNED_TROPHIES = 999;
/** The least a door may say: still far above any player's. */
const DOOR_TROPHIES_LEAST = 100;

const valueOf = (value) => (typeof value === "function" ? value() : value);

/**
 * The row a door is on a friend list, as the core draws a friend the server
 * keeps (social.js): `name` plain ASCII, the game's font promising nothing else.
 */
export const friendDoorRow = ({ id, name, where = 0, trophies = PINNED_TROPHIES }) =>
  systemFriendRowOf({ id, name: String(valueOf(name) ?? ""), trophies, dungeon: Number(valueOf(where)) || 0 });

/**
 * The hooks a door is, for a mode to merge into its own:
 *
 *   friendList       the row first on every list, any stored copy of it dropped
 *   loggedIn         the door is online and in a dungeon, so JOIN is drawn
 *   routeEntry       JOIN on the door is `entry(connection, request)`: the
 *                    request to admit — the mode's mark, the node of its choosing
 *   isSystemAccount  the id is the door's, never an account's
 *
 * `name` and `where` may be functions, read each time a list is answered: a
 * door may say how many are inside. `trophies` orders the doors among
 * themselves (above). `tellPresence` stands in for the core's in
 * a test.
 */
export const friendDoorHooks = ({ id, name, where = 0, trophies = PINNED_TROPHIES, entry, tellPresence = tellSystemPresence }) => {
  if (!Number.isSafeInteger(id) || id <= 0 || id > FRIEND_DOOR_ID_MOST) {
    throw new Error(`a friend door's id is 1 to ${FRIEND_DOOR_ID_MOST}, not ${id}`);
  }
  if (!Number.isSafeInteger(trophies) || trophies < DOOR_TROPHIES_LEAST || trophies > PINNED_TROPHIES) {
    throw new Error(`a friend door's trophies are ${DOOR_TROPHIES_LEAST} to ${PINNED_TROPHIES}, not ${trophies}`);
  }
  if (typeof entry !== "function") throw new Error(`friend door ${id} has no entry`);
  const mine = (accountId) => Number(accountId) === id;
  return {
    isSystemAccount: mine,
    friendList: (rows) => [friendDoorRow({ id, name, where, trophies }), ...(rows ?? []).filter((row) => !mine(row?.account_id))],
    loggedIn: (session) => tellPresence(session, id, Number(valueOf(where)) || 0),
    routeEntry: (connection, request) => (mine(request?.friendId) ? entry(connection, request) : request),
  };
};

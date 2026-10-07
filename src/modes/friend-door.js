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

/** A door's id: under 1000, which no account, doid or client friend cast ever is. */
export const FRIEND_DOOR_ID_MOST = 999;

/** The core's presence for a door: says `id` is online at `where` to `session` (friendDoorHooks' default). */
export const tellPresence = (session, id, where) => tellSystemPresence(session, id, where);

/** One of the default hero skins: an unknown one crashes the client's portrait. */
const PORTRAIT_SKIN = 151;

/**
 * Above any real friend's trophies, so the client — which sorts online friends
 * by trophies and ignores the server's order — always puts a door first.
 */
const PINNED_TROPHIES = 999;

const valueOf = (value) => (typeof value === "function" ? value() : value);

/** The row a door is on a friend list: `name` plain ASCII (the game's font promises nothing else). */
export const friendDoorRow = ({ id, name, where = 0 }) => ({
  account_id: id,
  name: String(valueOf(name) ?? ""),
  trophies: PINNED_TROPHIES,
  active_skin: PORTRAIT_SKIN,
  is_ingame_friend: true,
  identifier: `3_${id}`,
  friend_code: "",
  is_online: true,
  current_dungeon: Number(valueOf(where)) || 0,
  avatar_url: null,
});

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
 * door may say how many are inside. `tellPresence` stands in for the core's in
 * a test.
 */
export const friendDoorHooks = ({ id, name, where = 0, entry, tellPresence = tellSystemPresence }) => {
  if (!Number.isSafeInteger(id) || id <= 0 || id > FRIEND_DOOR_ID_MOST) {
    throw new Error(`a friend door's id is 1 to ${FRIEND_DOOR_ID_MOST}, not ${id}`);
  }
  if (typeof entry !== "function") throw new Error(`friend door ${id} has no entry`);
  const mine = (accountId) => Number(accountId) === id;
  return {
    isSystemAccount: mine,
    friendList: (rows) => [friendDoorRow({ id, name, where }), ...(rows ?? []).filter((row) => !mine(row?.account_id))],
    loggedIn: (session) => tellPresence(session, id, Number(valueOf(where)) || 0),
    routeEntry: (connection, request) => (mine(request?.friendId) ? entry(connection, request) : request),
  };
};

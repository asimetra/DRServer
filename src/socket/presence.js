import { PacketWriter } from "./packet.js";
import { CLID, OP } from "./opcodes.js";
import { generateVisible } from "./objects.js";
import { info } from "../log.js";

/**
 * Who is online, and which dungeon they are in.
 *
 * This is not a field on the friend list, which is where it looks like it
 * should live. `FriendInfo.lastMapNode` asks `PresenceManager.InDungeonId`,
 * `isOnline` asks whether it holds the account at all, and `isInDungeon` asks
 * whether the value it holds is non-zero — so all three come off a distributed
 * object over the socket and none of them off the RPC payload. Putting a
 * `current_dungeon` in the JSON would be read by nothing.
 *
 * Two fields carry it, and they run in opposite directions:
 *
 *   189 addFriends   client -> server   u16 byte length, then u32 account ids
 *   188 friendState  server -> client   u8 online, u32 account, u32 map node
 *
 * The client batches its side: `PresenceManager.addFriends` starts a
 * two-second timer and sends the accumulated list when it fires, so the server
 * is told the whole set rather than one id at a time.
 *
 * `online` is a flag rather than a state: zero removes the account from the
 * client's map and anything else adds or updates it. The map node is what
 * "which dungeon" means — zero for somebody standing in town, which is why
 * `isInDungeon` is simply "the value is not zero".
 */

export const FLID_ADD_FRIENDS = 189;
const FLID_FRIEND_STATE = 188;

/** Everyone connected, by account id, and the map node they are on. */
const online = new Map();

/**
 * Who is on, for anything outside the socket that wants to know.
 *
 * A count and the map nodes, not the account ids: the web front end asks this
 * to draw "seven adventurers afield", and a list of who exactly is a different
 * question with a different answer about privacy.
 */
export const presenceSummary = () => {
  // The value in this map is the map node itself, and 0 means town.
  const nodes = new Map();
  for (const where of online.values()) {
    const node = Number(where ?? 0);
    if (node) nodes.set(node, (nodes.get(node) ?? 0) + 1);
  }
  return {
    online: online.size,
    inDungeon: [...nodes.values()].reduce((sum, count) => sum + count, 0),
    byNode: Object.fromEntries(nodes),
  };
};

/** No required fields of its own: everything it knows arrives on field 188. */
export const presenceGenerate = (doid) =>
  generateVisible({ clid: CLID.PresenceManager, doid, fields: Buffer.alloc(0) });

const friendState = (doid, isOnline, accountId, mapNodeId) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_FRIEND_STATE)
    .u8(isOnline ? 1 : 0)
    .u32(accountId)
    .u32(mapNodeId)
    .frame();

/** Tells one session about one account, if it asked to be told about it. */
const tell = (session, accountId) => {
  if (!session.presenceDoid || !session.watchedFriends?.has(accountId)) return;
  const where = online.get(accountId);
  session.send(friendState(session.presenceDoid, where !== undefined, accountId, where ?? 0));
};

/** And everybody who asked about this one. */
const tellWatchers = (accountId) => {
  for (const session of sessions) tell(session, accountId);
};

const sessions = new Set();

/**
 * A session joins the roll when it logs in.
 *
 * Keyed by account rather than by socket because presence is about the person:
 * a reconnect that arrives before the old socket closes should not read as
 * having gone offline and come back.
 */
/**
 * Saying it again, on a slow tick.
 *
 * Presence here was purely change-driven: something moves, everybody watching
 * is told once, and if that once goes missing the friend panel is wrong until
 * the next time that person happens to move. The official server does not rely
 * on it either — across the recordings, 665 of its `friendState` updates repeat
 * a value it had already sent against 532 that actually changed, so more than
 * half of what it says is a restatement.
 *
 * It is not a fixed cadence there: gaps between two updates for one account run
 * 10s at the first quartile, 24s at the median and 54s at the third, which is
 * something prompting it rather than a clock. Thirty seconds sits in the middle
 * of that spread and is the cheap way to get the same property — a panel that
 * heals itself instead of staying wrong.
 *
 * The cost is bounded by what it skips: only accounts a session actually
 * watches and only the ones online, which is a handful of fifteen-byte frames
 * per player per half minute. Nobody offline is mentioned, so a big friend list
 * of absent people costs nothing.
 */
const REASSERT_MS = 30_000;
let reassertTimer = null;

const reassertAll = () => {
  for (const session of sessions) {
    for (const accountId of session.watchedFriends ?? []) {
      if (online.has(accountId)) tell(session, accountId);
    }
  }
};

/** Runs only while somebody is connected, and never holds the process open. */
const updateReassertTimer = () => {
  if (sessions.size && !reassertTimer) {
    reassertTimer = setInterval(reassertAll, REASSERT_MS);
    reassertTimer.unref?.();
    return;
  }
  if (!sessions.size && reassertTimer) {
    clearInterval(reassertTimer);
    reassertTimer = null;
  }
};

/** Test seam: run one tick now rather than waiting half a minute for it. */
export const reassertPresenceNow = reassertAll;

export const enterPresence = (session) => {
  sessions.add(session);
  updateReassertTimer();
  if (!session.accountId) return;
  /**
   * Town, always. A login is a client at its loading screen, even when it is
   * taking the account off a session that was standing in a dungeon — carrying
   * that dungeon over would leave the friends panel pointing at a floor this
   * player is not on and cannot be joined in.
   */
  online.set(session.accountId, 0);
  tellWatchers(session.accountId);
};

export const leavePresence = (session) => {
  sessions.delete(session);
  updateReassertTimer();
  if (!session.accountId) return;
  // Only if nobody else is holding the same account up.
  const stillHere = [...sessions].some((other) => other.accountId === session.accountId);
  if (stillHere) return;
  /**
   * And only if he was on the roll. Ending a session runs this twice — once
   * where it is closed and again from the socket's own close handler — and the
   * second one has nothing left to announce, so without this every disconnect
   * sends each watching friend the same "offline" twice.
   */
  if (!online.delete(session.accountId)) return;
  tellWatchers(session.accountId);
};

/**
 * Where somebody is now. Zero is town, which is what the client reads as "online
 * but not in a dungeon".
 */
export const setPresenceLocation = (session, mapNodeId) => {
  // Gameplay builders receive a MatchWorld context proxy; the presence roll
  // holds the raw connected member. Comparing the proxy itself against that
  // Set silently rejected the first/host member's dungeon transition, leaving
  // both the friend Join button and current_dungeon JSON at zero.
  const member = session?.member ?? session;
  if (!member?.accountId) return;
  /**
   * A session that has left the roll cannot put itself back on it.
   *
   * Teardown does both of these: the socket's close handler drops the session
   * from presence and then leaves the dungeon, and leaving a dungeon reports
   * being in town. Without this the second undoes the first and the friend
   * panel is told he went offline and immediately came back — which is what a
   * trace of a disconnect showed, two updates where there should be one.
   *
   * Guarded here rather than by ordering the two calls, because an order is a
   * thing somebody rearranges later without knowing why it was that way.
   */
  if (!sessions.has(member)) return;
  const where = Number(mapNodeId) || 0;
  if (online.get(member.accountId) === where) return;
  online.set(member.accountId, where);
  tellWatchers(member.accountId);
};

/**
 * The client's own list, and the answer to all of it at once.
 *
 * It sends the whole set each time rather than a delta, so the set replaces
 * what was there. Bounded by what an account can actually befriend; a list this
 * long is a client with a very full friends panel, not a flood.
 */
const MAX_WATCHED = 512;

export const handleAddFriends = (session, reader) => {
  const byteLength = reader.u16();
  const wanted = new Set();
  const count = Math.min(Math.floor(byteLength / 4), MAX_WATCHED);
  for (let index = 0; index < count; index++) wanted.add(reader.u32());

  /**
   * Added to what is already watched rather than replacing it.
   *
   * The client does send its whole set each time, so replacing looks right —
   * but its set is not the friend list. `UIFriends` never calls `addFriends` at
   * all; only the dungeon summary, the invite panel and the pending panel do,
   * and what they pass is the handful of people on that screen. Replacing
   * would drop the friends seeded at login every time a summary appeared.
   */
  session.watchedFriends ??= new Set();
  for (const accountId of wanted) {
    if (session.watchedFriends.size >= MAX_WATCHED) break;
    session.watchedFriends.add(accountId);
  }
  info(`[${session.id}] watching ${session.watchedFriends.size} account(s) for presence`);

  // Answer immediately for everyone asked about, rather than waiting for one of
  // them to move: the panel is open now.
  for (const accountId of wanted) tell(session, accountId);
  return true;
};

/**
 * The friends a session is told about without having asked.
 *
 * Waiting to be asked is why nobody was ever online. The client barely asks:
 * across 61 official recordings the server sends field 188 in 46 of them and
 * the client sends 189 in two, and in a session of our own neither field
 * crossed the wire at all. `FriendInfo.isOnline` reads `PresenceManager`
 * directly, so a friend nothing has spoken about is a friend who is offline by
 * default, for ever.
 *
 * What the official server does instead is push the whole list the moment the
 * object exists — six of them inside the same millisecond as the generate, in
 * the recording this was read from. So the friend list is the watch list, and
 * login is when it is sent.
 *
 * Only the ones actually here. Absence is already the client's default, and the
 * official burst is almost entirely `online` flags: 1349 against 29 across the
 * recordings. Anyone who arrives later is covered by `tellWatchers`, because
 * they are on the list either way.
 */
export const watchFriends = (session, accountIds) => {
  session.watchedFriends ??= new Set();
  for (const id of accountIds ?? []) {
    const accountId = Number(id);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
    if (session.watchedFriends.size >= MAX_WATCHED) break;
    session.watchedFriends.add(accountId);
    if (online.has(accountId)) tell(session, accountId);
  }
  return session.watchedFriends.size;
};

/**
 * The session an account is logged in on, if any.
 *
 * Asked here rather than kept in a second map beside this one, because two
 * registries of the same thing are two registries that can disagree. The roll
 * is the number of people connected, so walking it is cheap.
 */
/**
 * Every connection currently logged in.
 *
 * Presence keeps this roll for the friends panel; a global channel needs the
 * same list for a different reason, and keeping one roll is better than two
 * that can disagree about who is here.
 */
export const activeSessions = () => [...sessions];

export const sessionHolding = (accountId) =>
  [...sessions].find((session) => session.accountId === Number(accountId)) ?? null;

/** Whether an account is connected at all. */
export const isOnline = (accountId) => online.has(Number(accountId));

/** The map node they are on, or zero for town and for anybody not connected. */
export const dungeonOf = (accountId) => online.get(Number(accountId)) ?? 0;

/** Test seam: the roll is process-wide, so a test has to be able to empty it. */
export const clearPresence = () => {
  sessions.clear();
  online.clear();
  updateReassertTimer();
};

/**
 * Who may enter what, asked at three moments with one rule each time.
 *
 * - Friendship (`friendId`/`mapId` joins): at admission only. It decides
 *   whether the joiner may learn the match exists at all; a friendship ending
 *   while the floor loads does not reach back into the run.
 * - Progression (`mayEnterNode`): before a door leaves the old floor
 *   (`checkDestination`), at admission (`admitEntry`), and once the run holds
 *   the account (`requireMayEnter`) — the last because the hero played is read
 *   from that hold, not from the admission snapshot.
 * - Capacity and the match's state: at admission, by the registry, which
 *   counts the reserved place from then on.
 */
import { loadAccount } from "../accounts.js";
import { loadGameMaster } from "../gamemaster.js";
import { areFriends, friendIdsOf } from "../social.js";
import {
  activeAvatarMayEnter,
  dungeonMatches,
  hasDungeonAdminOverride,
  isHubNode,
  isUltimateNode,
} from "./matches.js";

/**
 * An entry refused for a reason the client has a sentence for, raised where
 * no result object can carry it — after admission, once the gameplay account
 * is held. `reason` is one of the names `entryErrorCodeFor` knows.
 */
export class EntryRefusedError extends Error {
  constructor(reason, message = `entry refused: ${reason}`) {
    super(message);
    this.name = "EntryRefusedError";
    this.reason = reason;
  }
}

const registryRequest = (session, request) => ({
  session,
  mapNodeId: request.mapNodeId,
  friendId: request.friendId,
  mapId: request.mapId,
  friendOnly: Boolean(request.friendOnly),
  group: request.matchMakerGroup ?? "",
});

const nodeOf = (gameMaster, mapNodeId) =>
  gameMaster?.mapNodeById?.get(mapNodeId) ??
  (gameMaster?.raw?.MapPage ?? []).find((candidate) => candidate.Id === mapNodeId);

/** The one progression answer every route shares: admin, hub, or the active hero's map. */
const mayEnterNode = (account, node, gameMaster) =>
  hasDungeonAdminOverride(account) ||
  isHubNode(node) ||
  activeAvatarMayEnter(account, node, gameMaster);

/**
 * The same question again, asked of the account the dungeon will actually play.
 *
 * Admission reads an unlocked snapshot; the run takes its own hold on the
 * account afterwards and picks the hero from that. A hero switched in between
 * would enter on a check another hero passed, so the held account is checked
 * before anything is built for it.
 */
export const requireMayEnter = async (
  account,
  mapNodeId,
  { loadGameMasterData = loadGameMaster } = {}
) => {
  const gameMaster = await loadGameMasterData();
  const node = nodeOf(gameMaster, Number(mapNodeId));
  if (!node) throw new EntryRefusedError("bad_map_node");
  if (!mayEnterNode(account, node, gameMaster)) {
    throw new EntryRefusedError(
      "content_not_completed",
      `account ${account?.id} active avatar ${account?.active_avatar} may not enter ${mapNodeId}`
    );
  }
};

/**
 * Whether a door may take this player to a node, answered without touching
 * anything — so a refusal leaves them where they stand. A door's entry is a
 * public one, which always finds or makes a match, so the node and the hero's
 * progression are all that can refuse it.
 */
export const checkDestination = async (
  session,
  mapNodeId,
  { loadAccountById = loadAccount, loadGameMasterData = loadGameMaster } = {}
) => {
  const gameMaster = await loadGameMasterData();
  const node = nodeOf(gameMaster, Number(mapNodeId));
  if (!node) return "bad_map_node";
  const account = await loadAccountById(session.accountId);
  return mayEnterNode(account, node, gameMaster) ? null : "content_not_completed";
};

/**
 * Whether the joiner has a friend in the match it named.
 *
 * `friendId` names the friend; `mapId` names the match, and any member who is
 * a friend will do — the id is there for a mod to offer "join", and friends
 * are who may use it. Anybody else is answered as if there were nothing there,
 * which is also what keeps a stranger from learning that there is. Only
 * members the joiner already lists are read: the rest cannot be the friend.
 */
const hasFriendThere = async (account, target, request, loadAccountById) => {
  const listed = new Set(friendIdsOf(account).map(Number));
  const named = Number(request.friendId);
  const candidates = named
    ? [named]
    : [...target.members].map((member) => Number(member.accountId));
  for (const id of candidates) {
    if (!listed.has(id) || id === Number(account.id)) continue;
    const other = await loadAccountById(id);
    if (other && areFriends(account, other)) return true;
  }
  return false;
};

/**
 * Admits a wire entry request on server-owned data and reserves its place.
 *
 * `friendId` and `mapId` identify a live match; they never prove that the
 * joining character is eligible for its content, nor that the joiner is
 * welcome in it. The account and MapPage row are loaded here so callers cannot
 * accidentally trust a client-supplied flag. An admitted entry carries the
 * registry's `reservation`, which its caller commits or aborts.
 */
export const admitEntry = async (
  session,
  request,
  {
    registry = dungeonMatches,
    loadAccountById = loadAccount,
    loadGameMasterData = loadGameMaster,
  } = {}
) => {
  const entry = registryRequest(session, request);
  // The client fills one or the other. Both at once would let a real friend's
  // id vouch for a match that friend is not in.
  if (Number(request.friendId) && Number(request.mapId)) {
    return { match: null, created: false, source: "map", error: "target_not_found" };
  }
  const target = registry.explicitTarget(request);
  // An explicit identity never falls back to the client-supplied node. Apart
  // from closing a spoofing path, returning before any loads keeps missing
  // friend/map probes cheap.
  if ((request.friendId || request.mapId) && !target) {
    return registry.reserve(entry);
  }

  const source = target
    ? (request.mapId ? "map" : "friend")
    : (request.friendOnly ? "private" : "public");
  // Read fresh on every entry: progression changes mid-session, and a door
  // or a friend is no different a route from the map.
  const account = await loadAccountById(session.accountId);
  const adminOverride = hasDungeonAdminOverride(account);

  // Before anything about the match itself, so that a stranger's answer does
  // not differ between "no such match" and "a match you may not see".
  if (target && !adminOverride && !(await hasFriendThere(account, target, request, loadAccountById))) {
    return { match: null, created: false, source, error: "target_not_found" };
  }

  const requestedNodeId = target?.mapNodeId ?? Number(request.mapNodeId ?? 0);
  const gameMaster = requestedNodeId ? await loadGameMasterData() : null;
  const node = nodeOf(gameMaster, requestedNodeId);
  if (!requestedNodeId || !node) {
    return {
      match: null,
      created: false,
      source,
      error: "bad_map_node",
    };
  }
  const mayEnter = mayEnterNode(account, node, gameMaster);

  // Knowing a friend is somewhere does not grant a hero who has not opened it
  // the way in.
  if (!mayEnter) {
    return {
      match: null,
      created: false,
      source,
      error: "content_not_completed",
    };
  }

  // The client ships a dedicated message for this exact case (110). Ordinary
  // dungeons support eligible late joins; Ultimate runs close after floor one.
  if (target && isUltimateNode(node) && target.floorIndex > 0 && !adminOverride) {
    return {
      match: null,
      created: false,
      source,
      error: "ultimate_in_progress",
    };
  }

  return registry.reserve({
    ...entry,
    eligibleForExplicitJoin: mayEnter,
    adminOverride,
  });
};

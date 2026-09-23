import { loadAccount } from "../accounts.js";
import { loadGameMaster } from "../gamemaster.js";
import {
  activeAvatarEligibleForExplicitJoin,
  dungeonMatches,
  hasDungeonAdminOverride,
  isHubNode,
  isUltimateNode,
} from "./matches.js";

/** Role changes take effect on reconnect; progression is still read fresh. */
const adminOverrideBySession = new WeakMap();

const registryRequest = (session, request) => ({
  session,
  mapNodeId: request.mapNodeId,
  friendId: request.friendId,
  mapId: request.mapId,
  friendOnly: Boolean(request.friendOnly),
  group: request.matchMakerGroup ?? "",
});

const rememberAdminOverride = (session, account) => {
  const adminOverride = hasDungeonAdminOverride(account);
  adminOverrideBySession.set(session, adminOverride);
  return adminOverride;
};

/**
 * Resolves a wire entry request using server-owned progression data.
 *
 * `friendId` and `mapId` identify a live match; they never prove that the
 * joining character is eligible for its content. The account and MapPage row
 * are loaded here so callers cannot accidentally trust a client-supplied flag.
 */
export const resolveMatchEntry = async (
  session,
  request,
  {
    registry = dungeonMatches,
    loadAccountById = loadAccount,
    loadGameMasterData = loadGameMaster,
  } = {}
) => {
  const entry = registryRequest(session, request);
  const target = registry.explicitTarget(request);
  // An explicit identity never falls back to the client-supplied node. Apart
  // from closing a spoofing path, returning before any loads keeps missing
  // friend/map probes cheap.
  if ((request.friendId || request.mapId) && !target) {
    return registry.resolve(entry);
  }

  const requestedNodeId = target?.mapNodeId ?? Number(request.mapNodeId ?? 0);
  const gameMaster = requestedNodeId ? await loadGameMasterData() : null;
  const mapNodes = gameMaster?.raw?.MapPage ?? [];
  const node = gameMaster?.mapNodeById?.get(requestedNodeId) ??
    mapNodes.find((candidate) => candidate.Id === requestedNodeId);
  const source = target
    ? (request.mapId ? "map" : "friend")
    : (request.friendOnly ? "private" : "public");
  if (!requestedNodeId || !node) {
    return {
      match: null,
      created: false,
      source,
      error: "bad_map_node",
    };
  }
  const progressionRequired = Boolean(target) || isUltimateNode(node);
  let account = null;
  let adminOverride;
  if (progressionRequired || !adminOverrideBySession.has(session)) {
    account = await loadAccountById(session.accountId);
    adminOverride = rememberAdminOverride(session, account);
  } else {
    adminOverride = adminOverrideBySession.get(session);
  }
  const eligibleForExplicitJoin = adminOverride ||
    isHubNode(node) ||
    (progressionRequired && activeAvatarEligibleForExplicitJoin(account, node, mapNodes));

  // Keep the progression gate first: knowing a friend is in an Ultimate does
  // not grant access to somebody whose active hero has not unlocked it.
  if (target && !eligibleForExplicitJoin) {
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

  // Ultimate is endgame content regardless of entry route. Checking only an
  // explicit friend/map request would let a modified client bypass the same
  // rule with a direct/public node request.
  if (!target && isUltimateNode(node) && !eligibleForExplicitJoin) {
    return {
      match: null,
      created: false,
      source: request.friendOnly ? "private" : "public",
      error: "content_not_completed",
    };
  }

  return registry.resolve({
    ...entry,
    eligibleForExplicitJoin,
    adminOverride,
  });
};

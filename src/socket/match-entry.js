import { loadAccount } from "../accounts.js";
import { loadGameMaster } from "../gamemaster.js";
import {
  activeAvatarMayEnter,
  dungeonMatches,
  hasDungeonAdminOverride,
  isHubNode,
  isUltimateNode,
} from "./matches.js";

const registryRequest = (session, request) => ({
  session,
  mapNodeId: request.mapNodeId,
  friendId: request.friendId,
  mapId: request.mapId,
  friendOnly: Boolean(request.friendOnly),
  group: request.matchMakerGroup ?? "",
});

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
  // Read fresh on every entry: progression changes mid-session, and a door
  // or a friend is no different a route from the map.
  const account = await loadAccountById(session.accountId);
  const adminOverride = hasDungeonAdminOverride(account);
  const mayEnter = adminOverride ||
    isHubNode(node) ||
    activeAvatarMayEnter(account, node, gameMaster);

  // Checked before anything about the target: knowing a friend is somewhere
  // does not grant a hero who has not opened it the way in.
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

  return registry.resolve({
    ...entry,
    eligibleForExplicitJoin: mayEnter,
    adminOverride,
  });
};

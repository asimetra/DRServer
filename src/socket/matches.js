/**
 * Dungeon instance allocation, independent from the wire/building code.
 *
 * The original protocol asks with one of three identities:
 *
 * - `mapNodeId`: public/private matchmaking for that node;
 * - `friendId`: the target player's account id, not a dungeon id;
 * - `mapId`: an explicit existing instance id.
 *
 * Original captures prove four players and also prove explicit late joins
 * after floor one. Random/public matching is intentionally narrower here: it
 * fills an existing instance only while that instance is on floor index zero.
 */

import { getMapNodeBit } from "../map-progress.js";

export const MAX_DUNGEON_PLAYERS = 4;
/** Bit 0 is reserved locally for server-authorized dungeon administration. */
export const DUNGEON_ADMIN_OVERRIDE_FLAG = 1;

const keyOf = ({ mapNodeId, group = "" }) => `${Number(mapNodeId)}|${group}`;

export const isUltimateNode = (node) => node?.NodeType === "INFINITE";

/**
 * A place rather than a challenge.
 *
 * The progression gate asks whether this hero has cleared the content, which is
 * the right question for a dungeon and a meaningless one for a room people
 * stand about in — a hub has no BitIndex to have cleared, so the gate refuses
 * everybody forever. `HUB` is this server's own node type and none of the
 * game's rows carry it, so nothing shipped changes.
 */
export const isHubNode = (node) => node?.NodeType === "HUB";
const NORMAL_NODE_TYPES = new Set(["DUNGEON", "BOSS"]);

/** `admin_flags` is persisted by the server and never read from an entry packet. */
export const hasDungeonAdminOverride = (account) => {
  try {
    const flags = BigInt(account?.admin_flags ?? 0);
    return flags >= 0n && (flags & BigInt(DUNGEON_ADMIN_OVERRIDE_FLAG)) !== 0n;
  } catch {
    return false;
  }
};

/** Explicit friend/map join is progression-gated per active character. */
export const avatarCompletedNode = (avatar, node) => {
  if (!avatar || !Number.isFinite(node?.BitIndex)) return false;
  return getMapNodeBit(avatar.completed_mapnode_mask, Number(node.BitIndex));
};

export const avatarCompletedAllNormalNodes = (avatar, mapNodes) => {
  if (!avatar) return false;
  const required = (mapNodes ?? []).filter((node) => NORMAL_NODE_TYPES.has(node?.NodeType));
  return required.length > 0 && required.every((node) => avatarCompletedNode(avatar, node));
};

/**
 * Normal explicit joins require that exact node. Ultimate joins are stricter:
 * the joining character must have cleared every authored non-Ultimate combat
 * node, including bosses. This is evaluated once at entry, never per tick.
 */
export const activeAvatarEligibleForExplicitJoin = (account, node, mapNodes) => {
  const avatar = account?.account_avatars?.find(
    (candidate) => candidate.id === account.active_avatar
  );
  return isUltimateNode(node)
    ? avatarCompletedAllNormalNodes(avatar, mapNodes)
    : avatarCompletedNode(avatar, node);
};

export class DungeonMatchRegistry {
  constructor({ maxPlayers = MAX_DUNGEON_PLAYERS, publicFloorZeroOnly = true } = {}) {
    this.maxPlayers = maxPlayers;
    this.publicFloorZeroOnly = publicFloorZeroOnly;
    this.nextId = 1;
    this.matches = new Map();
    this.matchByAccount = new Map();
    this.publicByKey = new Map();
  }

  create({ mapNodeId, group = "", privateMatch = false, sourceMatch = null } = {}) {
    const node = Number(mapNodeId ?? sourceMatch?.mapNodeId ?? 0);
    if (!node) throw new Error("a dungeon match needs a map node");
    const match = {
      id: this.nextId++,
      mapNodeId: node,
      group: String(group ?? sourceMatch?.group ?? ""),
      private: Boolean(privateMatch),
      floorIndex: 0,
      members: new Set(),
      state: "forming",
      createdAt: Date.now(),
      world: null,
    };
    this.matches.set(match.id, match);
    if (!match.private) {
      const key = keyOf(match);
      this.publicByKey.set(key, [...(this.publicByKey.get(key) ?? []), match]);
    }
    return match;
  }

  /**
   * The run is over, but its players are still in it.
   *
   * A dungeon that has ended keeps its members while they read the report, so
   * nothing closes the match and it went on advertising itself as joinable. A
   * friend joining it was admitted to a world with no floor left to send, and
   * sat on the loading screen for ever waiting for objects that were never
   * coming.
   *
   * Marked rather than closed, because closing would evict the people reading
   * the report and destroy the world their summary is describing.
   */
  finish(match) {
    if (!match || match.state === "closed" || match.state === "finished") return false;
    match.state = "finished";
    if (!match.private) {
      const key = keyOf(match);
      const remaining = (this.publicByKey.get(key) ?? []).filter((candidate) => candidate !== match);
      if (remaining.length) this.publicByKey.set(key, remaining);
      else this.publicByKey.delete(key);
    }
    return true;
  }

  canJoin(match, { publicSearch = false, adminOverride = false } = {}) {
    if (!match || match.state === "closed" || match.state === "finished") return false;
    const privileged = adminOverride === true;
    const capacity = this.maxPlayers + (privileged ? 1 : 0);
    if (match.members.size >= capacity) return false;
    // Original captures allow explicit late join on later floors. The requested
    // simplification applies only to random/public filling.
    return privileged || !publicSearch || !this.publicFloorZeroOnly || match.floorIndex === 0;
  }

  add(match, session, { adminOverride = false } = {}) {
    if (!this.canJoin(match, { adminOverride })) return false;
    if (!session?.accountId) throw new Error("a matched session needs an account id");
    const previous = this.matchByAccount.get(session.accountId);
    if (previous && previous !== match) this.remove(session);
    match.members.add(session);
    match.state = "active";
    session.dungeonMatch = match;
    this.matchByAccount.set(session.accountId, match);
    return true;
  }

  remove(session) {
    const match = session?.dungeonMatch ?? this.matchByAccount.get(session?.accountId);
    if (!match) return null;
    if (match.world?.detachMember) match.world.detachMember(session);
    else match.members.delete(session);
    if (session?.accountId && this.matchByAccount.get(session.accountId) === match) {
      this.matchByAccount.delete(session.accountId);
    }
    if (session?.dungeonMatch === match) delete session.dungeonMatch;
    if (!match.members.size) this.close(match);
    return match;
  }

  close(match) {
    if (!match || match.state === "closed") return false;
    match.state = "closed";
    this.matches.delete(match.id);
    match.world?.destroy?.();
    if (!match.private) {
      const key = keyOf(match);
      const remaining = (this.publicByKey.get(key) ?? []).filter((candidate) => candidate !== match);
      if (remaining.length) this.publicByKey.set(key, remaining);
      else this.publicByKey.delete(key);
    }
    for (const member of match.members) {
      if (this.matchByAccount.get(member.accountId) === match) this.matchByAccount.delete(member.accountId);
      if (member.dungeonMatch === match) delete member.dungeonMatch;
    }
    match.members.clear();
    return true;
  }

  publicMatch({ mapNodeId, group = "", adminOverride = false }) {
    return (this.publicByKey.get(keyOf({ mapNodeId, group })) ?? []).find((match) =>
      this.canJoin(match, { publicSearch: true, adminOverride })
    );
  }

  explicitTarget({ friendId = 0, mapId = 0 } = {}) {
    if (mapId) return this.matches.get(Number(mapId)) ?? null;
    if (friendId) return this.matchByAccount.get(Number(friendId)) ?? null;
    return null;
  }

  /**
   * Resolves an entry request without building anything yet.
   *
   * A normal explicit target may be joined after floor zero while capacity
   * remains. A full explicit target is a refusal — silently creating a separate
   * run makes a Join Friend action look successful without joining the friend.
   * Eligibility is computed outside the registry from server-owned account and
   * MapPage data and is fail-closed.
   */
  resolve({
    session,
    mapNodeId = 0,
    friendId = 0,
    mapId = 0,
    friendOnly = false,
    group = "",
    eligibleForExplicitJoin = false,
    adminOverride = false,
  }) {
    const privileged = adminOverride === true;
    const target = this.explicitTarget({ friendId, mapId });

    if (target) {
      if (!privileged && !eligibleForExplicitJoin) {
        return {
          match: null,
          created: false,
          source: mapId ? "map" : "friend",
          error: "content_not_completed",
        };
      }
      if (!this.canJoin(target, { adminOverride: privileged })) {
        return {
          match: null,
          created: false,
          source: mapId ? "map" : "friend",
          // Over and full are different refusals, and the client has a
          // different sentence for each. Calling a finished run full would tell
          // somebody to try again later for a game that has ended.
          error:
            target.state === "finished"
              ? "run_finished"
              : mapId
                ? "map_full"
                : "friend_full",
        };
      }
      const match = target;
      this.add(match, session, { adminOverride: privileged });
      return { match, created: false, source: mapId ? "map" : "friend" };
    }

    if (friendId || mapId) {
      return { match: null, created: false, source: friendId ? "friend" : "map", error: "target_not_found" };
    }

    let match = null;
    if (!friendOnly) {
      match = this.publicMatch({
        mapNodeId,
        group,
        adminOverride: privileged,
      });
    }
    if (!match) {
      match = this.create({ mapNodeId, group, privateMatch: Boolean(friendOnly) });
      this.add(match, session, { adminOverride: privileged });
      return { match, created: true, source: friendOnly ? "private" : "public" };
    }

    this.add(match, session, { adminOverride: privileged });
    return { match, created: false, source: "public" };
  }
}

/** Process-wide registry; tests normally construct their own isolated one. */
export const dungeonMatches = new DungeonMatchRegistry();

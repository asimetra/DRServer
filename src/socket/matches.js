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
const DEFAULT_FINISHED_MATCH_TTL_MS = 10 * 60 * 1000;
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
  constructor({
    maxPlayers = MAX_DUNGEON_PLAYERS,
    publicFloorZeroOnly = true,
    finishedMatchTtlMs = DEFAULT_FINISHED_MATCH_TTL_MS,
  } = {}) {
    this.maxPlayers = maxPlayers;
    this.publicFloorZeroOnly = publicFloorZeroOnly;
    this.finishedMatchTtlMs = Math.max(0, Number(finishedMatchTtlMs) || 0);
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
      /** Server-authorized members hidden from ordinary four-slot scorecards. */
      privilegedMembers: new Set(),
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
    if (this.finishedMatchTtlMs > 0) {
      match.finishTimer = setTimeout(() => this.close(match), this.finishedMatchTtlMs);
      match.finishTimer.unref?.();
    }
    return true;
  }

  canJoin(match, { publicSearch = false, adminOverride = false } = {}) {
    if (!match || !["forming", "active"].includes(match.state)) return false;
    const privileged = adminOverride === true;
    const privilegedCount = match.privilegedMembers?.size ?? 0;
    const ordinaryCount = Math.max(0, match.members.size - privilegedCount);
    // The administrator is an out-of-band observer/player and never consumes
    // one of the four native party slots. At most one such member is admitted,
    // regardless of whether it arrived before or after the ordinary party.
    if (privileged ? privilegedCount >= 1 : ordinaryCount >= this.maxPlayers) return false;
    // Original captures allow explicit late join on later floors. The requested
    // simplification applies only to random/public filling.
    return privileged || !publicSearch || !this.publicFloorZeroOnly || match.floorIndex === 0;
  }

  add(match, session, { adminOverride = false } = {}) {
    if (!this.canJoin(match, { adminOverride })) return false;
    if (!session?.accountId) throw new Error("a matched session needs an account id");
    const previous = this.matchByAccount.get(session.accountId);
    if (previous) {
      const previousMember = [...previous.members].find(
        (member) => member.accountId === session.accountId
      );
      // The socket layer normally displaces and tears down the old session
      // first. Keep the registry fail-closed as well: an async admission from
      // that displaced session must not evict or coexist with the live one.
      if (previousMember && (previousMember !== session || previous !== match)) return false;
      if (previousMember === session && previous === match) {
        if (adminOverride === true) match.privilegedMembers?.add(session);
        return true;
      }
      // Repair a stale index that has no corresponding member.
      this.matchByAccount.delete(session.accountId);
    }
    match.members.add(session);
    if (adminOverride === true) match.privilegedMembers?.add(session);
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
    match.privilegedMembers?.delete(session);
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
    clearTimeout(match.finishTimer);
    match.finishTimer = null;
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
      // A finished-room TTL can close while the client still has its report
      // open. Its world binding is gone at this point; the raw per-connection
      // flag must agree or MatchMaker will reject every later entry as a
      // duplicate active dungeon.
      member.dungeonActive = false;
    }
    match.members.clear();
    match.privilegedMembers?.clear();
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
              : target.state === "failed"
                ? "game_not_enterable"
              : mapId
                ? "map_full"
                : "friend_full",
        };
      }
      const match = target;
      if (!this.add(match, session, { adminOverride: privileged })) {
        return {
          match: null,
          created: false,
          source: mapId ? "map" : "friend",
          error: "game_not_enterable",
        };
      }
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
      if (!this.add(match, session, { adminOverride: privileged })) {
        this.close(match);
        return {
          match: null,
          created: false,
          source: friendOnly ? "private" : "public",
          error: "game_not_enterable",
        };
      }
      return { match, created: true, source: friendOnly ? "private" : "public" };
    }

    if (!this.add(match, session, { adminOverride: privileged })) {
      return {
        match: null,
        created: false,
        source: "public",
        error: "game_not_enterable",
      };
    }
    return { match, created: false, source: "public" };
  }
}

/** Process-wide registry; tests normally construct their own isolated one. */
export const dungeonMatches = new DungeonMatchRegistry();

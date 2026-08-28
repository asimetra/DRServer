import { PacketWriter } from "./packet.js";
import { OP } from "./opcodes.js";
import { config } from "../config.js";
import { error, info, warn } from "../log.js";
import { resolveMatchEntry } from "./match-entry.js";
import { joinDungeonMatch, leaveDungeonSession } from "./match-runtime.js";

/**
 * MatchMaker (clid 42) field handling.
 * Field ids are the FLID_* constants in
 * generatedCode/MatchMakerNetworkComponent.hx.
 */
export const FLID = {
  InfiniteDetails: 295,
  ClientRequestEntry: 296,
  ClientRequestEntryResponce: 297,
  RequestExit: 298,
  ClientExitComplete: 299,
  ClientDataFlushExit: 300,
  ClientRequestPartyMemberInvite: 301,
  RequestPartyMemberInvite: 302,
  ClientRequestLeaveParty: 303,
  ClientInformPartyComposition: 304,
};

/**
 * send_ClientRequestEntry: utf demographics, u32 sCode, u32 mapNodeId,
 * u32 friendId, u32 mapId, **u8** friendOnly, utf matchMakerGroup.
 * The friendOnly flag is a single byte (writeByte), not a short.
 */
const readEntryRequest = (reader) => ({
  demographics: reader.utf(),
  sCode: reader.u32(),
  mapNodeId: reader.u32(),
  friendId: reader.u32(),
  mapId: reader.u32(),
  friendOnly: reader.u8(),
  matchMakerGroup: reader.utf(),
});

/**
 * recv_ClientRequestEntryResponce: u16 errorCode, u32 value.
 * A non-zero code makes the client show the "matchmaker refuses" popup and
 * return to town; zero means "accepted", after which it waits for the floor
 * and hero objects before the loading screen will finish.
 */
export const buildEntryResponse = (doid, errorCode, value = 0) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID.ClientRequestEntryResponce)
    .u16(errorCode)
    .u32(value)
    .frame();

/** Production responds to RequestExit with ClientExitComplete(u16 1). */
export const buildExitComplete = (doid, value = 1) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID.ClientExitComplete)
    .u16(value)
    .frame();

/** MatchMaker errors already localized by the shipped client. */
export const ENTRY_ERROR = Object.freeze({
  BAD_MAP_NODE: 104,
  INTERNAL: 105,
  ULTIMATE_IN_PROGRESS: 110,
  UNAUTHORIZED_MAP: 201,
  FRIEND_NOT_FOUND: 500,
  MAP_NOT_FOUND: 501,
  DUNGEON_FULL: 502,
  GAME_NOT_ENTERABLE: 503,
  FRIEND_DUNGEON_FULL: 504,
});

/** Turns server-side reason names into the popup text the client already owns. */
export const entryErrorCodeFor = ({ error: reason, source } = {}) => {
  switch (reason) {
    case "bad_map_node":
      return ENTRY_ERROR.BAD_MAP_NODE;
    case "ultimate_in_progress":
      return ENTRY_ERROR.ULTIMATE_IN_PROGRESS;
    case "content_not_completed":
      return ENTRY_ERROR.UNAUTHORIZED_MAP;
    case "target_not_found":
      return source === "friend" ? ENTRY_ERROR.FRIEND_NOT_FOUND : ENTRY_ERROR.MAP_NOT_FOUND;
    /**
     * `WARNING_FRIEND_GAME_NOT_FOUND` in the client's own loading screen, which
     * is what a finished run is: the friend is there, the game is not.
     */
    case "run_finished":
      return ENTRY_ERROR.MAP_NOT_FOUND;
    case "friend_full":
      return ENTRY_ERROR.FRIEND_DUNGEON_FULL;
    case "map_full":
      return ENTRY_ERROR.DUNGEON_FULL;
    case "game_not_enterable":
      return ENTRY_ERROR.GAME_NOT_ENTERABLE;
    default:
      return ENTRY_ERROR.INTERNAL;
  }
};

export const handleField = (session, fieldId, reader) => {
  switch (fieldId) {
    case FLID.ClientRequestEntry: {
      const request = readEntryRequest(reader);
      info(
        `[${session.id}] dungeon entry requested: mapNode=${request.mapNodeId} ` +
          `mapId=${request.mapId} friendId=${request.friendId} ` +
          `friendOnly=${request.friendOnly} group="${request.matchMakerGroup}"`
      );

      if (!config.dungeonsEnabled) {
        warn(
          `[${session.id}] refusing entry with error ${ENTRY_ERROR.GAME_NOT_ENTERABLE} — ` +
            `dungeons are disabled (DR_DUNGEON=0)`
        );
        session.send(buildEntryResponse(session.matchMakerDoid, ENTRY_ERROR.GAME_NOT_ENTERABLE));
        return true;
      }

      if (session.entryPromise) return true;
      session.entryPromise = (async () => {
        const result = await resolveMatchEntry(session, request);
        if (!result.match) {
          const errorCode = entryErrorCodeFor(result);
          warn(
            `[${session.id}] refusing dungeon entry with ${errorCode}: ` +
              `${result.error ?? "no match"}`
          );
          session.send(buildEntryResponse(session.matchMakerDoid, errorCode));
          return;
        }

        // Production answers before generating the local player/area objects.
        session.send(buildEntryResponse(session.matchMakerDoid, 0, result.match.mapNodeId));
        await joinDungeonMatch(session, result, request);
      })()
        .catch((err) => {
          error(`[${session.id}] dungeon entry failed: ${err.stack ?? err}`);
          leaveDungeonSession(session, { notifyClient: true });
          session.send(buildEntryResponse(session.matchMakerDoid, ENTRY_ERROR.INTERNAL));
        })
        .finally(() => {
          session.entryPromise = null;
        });
      return true;
    }

    case FLID.RequestExit: {
      const value = reader.u32();
      info(`[${session.id}] exit requested value=${value}`);
      if (session.exitPromise) return true;
      session.exitPromise = (async () => {
        try {
          await session.rewardSavePromise;
        } catch (err) {
          warn(`[${session.id}] exiting after reward persistence failed: ${err.message}`);
        }
        leaveDungeonSession(session, { notifyClient: true });
        session.send(buildExitComplete(session.matchMakerDoid));
      })().finally(() => {
        session.exitPromise = null;
      });
      return true;
    }

    default:
      return false;
  }
};

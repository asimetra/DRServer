/**
 * The MatchMaker's wire: its field ids, the entry request it reads, the two
 * answers it sends and the refusal codes the client already has sentences for.
 *
 * Its own module so that everything that answers an entry — the MatchMaker,
 * a door, a session's transitions, a worker going down — speaks it without
 * importing the MatchMaker itself.
 */
import { PacketWriter } from "./packet.js";
import { OP } from "./opcodes.js";

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
export const readEntryRequest = (reader) => ({
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

/** The cohort follows a connection through server-driven doorway entries. */
export const rememberMatchMakerGroup = (session, match) => {
  const group = String(match?.group ?? "");
  session.matchMakerGroup = group;
  return group;
};

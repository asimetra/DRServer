import { config } from "../config.js";
import { info, warn } from "../log.js";
import { ENTRY_ERROR, FLID, buildEntryResponse, readEntryRequest } from "./entry-protocol.js";
import { transitionsOf } from "./session-transitions.js";

export {
  ENTRY_ERROR,
  FLID,
  buildEntryResponse,
  buildExitComplete,
  entryErrorCodeFor,
  rememberMatchMakerGroup,
} from "./entry-protocol.js";

/**
 * The two MatchMaker fields a client sends. What they start — admission, the
 * run, the teardown and every answer — is the session's transition controller
 * (session-transitions.js); this only reads the wire.
 */
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
      transitionsOf(session).requestEntry(request);
      return true;
    }

    case FLID.RequestExit: {
      const value = reader.u32();
      info(`[${session.id}] exit requested value=${value}`);
      transitionsOf(session).requestExit();
      return true;
    }

    default:
      return false;
  }
};

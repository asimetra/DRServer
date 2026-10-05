import { dungeonsClosedBecause } from "../maintenance.js";
import { info, warn } from "../log.js";
import { ENTRY_ERROR, FLID, buildEntryResponse, readEntryRequest } from "./entry-protocol.js";
import { transitionsOf } from "./session-transitions.js";
import { declare, viewFromDemographics } from "../content-packs.js";
import { declaredUiStrings } from "./ui-strings.js";
import { declaredCapabilities } from "./capabilities.js";

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
/**
 * What the client says it has, from the Demographics it sends with every entry
 * request (content-packs.js). Before anything of the run is generated, so the
 * first hero it is shown is already one it can draw.
 */
/** Each reader's own bound on a declaration; past it, or not JSON, it declares nothing. */
const MAX_DEMOGRAPHICS = 4096;

/** The Demographics object, parsed once for the three readers below; null for nothing said. */
const demographicsObject = (value) => {
  if (typeof value !== "string") return value ?? null;
  if (!value || value.length > MAX_DEMOGRAPHICS) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const noteDeclaration = (session, raw) => {
  const demographics = demographicsObject(raw);
  // Which of this server's banner strings the client holds (ui-strings.js).
  session.uiStrings = declaredUiStrings(demographics);
  // What it does itself that the server would otherwise do for it (capabilities.js).
  session.capabilities = declaredCapabilities(demographics);
  const view = viewFromDemographics(demographics);
  if (!view) return;
  if (session.contentView?.key !== view.key) {
    info(`[${session.id}] declares content packs: ${view.key || "none"}`);
  }
  session.contentView = view;
  declare(session.accountId, view);
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
      noteDeclaration(session, request.demographics);

      const closed = dungeonsClosedBecause();
      if (closed) {
        warn(`[${session.id}] refusing entry with error ${ENTRY_ERROR.GAME_NOT_ENTERABLE} — ${closed}`);
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

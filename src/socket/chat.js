/**
 * Chat, which is one string field in both directions.
 *
 * `PlayerGameObject` carries `Chat` on field 182 and `ShowPlayerIsTyping` on
 * 183. A client writes them on its own player object and the server writes them
 * on the speaker's object to everybody else — there is no room id, no channel
 * and no sender field, because the doid is the sender.
 *
 * Two things about the payload are not obvious and both come from the client:
 *
 *   - the speaker's name is *in the message*. `PlayerGameObjectOwner
 *     .handleOutgoingChat` builds `screenName + ": " + text` and sends that, so
 *     the wire reads "Simetra: hehe". Nothing here needs to add a name and
 *     nothing should reformat one.
 *   - the speaker has already seen their own line. The same method calls
 *     `this.Chat(text)` locally before sending, so an echo would double it.
 *
 * The corpus is unambiguous on the second: across 104 outbound chat and typing
 * frames on one account's player doid, not a single one came back inbound.
 */
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { RULE, noteViolation } from "./security-events.js";
import { runCommand } from "./commands.js";

export const FLID_PLAYER_CHAT = 182;
export const FLID_PLAYER_TYPING = 183;

/**
 * `UIChatLog` sets `maxChars = 169` on the input box and the name and ": " are
 * prepended after that, so a real line cannot be much longer. Names are capped
 * well below this, and the slack is deliberate: refusing an honest line is
 * worse than relaying a long one.
 */
const MAX_CHAT_BYTES = 320;

const chatFrame = (doid, text) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_PLAYER_CHAT)
    .utf(text)
    .frame();

const typingFrame = (doid, on) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_PLAYER_TYPING)
    .u8(on ? 1 : 0)
    .frame();

/**
 * The message with the speaker's name taken back off.
 *
 * Split on the first ": " rather than on the account name, because the name on
 * the wire is whatever the client believes it is and this server's idea of it
 * can differ — a rename mid-session, or a screen name we defaulted. A line with
 * no separator at all is taken whole; that is a client we do not know, not a
 * reason to drop what somebody said.
 */
const spokenPart = (line) => {
  const at = line.indexOf(": ");
  return at === -1 ? line : line.slice(at + 2);
};

/** Says it to one person, on their own player object, and to nobody else. */
export const tell = (session, text) => {
  // Both are absent outside a dungeon, which is also where chat does not exist:
  // the client only builds `UIChatLog` on a floor.
  if (!session?.playerDoid) return;
  session.sendDirect?.(chatFrame(session.playerDoid, text));
};

export const handleChat = async (session, reader) => {
  const line = reader.utf();
  if (!line) return;

  if (Buffer.byteLength(line, "utf8") > MAX_CHAT_BYTES) {
    noteViolation(session, RULE.oversizedChat, `${line.length} characters`);
    return;
  }

  const spoken = spokenPart(line);
  // A command is for this server, not for the room: it is answered privately
  // and never relayed. The speaker's own client has already drawn it locally,
  // which is the only trace of it anybody sees.
  if (await runCommand(session, spoken, (message) => tell(session, message))) return;

  session.broadcast?.(chatFrame(session.playerDoid, line), { except: session });
};

export const handleTyping = async (session, reader) => {
  const on = reader.u8();
  session.broadcast?.(typingFrame(session.playerDoid, on), { except: session });
};

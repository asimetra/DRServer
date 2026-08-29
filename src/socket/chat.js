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
import { config } from "../config.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { RULE, noteViolation } from "./security-events.js";
import { runCommand } from "./commands.js";
import { VOICE_COLOUR, giveVoice, say } from "./speech.js";

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

/**
 * The name the server answers under, and why it is a name at all.
 *
 * The client does have a notion of a system line: its chat log colours a whole
 * message by a log *type*, which is how "so-and-so left the dungeon" is drawn
 * differently from speech. That type is not reachable from a server. The only
 * thing that ever sets it is the client's own friend-status feed, and the one
 * path into the log from out here is the chat field on a player object, which
 * always arrives as ordinary speech under that object's name.
 *
 * What is reachable is the name. The log colours the name span by looking at
 * its first character and nothing else — a star is green, a bolt is orange. So
 * the closest thing to a system line this client will draw is a line from
 * somebody who is plainly not a player, and that is what this is.
 *
 * Two of them, because the colouring reads a star and a bolt and nothing else —
 * a warning sign is recognised but returns the default, so there is no third.
 * Two is what there is, and the division worth spending it on is whether the
 * server did what was asked.
 *
 * They are separate speakers rather than one renamed, because the name is fixed
 * when the object is generated: a speaker cannot change colour later without
 * being destroyed and rebuilt on every client in the room.
 */
const SERVER_VOICE = { id: "server", warn: false };
const SERVER_WARN_VOICE = { id: "server-warn", warn: true };

/** A name a deployment did not set, so that a reply always has somebody to be from. */
const DEFAULT_SERVER_NAME = "Server";

/**
 * The colour goes on the front, whatever the name is.
 *
 * It is the mechanism rather than a preference: the client reads the first
 * character of the name and nothing else, so a name choosing its own leading
 * character would decide its own colour by accident — and one that already
 * started with a star would be doubled by prepending another. Any colour
 * already there is taken off first.
 */
export const serverVoiceNameFor = (configured, warn) => {
  const bare = String(configured ?? "")
    .replace(/^[★⚡⚠]+/u, "")
    .trim();
  const name = bare || DEFAULT_SERVER_NAME;
  return `${warn ? VOICE_COLOUR.orange : VOICE_COLOUR.green}${name}`;
};

/**
 * Read at call time, not at module scope.
 *
 * `speech.js` imports this file for the chat field id and for `tell`, so the two
 * are a cycle. Functions across a cycle are fine — by the time one is called
 * both modules have finished evaluating — but `VOICE_COLOUR` read while they
 * still are would be `undefined`, and which of the two loaded first is not
 * something this file decides.
 */
const serverVoiceName = (warn) => serverVoiceNameFor(config.serverName, warn);

/**
 * Answers one person as the server rather than as themselves.
 *
 * A command reply used to be written on the caller's own player object, which
 * is the same frame their own speech uses — so the answer to `/who` read as
 * though they had typed it. Written on a speaker of its own it reads as a
 * reply, and costs one bodiless player object per floor.
 *
 * Falls back to the caller's own object when there is nothing to allocate a
 * speaker from, because losing the answer entirely is worse than mis-attributing
 * it.
 */
export const tellAsServer = (session, text, { warn = false } = {}) => {
  const voice = warn ? SERVER_WARN_VOICE : SERVER_VOICE;
  const speaker = giveVoice(session, { id: voice.id, name: serverVoiceName(voice.warn) });
  if (!speaker?.doid) {
    tell(session, text);
    return;
  }
  say(session, voice.id, text);
};

/**
 * The reply a command is handed: call it to answer, `.warn` to refuse.
 *
 * A refusal is not something a command can be trusted to signal by shape. Four
 * of the five `if (...) return reply(...)` lines in the command set are
 * refusals and the fifth is an ordinary answer written with an early return, so
 * guessing from the pattern would have coloured a health readout as an error.
 */
export const serverReplyFor = (session) => {
  const reply = (text) => tellAsServer(session, text);
  reply.warn = (text) => tellAsServer(session, text, { warn: true });
  return reply;
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
  if (await runCommand(session, spoken, serverReplyFor(session))) return;

  session.broadcast?.(chatFrame(session.playerDoid, line), { except: session });
};

export const handleTyping = async (session, reader) => {
  const on = reader.u8();
  session.broadcast?.(typingFrame(session.playerDoid, on), { except: session });
};

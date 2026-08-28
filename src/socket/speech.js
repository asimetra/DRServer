/**
 * Giving a thing on the floor a voice.
 *
 * This exists because the *channel* is uncertain and the *map* must not be. A
 * tile says "this one can talk"; how talking happens is settled here and
 * nowhere else, so changing it does not touch a single authored floor.
 *
 * What the channels are, measured rather than assumed:
 *
 *   - An NPC cannot say anything. It has fifteen fields and none is a name.
 *     `NPCView` does build a nametag when the row asks for a healthbar, and the
 *     balloon lives on that nametag — but the only thing that ever calls
 *     `Chat()` is a listener `HeroGameObject` registers against its own
 *     `playerID`, and an NPC has no playerID to register.
 *   - A hero can, and shows a balloon. But a monster's body and a balloon
 *     cannot be combined: `mBody`, `mEffect` and `mNametag` are children of one
 *     root and `scale` scales that root, so hiding the hero takes the words
 *     with it, and neither class has a visibility field.
 *   - A *player object* can be had on its own. `PlayerGameObject.Chat` raises
 *     two events — a balloon keyed to a hero's playerID, and a log line carrying
 *     the object's own name. With no hero listening the first goes nowhere
 *     without complaint, and the second arrives correctly attributed.
 *
 * So each speaker gets a player object and no body. It is what makes the line
 * read as somebody else's rather than as the listener's own, and it is what
 * puts the colour in the right place.
 */
import { CLID, OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { heroGenerate, playerGenerate, objectDisable } from "./objects.js";
import { FLID_PLAYER_CHAT, tell } from "./chat.js";
import { warn } from "../log.js";

/**
 * A name the chat log will colour.
 *
 * `PlayerSpecialStatus.getSpecialTextColor` reads the first character of the
 * speaker's name and nothing else: a star is #05CE78 green, a bolt is #FF6823
 * orange, and everything else takes the default #FFC988. It is the game's own
 * mechanism — presumably for staff — and it is available to anything this
 * server names.
 */
export const VOICE_COLOUR = Object.freeze({ green: "★", orange: "⚡", plain: "" });

const chatFrame = (doid, text) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_PLAYER_CHAT)
    .utf(text)
    .frame();

/**
 * Registers a placement as something that can talk, and gives it the object it
 * talks through.
 *
 * Called for any placement carrying a `voice`, whatever kind it is — the point
 * is that nothing here asks what it is, so a keeper, a statue and a signpost
 * are one case.
 *
 * The player object is generated to the whole room rather than to one socket:
 * everybody has to know who is speaking, even though each line is said to one
 * person.
 */
export const giveVoice = (session, { id, name, hero = null, position = null }) => {
  if (!id || !name) return null;
  session.speakers ??= new Map();
  if (session.speakers.has(id)) return session.speakers.get(id);

  const doid = session.allocateDoid?.(CLID.PlayerGameObject);
  if (!doid) {
    // Without an object of its own a speaker can still be named in the text;
    // it just loses the attribution the client would have drawn.
    session.speakers.set(id, { id, name, doid: null, heroDoid: null });
    return session.speakers.get(id);
  }

  const zone = session.dungeonZone ?? 10;
  session.objects?.set(doid, CLID.PlayerGameObject);
  session.broadcast?.(
    playerGenerate({ doid, parent: session.areaDoid ?? 0, zone, screenName: name })
  );

  /**
   * A body, if the map asked for one.
   *
   * This is the difference between a line in the log and a balloon over
   * somebody's head, and the log is closed most of the time — so a character
   * meant to be talked to wants a body. It has to be a *hero*: the balloon is
   * raised by a listener `HeroGameObject` registers against its own `playerID`,
   * which is why it must point back at the object above.
   *
   * The cost is the artwork. Heroes are the six the game ships, so a keeper
   * looks like a ranger rather than like a knight, and anything that wants a
   * monster's body gives up the balloon. The map chooses, not this module.
   */
  const heroDoid = hero && position ? session.allocateDoid?.(CLID.HeroGameObject) : null;
  if (heroDoid) {
    session.objects?.set(heroDoid, CLID.HeroGameObject);
    session.broadcast?.(
      heroGenerate({
        doid: heroDoid,
        parent: session.floorDoid ?? 0,
        zone,
        heroType: hero.heroType,
        skinType: hero.skinType,
        playerId: doid,
        screenName: name,
        position,
        // Nothing fights it and nothing heals it; a full bar is the honest one.
        hitPoints: hero.hitPoints ?? 100,
      })
    );
  }

  const speaker = { id, name, doid, heroDoid };
  session.speakers.set(id, speaker);
  return speaker;
};

/** Speakers belong to a floor, and go when it does. */
export const forgetVoices = (session) => {
  for (const speaker of session.speakers?.values() ?? []) {
    for (const doid of [speaker.heroDoid, speaker.doid]) {
      if (!doid) continue;
      session.objects?.delete(doid);
      try {
        session.broadcast?.(objectDisable(doid));
      } catch (error) {
        warn(`speech: could not retire ${speaker.name}: ${error.message}`);
      }
    }
  }
  session.speakers?.clear();
};

/** Who this is, or null if nothing on this floor answers to that id. */
export const speakerOf = (session, id) => session.speakers?.get(id) ?? null;

/**
 * Says something as that speaker, to one listener.
 *
 * Written on the speaker's own object, so the client attributes it to that name
 * and colours the name's own span. Said to one socket rather than broadcast: a
 * keeper greeting somebody is not an announcement.
 *
 * Falls back to the room's voice when the speaker has no object, which keeps a
 * line from being lost over a cosmetic failure.
 */
export const say = (session, id, text) => {
  const speaker = speakerOf(session, id);
  if (!speaker || !text) return false;
  if (!speaker.doid) {
    tell(session, `${speaker.name}: ${text}`);
    return true;
  }
  session.sendDirect?.(chatFrame(speaker.doid, `${speaker.name}: ${text}`));
  return true;
};

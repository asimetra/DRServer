/**
 * One room's worth of talking, across all of them.
 *
 * The game has no channel that reaches past the floor you are standing on, and
 * that absence is felt more than any missing feature this server has added:
 * players who are not in the same dungeon cannot say anything to each other at
 * all. It costs nothing on the client, because chat is already a string on a
 * player object and this only changes which objects it is written to.
 *
 * Opt-in, because it should be. Ordinary chat stays where it was said — a
 * dungeon is a conversation between the people in it, and a server that
 * broadcast every line of it would be unusable in a fight.
 *
 * The awkward part is attribution, and it is the reason `speech.js` exists. A
 * player in another dungeon has no object on your client and therefore no name
 * to hang a line on, so each listener is given a bodiless player object for the
 * speaker the first time they say something. After that the line is theirs: the
 * right name, coloured in the right place, indistinguishable from somebody
 * standing next to you.
 */
import { info } from "../log.js";
import { activeSessions } from "./presence.js";
import { giveVoice, say } from "./speech.js";

/** How the speaker is known to everyone else's floor, for as long as it lasts. */
const voiceIdFor = (accountId) => `global:${accountId}`;

/**
 * Whether a session can be spoken to.
 *
 * The client only builds its chat log on a floor, so a player at a loading
 * screen or on the map has nowhere to put a line. Sending one is not harmful,
 * but it is a line they will never see, and counting it as delivered would make
 * the speaker think they were heard.
 */
const canHear = (session) => Boolean(session?.playerDoid && session?.floorDoid);

/**
 * Says something to everybody who can hear it, as the person who said it.
 *
 * Not to the speaker: their own client drew the line locally the moment they
 * pressed enter, exactly as it does for ordinary chat, and echoing would double
 * it. Returns how many people it reached, which is what makes the difference
 * between talking and talking to yourself worth saying out loud.
 */
export const sayGlobally = (speaker, text) => {
  const account = Number(speaker?.accountId ?? 0);
  const name = speaker?.dungeonAccount?.name ?? `Player${account || "?"}`;
  const id = voiceIdFor(account);
  let heard = 0;

  for (const connection of activeSessions()) {
    /**
     * By account rather than by identity. Presence holds *connections* and a
     * caller inside a dungeon holds a world *context* — two objects for one
     * player — so comparing references would never match and the speaker would
     * be told what they had just said.
     */
    if (Number(connection.accountId) === account) continue;
    // Chat belongs to whoever is on a floor, and a floor is a world context —
    // the raw connection has no objects of its own to speak through.
    const listener = connection.world?.contextFor?.(connection) ?? connection;
    if (!canHear(listener)) continue;

    giveVoice(listener, { id, name });
    if (say(listener, id, text)) heard += 1;
  }

  info(`[${speaker?.id ?? "?"}] global: ${name}: ${text} (${heard} heard)`);
  return heard;
};

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
import { config } from "../config.js";
import { isRestricted } from "../restrictions.js";
import { info } from "../log.js";
import { ignoredIdsOf } from "../social.js";
import { activeSessions } from "./presence.js";
import { giveVoice, say } from "./speech.js";

/**
 * How often one account may speak here: as shipped, three lines at once, then
 * one every two seconds (`globalChatBurst`, `globalChatLineSeconds`). One line
 * is a frame to everybody on a floor anywhere, so with nothing but the socket's
 * own packet ceiling one player could send thousands a minute to everyone. Kept
 * by the main thread, which every line passes through whether or not match
 * workers run, so a player cannot reset it by walking into a dungeon on another
 * worker.
 */
const allowances = new Map();

/** Whether this account may say a line now; takes it from the allowance if so. */
export const admitGlobalLine = (account, now = Date.now()) => {
  const lineEveryMs = (config.globalChatLineSeconds ?? 2) * 1000;
  const linesSaved = config.globalChatBurst ?? 3;
  const id = Number(account);
  const last = allowances.get(id);
  const saved = last
    ? Math.min(linesSaved, last.saved + (now - last.at) / lineEveryMs)
    : linesSaved;
  if (saved < 1) return false;
  allowances.set(id, { saved: saved - 1, at: now });
  // Somebody whose allowance has refilled is somebody who can be forgotten.
  if (allowances.size > 4096) {
    for (const [key, entry] of allowances) {
      if (now - entry.at >= lineEveryMs * linesSaved) allowances.delete(key);
    }
  }
  return true;
};

/** Test seam: the allowances are process-wide. */
export const forgetGlobalAllowances = () => allowances.clear();

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
  // A restricted account is not heard here (restrictions.js).
  if (isRestricted(speaker?.dungeonAccount)) return null;
  // Null rather than zero: over the allowance is not the same as unheard.
  if (!admitGlobalLine(account)) return null;
  const name = speaker?.dungeonAccount?.name ?? `Player${account || "?"}`;
  const heard = deliverGlobalLine({ account, name, text }, activeSessions());
  info(`[${speaker?.id ?? "?"}] global: ${name}: ${text} (${heard} heard)`);
  return heard;
};

/**
 * The delivering half, over whichever connections this thread holds.
 *
 * Separate so that a match worker can say a line to the players in its own
 * dungeons: the roll of everybody lives on the main thread, and a line said in
 * one worker reaches the others by being handed to each of them in turn.
 */
export const deliverGlobalLine = ({ account, name, text }, connections) => {
  const id = voiceIdFor(account);
  let heard = 0;

  for (const connection of connections) {
    /**
     * By account rather than by identity. Presence holds *connections* and a
     * caller inside a dungeon holds a world *context* — two objects for one
     * player — so comparing references would never match and the speaker would
     * be told what they had just said.
     */
    if (Number(connection.accountId) === Number(account)) continue;
    // Chat belongs to whoever is on a floor, and a floor is a world context —
    // the raw connection has no objects of its own to speak through.
    const listener = connection.world?.contextFor?.(connection) ?? connection;
    if (!canHear(listener)) continue;
    // Nor to somebody who has blocked the speaker: the line arrives on a voice
    // this server made, so the client has nothing it could filter it by.
    if (ignoredIdsOf(listener.dungeonAccount).includes(Number(account))) continue;

    giveVoice(listener, { id, name });
    if (say(listener, id, text)) heard += 1;
  }
  return heard;
};

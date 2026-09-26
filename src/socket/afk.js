/**
 * A hero nobody is playing.
 *
 * The official server marked it: 30 seconds after a hero last moved, turned or
 * attacked, HeroGameObject field 167 went to 1 for the whole party and the
 * client wrote "Zzz..." over the name; the first move afterwards put it back
 * to 0. Across the official socket captures the marker came 29.5 to 34.9
 * seconds after the last such packet, which is a 30-second limit read on a
 * five-second clock, and chat never cleared it.
 *
 * Here the player is also told why, and a minute of it sends them back to
 * town the way their own exit would — standing at the entrance while the
 * party plays is not playing. Neither applies to a hub, which is a place to
 * stand, nor to a hero that cannot move: dead and waiting for a revive, or
 * done, with the run finished and the report coming.
 */
import { config } from "../config.js";
import { info, warn } from "../log.js";
import { tellAsServer } from "./chat.js";
import { matchHost } from "./match-host.js";
import { isHubNode } from "./matches.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";

export const FLID_HERO_SET_AFK = 167;

/** How often the clock is read; the official marker arrived on the same beat. */
const CHECK_MS = 5000;

export const heroAfkUpdate = (heroDoid, afk) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(FLID_HERO_SET_AFK)
    .u8(afk ? 1 : 0)
    .frame();

const announce = (session, afk) => {
  if (!session.heroDoid) return;
  const frame = heroAfkUpdate(session.heroDoid, afk);
  // Everybody on the floor, the idle player included: the owner's own
  // nametag carries the marker as well.
  if (typeof session.broadcast === "function") session.broadcast(frame);
  else session.send?.(frame);
};

/**
 * Short, and from the server's own speaker: written on the player's object it
 * read as the player's own line, with its first word taken for a name.
 */
const warningLine = () =>
  `Idle. Move within ${Math.round((config.afkKickMs - config.afkWarnMs) / 1000)}s or you return to town.`;

/**
 * Standing still says nothing about the player right now: dead, or the run
 * over — won, lost with the banner up, or the report on screen. Sending
 * somebody home then would only add an exit to an ending already under way.
 */
const excused = (session) =>
  !session.dungeonActive ||
  !session.heroDoid ||
  Boolean(session.actors?.get(session.heroDoid)?.dead) ||
  Boolean(session.floorFinished) ||
  Boolean(session.summaryTimer) ||
  Boolean(session.summaryDoid);

/** The hero moved, turned or attacked: the clock starts again, and the marker goes. */
export const noteActivity = (session, at = Date.now()) => {
  const idle = session.idleState;
  if (!idle) return;
  idle.lastActiveAt = at;
  if (idle.marked) {
    idle.marked = false;
    announce(session, false);
  }
};

/** One read of the clock. Exported so a test can turn it by hand. */
export const checkIdle = (session, at = Date.now()) => {
  const idle = session.idleState;
  if (!idle || idle.sendingHome) return;
  if (excused(session)) {
    // Time that could not be played does not count once it ends.
    idle.lastActiveAt = at;
    return;
  }
  const idleFor = at - idle.lastActiveAt;
  const place = isHubNode(session.mapPage);
  if (!idle.marked && idleFor >= config.afkWarnMs) {
    idle.marked = true;
    announce(session, true);
    if (!place && config.afkKickMs > config.afkWarnMs) tellAsServer(session, warningLine(), { warn: true });
    info(`[${session.id}] idle for ${Math.round(idleFor / 1000)}s — marked AFK`);
  }
  if (!place && config.afkKickMs > 0 && idleFor >= config.afkKickMs) {
    idle.sendingHome = true;
    info(`[${session.id}] idle for ${Math.round(idleFor / 1000)}s — sent back to town`);
    Promise.resolve(matchHost().sendHome(session)).catch((problem) =>
      warn(`[${session.id}] could not send an idle player home: ${problem.message}`)
    );
  }
};

/**
 * Watches one member for one floor, as the Mana trickle does; returns the
 * stopper. A new floor starts a new watch, since its hero is a new object that
 * the client draws awake.
 */
export const startAfkWatch = (
  session,
  { now = Date.now, schedule = setInterval, cancel = clearInterval } = {}
) => {
  if (!(config.afkWarnMs > 0)) return () => {};
  session.idleState = { lastActiveAt: now(), marked: false, sendingHome: false };
  // Never slower than the limit itself, so a short limit is still honoured.
  const timer = schedule(() => checkIdle(session, now()), Math.min(CHECK_MS, config.afkWarnMs));
  timer?.unref?.();
  return () => {
    cancel(timer);
    session.idleState = null;
  };
};

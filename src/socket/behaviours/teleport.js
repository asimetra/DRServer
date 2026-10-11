import { bodyClearSpot, bodyRadius, bodyWalkClear, standoff } from "../body.js";
import { objectDisable } from "../objects.js";
import { OP } from "../opcodes.js";
import { PacketWriter } from "../packet.js";
import { searchAgain } from "../routing.js";

/**
 * A teleporter's cycle: TELEPORT_AI with a `TeleportRecurT`, the specters and
 * the shadow wolf pet. It fights from where it stands, and after each swing
 * leaves and comes back somewhere else round its victim. One phase at a time,
 * in `ai.teleportPhase`:
 *
 *   visible       it fights as anything else does; its first swing of a
 *                 cycle waits `PreTeleportAttack`;
 *   post-attack   it swung, and stands for `PostTeleportAttack`
 *                 ("teleport-wait");
 *   teleport-out  the out animation plays (`teleportOutDelayMs`), then the
 *                 object is disabled ("teleport-out");
 *   hidden        off the floor (`actor.teleportHidden`) for `TeleportRecurT`
 *                 and a roll of `TeleportRecurRand`, then made again at a
 *                 clear point of its range round its victim ("teleport-in").
 *
 * The AI asks it three things, at the three points of the tick where they
 * belong: a hidden one whether it comes back (`comeBack`), before anything
 * else, since one off the floor is not released, noticed or lost; a visible
 * one in the fight what its phase does this tick (`teleportTurn`); and one
 * that has swung starts waiting (`teleportSwung`).
 */

const npcTimelineAction = (doid, timeline) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(145) // DistributedNPCGameObject.ReceiveTimelineAction
    .utf(timeline)
    .frame();

/** Whether it teleports on a cycle: a TELEPORT_AI row with a recurrence, and a body the floor can make again. */
export const teleportsOnCycle = (actor) =>
  actor.ai.behavior === "TELEPORT_AI" &&
  (actor.ai.teleportRecurMs ?? 0) > 0 &&
  typeof actor.teleportRegenerate === "function";

/** A clear authored-range point around the target for one teleport cycle; `bodies` is `contact` with the victim. */
const teleportDestinationFor = (session, actor, target, bodies, random) => {
  const maximum = standoff(actor, bodies, Number(actor.ai.teleportRange ?? 0));
  const minimum = Math.min(maximum, Math.max(bodies, maximum * 0.5));
  const radius = bodyRadius(actor);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const distance = minimum + (maximum - minimum) * random();
    const desired = {
      x: target.x + Math.cos(angle) * distance,
      y: target.y + Math.sin(angle) * distance,
    };
    if (!session.navigation) return desired;
    const clear = bodyClearSpot(
      session.navigation,
      actor,
      desired,
      radius,
      {
        reach: Math.max(60, maximum * 0.5),
        towards: target,
        accept: (candidate) => bodyWalkClear(session.navigation, actor, candidate, target, radius),
      }
    );
    if (clear) return clear;
  }
  return { ...actor.position };
};

/**
 * A hidden one's tick: nothing until it is due back, then made again at a
 * clear point of its range round `target`, facing it, with the first swing
 * of the new cycle held back. True when it came back.
 */
export const comeBack = (session, doid, actor, target, bodies, now) => {
  const { ai } = actor;
  if (now < (ai.teleportReturnAt ?? Infinity)) return false;
  const random = session.random ?? Math.random;
  const destination = teleportDestinationFor(session, actor, target, bodies, random);
  actor.position.x = destination.x;
  actor.position.y = destination.y;
  actor.heading =
    (Math.atan2(target.y - destination.y, target.x - destination.x) * 180) / Math.PI;
  actor.teleportHidden = false;
  ai.teleportPhase = "visible";
  ai.teleportHideAt = 0;
  ai.teleportReturnAt = 0;
  ai.teleportCycleStarted = true;
  ai.nextAttackAt = now + (ai.preTeleportAttackMs ?? 0);
  searchAgain(ai);
  ai.walkSpeed = 0;
  actor.teleportRegenerate(destination, actor.heading);
  session.send(npcTimelineAction(doid, ai.teleportInTimeline ?? "TELEPORT_IN"));
  return true;
};

/**
 * A visible one's tick once it is in the fight, by phase: `{ said }` when the
 * phase has the tick — `said` the state it shows, or null for none new — and
 * null when the tick is the fight's. Its first tick in a fight starts the
 * cycle, holding its first swing back by `PreTeleportAttack`.
 */
export const teleportTurn = (session, doid, actor, now) => {
  const { ai } = actor;
  if (!ai.teleportCycleStarted) {
    ai.teleportCycleStarted = true;
    ai.nextAttackAt = Math.max(
      ai.nextAttackAt ?? 0,
      now + (ai.preTeleportAttackMs ?? 0)
    );
  }
  switch (ai.teleportPhase) {
    case "post-attack":
      if (now < (ai.teleportHideAt ?? 0)) return { said: "teleport-wait" };
      ai.teleportPhase = "teleport-out";
      ai.teleportDisableAt = now + Math.max(0, Number(ai.teleportOutDelayMs ?? 1000));
      session.send(npcTimelineAction(doid, ai.teleportOutTimeline ?? "TELEPORT_OUT"));
      return { said: "teleport-out" };
    case "teleport-out": {
      if (now < (ai.teleportDisableAt ?? Infinity)) return { said: null };
      const random = session.random ?? Math.random;
      actor.teleportHidden = true;
      ai.teleportPhase = "hidden";
      ai.teleportDisableAt = 0;
      ai.teleportReturnAt =
        now +
        (ai.teleportRecurMs ?? 0) +
        random() * (ai.teleportRecurRandMs ?? 0);
      session.send(objectDisable(doid));
      return { said: "teleport-hidden" };
    }
    default:
      return null;
  }
};

/** It swung: it stands for `PostTeleportAttack`, then goes. */
export const teleportSwung = (ai, now) => {
  ai.teleportPhase = "post-attack";
  ai.teleportHideAt = now + (ai.postTeleportAttackMs ?? 0);
};

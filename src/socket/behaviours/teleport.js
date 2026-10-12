import { bodyClearSpot, bodyRadius, bodyWalkClear, standoff } from "../body.js";
import { objectDisable } from "../objects.js";
import { OP } from "../opcodes.js";
import { PacketWriter } from "../packet.js";
import { swingDueAt } from "../npc-act.js";
import { searchAgain } from "../routing.js";
import { restWalk } from "./chase.js";

/**
 * A teleporter's cycle: TELEPORT_AI with a `TeleportRecurT`, the specters and
 * the shadow wolf pet. Each visible period runs on its own clock, swing or
 * not: it appears, waits `PreTeleportAttack`, has its attack moment — a swing
 * if the attack gate lets it (in reach, in sight, due) — stands
 * `PostTeleportAttack` from that moment, goes out, is hidden `TeleportRecurT`
 * and a roll of `TeleportRecurRand`, and comes back at a clear point of its
 * range round its victim, or where it went out when there is none. One phase
 * at a time, in `ai.teleportPhase`:
 *
 *   visible       it fights as anything else does, its swing held until the
 *                 attack moment (`teleportAttackAt`);
 *   attack-moment the tick of the attack moment: the fight has it, and the
 *                 cycle moves on whatever the swing did (`teleportAttacked`);
 *   post-attack   it stands for `PostTeleportAttack` ("teleport-wait");
 *   teleport-out  the out animation plays (`teleportOutDelayMs`), then the
 *                 object is disabled ("teleport-out");
 *   hidden        off the floor (`actor.teleportHidden`) until it comes back
 *                 ("teleport-in").
 *
 * The official leaves on that clock. Over 7 solo captures, 208 of 350
 * TELEPORT_OUTs came in a visible period with no swing, and 146 from a
 * specter that never swung; the time from appearing to going out is the
 * same swung or not (PURPLE_SPECTER p50 4.8 s swung, n 97, and 4.9 s not,
 * n 154; RED 3.3 and 3.3 s), on Pre + Post (4.5 and 3.0 s) and a little.
 * Ours waited for a swing: 0 of 271 outs without one, visible for a p50 of
 * 10.6 s and up to a minute, staring at a hero it could not reach.
 *
 * And it starts by going: a specter standing where the floor put it is
 * disabled, no out animation, about 0.4 s after its victim first comes
 * within its aggro radius, and comes back with TELEPORT_IN some 2.5 s later,
 * 87-92% of the time. So the first tick of a fight hides it (`teleportTurn`).
 *
 * The AI asks it four things, at the points of the tick where they
 * belong: a hidden one, once the AI has seen it is still in its fight (its
 * DisengageDist, its target), whether it comes back (`comeBack`); a visible
 * one in the fight what its phase does this tick (`teleportTurn`); after the
 * fight's act, one at its attack moment moves on (`teleportAttacked`); and
 * one that lets go of its fight, hidden or going out, stands down
 * (`standDown`).
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
  ai.teleportAttackAt = now + (ai.preTeleportAttackMs ?? 0);
  swingDueAt(ai, ai.teleportAttackAt);
  searchAgain(ai);
  restWalk(ai);
  actor.teleportRegenerate(destination, actor.heading);
  session.send(npcTimelineAction(doid, ai.teleportInTimeline ?? "TELEPORT_IN"));
  return true;
};

/**
 * It has let go of its fight (ai.js `letGo`): its cycle is over. Off the
 * floor, it comes back where it went out, facing as it was; going out, it
 * comes back in; and it stands visible until its next fight, which starts
 * the cycle again by going. Left as it was, a specter let go while hidden
 * reappeared beside its victim wherever he had run, and a shadow wolf whose
 * fight ended while it was hidden stayed off the floor.
 */
export const standDown = (session, doid, actor) => {
  const { ai } = actor;
  if (actor.teleportHidden) {
    actor.teleportHidden = false;
    actor.teleportRegenerate(actor.position, actor.heading);
    session.send(npcTimelineAction(doid, ai.teleportInTimeline ?? "TELEPORT_IN"));
  } else if (ai.teleportPhase === "teleport-out") {
    session.send(npcTimelineAction(doid, ai.teleportInTimeline ?? "TELEPORT_IN"));
  }
  ai.teleportPhase = "visible";
  ai.teleportHideAt = 0;
  ai.teleportReturnAt = 0;
  ai.teleportDisableAt = 0;
  ai.teleportCycleStarted = false;
};

/** Off the floor until `TeleportRecurT` and a roll of `TeleportRecurRand` from now. */
const hide = (session, doid, actor, now) => {
  const { ai } = actor;
  const random = session.random ?? Math.random;
  actor.teleportHidden = true;
  ai.teleportPhase = "hidden";
  ai.teleportDisableAt = 0;
  ai.teleportReturnAt = now + (ai.teleportRecurMs ?? 0) + random() * (ai.teleportRecurRandMs ?? 0);
  session.send(objectDisable(doid));
};

/**
 * A visible one's tick once it is in the fight, by phase: `{ said }` when the
 * phase has the tick — `said` the state it shows, or null for none new — and
 * null when the tick is the fight's. Its first tick in a fight starts the
 * cycle by going, with no out animation.
 */
export const teleportTurn = (session, doid, actor, now) => {
  const { ai } = actor;
  if (!ai.teleportCycleStarted) {
    ai.teleportCycleStarted = true;
    hide(session, doid, actor, now);
    return { said: "teleport-hidden" };
  }
  switch (ai.teleportPhase) {
    case "visible":
      // Its attack moment: the fight has this tick, and the cycle goes on after it.
      if (now >= (ai.teleportAttackAt ?? 0)) ai.teleportPhase = "attack-moment";
      return null;
    case "post-attack":
      if (now < (ai.teleportHideAt ?? 0)) return { said: "teleport-wait" };
      ai.teleportPhase = "teleport-out";
      ai.teleportDisableAt = now + Math.max(0, Number(ai.teleportOutDelayMs ?? 1000));
      session.send(npcTimelineAction(doid, ai.teleportOutTimeline ?? "TELEPORT_OUT"));
      return { said: "teleport-out" };
    case "teleport-out":
      if (now < (ai.teleportDisableAt ?? Infinity)) return { said: null };
      hide(session, doid, actor, now);
      return { said: "teleport-hidden" };
    default:
      return null;
  }
};

/** Its attack moment has passed, swung or not: it stands for `PostTeleportAttack`, then goes. */
export const teleportAttacked = (ai, now) => {
  if (ai.teleportPhase !== "attack-moment") return;
  ai.teleportPhase = "post-attack";
  ai.teleportHideAt = now + (ai.postTeleportAttackMs ?? 0);
};

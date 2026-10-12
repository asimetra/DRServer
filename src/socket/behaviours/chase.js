import { standoff } from "../body.js";

/**
 * The ordinary walk: along the route to the victim, ending where the bodies
 * meet. A chaser does nothing else (CHASE_AI, and the teleporters, beasts and
 * allies between their own moments); a kiter walks so when it is not backing
 * off, and a pet when it is not backing out, at its full speed.
 *
 * What a behaviour asks for in a tick is an intent: `{ x, y }`, the step it
 * wants before the crowd and the scenery have their say (`stepNpc`,
 * npc-move.js), `walking` when that step is the ramped walk (the ramp starts
 * again from standing on any tick it is not), `steering` when it is a walk
 * straight at a target it cannot see, `away` when it is a kiter's
 * back-off, and `throughBodies` when the other monsters do not hold the
 * step (npc-move.js): its attack's own move (behaviours/overrides.js
 * `swingIntent`), or its way out of the scenery. `STILL` asks for nothing.
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);
const NPC_WALK_ACCELERATION_SECONDS = 0.9;

export const STILL = Object.freeze({ x: 0, y: 0, walking: false, steering: false, away: null, throughBodies: false });

/**
 * Ramps an NPC's ordinary walk up to its authored movement speed.
 *
 * Official captures still reach each NPC row's `BaseMove`, but cover about
 * 0.67 of that distance during the first second of a run. Starting at full
 * speed covered 0.90 locally and made every re-engaging pack snap onto the
 * player. Four 250 ms server turns with a 0.9-second ramp cover two thirds of
 * the authored first-second distance, matching the official 0.67 envelope and
 * its transform cadence. Attack lunges and player-owned pets have their own
 * movement rules and deliberately do not use this ramp.
 */
export const npcWalkingSpeed = (ai, targetSpeed, deltaSeconds) => {
  const target = Math.max(0, Number(targetSpeed) || 0);
  if (!(target > 0)) {
    ai.walkSpeed = 0;
    return 0;
  }
  const current = Math.max(0, Math.min(target, Number(ai.walkSpeed) || 0));
  const step = target * Math.max(0, Number(deltaSeconds) || 0) /
    NPC_WALK_ACCELERATION_SECONDS;
  ai.walkSpeed = Math.min(target, current + step);
  return ai.walkSpeed;
};

/** It stands: its next walk sets off from standing (`npcWalkingSpeed`, the one writer of `ai.walkSpeed`). */
export const restWalk = (ai) => {
  ai.walkSpeed = 0;
};

/**
 * The walk ends where the bodies meet, not where the swing starts.
 *
 * Stopping at `attackRange` drew every pack as a ring of the same radius
 * with the player alone in the middle: a halberd knight held 140 off, a
 * marksman 600, and a whole wave of one kind at identical range from the
 * player and from each other. The official does not do that — see
 * `standoff` (body.js) for the corpus that says where it does stop — and the
 * range is only ever asked one question, which is whether the thing may
 * swing from where it now stands. That question is `act`'s (npc-act.js).
 *
 * A pet walking back to its owner stops at its `ReturnDist` instead
 * (behaviours/pet.js `walkBackEndsAt`).
 */
export const walkEndsAt = (actor, bodies) => standoff(actor, bodies);

/**
 * The walk along `turn.route` this tick: to its waypoint, or at the target
 * itself as far as the walk's end (`turn.stopAt`). `ramped` is a monster's
 * walk (`npcWalkingSpeed`); a pet's is at its full speed.
 */
export const walkTowards = (turn, ramped) => {
  const { ai, actor, route, distance, stopAt, topSpeed, deltaSeconds } = turn;
  // The waypoint is the target itself: in sight, or walked at straight.
  const headsAtTarget = route.straight || route.steers;
  if (!(route.waypoint && (distance > stopAt || !headsAtTarget))) return STILL;
  const waypointDistance = distanceTo(actor.position, route.waypoint);
  // At the target itself the walk ends at the standoff; at a point on
  // the way, or the way out of the scenery, it ends there.
  const remaining = headsAtTarget ? Math.max(0, distance - stopAt) : waypointDistance;
  const walked = waypointDistance > 0.001;
  // Standing at its waypoint, as at the end of a route that ends short, it
  // is not walking: its ramp does not build to set off at full speed later.
  if (!walked || !(remaining > 0)) {
    return { ...STILL, steering: route.steers, throughBodies: Boolean(route.escaping) };
  }
  const speed = ramped ? npcWalkingSpeed(ai, topSpeed, deltaSeconds) : topSpeed;
  const chaseTravel = Math.min(speed * deltaSeconds, remaining);
  return {
    x: walked ? ((route.waypoint.x - actor.position.x) / waypointDistance) * chaseTravel : 0,
    y: walked ? ((route.waypoint.y - actor.position.y) / waypointDistance) * chaseTravel : 0,
    walking: ramped,
    // Walking straight at a target it cannot see, the step is held to the
    // scenery: see `stepNpc`.
    steering: route.steers,
    away: null,
    // A body in the scenery stands nowhere it may stand: the way out comes
    // before the crowd (routing.js `escaping`), as it comes before a swing.
    throughBodies: Boolean(route.escaping),
  };
};

/** CHASE_AI, and every monster that is not a kiter or stationary: it walks. */
export const chase = {
  intent: (turn) => walkTowards(turn, true),
};

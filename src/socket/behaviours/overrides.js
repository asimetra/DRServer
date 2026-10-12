import { attackStopped, buffMultiplierFor } from "../buffs.js";
import { bodyRadius, moveBody } from "../body.js";
import { endShove } from "../impact.js";
import { placeNpc } from "../npc-move.js";
import { STILL } from "./chase.js";

/**
 * What applies to a monster whatever its behaviour: a hit that throws it or
 * staggers it takes the tick (`heldByHit`); a debuff takes its speed or its
 * swing (`whatItMayDo`); and its own swing — the lunge an attack carries, the
 * lock while it winds up — takes the walk (`swingIntent`). The one more,
 * that nothing is fought from inside the scenery, is the route's to say
 * (`escaping`, routing.js) and `act`'s to keep (npc-act.js).
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/**
 * One tick of a shove in flight — a knockback or pull `pushVictim` (combat.js)
 * handed to the AI with a duration, so the throw is spread over the ticks that
 * fit in it rather than landing whole in one frame.
 *
 * Each tick carries the share of the distance the clock has reached and sends
 * the position, which on a 250ms tick and a 0.4s throw is two frames, as the
 * official's are. Through navigation: a throw that meets a wall ends there,
 * and the share it could not cover is not tried again. While it flies the
 * monster neither walks nor swings.
 */
export const slideShoved = (session, doid, actor, now) => {
  const shove = actor.ai?.shove;
  if (!shove) return false;
  const share = Math.min(1, Math.max(0, (now - shove.startedAt) / shove.durationMs));
  const step = share - shove.covered;
  shove.covered = share;
  if (share >= 1) endShove(actor.ai);
  if (step <= 0) return true;
  const nextPosition = moveBody(
    session.navigation,
    actor,
    actor.position,
    { x: shove.x * step, y: shove.y * step },
    bodyRadius(actor)
  );
  const travel = distanceTo(actor.position, nextPosition);
  if (travel < 0.5) {
    endShove(actor.ai);
    return true;
  }
  placeNpc(session, doid, actor, { next: nextPosition, travel });
  return true;
};

/** Whether a hit has the tick: a shove in flight carries it, a stagger holds it. */
export const heldByHit = (session, doid, actor, now) => {
  // Thrown by a hit — see pushVictim in combat.js. Carried, not walking.
  if (slideShoved(session, doid, actor, now)) return true;
  // Reeling from a hit that staggered it — see holdStaggered in combat.js.
  // It neither walks nor swings until the stun is over.
  return now < (actor.ai.staggeredUntil ?? 0);
};

/**
 * What a debuff on it lets it still do.
 *
 * `MOVEMENT` is the authored multiplier and covers the lot at once —
 * STUN_L4 and STOP_L4 carry a zero, SLOW_L1 a 0.75 — so a stunned monster
 * simply has no speed. Attacking is separate: a stun stops it, a root does
 * not, which is what the two abilities mean.
 *
 * Shock, paralysis and disabled controls stop both. `SHOCK_L0` says so in
 * its own words — "Unable to attack or move for 0.5 secs" — and carries
 * `MOVEMENT` zero for the moving half; the swinging half is this ability,
 * which nothing read. So `Zapping` held a monster still and let it go on
 * hitting whoever was standing next to it. FREEZE and FROZEN have the same
 * split through `PARALYZED` and `DISABLE_CONTROLS` respectively.
 */
export const whatItMayDo = (session, doid, ai, now) => {
  const mobility = buffMultiplierFor(session, doid, "MOVEMENT");
  const cannotAttack = attackStopped(session, doid);
  const attackLocked = now < (ai.attackLockedUntil ?? 0);
  return {
    mobility,
    cannotAttack,
    attackLocked,
    // Its own swing under way: locked in it, or lunging.
    swinging: attackLocked || Boolean(ai.lunge && now < ai.lunge.until),
  };
};

/**
 * The walk its own swing imposes this tick, or null when its behaviour has the
 * say.
 *
 * A lunge overrides the walk for as long as it lasts.
 *
 * It is the attack moving the monster, not the monster deciding to go
 * somewhere, so the chase does not get a say — an imp that has just hopped
 * backwards must not spend the same tick walking forwards again. Debuffs
 * still apply: `MOVEMENT` zero is a stun, and a stunned thing does not
 * charge.
 */
export const swingIntent = (ai, { mobility, attackLocked }, now, deltaSeconds) => {
  if (ai.lunge && now < ai.lunge.until) {
    // Not before its frame: a lunge waiting on its wind-up holds the body
    // where the swing left it, as the lock below does.
    if (now >= (ai.lunge.from ?? 0)) {
      // The attack moves it, not a walk: a lunge goes through the crowd (npc-move.js).
      return {
        ...STILL,
        x: ai.lunge.x * mobility * deltaSeconds,
        y: ai.lunge.y * mobility * deltaSeconds,
        throughBodies: true,
      };
    }
    return STILL;
  }
  // The swing owns this window. Ordinary chase here turns a dodgeable
  // melee windup into a homing hit; only authored lunge movement may run.
  if (attackLocked) return STILL;
  return null;
};

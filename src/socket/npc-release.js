import { info } from "../log.js";
import { bodyRadius } from "./body.js";
import { heroMembersOf } from "./match-world.js";
import { isPositionBlocked } from "./navigation.js";
import { boundedPush, separationDisplacement } from "./npc-crowd.js";
import { placeNpc, stepNpc } from "./npc-move.js";

/**
 * A prisoner let out of a cage by a generator (floor-generators.js) walks out
 * through the cage's mouth before it is an ordinary monster.
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/** How long a release may make no headway before it is given up on. */
const RELEASE_STALL_MS = 1000;

/**
 * Moves a freshly generated prisoner through its own cage before normal AI
 * starts, and says how that went:
 *
 *   "walking"  the release has the tick: waiting for its start, or walking;
 *   "out"      it walked clear of the cage on this tick's step, which ends
 *              the tick;
 *   "over"     it was already clear, or gave up: the rest of the tick is the
 *              ordinary AI's;
 *   null       there is no release.
 *
 * Out or over, it is an ordinary monster from here and lets go of whatever it
 * was released at (`clearNpcTarget`), which is the caller's to do.
 */
export const advanceNpcRelease = (session, doid, actor, now, deltaSeconds, spatialIndex, heroes = []) => {
  const { ai } = actor;
  // A burst let out together stands shoulder to shoulder (`sameWave`,
  // npc-crowd.js) until its group expires, released or not.
  if (ai.wave && now >= ai.wave.group.expiresAt) ai.wave = null;
  const release = ai.release;
  if (!release) return null;
  if (now < (release.startsAt ?? 0)) return "walking";

  const radius = bodyRadius(actor);

  /**
   * Out of the cage is enough; the release point is not a destination.
   *
   * Measured: a released monster walks 119 to 134 units to a point every member
   * of its cage shares, and only then looks at the player — nearly a second of
   * crossing the room to a spot nobody asked about. But the walk exists to get
   * through a doorway, and the doorway is behind it as soon as its own cage no
   * longer holds it.
   *
   * Out means the body clear of the cage, not the player in sight. A sight line
   * is sampled from its first step on, so one drawn from a body still half in
   * the bars reads clear. Ending the walk there left the body in the collider,
   * where every step of the chase that followed was refused: a knight 19 units
   * into the jail on the bridge tile, facing a player in plain view, never
   * moved again.
   */
  if (!isPositionBlocked(session.navigation, actor.position, radius)) {
    ai.release = null;
    return "over";
  }

  // Reaching the release point is not the end of it; being clear is (above).
  // One still blocked at it walks on and, failing that, falls to the stall.
  const distance = distanceTo(actor.position, release.target);

  if (session.debugAi) {
    info(
      `[ai] ${doid} RELEASE at (${Math.round(actor.position.x)},${Math.round(actor.position.y)}) ` +
        `-> (${Math.round(release.target.x)},${Math.round(release.target.y)}) ` +
        `${Math.round(distance)} to go`
    );
  }

  const travel = Math.min(ai.moveSpeed * deltaSeconds, distance);
  /**
   * Pushing apart applies here too. It was only in the chase, and a release
   * returns before ever reaching it — so the one moment a whole cage moves in
   * step was also the one moment nothing kept them off each other.
   */
  const heroDoids = new Set(heroMembersOf(session).keys());
  const separation = spatialIndex
    ? boundedPush(separationDisplacement(doid, actor, spatialIndex, heroDoids), ai, deltaSeconds)
    : { x: 0, y: 0 };
  // A cage exit may not run through the player either; see `keptOutOfHeroes`.
  // The release point is a doorway, not a destination, and walking a body into
  // the one dynamic body on the client shoves the player whatever the reason.
  const step = stepNpc(session.navigation, actor, {
    walk:
      distance > 0.001
        ? {
            x: ((release.target.x - actor.position.x) / distance) * travel,
            y: ((release.target.y - actor.position.y) / distance) * travel,
          }
        : { x: 0, y: 0 },
    separation,
    heroes,
    radius,
    deltaSeconds,
    navigationOptions: { ignoredColliders: release.ignoredColliders },
  });
  const actualTravel = step.travel;

  /**
   * A release has to be able to fail.
   *
   * advanceNpcRelease reports the actor as handled on every tick it runs, so an
   * actor that cannot reach its exit — wedged against geometry, or behind the
   * rest of its own wave — never reaches ordinary AI at all. It will not chase,
   * will not aggro, and will not answer to a player standing next to it. That
   * is the last one out of a cage standing there for the rest of the floor.
   *
   * So the plan is abandoned once it stops making progress. Normal pursuit is
   * a worse way out of a cage but an infinitely better one than none.
   */
  if (actualTravel > 1) {
    release.stalledSince = null;
  } else {
    release.stalledSince ??= now;
    if (now - release.stalledSince >= RELEASE_STALL_MS) {
      info(`[${session.id}] npc ${doid} gave up on its cage exit — chasing instead`);
      // Still out through the mouth, if it is still in the cage; see routeToTarget.
      ai.escape = release.target;
      ai.release = null;
      return "over";
    }
  }

  placeNpc(session, doid, actor, step, release.target);
  if (!isPositionBlocked(session.navigation, actor.position, radius)) {
    ai.release = null;
    return "out";
  }
  return "walking";
};

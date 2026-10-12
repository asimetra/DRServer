import { npcHeadingUpdate } from "./npc-move.js";

/**
 * Which way a monster faces, and when the client is told: here, once.
 *
 * Measured on 70 official captures, 3400 monsters and 18,668 engaged
 * seconds. The heading the official sends is the bearing from the monster to
 * where the server last heard its victim was — the best fit lags the hero by
 * about 150 ms, which is the position it last received; median error 0.9°,
 * 78% within 3° — whatever way the monster itself is walking: round a corner,
 * backing off, sliding along a wall, it looks at its victim. It is sent when
 * that bearing has turned about 15° from the last heading sent (the turns
 * sent pile up at 14-16°), and with every swing: 97% of 11,140
 * choreographies have a heading in the same tick. Not when a walk starts, not
 * on a clock, and never twice in a tick (0 of 195,700). That came to 1.62
 * headings a second and 0.196 left/right flips.
 *
 * Ours turned a monster to its next waypoint on every step it took and to
 * its victim again on every tick in reach, at half a degree: 3.66 headings a
 * second, 0.444 flips, and 17% of them a second heading in the same tick
 * (ice imps 5.1 a second, 36%) — a sprite that twitched between the corner
 * it walked round and the hero it walked at.
 *
 * And a swing holds its heading. Across 16 official captures not one
 * monster's heading came within 450 ms of its choreography (1091 swings
 * followed by a heading; p05 583 ms) where one came 1.7 to 2.1 times a second
 * before it, so a monster locked in its swing does not turn (ai.js).
 */

/** How far its victim's bearing turns from the heading last sent before another is sent, in degrees. */
export const HEADING_DRIFT_DEGREES = 15;

/** The heading from `from` to `to`, in degrees: the one way a heading is worked out. */
export const bearingTo = (from, to) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

/** The smaller angle between two headings, in degrees. */
const turnBetween = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/**
 * Turns it to `toward` and tells the client: on a `swing`, exactly and
 * always, since the swing's shape and lunge go the way it faces
 * (npc-act.js); otherwise once the bearing has drifted 15° from the heading
 * last sent. `actor.heading` is that heading, so a generate for a player
 * joining late (match-world.js) shows what everybody else was shown. One
 * that never turns (`LockRotation`, the golem) is left as it stands.
 */
export const face = (session, doid, actor, toward, { swing = false } = {}) => {
  if (actor.ai?.lockRotation || !toward) return;
  const onTop = Math.hypot(toward.x - actor.position.x, toward.y - actor.position.y) < 0.001;
  const current = Number(actor.heading) || 0;
  const heading = onTop ? current : bearingTo(actor.position, toward);
  if (!swing && turnBetween(heading, current) < HEADING_DRIFT_DEGREES) return;
  actor.heading = heading;
  session.send(npcHeadingUpdate(doid, heading));
};

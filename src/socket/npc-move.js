import { contact } from "./body.js";
import { moveWithNavigation } from "./navigation.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";

/**
 * How a monster's body gets from where it stands to where it is sent.
 *
 * The AI decides the step — a chase, a back-off, a lunge, a cage exit, an idle
 * body pushed off another — and what it faces while taking it (ai.js). What
 * happens to that step after is the same every time and is here once: the part
 * that runs into a body it touches is dropped, the push of the crowd is added
 * within one walking budget, the players are kept out of it, the walls get
 * the last word, and the client is told where it ended and which way it faces.
 */

const npcPositionUpdate = (doid, position) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(132) // DistributedNPCGameObject.position
    .f32(position.x)
    .f32(position.y)
    .frame();

export const npcHeadingUpdate = (doid, heading) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(133) // DistributedNPCGameObject.heading
    .f32(heading)
    .frame();

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/** Turns it to `target` and says so, unless it never turns or already faces it within half a degree. */
export const faceTarget = (session, doid, actor, target) => {
  if (actor.ai?.lockRotation) return;
  const heading = (Math.atan2(target.y - actor.position.y, target.x - actor.position.x) * 180) / Math.PI;
  if (Math.abs(heading - actor.heading) < 0.5) return;
  actor.heading = heading;
  session.send(npcHeadingUpdate(doid, heading));
};

/**
 * The one position this server must never send: a body inside the player's.
 *
 * On the client the local hero is the only dynamic Box2D body in the room. Every
 * monster collider is static — `CircleNavCollider.buildBody` takes a plain
 * `B2BodyDef`, which is static by default, and `HeroGameObjectOwner` is the only
 * thing that ever assigns `b2_dynamicBody`. That asymmetry is the whole story of
 * the shoving:
 *
 *   a static body a player walks into does nothing. The player is blocked and
 *   stops, which is ordinary collision and how it should feel;
 *
 *   a static body *moved into* the player is resolved by Box2D's position
 *   correction, and since only one of the two can move, the player is what
 *   moves. That is the slide.
 *
 * So the question is not how close a monster stands, it is how often we send it
 * somewhere overlapping. Measured on six knights round one player, before this:
 * 7.3% of emitted positions overlapped while the player stood still, and 14.9%
 * while the player walked — one in seven, a median of 6.3 units deep and up to
 * 43. Walking is worse for the obvious reason, that the chase aims at where the
 * player was last heard from and the player is no longer there.
 *
 * The whole step is swept, not merely its destination. A fast attack lunge can
 * begin on one side of the hero and end outside the body on the other side; an
 * endpoint-only check called both ends safe and sent a 100-200 unit apparent
 * teleport straight through the player. The first circle intersection is the
 * furthest legal destination on that step. This still runs before navigation,
 * so a wall wins the argument afterward.
 */
export const keptOutOfHeroes = (target, actor, heroes) => {
  const start = actor.position;
  let { x, y } = target;
  for (const hero of heroes) {
    if (!hero.position || !hero.actor) continue;
    const bodies = contact(actor, hero.actor);
    const fromX = start.x - hero.position.x;
    const fromY = start.y - hero.position.y;
    const fromDistance = Math.hypot(fromX, fromY);
    const stepX = x - start.x;
    const stepY = y - start.y;
    const stepLengthSquared = stepX * stepX + stepY * stepY;
    if (stepLengthSquared < 1e-9) continue;

    const towards = fromX * stepX + fromY * stepY;
    if (fromDistance < bodies - 0.001) {
      const targetX = x - hero.position.x;
      const targetY = y - hero.position.y;
      const targetDistance = Math.hypot(targetX, targetY);
      if (targetDistance >= bodies) continue;
      // Separation and backwards attack movement must still be able to lift an
      // already-overlapping spawn out. An inward/crossing step, however, keeps
      // the existing visible position instead of choosing the opposite side.
      if (towards <= 0 || targetDistance < 0.001) return { ...start };
      x = hero.position.x + (targetX / targetDistance) * bodies;
      y = hero.position.y + (targetY / targetDistance) * bodies;
      continue;
    }

    if (fromDistance <= bodies + 0.001 && towards >= 0) continue;

    const c = fromX * fromX + fromY * fromY - bodies * bodies;
    const discriminant = 4 * towards * towards - 4 * stepLengthSquared * c;
    if (discriminant < 0) continue;
    const root = (-2 * towards - Math.sqrt(discriminant)) / (2 * stepLengthSquared);
    if (root < 0 || root > 1) continue;
    x = start.x + stepX * root;
    y = start.y + stepY * root;
  }
  return { x, y };
};

/**
 * Takes out of a step whatever part of it runs into a body already touched.
 *
 * The rest is kept, so an actor slides around what it cannot pass through. Only
 * the walking half is filtered: the push is what resolves the contact and must
 * survive, and it points out of every contact it was computed from anyway.
 */
const withoutDrivingIntoContacts = (move, contacts) => {
  let { x, y } = move;
  for (const touching of contacts) {
    const into = x * touching.x + y * touching.y;
    if (into >= 0) continue;
    x -= into * touching.x;
    y -= into * touching.y;
  }
  return { x, y };
};

/**
 * Shares one movement budget between intentional motion and crowd correction.
 *
 * The separation vector used to be added after a complete walking step, so a
 * crowded chaser could move at nearly twice BaseMove. The official p90 sits on
 * BaseMove. The normal budget therefore caps the sum; an authored attack lunge
 * that is already longer remains authoritative, but separation cannot make it
 * longer still. With movement disabled the walk is zero while the undebuffed
 * body-push budget remains, so a stunned actor can still be displaced out of a
 * collision without walking under its own power.
 */
const movementWithinBudget = (motion, separation, ai, deltaSeconds) => {
  const x = motion.x + separation.x;
  const y = motion.y + separation.y;
  const requested = Math.hypot(x, y);
  if (requested <= 0.001) return { x: 0, y: 0 };

  const authoredMotion = Math.hypot(motion.x, motion.y);
  const walkingBudget = Math.max(0, Number(ai?.moveSpeed) || 0) *
    Math.max(0, Number(deltaSeconds) || 0);
  const budget = Math.max(walkingBudget, authoredMotion);
  if (requested <= budget || budget <= 0) return budget > 0 ? { x, y } : { x: 0, y: 0 };
  return { x: (x / requested) * budget, y: (y / requested) * budget };
};

/**
 * The step a body takes, from the walk it chose to where navigation lets it
 * end: `{ next, travel }`, or null when the step is too small to ask about.
 *
 * `contacts` are the bodies it touches, as `separationDisplacement` gives
 * them; `separation` is the crowd's push, already bounded. `ignoresSmall` is
 * where a step of a thousandth or less is dropped without asking navigation:
 * `"movement"` before the players are kept out of it, `"wanted"` after, unset
 * never. Each caller keeps what it did before the three shared this stage —
 * an idle body the first, the chase the second, a cage exit the third.
 */
export const stepNpc = (
  navigation,
  actor,
  { walk, contacts = [], separation, heroes, radius, deltaSeconds, navigationOptions, ignoresSmall = null }
) => {
  const movement = movementWithinBudget(
    withoutDrivingIntoContacts(walk, contacts),
    separation,
    actor.ai,
    deltaSeconds
  );
  if (ignoresSmall === "movement" && Math.hypot(movement.x, movement.y) <= 0.001) return null;
  const wanted = keptOutOfHeroes(
    { x: actor.position.x + movement.x, y: actor.position.y + movement.y },
    actor,
    heroes
  );
  if (ignoresSmall === "wanted" && distanceTo(actor.position, wanted) <= 0.001) return null;
  const next = moveWithNavigation(
    navigation,
    actor.position,
    { x: wanted.x - actor.position.x, y: wanted.y - actor.position.y },
    radius,
    navigationOptions
  );
  return { next, travel: distanceTo(actor.position, next) };
};

/**
 * Puts it where a step ended. A step that went anywhere is sent, turned to
 * `facing` first when the caller names something to face.
 */
export const placeNpc = (session, doid, actor, { next, travel }, facing = null) => {
  actor.position.x = next.x;
  actor.position.y = next.y;
  if (travel <= 0.001) return;
  if (facing) faceTarget(session, doid, actor, facing);
  session.send(npcPositionUpdate(doid, actor.position));
};

import { bodyPointOf, contact, moveBody } from "./body.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";

/**
 * How a monster's body gets from where it stands to where it is sent.
 *
 * The AI decides the step — a chase, a back-off, a lunge, a cage exit, an idle
 * body pushed off another (ai.js and behaviours/). What happens to that step
 * after is the same every time and is here once: the part that runs into a
 * player it touches is dropped, the walk stops where it would meet another
 * monster's body, the push of the crowd is added within one walking budget,
 * the players are kept out of it, the walls get the last word, and the client
 * is told where it ended. Which way it faces is not the
 * step's: see npc-facing.js.
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
 * The share of its headway a walk has to be given, by the scenery or by the
 * crowd, to be taken at all.
 */
const HEADWAY = 0.1;

/**
 * How far off the way it walks a body still stands in its way: 70 degrees.
 *
 * Over 57 solo captures, a chaser touching another monster on its side of the
 * hero, the hero standing still, waits out the next second 58.8% of the time
 * with the other body 0-20 degrees off its way to him, 58.8% at 20-40, 56.0%
 * at 40-55 and 57.7% at 55-70 (n 5464, 4684, 2051, 1388), and 47.4% at
 * 70-90 (n 1093). Ahead of it, however glancing, the other body holds it; one
 * beside it, it walks along.
 */
const AHEAD = Math.cos((70 * Math.PI) / 180);

/** Whether `body` is in the way of a walk along the unit `way` from `from`. */
const inTheWay = (from, way, body) => {
  const dx = body.x - from.x;
  const dy = body.y - from.y;
  const distance = Math.hypot(dx, dy);
  return distance < 0.001 || (dx * way.x + dy * way.y) / distance >= AHEAD;
};

/**
 * The first of `bodies` a walk from `from` would touch, and the share of the
 * walk (0 to 1) it gets before it does; null when it touches none. A body it
 * already touches or is inside only counts when the walk goes deeper.
 */
const firstMet = (from, walk, bodies) => {
  const lengthSquared = walk.x * walk.x + walk.y * walk.y;
  let met = null;
  for (const body of bodies) {
    const dx = from.x - body.x;
    const dy = from.y - body.y;
    const towards = dx * walk.x + dy * walk.y;
    if (towards >= 0) continue;
    const gap = dx * dx + dy * dy - body.touching * body.touching;
    if (gap <= 0) return { share: 0, body };
    const discriminant = towards * towards - lengthSquared * gap;
    if (discriminant < 0) continue;
    const root = (-towards - Math.sqrt(discriminant)) / lengthSquared;
    if (root >= 0 && root < (met?.share ?? 1)) met = { share: root, body };
  }
  return met;
};

/**
 * A walk held by the monsters in its way: `{ walk, blocked }`.
 *
 * Monster bodies are hard (npc-crowd.js). A walk goes as far as the first
 * body it would touch. If that body is in its way (`AHEAD`) it goes no
 * further and does not turn to slide round it: the official monster held
 * behind another one waits. Over 57 solo captures, of 14,989 samples of a
 * chaser held behind another with the hero standing still, 56.8% waited out
 * the next second, 9.1% walked round it and 0.8% ended inside it; with the
 * hero moving it waited 12.1% and went on as the crowd moved — the wait ends
 * when the hero moves. A body beside it, touched, keeps whatever part of the
 * walk runs along it, so two walking side by side to one hero do not hold
 * each other. A walk cut to less than a tenth of itself is not taken
 * (`blocked`): a waiting body stands rather than creeping up a unit a tick,
 * and sets off from standing when it goes.
 *
 * Touching or inside another body, nothing walks it deeper: a lunge, a
 * knockback or a burst spawned on one spot leaves bodies inside one another,
 * and the crowd's push lifts them apart.
 */
const heldByBodies = (actor, walk, bodies) => {
  const length = Math.hypot(walk.x, walk.y);
  if (!bodies?.length || length < 1e-6) return { walk, blocked: false };
  const from = bodyPointOf(actor, actor.position);
  const way = { x: walk.x / length, y: walk.y / length };
  let along = walk;
  // Bodies already touched: one in the way holds it, one beside it is walked along.
  for (const body of bodies) {
    const dx = from.x - body.x;
    const dy = from.y - body.y;
    const distance = Math.hypot(dx, dy);
    if (distance > body.touching) continue;
    const into = along.x * dx + along.y * dy;
    if (into >= 0) continue;
    if (inTheWay(from, way, body)) return { walk: { x: 0, y: 0 }, blocked: true };
    const normal = distance < 0.001 ? way : { x: dx / distance, y: dy / distance };
    const inward = along.x * normal.x + along.y * normal.y;
    along = { x: along.x - inward * normal.x, y: along.y - inward * normal.y };
  }
  const met = firstMet(from, along, bodies);
  const share = met ? met.share : 1;
  const taken = { x: along.x * share, y: along.y * share };
  if (Math.hypot(taken.x, taken.y) < HEADWAY * length) return { walk: { x: 0, y: 0 }, blocked: true };
  return { walk: taken, blocked: false };
};

/**
 * Takes out of a step whatever part of it runs into a player already touched.
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

/** Where a movement takes it: kept out of the players, then its body through the scenery. */
const moved = (navigation, actor, movement, { heroes, radius, navigationOptions, ignoresSmall }) => {
  if (ignoresSmall === "movement" && Math.hypot(movement.x, movement.y) <= 0.001) return null;
  const wanted = keptOutOfHeroes(
    { x: actor.position.x + movement.x, y: actor.position.y + movement.y },
    actor,
    heroes
  );
  if (ignoresSmall === "wanted" && distanceTo(actor.position, wanted) <= 0.001) return null;
  const next = moveBody(
    navigation,
    actor,
    actor.position,
    { x: wanted.x - actor.position.x, y: wanted.y - actor.position.y },
    radius,
    navigationOptions
  );
  return { wanted, next };
};

/**
 * Whether the scenery gave a step less than a tenth of the headway it asked
 * for along `walk`. Measured against what was asked once the crowd and the
 * players had their say, so a crowd cancelling the walk on open ground is not
 * a wall; what is left is what the scenery took.
 */
const sceneryRefused = (actor, walk, { wanted, next }) => {
  const length = Math.hypot(walk.x, walk.y);
  if (length <= 0.001) return false;
  const along = (point) =>
    ((point.x - actor.position.x) * walk.x + (point.y - actor.position.y) * walk.y) / length;
  const asked = along(wanted);
  return asked > 0.001 && along(next) < HEADWAY * asked;
};

/**
 * The step a body takes, from the walk it chose to where navigation lets it
 * end: `{ next, travel, refused, blocked }`, or null when the step is too
 * small to ask about.
 *
 * `contacts` are the players it touches and `bodies` the monsters it may not
 * walk into, as `separationDisplacement` gives them; `blocked` is a walk the
 * monsters in its way did not let it take (`heldByBodies`). A caller whose
 * step is carried rather than walked — a lunge, a cage's burst walking out —
 * gives no `bodies`. `separation` is the crowd's push, already bounded. `ignoresSmall` is
 * where a step of a thousandth or less is dropped without asking navigation:
 * `"movement"` before the players are kept out of it, `"wanted"` after, unset
 * never. Each caller keeps what it did before the three shared this stage —
 * an idle body the first, the chase the second, a cage exit the third.
 *
 * `steering` is a walk straight at a target the body cannot see (routing.js):
 * it slides along whatever it meets, and on a tick the scenery gives back
 * less than a tenth of the headway the step asked for, not even a slide, the
 * walk is not taken (`refused`): the body stands at the wall rather than
 * grinding into it or pacing along it, as the official does, and only the
 * crowd's push moves it. That is decided on the step itself, so navigation is
 * asked once a tick, and a second time only for the push on a tick refused
 * with a crowd pushing.
 */
export const stepNpc = (navigation, actor, options) => {
  const { walk, contacts = [], bodies, separation, deltaSeconds, steering = false } = options;
  const held = heldByBodies(actor, withoutDrivingIntoContacts(walk, contacts), bodies);
  const movement = movementWithinBudget(
    held.walk,
    separation,
    actor.ai,
    deltaSeconds
  );
  let step = moved(navigation, actor, movement, options);
  if (!step) return held.blocked ? { next: { ...actor.position }, travel: 0, refused: false, blocked: true } : null;
  const refused = steering && sceneryRefused(actor, walk, step);
  if (refused) {
    const push = movementWithinBudget({ x: 0, y: 0 }, separation, actor.ai, deltaSeconds);
    step = moved(navigation, actor, push, { ...options, ignoresSmall: "wanted" }) ?? {
      next: { ...actor.position },
    };
  }
  return { next: step.next, travel: distanceTo(actor.position, step.next), refused, blocked: held.blocked };
};

/** Puts it where a step ended; a step that went anywhere is sent. */
export const placeNpc = (session, doid, actor, { next, travel }) => {
  actor.position.x = next.x;
  actor.position.y = next.y;
  if (travel <= 0.001) return;
  session.send(npcPositionUpdate(doid, actor.position));
};

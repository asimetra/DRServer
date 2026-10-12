import { bodyPointOf, contact, moveBody } from "./body.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";

/**
 * How a monster's body gets from where it stands to where it is sent.
 *
 * The AI decides the step — a chase, a back-off, a lunge, a cage exit, an idle
 * body pushed off another (ai.js and behaviours/). What happens to that step
 * after is the same every time and is here once: what each body round it is
 * to the walk (`bodyRule`), the part that runs into a player it touches
 * dropped, the walk stopped where it would meet a monster's body or waiting
 * behind one of its own (`heldByBodies`, `afterStep`), the push of the crowd
 * added within one walking budget, the players kept out of it, the walls
 * given the last word, and the client told where it ended. Which way it
 * faces is not the step's: see npc-facing.js.
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
 * What a body is to a walker this tick, the one question every part of the
 * move stage asks of it: `BODY.PASS`, `KEEP_OUT`, `STOP_AT`, `ROUND` or
 * `QUEUE`. It asks whose side the two are on and whether they collide, never
 * what kind of thing either is. `player` says the body is a player's, met
 * at his feet; `playersSide` is the team the players are on, as the floor's
 * heroes carry it (npc-crowd.js `senseCrowd`), a player's own team for a
 * player; `walkingAt` the doid of what the walk is at.
 *
 *   PASS      on the players' side, both, and neither row says
 *             `CollideWithTeam`: they walk through each other, as heroes
 *             always have.
 *   STOP_AT   the same, but the player it walks at: its walk ends at his
 *             body, whoever's side it is on (`keptOutOfHeroes`). A pet's
 *             walk back to its owner along a route, whose last waypoint is
 *             where he stands, ended 16 inside him in the harness (the
 *             wolf walks 175 a tick) once nothing else stopped it there.
 *   KEEP_OUT  any other player: no step ends inside him, and the part of a
 *             walk into him, touched, is dropped, so it slides along him
 *             (`keptOutOfHeroes`, `withoutDrivingIntoContacts`).
 *   ROUND     a monster of another side: gone round at its body, with no
 *             wait (`heldByBodies`).
 *   QUEUE     a monster of its own side: waited behind, then passed
 *             (`heldByBodies`, `afterStep`).
 *
 * The client builds every actor's collision filter from its team
 * (`ActorGameObject.buildFilter`): it collides with every other team, and
 * with its own only when its row says `CollideWithTeam` (or it is the local
 * hero himself). So a player's pet, the chef, a hero's walking summon and
 * the other players are not in his way, nor he in theirs; the barricades,
 * the defence orb and the princesses (`CollideWithTeam`) are, and so are
 * they to anything on his side. The official agrees: in its solo captures a
 * hero's step ends inside a standing pet's body 98 times (centre distance
 * p50 35).
 *
 * That filter decides only the player's own body, the one body the client
 * moves; every other actor is a static body there, and two static bodies
 * never meet. How far apart two NPCs keep is the server's, and on the
 * monsters' side it is measured: the official does not walk one monster
 * into another (npc-crowd.js `separationDisplacement`). On the players'
 * side there is no such measure, so the side keeps the rule of the body
 * that is on it to move: it passes through itself, his pets, allies and
 * summons through him and through one another. A monster put on his side
 * by some mode would join it as it is.
 *
 * The official AI did keep its pets off their owner as they walked — a
 * moving pet overlaps its owner's body on 2.2%, 1.8% and 1.4% of samples
 * (wolf, dragon, rhino), and 1 of 99, 0 of 10 and 0 of 41 steps past him
 * went through him. Ours lets them through: a walk is never stopped by a
 * body it does not collide with, but for the one it walks at. That is
 * simpler than a wait behind a body that holds nothing, and costs only a
 * picture of the two overlapping for a moment. Resting is another matter:
 * the crowd's push still lifts two bodies on the side out of each other,
 * at contact (`separationDisplacement`), and a pet's walk to its owner ends
 * at its ReturnDist (behaviours/chase.js `walkEndsAt`).
 *
 * A wait is a queue, and one queues only behind its own side: all the
 * measure behind `afterStep` is of monsters behind monsters. The official's
 * pets do not queue behind monsters: a wolf walking back past its
 * TetherDist with a monster touching it in its way stood the next second on
 * 10.6% of quarter seconds (n 189), as on 12.1% with none (n 544); the
 * dragon on 0% (n 18), the rhino, a slow walker, on 31.7% (n 60) against
 * 8.8%. Ours, waiting as a monster does, stood 21.6%, 32.7% and 43.7%.
 *
 * An actor built without a team, as most tests build a monster, collides,
 * and queues behind another without one.
 */
export const BODY = Object.freeze({
  PASS: "pass",
  STOP_AT: "stop-at",
  KEEP_OUT: "keep-out",
  ROUND: "round",
  QUEUE: "queue",
});

export const bodyRule = (walker, other, { player = false, playersSide = null, walkingAt = null, doid = null } = {}) => {
  const side = player ? other?.team : playersSide;
  const friendly =
    walker?.team != null &&
    walker.team === side &&
    other?.team === side &&
    !walker.collidesWithTeam &&
    !other.collidesWithTeam;
  if (player) return friendly ? (doid === walkingAt ? BODY.STOP_AT : BODY.PASS) : BODY.KEEP_OUT;
  if (friendly) return BODY.PASS;
  return other?.team === walker?.team ? BODY.QUEUE : BODY.ROUND;
};

/**
 * The crowd round a walker (npc-crowd.js `separationDisplacement`'s `near`)
 * as its walk meets it (`bodyRule`): `contacts`, the players it is kept out
 * of and rests against, each as the way out of him; `bodies`, the monsters
 * it goes round or waits behind, each with its `rule`. The chase keeps
 * whatever part of itself runs along a player it touches and loses the part
 * that runs through him, so a crowd arriving at one player spreads round
 * him instead of piling into him.
 *
 * A body of `bodies` is the `near` record itself, its rule written on it:
 * the crowd builds those for this walker this tick, and nothing else holds
 * them.
 */
export const bodiesMet = (walker, near, { playersSide = null, walkingAt = null } = {}) => {
  const contacts = [];
  const bodies = [];
  for (const body of near ?? []) {
    const rule = bodyRule(walker, body.actor, { player: body.player, playersSide, walkingAt, doid: body.doid });
    if (body.player) {
      if (rule === BODY.KEEP_OUT && body.out) contacts.push(body.out);
    } else if (rule !== BODY.PASS) {
      body.rule = rule;
      bodies.push(body);
    }
  }
  return { contacts, bodies };
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
 *
 * Only the players the walk is kept out of or stops at are (`bodyRule`): a
 * body on his side that he does not collide with shoves nobody.
 */
export const keptOutOfHeroes = (target, actor, heroes, walkingAt = null) => {
  const start = actor.position;
  let { x, y } = target;
  for (const hero of heroes) {
    if (!hero.position || !hero.actor) continue;
    if (bodyRule(actor, hero.actor, { player: true, walkingAt, doid: hero.doid }) === BODY.PASS) continue;
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
 * hero, the hero up and standing still, waits out the next second 54.2% of
 * the time with the other body 0-20 degrees off its way to him, 50.7% at
 * 20-40, 49.3% at 40-55 and 49.1% at 55-70 (n 4584, 3717, 1648, 1061), and
 * 35.6% at 70-90 (n 845), where it advances 44.1%. Ahead of it, however
 * glancing, the other body holds it; one beside it, it walks along.
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
 * The bodies of another side in the way of a `walk` from where it stands
 * that the walk would meet — touching it, or within the walk's length of
 * touching — nearest first, and of the bodies as near (to a unit) the most
 * squarely in its way: what pins a walk that went nowhere
 * (behaviours/pet.js `pinnedBy`).
 */
export const touchingInTheWay = (actor, walk, bodies) => {
  const length = Math.hypot(walk.x, walk.y);
  if (!bodies?.length || length < 1e-6) return [];
  const from = bodyPointOf(actor, actor.position);
  const way = { x: walk.x / length, y: walk.y / length };
  const apart = (body) => Math.hypot(body.x - from.x, body.y - from.y);
  const gap = (body) => Math.round(apart(body) - body.touching);
  const square = (body) => ((body.x - from.x) * way.x + (body.y - from.y) * way.y) / (apart(body) || 1);
  return bodies
    .filter((body) => body.rule === BODY.ROUND && apart(body) <= body.touching + length && inTheWay(from, way, body))
    .sort((a, b) => gap(a) - gap(b) || square(b) - square(a));
};

/** How far off a body still counts as touching it: what a sweep to its edge leaves of rounding. */
const TOUCH_SLACK = 0.01;

/** How little a walk may run into a body it touches, as a cosine, and still be along it. */
const TANGENT = 0.01;

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
    // A walk along a body it touches, slid onto its tangent, is not into it.
    if (gap <= 0) {
      if (towards > -TANGENT * Math.sqrt(lengthSquared * (dx * dx + dy * dy))) continue;
      return { share: 0, body };
    }
    const discriminant = towards * towards - lengthSquared * gap;
    if (discriminant < 0) continue;
    const root = (-towards - Math.sqrt(discriminant)) / lengthSquared;
    if (root >= 0 && root < (met?.share ?? 1)) met = { share: root, body };
  }
  return met;
};

/**
 * A walk held by the monsters in its way: `{ walk, blocked, queued, wentRound }`.
 *
 * Monster bodies are hard (npc-crowd.js). A walk goes as far as the first
 * body it would touch. If that body is in its way (`AHEAD`) it goes no
 * further and does not turn to slide round it: the official monster held
 * behind another one waits. Over 57 solo captures, of 11,958 samples of a
 * chaser held behind another with the hero up and standing still, 49.2%
 * waited out the next second, 10.8% walked round it and 0.8% ended inside
 * it; with the hero moving (n 20,148) it waited 11.1% and went on as the
 * crowd moved. A body beside it, touched, keeps whatever part of the walk
 * runs along it, so two walking side by side to one hero do not hold each
 * other. A walk cut to less than a tenth of itself is not taken (`blocked`):
 * a waiting body stands rather than creeping up a unit a tick, and sets off
 * from standing when it goes.
 *
 * A wait ends (`passing`, decided by the move stage, ai.js): then a body in
 * its way is gone round as one beside it is — the part of the walk into it
 * dropped, or, met head on, the walk turned to the side it leans to — and
 * the walk still stops where it would touch the next body. A body it goes
 * `ROUND` (`bodyRule`) is gone round so from the first (`goesRound`), and a
 * walk held only going round one is `blocked` but not `queued`, which
 * starts no wait.
 *
 * Touching or inside another body, nothing walks it deeper: a lunge, a
 * knockback or a burst spawned on one spot leaves bodies inside one another,
 * and the crowd's push lifts them apart.
 */
const heldByBodies = (actor, walk, bodies, passing = false) => {
  const held = heldOnSide(actor, walk, bodies, passing, 1);
  // Going round, a side the crowd closes is tried the other way round.
  return held.blocked && held.wentRound ? heldOnSide(actor, walk, bodies, passing, -1) : held;
};

/** Whether a body in its way is gone round rather than waited behind: when its wait is over, or it is not one it queues behind. */
const goesRound = (body, passing) => passing || body.rule !== BODY.QUEUE;

const heldOnSide = (actor, walk, bodies, passing, flip) => {
  const length = Math.hypot(walk.x, walk.y);
  if (!bodies?.length || length < 1e-6) return { walk, blocked: false, queued: false, wentRound: false };
  const from = bodyPointOf(actor, actor.position);
  const way = { x: walk.x / length, y: walk.y / length };
  let along = walk;
  let wentRound = passing;
  // Bodies already touched: one in the way holds it, one beside it is walked
  // along, and so is one in its way it goes round (`goesRound`).
  for (const body of bodies) {
    const dx = from.x - body.x;
    const dy = from.y - body.y;
    const distance = Math.hypot(dx, dy);
    const round = goesRound(body, passing);
    // A body a sweep left at its touching distance is touched, a rounding
    // error or not. Passing, after a wait, so is one in its way that this
    // step would reach: the pass lasts `PASS_MS`. A body gone round with no
    // wait (one not queued behind) is walked up to first, by the sweep, and
    // gone round there; turned aside a step short of it with no end to it,
    // a walk stood off and came straight back the next tick, and the
    // harness's dragon walking back to its owner past three skeletons
    // turned back on itself 616 times in one run (pet-dragon seed 3 walker).
    if (distance > body.touching + TOUCH_SLACK + (passing && inTheWay(from, way, body) ? length : 0)) continue;
    const into = along.x * dx + along.y * dy;
    if (into >= 0) continue;
    const inWay = inTheWay(from, way, body);
    if (inWay && !round) return { walk: { x: 0, y: 0 }, blocked: true, queued: true, wentRound: false };
    wentRound ||= inWay;
    const normal = distance < 0.001 ? way : { x: dx / distance, y: dy / distance };
    const inward = along.x * normal.x + along.y * normal.y;
    along = { x: along.x - inward * normal.x, y: along.y - inward * normal.y };
    // Passing one met head on, there is no along to keep: it steps aside on
    // the side of the body it already stands out to (`flip` -1: the other),
    // its walk's length or the body's width, whichever is less. A step
    // aside wider than the body takes it off its way and back the next
    // tick: a wolf walks 175 a tick past a body 64 wide.
    if (inWay && Math.hypot(along.x, along.y) < PASS_HEADWAY * length) {
      const out = dx * -way.y + dy * way.x;
      const side = (out >= 0 ? 1 : -1) * flip;
      const tangent = { x: -normal.y, y: normal.x };
      const sign = (tangent.x * -way.y + tangent.y * way.x) * side >= 0 ? 1 : -1;
      const aside = Math.min(length, body.touching);
      along = { x: tangent.x * sign * aside, y: tangent.y * sign * aside };
    }
  }
  const swept = sweptAlong(from, way, along, bodies, passing);
  wentRound ||= swept.wentRound;
  // Going round a body `ROUND` with no wait, a slide back the way it came
  // is no headway: a pet boxed in by monsters was slid 55 back and walked
  // in again the next tick. A pass after a wait keeps what it was measured
  // with.
  const backwards = wentRound && !passing && swept.taken.x * way.x + swept.taken.y * way.y < -HEADWAY * length;
  if (Math.hypot(swept.taken.x, swept.taken.y) < HEADWAY * length || backwards) {
    return { walk: { x: 0, y: 0 }, blocked: true, queued: !wentRound, wentRound };
  }
  return { walk: swept.taken, blocked: false, queued: false, wentRound };
};

/**
 * Where a walk from `from` gets to among `bodies`: up to the first body it
 * meets. One in its way (`way`, `AHEAD`) stops it there, unless it is going
 * round (`goesRound`: its wait is over, or the body is not one it queues
 * behind); one beside it is slid along from the point they meet,
 * as one already touched is — wherever the sweep first meets it, a step's
 * length off or at a rounding error from touching. Two bodies side by side
 * that each walk a little into the other therefore slide past each other;
 * neither holds the other. `{ taken, wentRound }`, the second when it slid
 * round one in its way.
 */
const SLIDES = 3;
const sweptAlong = (from, way, walk, bodies, passing) => {
  let at = from;
  let rest = walk;
  let wentRound = false;
  const taken = { x: 0, y: 0 };
  for (let slide = 0; slide <= SLIDES; slide++) {
    const met = firstMet(at, rest, bodies);
    const share = met ? met.share : 1;
    taken.x += rest.x * share;
    taken.y += rest.y * share;
    if (!met || slide === SLIDES) break;
    if (inTheWay(from, way, met.body)) {
      if (!goesRound(met.body, passing)) break;
      wentRound = true;
    }
    at = { x: from.x + taken.x, y: from.y + taken.y };
    const dx = at.x - met.body.x;
    const dy = at.y - met.body.y;
    const distance = Math.hypot(dx, dy) || 1;
    const left = { x: rest.x * (1 - share), y: rest.y * (1 - share) };
    const inward = (left.x * dx + left.y * dy) / distance;
    rest = inward < 0 ? { x: left.x - (inward * dx) / distance, y: left.y - (inward * dy) / distance } : left;
    if (Math.hypot(rest.x, rest.y) < 1e-6) break;
  }
  return { taken, wentRound };
};

/** Less of its walk than this left by sliding, a monster going round a body turns to the body's side. */
const PASS_HEADWAY = 0.3;

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
const moved = (navigation, actor, movement, { heroes, walkingAt, radius, navigationOptions, ignoresSmall }) => {
  if (ignoresSmall === "movement" && Math.hypot(movement.x, movement.y) <= 0.001) return null;
  const wanted = keptOutOfHeroes(
    { x: actor.position.x + movement.x, y: actor.position.y + movement.y },
    actor,
    heroes,
    walkingAt
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
 * walk into, as `separationDisplacement` gives them; `walkingAt` the doid of
 * what it walks at, whose body ends its walk (`keptOutOfHeroes`); `blocked`
 * is a walk the monsters in its way did not let it take (`heldByBodies`),
 * and `passing` a walk whose wait is over and goes round them. A caller whose
 * step is carried rather than walked — a lunge, a cage's burst walking out —
 * gives no `bodies`. `separation` is the crowd's push, already bounded.
 *
 * `kind` names the step (`STEP`): a `walk`, the AI's own, a `settle`, an idle
 * body lifted out of another, or `carried`, a cage's burst walking out. It
 * says where a step of a thousandth or less is dropped without asking
 * navigation (`ignoresSmall`): a settle before the players are kept out of
 * it, a walk after, a carried step never. Each kept what it did before the
 * three shared this stage.
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
export const STEP = Object.freeze({ walk: "wanted", settle: "movement", carried: null });

export const stepNpc = (navigation, actor, given) => {
  const options = { ...given, ignoresSmall: STEP[given.kind] ?? null };
  const { walk, contacts = [], bodies, passing = false, separation, deltaSeconds, steering = false } = options;
  const held = heldByBodies(actor, withoutDrivingIntoContacts(walk, contacts), bodies, passing);
  const movement = movementWithinBudget(
    held.walk,
    separation,
    actor.ai,
    deltaSeconds
  );
  let step = moved(navigation, actor, movement, options);
  if (!step) return held.blocked ? { next: { ...actor.position }, travel: 0, refused: false, blocked: true, queued: held.queued } : null;
  const refused = steering && sceneryRefused(actor, walk, step);
  if (refused) {
    const push = movementWithinBudget({ x: 0, y: 0 }, separation, actor.ai, deltaSeconds);
    step = moved(navigation, actor, push, { ...options, ignoresSmall: "wanted" }) ?? {
      next: { ...actor.position },
    };
  }
  return { next: step.next, travel: distanceTo(actor.position, step.next), refused, blocked: held.blocked, queued: held.queued };
};

/**
 * How long a monster waits behind another of its side before it goes round
 * (`QUEUE`, `bodyRule`): a fresh draw each time it is stopped, with an even
 * chance of ending every moment (`WAIT_ENDS_PER_SECOND`), and once it ends,
 * how long it goes round (`PASS_MS`) before a body in its way stops it
 * again.
 *
 * The official's waits end. Over 57 solo captures, a chaser stood behind
 * another monster for a second or more 671 times; of those still waiting at
 * 1, 2 and 3 s, 46%, 42% and 43% stopped within the next second. Second by
 * second, with the hero standing still and the one in its way standing short
 * of the hero (a shooter in range, one held itself, one at the end of a
 * route; n 4,922), it waited 66% of the time and moved on the rest —
 * advancing 12%, round it 11%; behind one swinging at the hero (n 3,073) it
 * waited 34%. A wait without end left a queue standing behind a monster
 * that was going nowhere: 94 s behind an ice imp shooting from range, on
 * 838788c. With the hero moving the queue moves with him anyway (waits 5-19%
 * of seconds), and these waits rarely run out.
 */
const WAIT_ENDS_PER_SECOND = 0.42;
const PASS_MS = 1000;
const waitFor = (random) => (-Math.log(1 - Math.min(0.999999, random())) / WAIT_ENDS_PER_SECOND) * 1000;

/** It is in no queue: no wait drawn, no pass under way (letting go of a target, npc-targeting.js `clearNpcTarget`). */
export const forgetQueue = (ai) => {
  ai.waitEndsAt = null;
  ai.passingUntil = null;
};

/** Whether its wait is over and its walk goes round the bodies it queued behind this tick. */
export const passingNow = (ai, now) => now < (ai.passingUntil ?? 0);

/**
 * The wait bookkept from what the step did (`ai.waitEndsAt`,
 * `ai.passingUntil`, written here alone): a walk stopped in a queue
 * (`queued`) starts a wait, one that has waited its draw goes round for
 * `PASS_MS`, one that walks freely, or was only held going round a body of
 * another side, has no wait.
 */
export const afterStep = (session, ai, now, step, passing) => {
  if (passing) return;
  if (!step?.queued) {
    ai.waitEndsAt = null;
    return;
  }
  if (ai.waitEndsAt == null) ai.waitEndsAt = now + waitFor(session.random ?? Math.random);
  else if (now >= ai.waitEndsAt) {
    ai.waitEndsAt = null;
    ai.passingUntil = now + PASS_MS;
  }
};

/** Puts it where a step ended; a step that went anywhere is sent. */
export const placeNpc = (session, doid, actor, { next, travel }) => {
  actor.position.x = next.x;
  actor.position.y = next.y;
  if (travel <= 0.001) return;
  session.send(npcPositionUpdate(doid, actor.position));
};

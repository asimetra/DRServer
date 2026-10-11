import {
  bodyOffsetOf,
  collisionPointOf,
  findCageReleasePath,
  hasLineOfSight,
  isPositionBlocked,
  moveWithNavigation,
  navigationEntryFor,
  nearestClearPosition,
} from "./navigation.js";
import { searchRoute } from "./route-memo.js";

/**
 * Where an actor is and how wide it is, asked in one place.
 *
 * The position on the wire is the feet. The body is a circle above them: its
 * radius is the one the actor was built with (`authoredBodyRadius`), its
 * middle the feet moved by the library's offset at the size the actor is
 * drawn — 22 up for every hero and 97 of the 122 monsters, times their
 * `Scale` (`collisionPointOf`, navigation.js). The AI, the separation, the
 * swing and the shot used to work these out each for itself. The scenery is
 * met at the body: see "The scenery, asked at the body" below.
 */

/** The library's body circle for a constant, radius and offset from the feet. */
const libraryBodyOf = (constant) => navigationEntryFor(constant)?.navCollisions?.[0];

const scaledBody = (npc, authored) =>
  Math.max(12, (Number(authored) || (npc.CollisionSize ?? 35)) * (npc.Scale ?? 1));

/**
 * The body a spawned NPC is built with: the library's circle, `CollisionSize`
 * for a row with no shape, scaled, never under twelve. See where npc-spawn.js
 * calls it for why the shape comes first.
 */
export const authoredBodyRadius = (npc, constant) => scaledBody(npc, libraryBodyOf(constant)?.radius);

/**
 * The same from the row alone, which is what a placed summon is built with and
 * what a generator sizes its cage exit by (placeables.js, floor-generators.js).
 * The two agree for every row without a library shape.
 */
export const rowBodyRadius = (npc) => scaledBody(npc, 0);

/** The width of a body as the AI measures it: never under twelve, 35 when nothing says. */
export const bodyRadius = (actor) =>
  Math.max(12, actor.ai?.collisionRadius ?? actor.collisionRadius ?? 35);

/** The distance between two middles at which their bodies touch. */
export const contact = (actor, other) => bodyRadius(actor) + bodyRadius(other);

/** Where it stands: the position on the wire. */
export const feetOf = (actor) => actor.position;

/** Where it collides, for feet at `position`: `position` itself for an actor the library has no shape for. */
export const bodyPointOf = (actor, position) => collisionPointOf(actor, position);

/**
 * Where a monster sees from, swings from and shoots from: its body, one
 * point. A swing's shape and a shot leave from the body (npc-swings.js
 * `landNpcSwing`, `launchNpcProjectile`), as the client places its own
 * colliders at `worldCenter`, and what it sees is what they can reach: the
 * victim's body (`seesBody`). The sight line used to start at the feet,
 * which were what this server kept out of the walls, and end at the
 * victim's feet or, failing that, his body.
 *
 * The official decides it body to body. With a hero's feet line from the
 * monster blocked and the body line clear, its monsters attack 0.224 times a
 * second, against 0.231 with both clear: the feet line does not hold it back.
 */
export const swingOrigin = (actor) => bodyPointOf(actor, feetOf(actor)) ?? feetOf(actor);
export const sightOrigin = swingOrigin;

/**
 * Whether `actor`, its feet at `from`, sees `victim`, whose feet are at
 * `at`: a line of no width from its body to the victim's, which is what a
 * swing is let go on (npc-act.js) and what a route ends in sight of
 * (routing.js). A victim with no body in the library is seen at its feet.
 */
export const seesBody = (navigation, actor, from, victim, at) =>
  hasLineOfSight(navigation, bodyPointOf(actor, from) ?? from, bodyPointOf(victim, at) ?? at, 0);

/**
 * The scenery, asked at the body.
 *
 * An actor collides with the walls at its body, not its feet. Over about
 * 472,000 official monster samples the body circle is inside the scenery on
 * 0-2.3% of a row's samples and the circle drawn at the feet on 3-18%; the
 * body touches a wall on 13.4% of them and the feet on 4.3%. No row is better
 * explained by the feet but the placed STATIONARY_KNIGHT turrets, which never
 * walk. Ours kept the feet out of the walls, so a knight sliding along a wall
 * above it stood with its body in it (up to 33% of a KNIGHT's samples) and
 * one along a wall below it kept a body's width off.
 *
 * So every question an actor's circle asks of the scenery is asked here of
 * its body: the feet it is given are moved up to the body, the question put
 * as navigation.js has it, and an answer that is a place moved back down to
 * the feet, which is what the wire and the rest of the AI speak. Moving,
 * routing, finding a way out, placing and releasing all ask through these.
 * `body` is the actor, or a row about to be one: `{ constant, scale }`
 * (`rowBody`). One the library has no shape for is asked at its feet.
 */
const offsetOf = (body) => {
  const offset = bodyOffsetOf(body);
  return offset && (offset.x || offset.y) ? offset : null;
};
const up = (offset, point) => (offset && point ? { x: point.x + offset.x, y: point.y + offset.y } : point);
const down = (offset, point) => (offset && point ? { x: point.x - offset.x, y: point.y - offset.y } : point);

/** The body a row will be spawned with, for placing it before it is an actor. */
export const rowBody = (npc, scale = null) => ({ constant: npc?.Constant, scale: Number(scale ?? npc?.Scale ?? 1) || 1 });

/** Whether its body, with its feet at `feet`, overlaps the scenery. */
export const bodyBlocked = (navigation, body, feet, radius = 0, options) =>
  isPositionBlocked(navigation, up(offsetOf(body), feet), radius, options);

/** Whether its body can go straight from where its feet are at `from` to where they are at `to`. */
export const bodyWalkClear = (navigation, body, from, to, radius = 0, options) => {
  const offset = offsetOf(body);
  return hasLineOfSight(navigation, up(offset, from), up(offset, to), radius, options);
};

/** Where a step takes its feet, its body slid through the scenery (`moveWithNavigation`). */
export const moveBody = (navigation, body, from, displacement, radius = 0, options) => {
  const offset = offsetOf(body);
  return down(offset, moveWithNavigation(navigation, up(offset, from), displacement, radius, options));
};

/**
 * The nearest feet its body stands clear at (`nearestClearPosition`): `towards`
 * and `reachableFrom` are feet too, and `accept` is handed feet.
 */
export const bodyClearSpot = (navigation, body, origin, radius = 0, { towards = null, reachableFrom = null, accept, reach } = {}) => {
  const offset = offsetOf(body);
  if (!offset) return nearestClearPosition(navigation, origin, radius, { towards, reachableFrom, accept, reach });
  const spot = nearestClearPosition(navigation, up(offset, origin), radius, {
    towards: up(offset, towards),
    reachableFrom: up(offset, reachableFrom),
    accept: accept && ((candidate) => accept(down(offset, candidate))),
    reach,
  });
  return down(offset, spot);
};

/**
 * Its route from `start` to `goal`, searched for its body (`searchRoute`,
 * remembered on `owner`) and walked by its feet.
 */
export const bodyRoute = (owner, navigation, body, start, goal, radius) => {
  const offset = offsetOf(body);
  if (!offset) return searchRoute(owner, navigation, start, goal, radius);
  const found = searchRoute(owner, navigation, up(offset, start), up(offset, goal), radius);
  const route = found.map((point) => down(offset, point));
  if (found.endsShort) route.endsShort = true;
  return route;
};

/** The way out of the cage its body is in (`findCageReleasePath`), its `target` for the feet. */
export const bodyCageExit = (navigation, body, origin, radius, target) => {
  const offset = offsetOf(body);
  const exit = findCageReleasePath(navigation, up(offset, origin), radius, up(offset, target));
  return exit && offset ? { ...exit, target: down(offset, exit.target) } : exit;
};

/**
 * Where its feet stand for its body to be on the victim's, whose feet are at
 * `at`: what a route aims at, so that the place it ends in sight of is the
 * victim's body (pathfind.js `placeReached`).
 */
export const aimAt = (actor, victim, at) => down(offsetOf(actor), bodyPointOf(victim, at) ?? at);

/**
 * How far a swing's shape is pushed out by its own body.
 *
 * Not `bodyRadius`: floored at zero and zero when nothing says. The two only
 * part for a body under twelve or none at all, which no built `ai` has.
 */
export const swingBodyRadius = (ai, attacker) =>
  Math.max(0, Number(ai.collisionRadius ?? attacker.collisionRadius ?? 0));

/**
 * How far one attack reaches, middle to middle, given the two bodies.
 *
 * A contact attack's `Range` is the gap it closes between the two bodies, not
 * the distance between their feet: it may swing when the edge of its body is
 * within `Range` of the edge of the player's, which is `Range` plus both radii
 * from the middle. Measured on the official, solo captures, swings at a player
 * who had not moved for 800ms (so the position on the wire is where they
 * stood):
 *
 *   KNIGHT_HALBERD  Range 140  bodies 68  swings up to 200, 71% beyond 140, none beyond 208
 *   KNIGHT          Range  80  bodies 68  swings up to 137, 42% beyond  80, none beyond 148
 *   KNIGHT_BOXERS   Range  80  bodies 64  swings up to 129, 48% beyond  80, none beyond 144
 *   BRUTE_DARK      Range  80  bodies 70  swings up to 137, 52% beyond  80, none beyond 150
 *   BABY_YETI       Range  65  bodies 68  swings up to 138, every one beyond 65, one of 68 beyond 133
 *
 * With the player moving, 3-13% of swings sit past that line and 1-8% past it
 * by forty, which is the lag between what the server had seen and where the
 * player then was. Reading `Range` from the middle instead held a halberd
 * knight at 134-141 from the player for 45 seconds, swinging once, and a sword
 * knight could only ever swing from inside 80 where the official swings from
 * 148.
 *
 * A shot keeps its `Range` as the furthest it is thrown, from the middle:
 * KNIGHT_MARKSMAN's 600 has 16% of its shots beyond 600 and 13% beyond 626,
 * which is the same lag tail and not a wider band. The bodies are still the
 * floor for anything, so a leech whose body meets the player's at 131 may bite
 * what it is touching.
 */
export const reach = (attack, bodies) =>
  attack?.projectile
    ? Math.max(Number(attack.range ?? 0), bodies)
    : Number(attack.range ?? 0) + bodies;

/**
 * How far it may swing from at all: the furthest of its attacks' reaches, or
 * the two bodies if that is greater. The second case is only a shot from a
 * body wider than its range now — a contact attack always reaches at least the
 * bodies.
 */
export const furthestReach = (attacks, bodies) =>
  Math.max(bodies, ...attacks.map((attack) => reach(attack, bodies)));

/**
 * The "may it swing from here at all" bar an `ai` is built with: the furthest
 * of its attacks' `Range`, twenty at least. Which attack it then uses is
 * decided per swing against that attack's own band.
 */
export const furthestAttackRange = (attackSet) =>
  Math.max(20, ...attackSet.map((attack) => attack.range));

/**
 * How close a monster walks to its victim, middle to middle, given the bodies.
 *
 * Bodies touching. The corpus is unambiguous that this and not the attack
 * range is where the walk ends — for a monster standing still in a fight, the
 * fifth percentile of its distance to the hero sits on the sum of the two
 * bodies whatever its range happens to be:
 *
 *   KNIGHT            p05 67   bodies 67.9   Range  80
 *   SKELETON_WARRIOR  p05 67   bodies 67.1   Range  80
 *   BABY_YETI         p05 65   bodies 67.9   Range  65
 *   RAPTOR            p05 69   bodies 71.9   Range 100
 *   KNIGHT_HALBERD    p05 69   bodies 67.9   Range 140
 *
 * KNIGHT_HALBERD settles it. Its range is 140 and its bodies meet at 68, and
 * its distances pile up in the 60-80 bin with a *trough* from there to 140 —
 * so it is walking to contact and not stopping at its reach. Ours stopped at
 * the reach, which put a halberd knight in a ring 140 units off the player
 * poking at them, and a marksman in one 600 units out.
 *
 * Never inside the bodies, whatever the reach says. This used to allow a
 * monster whose body is wider than its swing to stand *inside* the player so it
 * could still connect, on the reasoning that a dragon which cannot bite is not
 * what the table says. Thirteen of the 98 fighting rows qualified and the worst
 * of them, GIANT_LEECH, was parked 69 units inside the player — and on the
 * client the local hero is the only dynamic body in the room, so a monster
 * inside it is not a monster standing close, it is the player being shoved. A
 * BABY_YETI sat 10.4 units in for half of every tick it was engaged.
 *
 * The official does not do it. For those same rows its standing distance is at
 * or beyond the bodies: BRUTE_CAVE p05 98 against bodies of 87, GREEN_BRUTE 85
 * against 78, JUNGLE_LEECH 66 against 67, BABY_YETI 65 against 68. The reason
 * it can afford to is that those monsters have a longer attack than the one
 * this server gives them — BRUTE_CAVE's swings in the corpus are EN_FART_ATTACK
 * at range 250, not the range-80 `Attack1` we read. So the clamp was
 * compensating for a missing attack by moving the body, and the compensation
 * belongs on the attack instead: see `furthestReach`.
 *
 * And except for the ones that do not want contact. `keep` is the ring it
 * would rather hold — its `keepDistance`, the kiters' standoff from the NPC row
 * (see where it is read in dungeon.js for the corpus behind it) — but never
 * further than eight inside its `attackRange`. A teleporter asks the same with
 * its `teleportRange` as the ring, for the furthest it may land from its
 * victim.
 */
export const standoff = (actor, bodies, keep = actor.ai?.keepDistance ?? 0) => {
  const swing = Math.max(12, (actor.ai?.attackRange ?? bodies) - 8);
  return Math.max(bodies, Math.min(keep, swing));
};

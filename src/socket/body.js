import { collisionPointOf, navigationEntryFor } from "./navigation.js";

/**
 * Where an actor is and how wide it is, asked in one place.
 *
 * The position on the wire is the feet. The body is a circle above them: its
 * radius is the one the actor was built with (`authoredBodyRadius`), its
 * middle the feet moved by the library's offset — 22 up for every hero and 97
 * of the 122 monsters (`collisionPointOf`, navigation.js). The AI, the
 * separation, the swing and the shot used to work these out each for itself.
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
 * Where a monster's sight line starts, and where its swing and its shot start.
 *
 * Open decision: they are not the same point. A sight line is drawn from the
 * feet (ai.js `victimInSight`), the point this server's navigation keeps clear
 * of the walls. A swing's shape and a shot leave from the body (npc-swings.js
 * `landNpcSwing`, `launchNpcProjectile`), as the client places its own
 * colliders at `worldCenter`. So a monster sees from 22 below where it hits
 * from. Both answers are kept as they were; which one is right is not decided.
 */
export const sightOrigin = (actor) => feetOf(actor);
export const swingOrigin = (actor) => bodyPointOf(actor, feetOf(actor)) ?? feetOf(actor);

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

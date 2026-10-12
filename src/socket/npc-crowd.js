import { candidateSetOf } from "./actor-roles.js";
import { bodyRadius } from "./body.js";
import { heroMembersOf } from "./match-world.js";
import { bodyOffsetOf } from "./navigation.js";
import { placeNpc, stepNpc } from "./npc-move.js";

/**
 * Who is on the floor this tick, and the crowd they make.
 *
 * The AI senses the floor once a tick (`senseCrowd`): the living heroes, where
 * the player says they stand, and everything else with a body by the side it
 * is on. The same crowd is what every moving body is pushed out of
 * (`separationDisplacement`), monsters and players alike, and what an idle
 * body settles against (`separateIdleNpc`).
 */

export const squaredDistanceTo = (from, to) => {
  const x = to.x - from.x;
  const y = to.y - from.y;
  return x * x + y * y;
};

/**
 * The crowd the separation works against, monsters and the player alike.
 *
 * The player used to be left out of it, because only actors with an `ai` were
 * indexed. Nothing then kept a monster from walking into the space the player
 * occupies — and on the client the player is the one dynamic body in the room,
 * so a body walked into is a player shoved aside. That is the drifting: not the
 * player moving, the crowd moving them.
 */
const buildNpcSpatialIndex = (actors, deltaSeconds, heroDoids) => {
  let largestRadius = 0;
  let maximumTravel = 0;
  for (const actor of actors.values()) {
    if (actor.ai && !actor.dead && !actor.teleportHidden && actor.position) {
      largestRadius = Math.max(largestRadius, bodyRadius(actor));
      maximumTravel = Math.max(maximumTravel, (actor.ai.moveSpeed ?? 0) * deltaSeconds);
    }
  }

  /**
   * Whatever a body could meet this tick is in the 3x3 cells round it: two
   * bodies touching, the walk it takes towards the other, and the step the
   * other may already have taken this tick (the tick is sequential, and an
   * actor is found where it now stands but bucketed where it stood). Eight
   * more is for two bodies drawn at different sizes, whose middles sit at
   * different heights above their feet.
   */
  const cellSize = Math.max(1, largestRadius * 2 + maximumTravel * 2 + 8);
  // Each cell a flat list of doid, actor, doid, actor... under its `cellKey`.
  const cells = new Map();
  /** The team the players are on, as their heroes carry it (npc-move.js `bodyRule`). */
  let playersSide = null;
  for (const doid of heroDoids) playersSide ??= actors.get(doid)?.team ?? null;
  for (const [doid, actor] of actors) {
    // A teleporter off the floor is no body, as it is no candidate (`senseCrowd`).
    if ((!actor.ai && !heroDoids.has(doid)) || actor.dead || actor.teleportHidden || !actor.position) continue;
    const x = Math.floor(actor.position.x / cellSize);
    const y = Math.floor(actor.position.y / cellSize);
    const key = cellKey(x, y);
    const cell = cells.get(key);
    if (cell) cell.push(doid, actor);
    else cells.set(key, [doid, actor]);
  }
  return { cellSize, cells, playersSide };
};

/** A cell's key in the index: a number, one per cell of any floor (a coordinate within ±2^19 cells). */
const cellKey = (x, y) => x * 1048576 + y;

/**
 * The crowd round one body: the push out of whatever it already overlaps,
 * the players it touches, and the monsters it may not walk into.
 *
 * Monster bodies are hard. On the client every actor but the local hero is a
 * static Box2D body, so two monsters never push each other apart there, and
 * the official server does not walk one into another: over 57 solo captures
 * (135,406 engaged monster samples, the hero up) a body is more than 10
 * units inside another's on 3.4% of them, where ours, pushing apart half the shortfall a
 * tick against a whole step of chase, sat at 18-38%. So a walk stops where it
 * would touch another monster's body (`bodies`, swept by `stepNpc`,
 * npc-move.js), and the push below only lifts a body out of one it is already
 * inside: after a lunge, a knockback, or a burst that spawned on one spot.
 * Two monsters touching are at rest; nothing pushes them further apart.
 *
 * Monsters meet at their bodies (`bodyPointOf`, body.js), where they meet the
 * walls; a player at his feet, as `keptOutOfHeroes` (npc-move.js) keeps him. The stable
 * pair angle separates two actors on identical coordinates instead of leaving
 * the direction undefined.
 *
 * `x`, `y` is the push, and `near` every other body near enough to meet
 * this tick, players and monsters alike: its doid and actor, whether it is
 * a `player`, the point it is met at, the distance at which the two touch,
 * and for a player it rests against, `out`, the way out of him. What each
 * of them is to a walk — a body it walks through, goes round, waits behind
 * or is kept out of — is not the crowd's to say (npc-move.js `bodyRule`).
 * A body that does not walk (`separateIdleNpc`) asks for the push alone
 * (`collectNear` false), and `near` stays empty.
 */
export const separationDisplacement = (
  doid,
  actor,
  spatialIndex,
  heroDoids,
  { includeHeroes = true, correctionShare = 0.5, collectNear = true } = {}
) => {
  let x = 0;
  let y = 0;
  const near = [];
  const radius = bodyRadius(actor);
  const { position } = actor;
  // Its body point (body.js `bodyPointOf`), and each monster's below, as numbers.
  const ownOffset = bodyOffsetOf(actor);
  const ownX = ownOffset ? position.x + ownOffset.x : position.x;
  const ownY = ownOffset ? position.y + ownOffset.y : position.y;
  const cellX = Math.floor(position.x / spatialIndex.cellSize);
  const cellY = Math.floor(position.y / spatialIndex.cellSize);

  for (let yOffset = -1; yOffset <= 1; yOffset++) {
    for (let xOffset = -1; xOffset <= 1; xOffset++) {
      const cell = spatialIndex.cells.get(cellKey(cellX + xOffset, cellY + yOffset));
      if (!cell) continue;

      for (let at = 0; at < cell.length; at += 2) {
        const otherDoid = cell[at];
        const other = cell[at + 1];
        if (otherDoid === doid) continue;
        const isHero = heroDoids.has(otherDoid);
        // Idle separation solves mob spawn overlap. A passive AggroRadius=0
        // actor must not look as though it is fleeing merely because the hero
        // walked into it; engaged/release movement keeps the hero-body rule.
        if (!includeHeroes && isHero) continue;

        // A player is met at his feet, from its feet; a monster body to body.
        const offset = isHero ? null : bodyOffsetOf(other);
        const atX = offset ? other.position.x + offset.x : other.position.x;
        const atY = offset ? other.position.y + offset.y : other.position.y;
        let dx = (isHero ? position.x : ownX) - atX;
        let dy = (isHero ? position.y : ownY) - atY;
        let distance = Math.hypot(dx, dy);
        const touching = radius + bodyRadius(other);
        const body = collectNear
          ? { doid: otherDoid, actor: other, player: isHero, x: atX, y: atY, touching, out: null }
          : null;
        if (body) near.push(body);
        /**
         * The nearest peer sits on the sum of the two bodies. Measured
         * against the official for monsters standing in a fight: KNIGHT p25
         * 84 against 84, BRUTE p25 85 against 88, ICE_IMP p25 70 against 70.
         * The player is the same rule, for every body: lifted out of him at
         * contact, and no further.
         *
         * A standoff is where a walk stops (body.js `standoff`), not a ring
         * the crowd pushes it out to. Kept at its keep distance here, a hero
         * walking into a marksman dragged it 3528 units in 20 s, attacking or
         * not, and the dragon pet was shoved 200 off every player it passed.
         * The official kiter stands its ground when a player closes on it,
         * and only backs off now and then (`awayFromThreats`).
         */
        const minimumDistance = touching;
        if (distance >= minimumDistance) continue;

        if (distance < 0.001) {
          const low = Math.min(doid, otherDoid);
          const high = Math.max(doid, otherDoid);
          const hash = (Math.imul(low, 1103515245) ^ Math.imul(high, 12345)) >>> 0;
          const angle = (hash / 0x100000000) * Math.PI * 2 + (doid === low ? 0 : Math.PI);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        // Combat movement lets both participants share the correction. Idle
        // spawn resolution is sequential and uses the whole shortfall so the
        // pair reaches contact in the first server step instead of creeping.
        const correction =
          (minimumDistance - Math.min(distance, minimumDistance)) * correctionShare;
        x += (dx / distance) * correction;
        y += (dy / distance) * correction;
        if (isHero && body) body.out = { x: dx / distance, y: dy / distance };
      }
    }
  }

  return { x, y, near };
};

/**
 * How far a body may be shoved in one tick.
 *
 * At most as fast as it could walk, undebuffed. A crowd moves a body, it does
 * not fling it — and the raw displacement is a sum over every neighbour, so a
 * deep stack would otherwise resolve as one visible jump.
 *
 * Undebuffed on purpose. `MOVEMENT` says what an actor can walk, not whether it
 * can be pushed; a stunned monster still occupies space and is still shoved out
 * of another one.
 */
export const boundedPush = (separation, ai, deltaSeconds) => {
  const push = Math.hypot(separation.x, separation.y);
  if (push <= 0.001) return { x: 0, y: 0 };
  const travel = Math.min((ai?.moveSpeed ?? 0) * deltaSeconds, push);
  return { x: (separation.x / push) * travel, y: (separation.y / push) * travel };
};

/**
 * Resolves body overlap without turning an idle NPC into a pursuing one.
 *
 * This deliberately runs only after cage release has had first refusal and
 * only while the hero remains outside aggro. It emits position, not heading,
 * does not set `engaged`, and uses ordinary navigation collisions. A prisoner
 * therefore keeps the release target and its temporary ignored cage collider;
 * a resting pack merely reaches body contact and stops.
 */
export const separateIdleNpc = (
  session,
  doid,
  actor,
  spatialIndex,
  heroDoids,
  heroes,
  deltaSeconds
) => {
  const crowding = separationDisplacement(
    doid,
    actor,
    spatialIndex,
    heroDoids,
    {
      includeHeroes: false,
      correctionShare: 1,
      collectNear: false,
    }
  );
  // Nothing to be lifted out of, no step: with no walk and no push the step
  // would go nowhere (`stepNpc`).
  const push = boundedPush(crowding, actor.ai, deltaSeconds);
  if (!push.x && !push.y) return false;
  const step = stepNpc(session.navigation, actor, {
    walk: { x: 0, y: 0 },
    separation: push,
    heroes,
    radius: bodyRadius(actor),
    deltaSeconds,
    kind: "settle",
  });
  if (!step || step.travel <= 0.001) return false;
  placeNpc(session, doid, actor, step);
  return true;
};

/**
 * The floor as the AI sees it at the start of a tick.
 *
 * Each candidate holds the actor's own position, not a copy, so one that has
 * already moved in this tick is found where it now stands. A hidden teleporter
 * is not on the floor. `navigation` is the floor's scenery, which a pet's
 * pick asks of (behaviours/pet.js `petPick`).
 */
export const senseCrowd = (session, actors, deltaSeconds) => {
  const heroes = [...heroMembersOf(session)]
    .map(([doid, member]) => {
      const actor = actors.get(doid);
      const position = member.heroPosition ?? actor?.position;
      return { doid, member, actor, position };
    })
    .filter(({ actor, position }) => actor && !actor.dead && actor.hitPoints > 0 && position);
  const heroDoids = new Set(heroes.map(({ doid }) => doid));
  const spatialIndex = buildNpcSpatialIndex(actors, deltaSeconds, heroDoids);
  const sets = { pets: [], enemies: [], beasts: [], allies: [] };
  const { pets, enemies, beasts, allies } = sets;
  for (const [doid, actor] of actors) {
    if (actor.dead || actor.teleportHidden || !(actor.hitPoints > 0) || !actor.position) continue;
    const set = candidateSetOf(actor);
    if (set) sets[set].push({ doid, actor, position: actor.position, member: null });
  }
  // Who may target whom is target-lock.js's to say (`targetsOf`).
  return {
    navigation: session.navigation ?? null,
    heroes,
    heroDoids,
    spatialIndex,
    pets,
    enemies,
    beasts,
    allies,
  };
};

/**
 * Nothing has an opposing combatant left: no hero, pet or ally, and not both
 * an enemy and a beast to fight each other.
 */
export const nobodyToFight = ({ heroes, pets, allies, enemies, beasts }) =>
  !heroes.length && !pets.length && !allies.length && (!enemies.length || !beasts.length);

/** The candidate nearest `position`, the first of equals; null when there are none. */
export const nearestTo = (position, candidates) =>
  candidates.reduce(
    (nearest, candidate) =>
      !nearest ||
      squaredDistanceTo(position, candidate.position) <
        squaredDistanceTo(position, nearest.position)
        ? candidate
        : nearest,
    null
  );

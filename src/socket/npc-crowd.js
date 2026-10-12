import { friendlyBodies, isHuntable } from "./actor-roles.js";
import { bodyPointOf, bodyRadius, standoff } from "./body.js";
import { heroMembersOf } from "./match-world.js";
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
    if (actor.ai && !actor.dead && actor.position) {
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
  const cells = new Map();
  /** The team the players are on, as their heroes carry it (actor-roles.js `friendlyBodies`). */
  let playersSide = null;
  for (const doid of heroDoids) playersSide ??= actors.get(doid)?.team ?? null;
  for (const [doid, actor] of actors) {
    if ((!actor.ai && !heroDoids.has(doid)) || actor.dead || !actor.position) continue;
    const x = Math.floor(actor.position.x / cellSize);
    const y = Math.floor(actor.position.y / cellSize);
    const key = `${x},${y}`;
    const cell = cells.get(key) ?? [];
    cell.push([doid, actor]);
    cells.set(key, cell);
  }
  return { cellSize, cells, playersSide };
};

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
 * walls; a player at his feet, as `keptOutOfHeroes` keeps him. The stable
 * pair angle separates two actors on identical coordinates instead of leaving
 * the direction undefined.
 *
 * `x`, `y` is the push; `contacts` the players it touches, each as the way
 * out of him; `bodies` every other monster near enough to meet this tick,
 * its body point, the distance at which the two touch and whether it
 * `queues` behind it, being of its team (npc-move.js `goesRound`). On the
 * players' side, the others on it are neither (actor-roles.js
 * `friendlyBodies`): they pass through one another, and only the push
 * lifts two of them out of each other.
 */
export const separationDisplacement = (
  doid,
  actor,
  spatialIndex,
  heroDoids,
  { includeHeroes = true, correctionShare = 0.5 } = {}
) => {
  let x = 0;
  let y = 0;
  /**
   * The players it is resting against, each as the way out of that one.
   *
   * The chase keeps whatever part of itself runs along a player it touches
   * and loses the part that runs through him (`stepNpc`), so a crowd
   * arriving at one player spreads round him instead of piling into him.
   * A body on his side that he does not collide with walks on through him
   * (`friendlyBodies`, actor-roles.js); the push still lifts it out.
   */
  const contacts = [];
  const bodies = [];
  const radius = bodyRadius(actor);
  const own = bodyPointOf(actor, actor.position);
  const cellX = Math.floor(actor.position.x / spatialIndex.cellSize);
  const cellY = Math.floor(actor.position.y / spatialIndex.cellSize);

  for (let yOffset = -1; yOffset <= 1; yOffset++) {
    for (let xOffset = -1; xOffset <= 1; xOffset++) {
      const cell = spatialIndex.cells.get(`${cellX + xOffset},${cellY + yOffset}`);
      if (!cell) continue;

      for (const [otherDoid, other] of cell) {
        if (otherDoid === doid) continue;
        const isHero = heroDoids.has(otherDoid);
        // Idle separation solves mob spawn overlap. A passive AggroRadius=0
        // actor must not look as though it is fleeing merely because the hero
        // walked into it; engaged/release movement keeps the hero-body rule.
        if (!includeHeroes && isHero) continue;

        const from = isHero ? actor.position : own;
        const at = isHero ? other.position : bodyPointOf(other, other.position);
        let dx = from.x - at.x;
        let dy = from.y - at.y;
        let distance = Math.hypot(dx, dy);
        const touching = radius + bodyRadius(other);
        // A body on the players' side does not hold a walk on it
        // (`friendlyBodies`); one of another team is not queued behind.
        const friendly = friendlyBodies(actor, other, spatialIndex.playersSide);
        if (!isHero && !friendly) bodies.push({ x: at.x, y: at.y, touching, queues: other.team === actor.team });
        /**
         * The nearest peer sits on the sum of the two bodies. Measured
         * against the official for monsters standing in a fight: KNIGHT p25
         * 84 against 84, BRUTE p25 85 against 88, ICE_IMP p25 70 against 70.
         * The player is the same rule with one exception, which `standoff`
         * (body.js) carries.
         *
         * That exception is a pet's alone. A kiter's standoff is where it
         * stops walking in, not a ring a player pushes it along: kept at its
         * keep distance here, a hero walking into a marksman dragged it 3528
         * units in 20 s, attacking or not. The official kiter stands its
         * ground when a player closes on it, and only backs off now and then
         * (`awayFromThreats`).
         */
        const minimumDistance = isHero && actor.ai?.kind === "pet" ? standoff(actor, touching) : touching;
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
        if (isHero && !friendly) contacts.push({ x: dx / distance, y: dy / distance });
      }
    }
  }

  return { x, y, contacts, bodies };
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
    }
  );
  const step = stepNpc(session.navigation, actor, {
    walk: { x: 0, y: 0 },
    separation: boundedPush(crowding, actor.ai, deltaSeconds),
    heroes,
    radius: bodyRadius(actor),
    deltaSeconds,
    ignoresSmall: "movement",
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
 * pick asks of (npc-targeting.js). `petAggressors` is how many enemies are on each pet,
 * which targeting keeps current as it goes (npc-targeting.js).
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
  const pets = [];
  const enemies = [];
  const beasts = [];
  /** On the players' side without being players: the chef, a princess, a barricade (dungeon.js `isAlly`). */
  const allies = [];
  for (const [doid, actor] of actors) {
    if (actor.dead || actor.teleportHidden || !(actor.hitPoints > 0) || !actor.position) continue;
    const candidate = { doid, actor, position: actor.position, member: null };
    if (actor.isPet) pets.push(candidate);
    else if (actor.isEnemy) enemies.push(candidate);
    else if (actor.isBeast) beasts.push(candidate);
    else if (actor.isAlly) allies.push(candidate);
  }
  const byDoid = (candidates) => new Map(candidates.map((candidate) => [candidate.doid, candidate]));
  const petByDoid = byDoid(pets);
  const huntable = enemies.filter(({ actor }) => isHuntable(actor));
  const petAggressors = new Map();
  for (const { actor } of enemies) {
    if (!petByDoid.has(actor.ai?.targetDoid)) continue;
    petAggressors.set(
      actor.ai.targetDoid,
      (petAggressors.get(actor.ai.targetDoid) ?? 0) + 1
    );
  }
  return {
    navigation: session.navigation ?? null,
    heroes,
    heroDoids,
    spatialIndex,
    pets,
    enemies,
    beasts,
    allies,
    huntable,
    heroByDoid: byDoid(heroes),
    petByDoid,
    beastByDoid: byDoid(beasts),
    allyByDoid: byDoid(allies),
    petTargets: [...huntable, ...beasts],
    beastTargets: [...heroes, ...pets, ...allies, ...huntable],
    petAggressors,
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

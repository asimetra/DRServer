import { isHuntable } from "./actor-roles.js";
import { bodyRadius, standoff } from "./body.js";
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

const sameWave = (actor, other) =>
  actor.ai?.wave?.group && actor.ai.wave.group === other.ai?.wave?.group;

/** Indexes active NPCs so local separation only considers nearby neighbours. */
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

  // An actor can change cells during the sequential tick. Making a cell at
  // least one maximum step wide keeps its old bucket within the 3x3 query.
  const cellSize = Math.max(1, largestRadius * 2 + 8, maximumTravel);
  const cells = new Map();
  for (const [doid, actor] of actors) {
    if ((!actor.ai && !heroDoids.has(doid)) || actor.dead || !actor.position) continue;
    const x = Math.floor(actor.position.x / cellSize);
    const y = Math.floor(actor.position.y / cellSize);
    const key = `${x},${y}`;
    const cell = cells.get(key) ?? [];
    cell.push([doid, actor]);
    cells.set(key, cell);
  }
  return { cellSize, cells };
};

/**
 * Local collision avoidance for moving NPCs.
 *
 * The client renders Box2D bodies, but the server is authoritative for NPC
 * positions. Driving every melee actor toward the exact same point therefore
 * makes them stack even though their client-side bodies are solid. This
 * computes a small symmetric displacement for overlapping server actors. The
 * stable pair angle also separates two actors that arrived at identical
 * coordinates instead of leaving the direction undefined.
 */
export const separationDisplacement = (
  doid,
  actor,
  spatialIndex,
  heroDoids,
  {
    includeHeroes = true,
    npcPadding = 8,
    correctionShare = 0.5,
  } = {}
) => {
  let x = 0;
  let y = 0;
  /**
   * The bodies it is resting against, each as the way out of that one.
   *
   * Pushing apart alone does not hold a crowd open. The push is half the
   * shortfall and shrinks as the gap closes, while the chase is a whole step
   * every tick and does not — so two monsters converging on one hero settle
   * wherever those balance, which is inside each other. Measured at a 50.8 gap
   * where their bodies needed 78.
   *
   * A contact is the other half of it: you may walk around a body you are
   * touching, not into it. The chase keeps whatever part of itself runs along
   * the contact and loses the part that runs through it, so a crowd arriving
   * at one target spreads into a ring instead of a pile.
   */
  const contacts = [];
  const radius = bodyRadius(actor);
  const cellX = Math.floor(actor.position.x / spatialIndex.cellSize);
  const cellY = Math.floor(actor.position.y / spatialIndex.cellSize);

  for (let yOffset = -1; yOffset <= 1; yOffset++) {
    for (let xOffset = -1; xOffset <= 1; xOffset++) {
      const cell = spatialIndex.cells.get(`${cellX + xOffset},${cellY + yOffset}`);
      if (!cell) continue;

      for (const [otherDoid, other] of cell) {
        if (otherDoid === doid) continue;
        // Idle separation solves mob spawn overlap. A passive AggroRadius=0
        // actor must not look as though it is fleeing merely because the hero
        // walked into it; engaged/release movement keeps the hero-body rule.
        if (!includeHeroes && heroDoids.has(otherDoid)) continue;

        let dx = actor.position.x - other.position.x;
        let dy = actor.position.y - other.position.y;
        let distance = Math.hypot(dx, dy);
        /**
         * Everyone gets the full buffer, wave or not.
         *
         * Members of one burst used to settle for three quarters of a single
         * radius on the grounds that "the client already owns physical body
         * contact". It does not: the client makes a dynamic Box2D body for the
         * local hero and leaves every other actor static, so two monsters never
         * push each other apart there. This displacement is the only thing
         * keeping them out of one another, and at a quarter of the distance they
         * needed it was letting a released wave overlap by design.
         */
        const bodies = radius + bodyRadius(other);
        /**
         * A burst may stand shoulder to shoulder; it may not stand inside
         * itself. Unrelated NPCs keep a little air between them as well.
         *
         * Measured against the official for monsters standing in a fight, the
         * nearest peer sits on the sum of the two bodies: KNIGHT p25 84 against
         * 84, BRUTE p25 85 against 88, ICE_IMP p25 70 against 70. The player is
         * the same rule with one exception, which `standoff` (body.js) carries.
         *
         * That exception is a pet's alone. A kiter's standoff is where it stops
         * walking in, not a ring a player pushes it along: kept at its keep
         * distance here, a hero walking into a marksman dragged it 3528 units
         * in 20 s, attacking or not. The official kiter stands its ground when
         * a player closes on it, and only backs off now and then
         * (`awayFromThreats`).
         */
        const minimumDistance = heroDoids.has(otherDoid)
          ? actor.ai?.kind === "pet"
            ? standoff(actor, bodies)
            : bodies
          : sameWave(actor, other)
            ? bodies
            : bodies + npcPadding;
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
        contacts.push({ x: dx / distance, y: dy / distance });
      }
    }
  }

  return { x, y, contacts };
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
      npcPadding: 0,
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
 * is not on the floor. `petAggressors` is how many enemies are on each pet,
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

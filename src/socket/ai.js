import { config } from "../config.js";
import { info, warn } from "../log.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { performNpcAttack } from "./combat.js";
import { buffMultiplierFor, hasAbility } from "./buffs.js";
import { heroMembersOf } from "./match-world.js";
import {
  findPath,
  hasLineOfSight,
  isPositionBlocked,
  moveWithNavigation,
} from "./navigation.js";

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
const ROUTE_REFRESH_MS = 1000;
const FAILED_PATH_RETRY_MS = 2000;

const squaredDistanceTo = (from, to) => {
  const x = to.x - from.x;
  const y = to.y - from.y;
  return x * x + y * y;
};

const collisionRadius = (actor) =>
  Math.max(12, actor.ai?.collisionRadius ?? actor.collisionRadius ?? 35);

const sameWave = (actor, other) =>
  actor.ai?.wave?.group && actor.ai.wave.group === other.ai?.wave?.group;

const clearNpcTarget = (actor) => {
  const { ai } = actor;
  if (!ai) return;
  ai.engaged = false;
  ai.state = "idle";
  ai.path = null;
  ai.pathIndex = 0;
  ai.pathTarget = null;
  ai.pathFailed = false;
  ai.nextPathAt = 0;
  ai.navigationRevision = undefined;
};

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
      largestRadius = Math.max(largestRadius, collisionRadius(actor));
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
const separationDisplacement = (doid, actor, spatialIndex, heroDoids) => {
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
  const cellX = Math.floor(actor.position.x / spatialIndex.cellSize);
  const cellY = Math.floor(actor.position.y / spatialIndex.cellSize);

  for (let yOffset = -1; yOffset <= 1; yOffset++) {
    for (let xOffset = -1; xOffset <= 1; xOffset++) {
      const cell = spatialIndex.cells.get(`${cellX + xOffset},${cellY + yOffset}`);
      if (!cell) continue;

      for (const [otherDoid, other] of cell) {
        if (otherDoid === doid) continue;

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
        const bodies = collisionRadius(actor) + collisionRadius(other);
        /**
         * A burst may stand shoulder to shoulder; it may not stand inside
         * itself. Unrelated NPCs keep a little air between them as well.
         *
         * Against the player it is bodies exactly — close enough to still be in
         * reach of whatever they are swinging, far enough not to stand where
         * the player is standing.
         */
        /**
         * Against the player, never further than it can swing.
         *
         * Holding a monster a body's width off the hero is right until the body
         * is wider than the reach, and then it is a monster that hovers outside
         * its own attack for ever. Two of the game's 117 attackable rows are
         * exactly that — Red Dragon, body 120, and Blue Dragon, body 100, both
         * authored with a range of 80 — and a dragon that cannot bite is not
         * what the table says. It was already true before anything here kept
         * them apart properly: measured, the Red Dragon settled at 179 and
         * never once got inside its 80.
         *
         * So the bar against the hero is the body or the reach, whichever is
         * the smaller. For everything of ordinary size the body is smaller and
         * nothing changes; only the ones big enough to trap themselves are let
         * closer.
         */
        const reach = Math.max(12, (actor.ai?.attackRange ?? bodies) - 8);
        const minimumDistance = heroDoids.has(otherDoid)
          ? Math.min(bodies, reach)
          : sameWave(actor, other)
            ? bodies
            : bodies + 8;
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

        // Each side takes half the correction, keeping pair motion symmetric.
        const correction = (minimumDistance - Math.min(distance, minimumDistance)) * 0.5;
        x += (dx / distance) * correction;
        y += (dy / distance) * correction;
        contacts.push({ x: dx / distance, y: dy / distance });
      }
    }
  }

  return { x, y, contacts };
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
  for (const contact of contacts) {
    const into = x * contact.x + y * contact.y;
    if (into >= 0) continue;
    x -= into * contact.x;
    y -= into * contact.y;
  }
  return { x, y };
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
const boundedPush = (separation, ai, deltaSeconds) => {
  const push = Math.hypot(separation.x, separation.y);
  if (push <= 0.001) return { x: 0, y: 0 };
  const travel = Math.min((ai?.moveSpeed ?? 0) * deltaSeconds, push);
  return { x: (separation.x / push) * travel, y: (separation.y / push) * travel };
};

const routeToTarget = (session, actor, target, now) => {
  const { ai } = actor;
  const navigation = session.navigation;
  const radius = collisionRadius(actor);
  if (!navigation || hasLineOfSight(navigation, actor.position, target, radius)) {
    ai.path = null;
    ai.pathIndex = 0;
    ai.pathFailed = false;
    return { waypoint: target, direct: true };
  }

  const targetMoved =
    !ai.pathTarget ||
    squaredDistanceTo(ai.pathTarget, target) >= navigation.cellSize * navigation.cellSize;
  const pathFinished = ai.path?.length && (ai.pathIndex ?? 0) >= ai.path.length;
  if (
    !Array.isArray(ai.path) ||
    pathFinished ||
    now >= (ai.nextPathAt ?? 0) ||
    targetMoved ||
    ai.navigationRevision !== navigation.revision
  ) {
    ai.path = findPath(navigation, actor.position, target, radius);
    ai.pathIndex = 0;
    ai.pathFailed = ai.path.length === 0;
    ai.pathTarget = { ...target };
    // A closed route should not make every NPC redo a full map search five
    // times per second. A changed target or navigation revision retries early.
    ai.nextPathAt = now + (ai.pathFailed ? FAILED_PATH_RETRY_MS : ROUTE_REFRESH_MS);
    ai.navigationRevision = navigation.revision;
  }

  const reachedDistance = Math.max(18, radius * 0.5);
  while (
    ai.path &&
    ai.pathIndex < ai.path.length &&
    squaredDistanceTo(actor.position, ai.path[ai.pathIndex]) <= reachedDistance * reachedDistance
  ) {
    ai.pathIndex++;
  }
  return { waypoint: ai.path?.[ai.pathIndex] ?? null, direct: false };
};

const faceTarget = (session, doid, actor, target) => {
  const heading = (Math.atan2(target.y - actor.position.y, target.x - actor.position.x) * 180) / Math.PI;
  if (Math.abs(heading - actor.heading) < 0.5) return;
  actor.heading = heading;
  session.send(npcHeadingUpdate(doid, heading));
};

/**
 * The gap before this NPC may swing again, rolled fresh each time.
 *
 * `AttackTimer` is the floor and `AttackTimeRand` the spread above it; see the
 * cadence figures where the two are read off the NPC row in dungeon.js. Rolling
 * per swing rather than once per NPC is what the corpus shows and what stops a
 * pack of four knights hitting on the same millisecond for a whole fight.
 *
 * The 100ms floor is for the four enemy rows that author `AttackTimer` 0 with
 * no spread. Without it they attack on every tick of the AI loop.
 */
export const attackIntervalMs = (ai) =>
  Math.max(100, (ai.attackTimerMs ?? 1500) + Math.random() * (ai.attackRandMs ?? 0));

/** Moves a freshly generated prisoner through its own cage before normal AI starts. */
/** How long a release may make no headway before it is given up on. */
const RELEASE_STALL_MS = 1000;

const advanceNpcRelease = (
  session,
  doid,
  actor,
  now,
  deltaSeconds,
  spatialIndex,
  heroDoid,
  heroPosition
) => {
  const { ai } = actor;
  const release = ai.release;
  if (!release) return false;

  ai.state = "release";
  if (now < (release.startsAt ?? 0)) return true;

  const radius = collisionRadius(actor);

  /**
   * The walk out of the cage is for getting out of the cage. Once the player is
   * in plain sight there is nothing left to get past, and every member of a wave
   * shares one release point — so carrying on means the whole group crosses to
   * the same spot before turning on the player, which is what makes them look
   * like they are gathering somewhere first.
   */
  const hero = session.actors?.get(heroDoid);
  if (
    hero &&
    !hero.dead &&
    heroPosition &&
    hasLineOfSight(session.navigation, actor.position, heroPosition, radius)
  ) {
    ai.release = null;
    clearNpcTarget(actor);
    return false;
  }

  /**
   * Out of the cage is enough; the release point is not a destination.
   *
   * Measured: a released monster walks 119 to 134 units to a point every member
   * of its cage shares, and only then looks at the player — nearly a second of
   * crossing the room to a spot nobody asked about. But the walk exists to get
   * through a doorway, and the doorway is behind it as soon as its own cage no
   * longer holds it.
   *
   * The line of sight above covers the open cases; this covers the ones where
   * the player is round a corner, which is where the detour was visible.
   */
  if (!isPositionBlocked(session.navigation, actor.position, radius)) {
    ai.release = null;
    clearNpcTarget(actor);
    return false;
  }

  const distance = distanceTo(actor.position, release.target);
  const reachedDistance = Math.max(8, radius * 0.25);
  if (distance <= reachedDistance) {
    ai.release = null;
    clearNpcTarget(actor);
    return true;
  }

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
  const nextPosition = moveWithNavigation(
    session.navigation,
    actor.position,
    {
      x: ((release.target.x - actor.position.x) / distance) * travel + separation.x,
      y: ((release.target.y - actor.position.y) / distance) * travel + separation.y,
    },
    radius,
    { ignoredColliders: release.ignoredColliders }
  );
  const actualTravel = distanceTo(actor.position, nextPosition);

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
      ai.release = null;
      clearNpcTarget(actor);
      return false;
    }
  }

  actor.position.x = nextPosition.x;
  actor.position.y = nextPosition.y;
  if (actualTravel > 0.001) {
    faceTarget(session, doid, actor, release.target);
    session.send(npcPositionUpdate(doid, actor.position));
  }
  if (distanceTo(actor.position, release.target) <= reachedDistance) {
    ai.release = null;
    clearNpcTarget(actor);
  }
  return true;
};

/** One deterministic AI step; exported so movement and combat can be locked by tests. */
export const tickNpcAi = async (session, now, deltaSeconds) => {
  const actors = session.actors;
  if (!actors) return;
  const heroes = [...heroMembersOf(session)]
    .map(([doid, member]) => {
      const actor = actors.get(doid);
      const position = member.heroPosition ?? actor?.position;
      return { doid, member, actor, position };
    })
    .filter(({ actor, position }) => actor && !actor.dead && actor.hitPoints > 0 && position);
  if (!heroes.length) {
    // The server owns death. Explicitly releasing every chase state prevents
    // an NPC from resuming a stale route while the player is down or reviving.
    for (const actor of actors.values()) clearNpcTarget(actor);
    return;
  }
  const heroDoids = new Set(heroes.map(({ doid }) => doid));
  const spatialIndex = buildNpcSpatialIndex(actors, deltaSeconds, heroDoids);

  for (const [doid, actor] of actors) {
    const ai = actor.ai;
    if (!ai || actor.dead || !actor.position) continue;
    const victim = heroes.reduce(
      (nearest, candidate) =>
        !nearest ||
        squaredDistanceTo(actor.position, candidate.position) <
          squaredDistanceTo(actor.position, nearest.position)
          ? candidate
          : nearest,
      null
    );
    const target = victim.position;
    if (ai.wave && now >= ai.wave.group.expiresAt) ai.wave = null;
    if (
      advanceNpcRelease(
        session,
        doid,
        actor,
        now,
        deltaSeconds,
        spatialIndex,
        victim.doid,
        target
      )
    ) continue;

    let distance = distanceTo(actor.position, target);
    if (!ai.engaged) {
      if (distance > ai.aggroRadius) continue;
      ai.engaged = true;
      ai.state = "chase";
    } else if (distance > ai.disengageDistance) {
      ai.engaged = false;
      ai.state = "idle";
      continue;
    }

    /**
     * What a debuff on it lets it still do.
     *
     * `MOVEMENT` is the authored multiplier and covers the lot at once —
     * STUN_L4 and STOP_L4 carry a zero, SLOW_L1 a 0.75 — so a stunned monster
     * simply has no speed. Attacking is separate: a stun stops it, a root does
     * not, which is what the two abilities mean.
     */
    const mobility = buffMultiplierFor(session, doid, "MOVEMENT");
    const stunned = hasAbility(session, doid, "STUN");
    const speed = ai.moveSpeed * mobility;

    const route = routeToTarget(session, actor, target, now);

    // DR_DEBUG_AI=1 prints where each chaser is actually heading, which is the
    // only way to tell a legitimate detour around geometry from a detour to
    // somewhere nobody asked for.
    if (session.debugAi && route.waypoint) {
      info(
        `[ai] ${doid} at (${Math.round(actor.position.x)},${Math.round(actor.position.y)}) ` +
          `-> (${Math.round(route.waypoint.x)},${Math.round(route.waypoint.y)}) ` +
          `${route.direct ? "direct" : `via path ${ai.pathIndex}/${ai.path?.length ?? 0}`} ` +
          `hero (${Math.round(target.x)},${Math.round(target.y)})`
      );
    }
    /**
     * Pushing apart and walking are two budgets, not one.
     *
     * They shared a step, and the step was the debuffed speed. Two consequences,
     * and both of them are the crowd standing inside itself:
     *
     * A monster whose `MOVEMENT` is zero — STUN_L4 and STOP_L4 both carry one —
     * had no step at all, so nothing could separate it. Freezing a wave is
     * ordinary play here, and a frozen wave collapsed into one square and stayed
     * there until it thawed.
     *
     * And where the two were summed before being clamped, the chase term was
     * already a whole step long, so the separation only tilted the direction a
     * little and the pair kept closing. The tighter the crowd, the more the one
     * thing holding it apart was squeezed out of the budget.
     */
    const crowding = separationDisplacement(doid, actor, spatialIndex, heroDoids);
    const separation = boundedPush(crowding, ai, deltaSeconds);

    let chaseX = 0;
    let chaseY = 0;
    if (route.waypoint && (distance > ai.attackRange || !route.direct)) {
      const waypointDistance = distanceTo(actor.position, route.waypoint);
      const remaining = route.direct ? Math.max(0, distance - ai.attackRange) : waypointDistance;
      const chaseTravel = Math.min(speed * deltaSeconds, remaining);
      if (waypointDistance > 0.001) {
        chaseX = ((route.waypoint.x - actor.position.x) / waypointDistance) * chaseTravel;
        chaseY = ((route.waypoint.y - actor.position.y) / waypointDistance) * chaseTravel;
      }
    }

    const walk = withoutDrivingIntoContacts({ x: chaseX, y: chaseY }, crowding.contacts);
    const moveX = walk.x + separation.x;
    const moveY = walk.y + separation.y;

    // Both halves arrive already bounded — the chase by the debuffed speed and
    // the push by the undebuffed one — so clamping the sum again here is what
    // used to take the separation back out of it.
    const requestedTravel = Math.hypot(moveX, moveY);
    if (requestedTravel > 0.001) {
      const nextPosition = moveWithNavigation(
        session.navigation,
        actor.position,
        { x: moveX, y: moveY },
        collisionRadius(actor)
      );
      const actualTravel = distanceTo(actor.position, nextPosition);
      actor.position.x = nextPosition.x;
      actor.position.y = nextPosition.y;
      if (actualTravel > 0.001) {
        faceTarget(session, doid, actor, route.waypoint ?? target);
        session.send(npcPositionUpdate(doid, actor.position));
      }
      distance = distanceTo(actor.position, target);
    }

    const clearAttack = hasLineOfSight(
      session.navigation,
      actor.position,
      target,
      0
    );
    if (distance > ai.attackRange || !clearAttack) {
      ai.state = route.waypoint ? "chase" : "blocked";
      continue;
    }

    faceTarget(session, doid, actor, target);
    ai.state = "attack";
    // A garlic trap's whole point: STUN_L4 for three seconds, during which it
    // does not swing. Without this the debuff was a picture on the health bar.
    if (stunned) continue;
    if (now < ai.nextAttackAt) continue;

    ai.nextAttackAt = now + attackIntervalMs(ai);
    // Awaited so the hit lands before the tick moves on: damage is the
    // server's own bookkeeping and must not race the next frame.
    const victimSession = victim.member.world?.contextFor(victim.member) ?? victim.member;
    await performNpcAttack(victimSession, doid, ai);
  }
};

/** Runs the lightweight server-authoritative chase/attack loop for one session. */
export const startNpcAi = (session) => {
  let previous = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const deltaSeconds = Math.min((now - previous) / 1000, 0.25);
    previous = now;
    // The loop must survive a failed tick rather than die silently.
    tickNpcAi(session, now, deltaSeconds).catch((error) =>
      warn(`ai: tick failed: ${error.message}`)
    );
  }, config.npcAiTickMs);

  timer.unref?.();
  info(`[${session.id}] NPC AI ticking every ${config.npcAiTickMs}ms`);
  return () => clearInterval(timer);
};

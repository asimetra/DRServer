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

/**
 * How close this monster is allowed to stand to a hero.
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
 * belongs on the attack instead: see `heroReach` below.
 *
 * And except for the ones that do not want contact. `keepDistance` carries the
 * kiters' standoff from the NPC row; see where it is read in dungeon.js for the
 * corpus behind it.
 */
const heroContact = (actor, hero) => collisionRadius(actor) + collisionRadius(hero);

const heroStandoff = (actor, hero) => {
  const contact = heroContact(actor, hero);
  const reach = Math.max(12, (actor.ai?.attackRange ?? contact) - 8);
  return Math.max(contact, Math.min(actor.ai?.keepDistance ?? 0, reach));
};

/**
 * How far this one may swing from.
 *
 * The furthest of its attacks, or the width of the two bodies if that is
 * greater. The second case used to be thirteen rows and is now three —
 * GIANT_LEECH, BIG_LEECH and BABY_YETI — because reading `Attack2` and
 * `Attack3` gave the other ten something that does reach: the four brutes and
 * the dragon all carry EN_FART_ATTACK at range 250 against bodies of 87 to 206.
 * For the three left, a leech whose body meets the player's at 131 and whose
 * bite reaches 70 could never bite on range alone. Letting it hit what it is
 * physically touching costs nothing, where moving its body inside the player
 * cost the player being shoved.
 */
const heroReach = (actor, hero) => Math.max(actor.ai?.attackRange ?? 0, heroContact(actor, hero));

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
 * Clamping the destination rather than the step, and before navigation rather
 * than after, so a wall still wins the argument.
 */
const keptOutOfHeroes = (target, actor, heroes) => {
  let { x, y } = target;
  for (const hero of heroes) {
    if (!hero.position || !hero.actor) continue;
    const contact = heroContact(actor, hero.actor);
    let dx = x - hero.position.x;
    let dy = y - hero.position.y;
    let distance = Math.hypot(dx, dy);
    if (distance >= contact) continue;
    // Exactly on top of the player has no direction to be pushed out along;
    // any fixed one will do, and the chase will correct it next tick.
    if (distance < 0.001) {
      dx = 1;
      dy = 0;
      distance = 1;
    }
    x = hero.position.x + (dx / distance) * contact;
    y = hero.position.y + (dy / distance) * contact;
  }
  return { x, y };
};

/**
 * The attacks it could use from here, right now.
 *
 * Three things have to hold, and all three are authored on the attack row.
 * `MinRange` and `Range` are the band — a spear throw with a MinRange of 400 is
 * not a thing an imp does to someone standing on its toes — and `AI_RechargeT`
 * is that attack's own cooldown, which is what makes a shaman's fifteen-second
 * summon rare among its three-second bolts. The band's top is widened to the
 * bodies for the same reason `heroReach` is.
 *
 * An `ai` built before this existed, or by a test, has its single attack
 * promoted into the same shape rather than being special-cased below.
 */
const usableAttacks = (ai, distance, contact, now) => {
  ai.attacks ??= [
    {
      attackType: ai.attackType,
      range: ai.attackRange ?? 0,
      minRange: 0,
      rechargeMs: 0,
      readyAt: 0,
    },
  ];
  return ai.attacks.filter(
    (attack) =>
      now >= (attack.readyAt ?? 0) &&
      distance >= (attack.minRange ?? 0) &&
      distance <= Math.max(attack.range ?? 0, contact)
  );
};

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
         * Measured against the official for monsters standing in a fight, the
         * nearest peer sits on the sum of the two bodies: KNIGHT p25 84 against
         * 84, BRUTE p25 85 against 88, ICE_IMP p25 70 against 70. The player is
         * the same rule with one exception, which `heroStandoff` carries.
         */
        const minimumDistance = heroDoids.has(otherDoid)
          ? heroStandoff(actor, other)
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
  heroPosition,
  heroes = []
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
  // A cage exit may not run through the player either; see `keptOutOfHeroes`.
  // The release point is a doorway, not a destination, and walking a body into
  // the one dynamic body on the client shoves the player whatever the reason.
  const wanted = keptOutOfHeroes(
    {
      x: actor.position.x + ((release.target.x - actor.position.x) / distance) * travel + separation.x,
      y: actor.position.y + ((release.target.y - actor.position.y) / distance) * travel + separation.y,
    },
    actor,
    heroes
  );
  const nextPosition = moveWithNavigation(
    session.navigation,
    actor.position,
    { x: wanted.x - actor.position.x, y: wanted.y - actor.position.y },
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
  const pets = [];
  const enemies = [];
  for (const [doid, actor] of actors) {
    if (actor.dead || !(actor.hitPoints > 0) || !actor.position) continue;
    const candidate = { doid, actor, position: actor.position, member: null };
    if (actor.isPet) pets.push(candidate);
    else if (actor.isEnemy) enemies.push(candidate);
  }
  const playerTargets = [...heroes, ...pets];

  const nearestTo = (position, candidates) =>
    candidates.reduce(
      (nearest, candidate) =>
        !nearest ||
        squaredDistanceTo(position, candidate.position) <
          squaredDistanceTo(position, nearest.position)
          ? candidate
          : nearest,
      null
    );

  for (const [doid, actor] of actors) {
    const ai = actor.ai;
    if (!ai || actor.dead || !actor.position) continue;
    let followingOwner = false;
    let victim;
    if (ai.kind === "pet") {
      const owner = heroes.find(({ doid: heroDoid }) => heroDoid === ai.ownerDoid);
      if (!owner) {
        clearNpcTarget(actor);
        continue;
      }
      const enemy = nearestTo(actor.position, enemies);
      const ownerDistance = distanceTo(actor.position, owner.position);
      const enemyDistance = enemy ? distanceTo(actor.position, enemy.position) : Infinity;
      if (ai.tetherDistance > 0 && ownerDistance > ai.tetherDistance) {
        ai.outsideTetherAt ??= now;
      } else {
        ai.outsideTetherAt = null;
      }
      const mustReturn =
        ai.outsideTetherAt != null && now - ai.outsideTetherAt >= (ai.tetherTimerMs ?? 0);
      if (mustReturn || !enemy || (!ai.engaged && enemyDistance > ai.aggroRadius)) {
        if (ownerDistance <= Math.max(heroContact(actor, owner.actor), ai.returnDistance ?? 0)) {
          clearNpcTarget(actor);
          continue;
        }
        victim = owner;
        followingOwner = true;
        ai.engaged = false;
        ai.state = "return";
      } else {
        victim = enemy;
      }
    } else {
      victim = nearestTo(actor.position, playerTargets);
    }
    if (!victim) continue;
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
        target,
        heroes
      )
    ) continue;

    let distance = distanceTo(actor.position, target);
    if (!followingOwner) {
      if (!ai.engaged) {
        if (distance > ai.aggroRadius) continue;
        ai.engaged = true;
        ai.state = "chase";
      } else if (distance > ai.disengageDistance) {
        ai.engaged = false;
        ai.state = "idle";
        continue;
      }
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

    /**
     * The walk ends where the bodies meet, not where the swing starts.
     *
     * Stopping at `attackRange` drew every pack as a ring of the same radius
     * with the player alone in the middle: a halberd knight held 140 off, a
     * marksman 600, and a whole wave of one kind at identical range from the
     * player and from each other. The official does not do that — see
     * `heroStandoff` for the corpus that says where it does stop — and the
     * range is only ever asked one question, which is whether the thing may
     * swing from where it now stands. That question is still below.
     */
    const standoff = followingOwner
      ? Math.max(heroContact(actor, victim.actor), ai.returnDistance ?? 0)
      : heroStandoff(actor, victim.actor);
    let chaseX = 0;
    let chaseY = 0;
    /**
     * A lunge overrides the walk for as long as it lasts.
     *
     * It is the attack moving the monster, not the monster deciding to go
     * somewhere, so the chase does not get a say — an imp that has just hopped
     * backwards must not spend the same tick walking forwards again. Debuffs
     * still apply: `MOVEMENT` zero is a stun, and a stunned thing does not
     * charge.
     */
    if (ai.lunge && now < ai.lunge.until) {
      chaseX = ai.lunge.x * mobility * deltaSeconds;
      chaseY = ai.lunge.y * mobility * deltaSeconds;
    } else if (route.waypoint && (distance > standoff || !route.direct)) {
      const waypointDistance = distanceTo(actor.position, route.waypoint);
      const remaining = route.direct ? Math.max(0, distance - standoff) : waypointDistance;
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
    const wanted = keptOutOfHeroes(
      { x: actor.position.x + moveX, y: actor.position.y + moveY },
      actor,
      heroes
    );
    const requestedTravel = distanceTo(actor.position, wanted);
    if (requestedTravel > 0.001) {
      const nextPosition = moveWithNavigation(
        session.navigation,
        actor.position,
        { x: wanted.x - actor.position.x, y: wanted.y - actor.position.y },
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

    if (followingOwner) {
      ai.state = "return";
      continue;
    }

    const clearAttack = hasLineOfSight(
      session.navigation,
      actor.position,
      target,
      0
    );
    if (distance > heroReach(actor, victim.actor) || !clearAttack) {
      ai.state = route.waypoint ? "chase" : "blocked";
      continue;
    }

    faceTarget(session, doid, actor, target);
    ai.state = "attack";
    // A garlic trap's whole point: STUN_L4 for three seconds, during which it
    // does not swing. Without this the debuff was a picture on the health bar.
    if (stunned) continue;
    if (now < ai.nextAttackAt) continue;

    /**
     * Which of its moves this swing is.
     *
     * Being in reach is not the same as having something to throw: an imp
     * standing on the player is inside the MinRange of its spear and may have
     * spent its headbutt, and the honest answer then is that this swing does not
     * happen. Not rolling the cadence in that case is deliberate — it retries on
     * the next tick rather than burning the interval on a swing it could not
     * make.
     */
    const choices = usableAttacks(ai, distance, heroContact(actor, victim.actor), now);
    if (!choices.length) continue;
    const chosen = choices[Math.floor(Math.random() * choices.length)];
    chosen.readyAt = now + (chosen.rechargeMs ?? 0);

    /**
     * The lunge the attack itself carries, if it carries one.
     *
     * A constant velocity for `MoveDuration` at `MoveAngle` degrees off the way
     * it is facing, which is what the client does for the player and what the
     * corpus shows the official doing for monsters. `faceTarget` ran a moment
     * ago, so the heading is at the victim and an angle of 0 is a charge at
     * them while 180 is a hop backwards.
     */
    if (chosen.moveAmount > 0 && chosen.moveDurationMs > 0) {
      const angle = ((actor.heading + chosen.moveAngle) * Math.PI) / 180;
      const speed = chosen.moveAmount / (chosen.moveDurationMs / 1000);
      ai.lunge = {
        until: now + chosen.moveDurationMs,
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed,
      };
    }

    ai.nextAttackAt = now + attackIntervalMs(ai);
    // Awaited so the hit lands before the tick moves on: damage is the
    // server's own bookkeeping and must not race the next frame.
    const victimSession = victim.member
      ? victim.member.world?.contextFor(victim.member) ?? victim.member
      : session;
    await performNpcAttack(victimSession, doid, { ...ai, ...chosen }, victim.doid);
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

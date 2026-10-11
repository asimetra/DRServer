import { config } from "../config.js";
import { FRAMES_PER_SECOND } from "../gamemaster.js";
import { info, warn } from "../log.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { performNpcAttack } from "./combat.js";
import { attackStopped, buffMultiplierFor } from "./buffs.js";
import { heroMembersOf, matchStateOf, worldOf } from "./match-world.js";
import { floorAttackSpeedScale, npcAttackSpeed } from "./npc-attacks.js";
import {
  hasLineOfSight,
  isPositionBlocked,
  moveWithNavigation,
  nearestClearPosition,
} from "./navigation.js";
import { objectDisable } from "./objects.js";
import { bodyPointOf, bodyRadius, contact, furthestReach, reach, sightOrigin, standoff } from "./body.js";
import { faceTarget, placeNpc, stepNpc } from "./npc-move.js";
import { describeRoute, NO_ROUTE_ASKED, routeToTarget, searchAgain } from "./routing.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { clearNpcTarget, LET_GO, pickTarget } from "./npc-targeting.js";
import {
  boundedPush,
  nobodyToFight,
  senseCrowd,
  separateIdleNpc,
  separationDisplacement,
} from "./npc-crowd.js";

const npcTimelineAction = (doid, timeline) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(145) // DistributedNPCGameObject.ReceiveTimelineAction
    .utf(timeline)
    .frame();

export { MAX_PET_AGGRESSORS } from "./npc-targeting.js";

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);
const ATTACK_RANGE_EPSILON = 2;
const NPC_WALK_ACCELERATION_SECONDS = 0.9;

/**
 * Ramps an NPC's ordinary walk up to its authored movement speed.
 *
 * Official captures still reach each NPC row's `BaseMove`, but cover about
 * 0.67 of that distance during the first second of a run. Starting at full
 * speed covered 0.90 locally and made every re-engaging pack snap onto the
 * player. Four 250 ms server turns with a 0.9-second ramp cover two thirds of
 * the authored first-second distance, matching the official 0.67 envelope and
 * its transform cadence. Attack lunges and player-owned pets have their own
 * movement rules and deliberately do not use this ramp.
 */
export const npcWalkingSpeed = (ai, targetSpeed, deltaSeconds) => {
  const target = Math.max(0, Number(targetSpeed) || 0);
  if (!(target > 0)) {
    ai.walkSpeed = 0;
    return 0;
  }
  const current = Math.max(0, Math.min(target, Number(ai.walkSpeed) || 0));
  const step = target * Math.max(0, Number(deltaSeconds) || 0) /
    NPC_WALK_ACCELERATION_SECONDS;
  ai.walkSpeed = Math.min(target, current + step);
  return ai.walkSpeed;
};

/**
 * The attacks this one has, in the per-attack shape `usableAttacks` reads.
 *
 * An `ai` built before `attacks` existed, or by a test, has its single attack
 * promoted into the same shape rather than being special-cased anywhere.
 */
const attacksOf = (ai) =>
  (ai.attacks ??= [
    {
      attackType: ai.attackType,
      range: ai.attackRange ?? 0,
      minRange: 0,
      rechargeMs: 0,
      readyAt: 0,
      projectile: ai.projectile ?? null,
    },
  ]);

/**
 * Whether a swing from here can see its victim: a hero's feet or its body.
 *
 * A hero's wire position is its feet and its body is the circle 22 units above
 * them (`collisionPointOf`). The client keeps that body out of the walls, not
 * the feet, so a hero leaning on a wall *below* it has its feet on the wall's
 * edge or a unit or two inside it. A sight line to the feet alone then ends
 * inside the wall and every monster around reads the hero as behind it: they
 * walk up to contact and stand there. In one played floor (nordic caves, seed
 * 169884306) monsters spent 226 monster-seconds within 100 units of a hero
 * leaning on NORDIC_CAVE_WALL_B/D and landed 4 hits, against 0.76 a second
 * when the feet were clear. The official keeps swinging there: across the 96
 * official captures, with the feet inside this server's geometry at a wall
 * below, monsters within 100 units attacked 0.61 times a monster-second,
 * against 0.75 elsewhere.
 *
 * The feet are still asked first, so nothing that could be hit before is safe
 * now; the body only adds the hero whose feet are in the wall. A wall between
 * the monster and the hero hides both: the body is 22 above feet that are at
 * most on the near edge of a wall below, and 22 nearer a wall above them.
 *
 * Only for heroes. A monster's position is the point this server's own
 * navigation keeps clear of the walls, so it is already the right end.
 */
const victimInSight = (navigation, actor, victim, target, heroDoids) => {
  const origin = sightOrigin(actor);
  if (hasLineOfSight(navigation, origin, target, 0)) return true;
  if (!heroDoids.has(victim.doid)) return false;
  const body = bodyPointOf(victim.actor, target);
  return Boolean(body) && body !== target && hasLineOfSight(navigation, origin, body, 0);
};

/** A clear authored-range point around the target for one teleport cycle; `bodies` is `contact` with the victim. */
const teleportDestinationFor = (session, actor, target, bodies, random) => {
  const maximum = standoff(actor, bodies, Number(actor.ai.teleportRange ?? 0));
  const minimum = Math.min(maximum, Math.max(bodies, maximum * 0.5));
  const radius = bodyRadius(actor);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const distance = minimum + (maximum - minimum) * random();
    const desired = {
      x: target.x + Math.cos(angle) * distance,
      y: target.y + Math.sin(angle) * distance,
    };
    if (!session.navigation) return desired;
    const clear = nearestClearPosition(
      session.navigation,
      desired,
      radius,
      {
        reach: Math.max(60, maximum * 0.5),
        towards: target,
        accept: (candidate) => hasLineOfSight(session.navigation, candidate, target, radius),
      }
    );
    if (clear) return clear;
  }
  return { ...actor.position };
};

/**
 * How a kiter backs off: measured, not authored.
 *
 * Every official capture, every KITE_AI monster with a keep distance, the
 * player inside it, neither side swinging nor hit in the last second, rebuilt
 * from the monster's own position updates (549 back-offs, 1244 s solo):
 *
 *   starts     about 0.4 per second pooled, the same for every ranged kiter
 *              within noise (marksman, both axe throwers, archer, imp,
 *              savage bow), and the same however deep inside the player
 *              stands. In open ground it is about 0.35 against a player
 *              standing still and 0.8 against one moving, toward it or not.
 *              With a monster close behind it is a third of that, which the
 *              body in the way gives here (a back-off that gets nowhere ends).
 *   ends       when it is back out at its keep distance (43%), blocked (25%),
 *              when it shoots (16%), when hit (6%); otherwise about 12% a
 *              250 ms tick, a mean near 2 s. p50 0.5 s, longest 3.25 s of 500.
 *   shoots     in about a fifth of them, standing for the shot.
 *
 * `FleeTimer` and `FleeTimerRand` do not govern it: SAVAGE_BOW, which authors
 * FleeTimer 0, backs off as often as the rows authoring 4, and a 4-7 s pause
 * between back-offs fits the corpus worst of the models tried. Not modelled:
 * a second back-off follows within 1.5 s more often than chance, then 2-4 s
 * are quieter than chance (29 against 48 expected); and the official decides
 * moves on a roughly 500 ms beat.
 */
const BACK_OFF_STILL_PER_SECOND = 0.35;
const BACK_OFF_MOVING_PER_SECOND = 0.8;
/** A player covering this much ground a second counts as moving. */
const BACK_OFF_MOVING_SPEED = 60;
const BACK_OFF_MEAN_MS = 2000;
const BACK_OFF_MOST_MS = 3250;

/**
 * Whether a kiter or a ranged pet may back off from its target, given the
 * route to it: when it sees the target, and when it has no route to it.
 *
 * The second half is today's behaviour kept on purpose, not a rule anyone
 * chose for both. c13780e made a failed route hand out the target as a
 * "direct" waypoint so that the walk would end at the standoff, and both
 * back-offs read that same flag. For the kiter it was meant — the commit
 * says "a kiter backs off as from any target in sight", from the captures'
 * "kiters keep their distance", and test/no-route-walk.test.js holds it. For
 * the pet's MinRange retreat it came along unasked (and no placed pet has a
 * keep distance today, so it does not run). A target with a route that is
 * not in sight is not backed off from, and a body escaping the scenery backs
 * off from nothing.
 *
 * DECISION FOR THE MAINTAINER: should a pet or a kiter back off from a target
 * it has no route to?
 */
const backsOffFrom = (route) => route.sees || (route.blocked && !route.escaping);

/**
 * Away from everyone inside its keep distance, nearer ones counting more, or
 * null when nobody is inside or it is pressed from opposite sides — backing
 * off one player into another is not getting away. `depth` is how far the
 * deepest one stands inside: no step backs off further than that.
 */
export const awayFromThreats = (actor, threats, keep) => {
  let x = 0;
  let y = 0;
  let strongest = 0;
  for (const { position } of threats) {
    const dx = actor.position.x - position.x;
    const dy = actor.position.y - position.y;
    const distance = Math.hypot(dx, dy);
    // A step of exactly `depth` lands on the keep distance give or take a
    // rounding error; landed is out.
    if (distance >= keep - 1e-6 || distance < 0.001) continue;
    const weight = (keep - distance) / keep;
    x += (dx / distance) * weight;
    y += (dy / distance) * weight;
    strongest = Math.max(strongest, weight);
  }
  const length = Math.hypot(x, y);
  if (!strongest || length < strongest * 0.25) return null;
  return { x: x / length, y: y / length, depth: strongest * keep };
};

/**
 * The attacks it could use from here, right now.
 *
 * `Range` is the most it may reach — from the edge of its body for a swing and
 * from the middle for a shot, see `reach` (body.js) — and `AI_RechargeT` is that
 * attack's own cooldown, which is what makes a shaman's fifteen-second summon
 * rare among its three-second bolts.
 *
 * `MinRange` is not a floor for a monster. It reads like one — a spear throw at
 * 400 to 700 — and the official ignores it: the ice imp's throw, authored
 * MinRange 400, went out below 400 on 53% of 1123 recorded casts (median 349,
 * a tenth under 135), its headbutt below 200 on 21%, Infinite's lightning orb
 * below 300 on 96%. The top is kept to: the throw's p90 is 637 against 700, the
 * back-off's 479 against 500. Treating it as a floor left an imp that had
 * hopped back and walked in again with nothing but another hop, so ours threw
 * 16% of the time against the official's 36% and hopped 48% against 27%.
 *
 * A pet keeps it: a ranged pet backs out to its projectile's MinRange (see the
 * standoff in tickNpcAi), which is measured on pets and is theirs.
 */
const usableAttacks = (ai, distance, bodies, now) => {
  const honoursMinRange = ai.kind === "pet";
  return attacksOf(ai).filter(
    (attack) =>
      now >= (attack.readyAt ?? 0) &&
      (!honoursMinRange || distance + ATTACK_RANGE_EPSILON >= (attack.minRange ?? 0)) &&
      distance <= reach(attack, bodies) + ATTACK_RANGE_EPSILON
  );
};

/** Chooses uniformly from the authored attacks usable in this range/cooldown band. */
export const chooseNpcAttack = (
  ai,
  distance,
  bodies,
  now,
  random = Math.random
) => {
  const choices = usableAttacks(ai, distance, bodies, now);
  if (!choices.length) return null;
  const roll = Math.min(1 - Number.EPSILON, Math.max(0, Number(random()) || 0));
  return choices[Math.floor(roll * choices.length)];
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
/**
 * How long until this one swings again, and what is slowing it down.
 *
 * `slowness` is the reciprocal of an attack-speed multiplier: `CRIPPLE_L4`
 * authors `MELEE_SPD` 0.2, so a muzzled monster waits five times as long.
 *
 * This is the whole of what `CRIPPLE` — "Muzzling" at five stars, "Slow enemy
 * attacks for 6 sec!" — was supposed to do, and nothing read those columns. The
 * buff object was created and drawn and the monster swung on exactly the same
 * clock, which is the same shape of bug the stun check above was written for:
 * a debuff that was a picture on the health bar.
 */
export const attackIntervalMs = (ai, slowness = 1) =>
  Math.max(
    100,
    ((ai.attackTimerMs ?? 1500) + Math.random() * (ai.attackRandMs ?? 0)) * Math.max(1, slowness)
  );

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

  const radius = bodyRadius(actor);

  /**
   * Out of the cage is enough; the release point is not a destination.
   *
   * Measured: a released monster walks 119 to 134 units to a point every member
   * of its cage shares, and only then looks at the player — nearly a second of
   * crossing the room to a spot nobody asked about. But the walk exists to get
   * through a doorway, and the doorway is behind it as soon as its own cage no
   * longer holds it.
   *
   * Out means the body clear of the cage, not the player in sight. A sight line
   * is sampled from its first step on, so one drawn from a body still half in
   * the bars reads clear. Ending the walk there left the body in the collider,
   * where every step of the chase that followed was refused: a knight 19 units
   * into the jail on the bridge tile, facing a player in plain view, never
   * moved again.
   */
  if (!isPositionBlocked(session.navigation, actor.position, radius)) {
    ai.release = null;
    clearNpcTarget(actor);
    return false;
  }

  // Reaching the release point is not the end of it; being clear is (above).
  // One still blocked at it walks on and, failing that, falls to the stall.
  const distance = distanceTo(actor.position, release.target);

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
  const step = stepNpc(session.navigation, actor, {
    walk:
      distance > 0.001
        ? {
            x: ((release.target.x - actor.position.x) / distance) * travel,
            y: ((release.target.y - actor.position.y) / distance) * travel,
          }
        : { x: 0, y: 0 },
    separation,
    heroes,
    radius,
    deltaSeconds,
    navigationOptions: { ignoredColliders: release.ignoredColliders },
  });
  const actualTravel = step.travel;

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
      // Still out through the mouth, if it is still in the cage; see routeToTarget.
      ai.escape = release.target;
      ai.release = null;
      clearNpcTarget(actor);
      return false;
    }
  }

  placeNpc(session, doid, actor, step, release.target);
  if (!isPositionBlocked(session.navigation, actor.position, radius)) {
    ai.release = null;
    clearNpcTarget(actor);
  }
  return true;
};

/**
 * One tick of a shove in flight — a knockback or pull `pushVictim` (combat.js)
 * handed to the AI with a duration, so the throw is spread over the ticks that
 * fit in it rather than landing whole in one frame.
 *
 * Each tick carries the share of the distance the clock has reached and sends
 * the position, which on a 250ms tick and a 0.4s throw is two frames, as the
 * official's are. Through navigation: a throw that meets a wall ends there,
 * and the share it could not cover is not tried again. While it flies the
 * monster neither walks nor swings.
 */
export const slideShoved = (session, doid, actor, now) => {
  const shove = actor.ai?.shove;
  if (!shove) return false;
  const share = Math.min(1, Math.max(0, (now - shove.startedAt) / shove.durationMs));
  const step = share - shove.covered;
  shove.covered = share;
  if (share >= 1) actor.ai.shove = null;
  if (step <= 0) return true;
  const nextPosition = moveWithNavigation(
    session.navigation,
    actor.position,
    { x: shove.x * step, y: shove.y * step },
    bodyRadius(actor)
  );
  const travel = distanceTo(actor.position, nextPosition);
  if (travel < 0.5) {
    actor.ai.shove = null;
    return true;
  }
  placeNpc(session, doid, actor, { next: nextPosition, travel });
  return true;
};

/** One deterministic AI step; exported so movement and combat can be locked by tests. */
export const tickNpcAi = async (session, now, deltaSeconds) => {
  const state = matchStateOf(session);
  const actors = state.actors;
  if (!actors) return;
  const crowd = senseCrowd(session, actors, deltaSeconds);
  if (nobodyToFight(crowd)) {
    // Nothing has an opposing combatant left. Releasing chase state prevents
    // stale routes resuming after a revive or a new spawn.
    for (const actor of actors.values()) clearNpcTarget(actor);
    return;
  }
  const { heroes, heroDoids, spatialIndex } = crowd;

  for (const [doid, actor] of actors) {
    const ai = actor.ai;
    if (!ai || actor.dead || !actor.position) continue;
    // Thrown by a hit — see pushVictim in combat.js. Carried, not walking.
    if (slideShoved(session, doid, actor, now)) continue;
    // Reeling from a hit that staggered it — see holdStaggered in combat.js.
    // It neither walks nor swings until the stun is over.
    if (now < (ai.staggeredUntil ?? 0)) continue;
    const picked = pickTarget(crowd, actor, now);
    if (picked === LET_GO) {
      clearNpcTarget(actor);
      continue;
    }
    if (!picked) continue;
    const { victim, following: followingOwner } = picked;
    const target = victim.position;
    // Its body and the victim's, asked once: neither changes in the tick.
    const radius = bodyRadius(actor);
    const bodies = contact(actor, victim.actor);
    const recurringTeleport =
      ai.behavior === "TELEPORT_AI" &&
      (ai.teleportRecurMs ?? 0) > 0 &&
      typeof actor.teleportRegenerate === "function";

    if (actor.teleportHidden) {
      if (!recurringTeleport || now < (ai.teleportReturnAt ?? Infinity)) continue;
      const random = session.random ?? Math.random;
      const destination = teleportDestinationFor(session, actor, target, bodies, random);
      actor.position.x = destination.x;
      actor.position.y = destination.y;
      actor.heading =
        (Math.atan2(target.y - destination.y, target.x - destination.x) * 180) / Math.PI;
      actor.teleportHidden = false;
      ai.teleportPhase = "visible";
      ai.teleportHideAt = 0;
      ai.teleportReturnAt = 0;
      ai.teleportCycleStarted = true;
      ai.nextAttackAt = now + (ai.preTeleportAttackMs ?? 0);
      searchAgain(ai);
      ai.walkSpeed = 0;
      actor.teleportRegenerate(destination, actor.heading);
      session.send(npcTimelineAction(doid, ai.teleportInTimeline ?? "TELEPORT_IN"));
      ai.state = "teleport-in";
      continue;
    }

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
        if (distance > ai.aggroRadius) {
          // Release AI already returned above while a cage exit was active.
          // Outside awareness the only permitted motion is resolving a body
          // overlap; no route, facing change or chase state is created.
          separateIdleNpc(
            session,
            doid,
            actor,
            spatialIndex,
            heroDoids,
            heroes,
            deltaSeconds
          );
          continue;
        }
        ai.engaged = true;
        ai.state = "chase";
      } else if (distance > ai.disengageDistance) {
        clearNpcTarget(actor);
        continue;
      }
    }

    if (recurringTeleport && !ai.teleportCycleStarted) {
      ai.teleportCycleStarted = true;
      ai.nextAttackAt = Math.max(
        ai.nextAttackAt ?? 0,
        now + (ai.preTeleportAttackMs ?? 0)
      );
    }
    if (recurringTeleport && ai.teleportPhase === "post-attack") {
      if (now < (ai.teleportHideAt ?? 0)) {
        ai.state = "teleport-wait";
        continue;
      }
      ai.teleportPhase = "teleport-out";
      ai.teleportDisableAt = now + Math.max(0, Number(ai.teleportOutDelayMs ?? 1000));
      ai.state = "teleport-out";
      session.send(npcTimelineAction(doid, ai.teleportOutTimeline ?? "TELEPORT_OUT"));
      continue;
    }
    if (recurringTeleport && ai.teleportPhase === "teleport-out") {
      if (now < (ai.teleportDisableAt ?? Infinity)) continue;
      const random = session.random ?? Math.random;
      actor.teleportHidden = true;
      ai.teleportPhase = "hidden";
      ai.teleportDisableAt = 0;
      ai.teleportReturnAt =
        now +
        (ai.teleportRecurMs ?? 0) +
        random() * (ai.teleportRecurRandMs ?? 0);
      ai.state = "teleport-hidden";
      session.send(objectDisable(doid));
      continue;
    }

    /**
     * What a debuff on it lets it still do.
     *
     * `MOVEMENT` is the authored multiplier and covers the lot at once —
     * STUN_L4 and STOP_L4 carry a zero, SLOW_L1 a 0.75 — so a stunned monster
     * simply has no speed. Attacking is separate: a stun stops it, a root does
     * not, which is what the two abilities mean.
     *
     * Shock, paralysis and disabled controls stop both. `SHOCK_L0` says so in
     * its own words — "Unable to attack or move for 0.5 secs" — and carries
     * `MOVEMENT` zero for the moving half; the swinging half is this ability,
     * which nothing read. So `Zapping` held a monster still and let it go on
     * hitting whoever was standing next to it. FREEZE and FROZEN have the same
     * split through `PARALYZED` and `DISABLE_CONTROLS` respectively.
     */
    const mobility = buffMultiplierFor(session, doid, "MOVEMENT");
    const cannotAttack = attackStopped(session, doid);
    const topSpeed = ai.moveSpeed * mobility;
    const attackLocked = now < (ai.attackLockedUntil ?? 0);

    /**
     * A stationary boss is deliberately embedded in its arena set piece.
     * Route planning reads that as "inside scenery" and keeps it forever in
     * escape state, which prevents the attack branch below from running. It
     * authors IsNavigable=0 and LockRotation=true: it neither finds a route nor
     * asks the scenery for line of sight; its attack timelines place their own
     * colliders in the arena.
     */
    const stationary = ai.behavior === "STATIONARY_AI";
    const route = stationary ? NO_ROUTE_ASKED : routeToTarget(session, actor, target, now, heroes);
    // The waypoint is the target itself: in sight, or walked at straight.
    const headsAtTarget = route.sees || route.steers;

    // DR_DEBUG_AI=1 prints where each chaser is actually heading, which is the
    // only way to tell a legitimate detour around geometry from a detour to
    // somewhere nobody asked for.
    if (state.debugAi && route.waypoint) {
      info(
        `[ai] ${doid} at (${Math.round(actor.position.x)},${Math.round(actor.position.y)}) ` +
          `-> (${Math.round(route.waypoint.x)},${Math.round(route.waypoint.y)}) ` +
          `${describeRoute(ai, route)} ` +
          `hero (${Math.round(target.x)},${Math.round(target.y)})`
      );
    }
    // Separation remains possible under MOVEMENT zero, but it no longer gives
    // an actor a second BaseMove-sized step on top of its walk.
    const crowding = separationDisplacement(doid, actor, spatialIndex, heroDoids);
    const separation = boundedPush(crowding, ai, deltaSeconds);

    /**
     * The walk ends where the bodies meet, not where the swing starts.
     *
     * Stopping at `attackRange` drew every pack as a ring of the same radius
     * with the player alone in the middle: a halberd knight held 140 off, a
     * marksman 600, and a whole wave of one kind at identical range from the
     * player and from each other. The official does not do that — see
     * `standoff` (body.js) for the corpus that says where it does stop — and the
     * range is only ever asked one question, which is whether the thing may
     * swing from where it now stands. That question is still below.
     */
    const stopAt = followingOwner
      ? Math.max(bodies, ai.returnDistance ?? 0)
      : standoff(actor, bodies);
    /**
     * A kiter backs off now and then, for a moment, from whoever stands
     * inside its keep distance, more often while its target is moving. It is
     * a chance each tick, not a timer: there is no window to wait out and
     * nothing to re-arm. A back-off ends when its time is up, when it is back
     * out at its keep distance, when it swings, or when it cannot get away.
     */
    const canBackOff =
      !followingOwner &&
      ai.kind !== "pet" &&
      ai.behavior === "KITE_AI" &&
      stopAt > bodies &&
      backsOffFrom(route) &&
      mobility > 0;
    const threats = heroes.some(({ doid: heroDoid }) => heroDoid === victim.doid)
      ? heroes
      : [...heroes, { position: target }];
    const away = canBackOff ? awayFromThreats(actor, threats, stopAt) : null;
    const swinging = attackLocked || Boolean(ai.lunge && now < ai.lunge.until);
    const seen = ai.targetSeen;
    const targetMoving =
      seen?.doid === victim.doid &&
      now > seen.at &&
      distanceTo(seen, target) / ((now - seen.at) / 1000) > BACK_OFF_MOVING_SPEED;
    ai.targetSeen = { doid: victim.doid, x: target.x, y: target.y, at: now };
    if (!away) {
      ai.fleeUntil = 0;
    } else if (now >= (ai.fleeUntil ?? 0) && !swinging) {
      const random = session.random ?? Math.random;
      const rate = targetMoving ? BACK_OFF_MOVING_PER_SECOND : BACK_OFF_STILL_PER_SECOND;
      if (random() < 1 - Math.exp(-rate * deltaSeconds)) {
        const length = -Math.log(1 - Math.min(0.999999, random())) * BACK_OFF_MEAN_MS;
        ai.fleeUntil = now + Math.min(BACK_OFF_MOST_MS, length);
      }
    }
    let fleeing = Boolean(away) && now < (ai.fleeUntil ?? 0);
    let chaseX = 0;
    let chaseY = 0;
    let usedOrdinaryWalk = false;
    let steering = false;
    let backingOff = false;
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
      // Not before its frame: a lunge waiting on its wind-up holds the body
      // where the swing left it, as the lock below does.
      if (now >= (ai.lunge.from ?? 0)) {
        chaseX = ai.lunge.x * mobility * deltaSeconds;
        chaseY = ai.lunge.y * mobility * deltaSeconds;
      }
    } else if (attackLocked) {
      // The swing owns this window. Ordinary chase here turns a dodgeable
      // melee windup into a homing hit; only authored lunge movement may run.
    } else if (fleeing) {
      // Out to its keep distance and no further: past it, the chase would
      // only walk it back in, a hop out and back on every back-off.
      const step = Math.min(topSpeed * deltaSeconds, away.depth);
      if (step > 0.001) {
        chaseX = away.x * step;
        chaseY = away.y * step;
        backingOff = true;
      } else {
        // Nowhere left to go: a back-off kept alive here would follow a
        // player walking in, step for step.
        ai.fleeUntil = 0;
        fleeing = false;
      }
    } else if (
      ai.kind === "pet" &&
      (ai.keepDistance ?? 0) > 0 &&
      backsOffFrom(route) &&
      distance < stopAt &&
      !(ai.attacks ?? []).some(
        (attack) =>
          !attack.projectile &&
          now >= (attack.readyAt ?? 0) &&
          distance + ATTACK_RANGE_EPSILON >= (attack.minRange ?? 0) &&
          distance <= reach(attack, bodies) + ATTACK_RANGE_EPSILON
      )
    ) {
      /**
       * A ranged pet caught between its bite and projectile bands backs out to
       * the projectile's authored MinRange. Without this, a stationary target
       * at 100-199 units left Dragon with neither bite nor fireball available,
       * so both actors could stand still forever.
       */
      const retreat = Math.min(topSpeed * deltaSeconds, stopAt - distance);
      if (distance > 0.001) {
        chaseX = ((actor.position.x - target.x) / distance) * retreat;
        chaseY = ((actor.position.y - target.y) / distance) * retreat;
      }
    } else if (route.waypoint && (distance > stopAt || !headsAtTarget)) {
      const waypointDistance = distanceTo(actor.position, route.waypoint);
      // At the target itself the walk ends at the standoff; at a point on
      // the way, or the way out of the scenery, it ends there.
      const remaining = headsAtTarget ? Math.max(0, distance - stopAt) : waypointDistance;
      const speed = ai.kind === "pet"
        ? topSpeed
        : npcWalkingSpeed(ai, topSpeed, deltaSeconds);
      const chaseTravel = Math.min(speed * deltaSeconds, remaining);
      usedOrdinaryWalk = ai.kind !== "pet";
      if (waypointDistance > 0.001) {
        chaseX = ((route.waypoint.x - actor.position.x) / waypointDistance) * chaseTravel;
        chaseY = ((route.waypoint.y - actor.position.y) / waypointDistance) * chaseTravel;
      }
      // Walking straight at a target it cannot see, the step is held to the
      // scenery: see `stepNpc`.
      steering = route.steers;
    }
    if (ai.kind !== "pet" && !usedOrdinaryWalk) ai.walkSpeed = 0;

    const before = { x: actor.position.x, y: actor.position.y };
    const step = stepNpc(state.navigation, actor, {
      walk: { x: chaseX, y: chaseY },
      contacts: crowding.contacts,
      separation,
      heroes,
      radius,
      deltaSeconds,
      ignoresSmall: "wanted",
      steering,
    });
    /**
     * A walk the scenery would not take is not taken, and a body that did not
     * walk is at rest: the next walk sets off from standing, as any walk from
     * standing does (`npcWalkingSpeed`). Kept up instead, a body held at a wall
     * would set off at full speed the moment the wall let it slide.
     */
    if (step?.refused && ai.kind !== "pet") ai.walkSpeed = 0;
    if (step) {
      placeNpc(session, doid, actor, step, route.waypoint ?? target);
      distance = distanceTo(actor.position, target);
    }
    // A wall, a crowd or a player in the way: it fights from where it stands.
    // Progress is measured along the way out, so a neighbour's shove sideways
    // does not count as getting away.
    if (
      backingOff &&
      (actor.position.x - before.x) * away.x + (actor.position.y - before.y) * away.y <
        0.25 * Math.min(topSpeed * deltaSeconds, away.depth)
    ) {
      ai.fleeUntil = 0;
      fleeing = false;
    }

    if (followingOwner) {
      ai.state = "return";
      continue;
    }

    // Nothing is fought from inside the scenery: out first. See routeToTarget.
    if (route.escaping) {
      ai.state = "escape";
      continue;
    }

    if (attackLocked) {
      ai.state = "attack";
      continue;
    }

    const clearAttack =
      stationary || victimInSight(state.navigation, actor, victim, target, heroDoids);
    if (distance > furthestReach(attacksOf(ai), bodies) || !clearAttack) {
      // Walking straight at a hero it has no route to, or none to the hero
      // itself, is still "blocked": that is what the floor command and the
      // debug line want to know.
      ai.state = fleeing ? "flee" : route.waypoint && !route.steers ? "chase" : "blocked";
      continue;
    }
    // Backing off, it still shoots when its swing is due: it stands for the
    // swing (the lock above) and carries on after.
    if (fleeing && (cannotAttack || now < ai.nextAttackAt)) {
      ai.state = "flee";
      continue;
    }

    faceTarget(session, doid, actor, target);
    ai.state = "attack";
    // A garlic trap's whole point: STUN_L4 for three seconds, during which it
    // does not swing. Without this the debuff was a picture on the health bar.
    if (cannotAttack) continue;
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
    const random = session.random ?? Math.random;
    const chosen = chooseNpcAttack(
      ai,
      distance,
      bodies,
      now,
      random
    );
    if (!chosen) continue;
    chosen.readyAt = now + (chosen.rechargeMs ?? 0);

    /**
     * Both authored speed layers pace the cast.
     *
     * `AttackSpd` belongs to the selected attack, while an active buff modifies
     * the matching MELEE/SHOOT/MAGIC speed column. SAVAGE_BOW is the decisive
     * capture: EN_POISON_ARROW authors 0.25, the official sends playSpeed 0.25,
     * and its 1.5-second AttackTimer starts producing casts around six seconds.
     * This server dropped AttackSpd and did both four times too quickly.
     */
    const buffSpeed = buffMultiplierFor(session, doid, chosen.speedStat ?? "MELEE_SPD");
    const authoredSpeed = npcAttackSpeed(chosen.attackSpeed);
    const castSpeed = authoredSpeed * (buffSpeed > 0 ? buffSpeed : 1) * floorAttackSpeedScale(session);
    const buffSlowness = buffSpeed > 0 ? 1 / buffSpeed : 1;
    const frameMs = (frame) => Math.max(0, Number(frame ?? 0)) * (1000 / FRAMES_PER_SECOND) / castSpeed;

    /**
     * The lunge the attack itself carries, if it carries one.
     *
     * A constant velocity for `MoveDuration` at `MoveAngle` degrees off the way
     * it is facing, which is what the client does for the player and what the
     * corpus shows the official doing for monsters. `faceTarget` ran a moment
     * ago, so the heading is at the victim and an angle of 0 is a charge at
     * them while 180 is a hop backwards.
     *
     * From the frame the timeline puts `attackautomove` on (gamemaster.js,
     * `autoMoveFrame`), at the pace the cast plays: a frost troll winds its
     * drill up for fifteen frames and then goes, and started here on the swing
     * it had arrived before its own animation left the ground. An attack with
     * no frame of its own (a test's hand-made one) goes at once, as before.
     */
    if (chosen.moveAmount > 0 && chosen.moveDurationMs > 0) {
      const angle = ((actor.heading + chosen.moveAngle) * Math.PI) / 180;
      const speed = chosen.moveAmount / (chosen.moveDurationMs / 1000);
      const from = now + frameMs(chosen.moveFrame ?? 0);
      ai.lunge = {
        from,
        until: from + chosen.moveDurationMs,
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed,
      };
    }
    ai.attackLockedUntil = now +
      Math.max(0, Number(chosen.attackLockFrame ?? chosen.impactFrame ?? 0)) *
        (1000 / FRAMES_PER_SECOND) /
        castSpeed;
    ai.nextAttackAt = now + Math.max(100, attackIntervalMs(ai, buffSlowness) / authoredSpeed);
    // Awaited so the hit lands before the tick moves on: damage is the
    // server's own bookkeeping and must not race the next frame.
    const victimSession = victim.member
      ? victim.member.world?.contextFor(victim.member) ?? victim.member
      : session;
    ai.attackHeading = actor.heading;
    // A shot ends a back-off: it stands for the swing and fights from there.
    ai.fleeUntil = 0;
    await performNpcAttack(
      victimSession,
      doid,
      { ...ai, ...chosen, attackHeading: actor.heading },
      victim.doid
    );
    if (recurringTeleport) {
      ai.teleportPhase = "post-attack";
      ai.teleportHideAt = now + (ai.postTeleportAttackMs ?? 0);
    }
  }
};

/** Runs the lightweight server-authoritative chase/attack loop for one session. */
export const startNpcAi = (session) => {
  let previous = Date.now();
  const scope = matchStateOf(session).floorScope;
  const tick = () => {
    const now = Date.now();
    const deltaSeconds = Math.min((now - previous) / 1000, 0.25);
    previous = now;
    const run = () => tickNpcAi(session, now, deltaSeconds);
    // The loop must survive a failed tick rather than die silently.
    Promise.resolve(worldOf(session)?.withOutputBatch(run) ?? run()).catch((error) =>
      warn(`ai: tick failed: ${error.message}`)
    );
  };
  const timer = scope
    ? scope.interval(tick, config.npcAiTickMs)
    : setInterval(tick, config.npcAiTickMs);

  if (!scope) timer.unref?.();
  info(`[${session.id}] NPC AI ticking every ${config.npcAiTickMs}ms`);
  return () => cancelScopedTimer(scope, timer, clearInterval);
};

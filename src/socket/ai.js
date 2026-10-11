import { config } from "../config.js";
import { info, warn } from "../log.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { attackStopped, buffMultiplierFor } from "./buffs.js";
import { matchStateOf, worldOf } from "./match-world.js";
import {
  hasLineOfSight,
  moveWithNavigation,
  nearestClearPosition,
} from "./navigation.js";
import { objectDisable } from "./objects.js";
import { bodyRadius, contact, reach, standoff } from "./body.js";
import { placeNpc, stepNpc } from "./npc-move.js";
import { describeRoute, NO_ROUTE_ASKED, routeToTarget, searchAgain } from "./routing.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { clearNpcTarget, LET_GO, pickTarget } from "./npc-targeting.js";
import { advanceNpcRelease } from "./npc-release.js";
import { act, ATTACK_RANGE_EPSILON } from "./npc-act.js";
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
export { attackIntervalMs, chooseNpcAttack } from "./npc-act.js";

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);
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

/**
 * What the floor command shows for a monster once it has acted, or not
 * (command-set.js), from `act`'s reason.
 */
const stateAfterAct = (reason, fleeing, route) => {
  switch (reason) {
    case "following":
      return "return";
    case "escaping":
      return "escape";
    case "out-of-reach":
      // Walking straight at a hero it has no route to, or none to the hero
      // itself, is still "blocked": that is what the floor command and the
      // debug line want to know.
      return fleeing ? "flee" : route.waypoint && !route.steers ? "chase" : "blocked";
    case "backing-off":
      return "flee";
    default:
      // Locked in a swing, stunned, waiting on its cadence, nothing to throw
      // from here, or swung: it is attacking.
      return "attack";
  }
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

    const release = advanceNpcRelease(session, doid, actor, now, deltaSeconds, spatialIndex, heroes);
    if (release === "walking") {
      ai.state = "release";
      continue;
    }
    if (release) {
      // Out of its cage, an ordinary monster from here.
      clearNpcTarget(actor);
      if (release === "out") continue;
    }

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

    const reason = await act(session, {
      doid,
      actor,
      victim,
      target,
      bodies,
      distance,
      route,
      now,
      following: followingOwner,
      attackLocked,
      cannotAttack,
      fleeing,
      seesAlways: stationary,
      navigation: state.navigation,
      heroDoids,
    });
    ai.state = stateAfterAct(reason, fleeing, route);
    if (reason === "swung" && recurringTeleport) {
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

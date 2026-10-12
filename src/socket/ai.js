import { config } from "../config.js";
import { info, warn } from "../log.js";
import { bodyRadius, contact } from "./body.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { matchStateOf, worldOf } from "./match-world.js";
import { act, reachOf } from "./npc-act.js";
import { boundedPush, nobodyToFight, senseCrowd, separateIdleNpc, separationDisplacement } from "./npc-crowd.js";
import { face } from "./npc-facing.js";
import { afterStep, bodiesMet, passingNow, placeNpc, stepNpc } from "./npc-move.js";
import { advanceNpcRelease } from "./npc-release.js";
import { clearNpcTarget, LET_GO, pickTarget } from "./npc-targeting.js";
import { engage } from "./target-lock.js";
import { describeRoute, NO_ROUTE_ASKED, routeToTarget } from "./routing.js";
import { chase, restWalk, walkEndsAt } from "./behaviours/chase.js";
import { kite, backingOff } from "./behaviours/kite.js";
import { heldByHit, swingIntent, whatItMayDo } from "./behaviours/overrides.js";
import { pet, snapBackSpot } from "./behaviours/pet.js";
import { isStationary, stationary } from "./behaviours/stationary.js";
import { comeBack, teleportAttacked, teleportsOnCycle, teleportTurn } from "./behaviours/teleport.js";

/**
 * The monster AI: every actor with an `ai`, every tick, the same pipeline.
 *
 *   sense    the crowd on the floor (npc-crowd.js)
 *   held     a hit that throws or staggers it has the tick (behaviours/overrides.js)
 *   target   who it goes for, one selector per kind (npc-targeting.js)
 *   cycle    a teleporter off the floor, or between swings (behaviours/teleport.js)
 *   release  a prisoner walking out of its cage (npc-release.js)
 *   notice   aggro and disengagement
 *   route    where it walks next (routing.js)
 *   intent   the step its own swing, or else its behaviour, asks for
 *            (behaviours/: chase, kite, pet, stationary)
 *   move     the step taken through the crowd and the scenery (npc-move.js)
 *   act      whether it swings (npc-act.js)
 *   face     which way it turns (npc-facing.js)
 *
 * Each stage after `held` may end the tick. What the tick came to is the
 * one state the floor command shows (`ai.state`, command-set.js): each
 * stage that has something to show says it, the last word stands, and it is
 * written once.
 *
 * What the pipeline keeps on an `ai` between ticks, and the one module that
 * writes each (npc-spawn.js and placeables.js build the row's numbers; the
 * rest is written only through these):
 *
 *   state                                  ai.js
 *   targetDoid, nextTargetAt, engaged      target-lock.js
 *   routing, escape                        routing.js
 *   waitEndsAt, passingUntil               npc-move.js
 *   walkSpeed                              behaviours/chase.js
 *   nextAttackAt, attackLockedUntil,
 *     lunge, attackHeading, attacks        npc-act.js
 *   fleeUntil, targetSeen                  behaviours/kite.js
 *   leashed, passedOver, nextPickupAt,
 *     pinnedBy, pinnedRevision             behaviours/pet.js
 *   teleport*                              behaviours/teleport.js
 *   release                                npc-release.js
 *   shove                                  impact.js
 *   staggeredUntil                         hit-pricing.js
 *
 * Letting go of a target (`clearNpcTarget`, npc-targeting.js) asks each of
 * those that keeps something about it to forget it.
 */

export { attackIntervalMs, chooseNpcAttack } from "./npc-act.js";
export { awayFromThreats } from "./behaviours/kite.js";
export { npcWalkingSpeed } from "./behaviours/chase.js";
export { slideShoved } from "./behaviours/overrides.js";

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/** How far a step from `from` goes towards `target`, along the line to it. */
const towards = (step, from, target) => {
  const length = distanceTo(from, target);
  return length > 0.001 ? (step.x * (target.x - from.x) + step.y * (target.y - from.y)) / length : 0;
};

/** Its behaviour: a pet is a pet whatever its row says; then by `Aggro_AI_Type`. */
const behaviourOf = (ai) =>
  ai.kind === "pet"
    ? pet
    : ai.behavior === "KITE_AI"
      ? kite
      : isStationary(ai)
        ? stationary
        : chase;

/** It lets go of its target (`clearNpcTarget`), and shows as idle. */
const letGo = (actor) => {
  clearNpcTarget(actor);
  return "idle";
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
    case "held-short":
      // In reach, but held behind a monster or a wall short of where its walk ends.
      return "blocked";
    default:
      // Locked in a swing, stunned, waiting on its cadence, nothing to throw
      // from here, or swung: it is attacking.
      return "attack";
  }
};

/** The state a tick came to, written once; null leaves the last one standing. */
const settle = (ai, said) => {
  if (said) ai.state = said;
};

// DR_DEBUG_AI=1 prints where each chaser is actually heading, which is the
// only way to tell a legitimate detour around geometry from a detour to
// somewhere nobody asked for.
const traceRoute = (doid, actor, route, target) =>
  info(
    `[ai] ${doid} at (${Math.round(actor.position.x)},${Math.round(actor.position.y)}) ` +
      `-> (${Math.round(route.waypoint.x)},${Math.round(route.waypoint.y)}) ` +
      `${describeRoute(actor.ai, route)} ` +
      `hero (${Math.round(target.x)},${Math.round(target.y)})`
  );

/**
 * The move stage: the intent's step, held by the monsters in its way, pushed
 * by the crowd, kept out of the players, through the scenery (`stepNpc`), and
 * sent. True when it went anywhere. A walk is held by the monsters in its
 * way; a lunge, and the way out of the scenery, are not (`throughBodies`).
 */
const move = (session, state, crowd, doid, actor, intent, turn) => {
  const { ai } = actor;
  const passing = passingNow(ai, turn.now);
  if (ai.kind !== "pet" && !intent.walking) restWalk(ai);
  // Separation remains possible under MOVEMENT zero, but it no longer gives
  // an actor a second BaseMove-sized step on top of its walk.
  const crowding = separationDisplacement(doid, actor, crowd.spatialIndex, crowd.heroDoids);
  // Each body round it, as this walk meets it (npc-move.js `bodyRule`).
  const met = bodiesMet(actor, crowding.near, {
    playersSide: crowd.spatialIndex.playersSide,
    walkingAt: turn.victim.doid,
  });
  // What it walked among, for its behaviour to look at once it has moved.
  turn.around = met.bodies;
  const step = stepNpc(state.navigation, actor, {
    walk: { x: intent.x, y: intent.y },
    contacts: met.contacts,
    bodies: intent.throughBodies ? null : met.bodies,
    passing,
    separation: boundedPush(crowding, ai, turn.deltaSeconds),
    heroes: crowd.heroes,
    walkingAt: turn.victim.doid,
    radius: turn.radius,
    deltaSeconds: turn.deltaSeconds,
    ignoresSmall: "wanted",
    steering: intent.steering,
  });
  /**
   * A walk the scenery or the crowd would not take is not taken, and a body
   * that did not walk is at rest: the next walk sets off from standing, as
   * any walk from standing does (`npcWalkingSpeed`). Kept up instead, a body
   * held at a wall, or behind another monster, would set off at full speed
   * the moment it was let go.
   */
  if ((step?.refused || step?.blocked) && ai.kind !== "pet") restWalk(ai);
  if (!intent.throughBodies) afterStep(session, ai, turn.now, step, passing);
  if (!step) return false;
  placeNpc(session, doid, actor, step);
  return step.travel > 0.001;
};

/**
 * The face stage, once it has moved and acted: its victim, whichever way it
 * walked — round a corner, backing off, along a wall (npc-facing.js). A
 * swing faced its victim as it went (`act`), and one still under way keeps
 * the heading it went with. A pet walking back to its owner faces where it
 * walks, and one standing by does not turn.
 */
const turnAfter = (session, doid, actor, turn, reason, walked) => {
  if (reason === "swung" || reason === "locked") return;
  if (!turn.following) {
    face(session, doid, actor, turn.target);
    return;
  }
  if (walked) face(session, doid, actor, turn.route.waypoint ?? turn.target);
};

/**
 * One actor's tick, `state` being the match's (matchStateOf); answers with the
 * state it came to, or null for no change.
 */
const tickActor = async (session, state, crowd, doid, actor, now, deltaSeconds) => {
  const { ai } = actor;
  if (heldByHit(session, doid, actor, now)) return null;

  const picked = pickTarget(crowd, actor, now);
  if (picked === LET_GO) return letGo(actor);
  if (!picked) return null;
  const { victim, following } = picked;
  let said = following ? "return" : null;
  const target = victim.position;
  // Its body and the victim's, asked once: neither changes in the tick.
  const radius = bodyRadius(actor);
  const bodies = contact(actor, victim.actor);
  const cycle = teleportsOnCycle(actor);

  // Off the floor between teleports: nothing else of the tick is its own.
  if (actor.teleportHidden) {
    return cycle && comeBack(session, doid, actor, target, bodies, now) ? "teleport-in" : said;
  }

  // Too far behind the one it follows, it is put back beside him, and has
  // nothing to do with what it fought or the way it was going
  // (behaviours/pet.js `snapBackSpot`). Every pet row's TetherDist is well
  // inside the distance, so one that far off is always following.
  const snapped = following ? snapBackSpot(state.navigation, actor, victim) : null;
  if (snapped) {
    clearNpcTarget(actor);
    placeNpc(session, doid, actor, { next: snapped, travel: distanceTo(actor.position, snapped) });
    return said;
  }

  const release = advanceNpcRelease(session, doid, actor, now, deltaSeconds, crowd.spatialIndex, crowd.heroes);
  if (release === "walking") return "release";
  if (release) {
    // Out of its cage, an ordinary monster from here: it has let go of what
    // it was released at (npc-release.js `endRelease`), and shows as idle.
    said = "idle";
    if (release === "out") return said;
  }

  if (!following) {
    const distance = distanceTo(actor.position, target);
    if (!ai.engaged) {
      if (distance > ai.aggroRadius) {
        // Release AI already returned above while a cage exit was active.
        // Outside awareness the only permitted motion is resolving a body
        // overlap; no route, facing change or chase state is created.
        separateIdleNpc(session, doid, actor, crowd.spatialIndex, crowd.heroDoids, crowd.heroes, deltaSeconds);
        return said;
      }
      engage(ai);
      said = "chase";
    } else if (distance > ai.disengageDistance) {
      return letGo(actor);
    }
  }

  if (cycle) {
    const phase = teleportTurn(session, doid, actor, now);
    if (phase) return phase.said ?? said;
  }

  const may = whatItMayDo(session, doid, ai, now);
  const route = isStationary(ai)
    ? NO_ROUTE_ASKED
    : routeToTarget(session, actor, target, now, crowd.heroes, following ? Infinity : reachOf(ai, bodies), victim.actor);
  if (state.debugAi && route.waypoint) traceRoute(doid, actor, route, target);
  const behaviour = behaviourOf(ai);
  const turn = {
    session,
    actor,
    ai,
    victim,
    target,
    radius,
    bodies,
    route,
    following,
    heroes: crowd.heroes,
    now,
    deltaSeconds,
    mobility: may.mobility,
    topSpeed: ai.moveSpeed * may.mobility,
    swinging: may.swinging,
    distance: distanceTo(actor.position, target),
    stopAt: walkEndsAt(actor, bodies, following),
    away: null,
  };
  turn.away = behaviour.prepare?.(turn) ?? null;
  const intent = swingIntent(ai, may, now, deltaSeconds) ?? behaviour.intent(turn);
  const before = { x: actor.position.x, y: actor.position.y };
  const walked = move(session, state, crowd, doid, actor, intent, turn);
  behaviour.moved?.(turn, intent, before);

  const fleeing = backingOff(ai, turn.away, now);
  const distance = distanceTo(actor.position, target);
  const reason = await act(session, {
    doid,
    actor,
    victim,
    target,
    bodies,
    distance,
    // Where its walk ends, how far it asked to go at its victim, and how much
    // nearer the tick brought it: a contact swing is made at the walk's end or
    // on the way in.
    stopAt: turn.stopAt,
    pressed: towards(intent, before, target),
    advanced: turn.distance - distance,
    route,
    now,
    following,
    attackLocked: may.attackLocked,
    cannotAttack: may.cannotAttack,
    fleeing,
    seesAlways: isStationary(ai),
    navigation: state.navigation,
  });
  if (cycle) teleportAttacked(ai, now);
  turnAfter(session, doid, actor, turn, reason, walked);
  return stateAfterAct(reason, fleeing, route);
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
    for (const actor of actors.values()) if (actor.ai) settle(actor.ai, letGo(actor));
    return;
  }
  for (const [doid, actor] of actors) {
    if (!actor.ai || actor.dead || !actor.position) continue;
    settle(actor.ai, await tickActor(session, state, crowd, doid, actor, now, deltaSeconds));
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

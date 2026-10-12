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
import { clearNpcTarget, LET_GO, notice, pickTarget } from "./npc-targeting.js";
import { describeRoute, NO_ROUTE_ASKED, routeToTarget } from "./routing.js";
import { chase, restWalk, walkEndsAt } from "./behaviours/chase.js";
import { isKiter, kite } from "./behaviours/kite.js";
import { heldByHit, swingIntent, whatItMayDo } from "./behaviours/overrides.js";
import { follow, pet } from "./behaviours/pet.js";
import { isStationary, stationary } from "./behaviours/stationary.js";
import { comeBack, standDown, teleportAttacked, teleportsOnCycle, teleportTurn } from "./behaviours/teleport.js";

/**
 * The monster AI: every actor with an `ai`, every tick, the same pipeline.
 *
 *   sense    the crowd on the floor (npc-crowd.js)
 *   held     a hit that throws or staggers it has the tick (behaviours/overrides.js)
 *   target   who it goes for, one selector per kind (npc-targeting.js)
 *   release  a prisoner walking out of its cage (npc-release.js)
 *   notice   aggro and disengagement
 *   cycle    a teleporter off the floor, or between swings (behaviours/teleport.js)
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
 *   routeMemo                              route-memo.js
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
 * those that keeps something about it to forget it: target-lock.js,
 * routing.js, chase.js, npc-act.js, kite.js, npc-move.js and pet.js.
 */

export { attackIntervalMs, chooseNpcAttack } from "./npc-act.js";
export { awayFromThreats } from "./behaviours/kite.js";
export { npcWalkingSpeed } from "./behaviours/chase.js";
export { slideShoved } from "./impact.js";

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/** How far a step from `from` goes towards `target`, along the line to it. */
const towards = (step, from, target) => {
  const length = distanceTo(from, target);
  return length > 0.001 ? (step.x * (target.x - from.x) + step.y * (target.y - from.y)) / length : 0;
};

/**
 * Its behaviour this tick: a pet walking back to its owner follows; a pet
 * is a pet whatever its row says; then by `Aggro_AI_Type`. What a behaviour
 * may say, beside its `intent` (each optional; ai.js reads only these):
 *
 *   fights       false: no fight — not noticed or lost, off a teleport
 *                cycle, no swing; it shows `said`
 *   said         the state it starts the tick showing
 *   placeAt      a spot to be put at instead of walking, letting go
 *   routes       false: it asks no route
 *   routeReach   how far it may swing from, for its route (default `reachOf`)
 *   stopAt       where its walk at its victim ends (default `walkEndsAt`)
 *   seesAlways   it swings without asking the scenery for sight
 *   prepare      before its intent
 *   moved        once it has moved: where it was, and the bodies it met
 *   fleeing      it is backing off ("flee")
 *   actGate      what holds its swing back after reach and sight
 *   acted        after it acted
 *   face         which way it turns (default: its victim)
 */
const behaviourOf = (ai, picked) =>
  picked.following
    ? follow
    : ai.kind === "pet"
      ? pet
      : isKiter(ai)
        ? kite
        : isStationary(ai)
          ? stationary
          : chase;

/**
 * It lets go of its target (`clearNpcTarget`), and shows as idle; a
 * teleporter's cycle ends with it (behaviours/teleport.js `standDown`).
 */
const letGo = (session, doid, actor) => {
  clearNpcTarget(actor);
  if (teleportsOnCycle(actor)) standDown(session, doid, actor);
  return "idle";
};

/**
 * What the floor command shows for a monster once it has acted, or not
 * (command-set.js), from `act`'s reason; one not in a fight shows what it
 * said.
 */
const stateAfterAct = (reason, fleeing, route, said) => {
  switch (reason) {
    case "not-fighting":
      return said;
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
 * sent: whether it went anywhere (`walked`), and the bodies it walked among
 * (`among`, npc-move.js `bodiesMet`) for its behaviour to look at once it
 * has moved (`moved`). A walk is held by the monsters in its way; a lunge,
 * and the way out of the scenery, are not (`throughBodies`).
 */
const move = (session, state, crowd, doid, actor, intent, turn) => {
  const { ai } = actor;
  const passing = passingNow(ai, turn.now);
  if (!intent.walking) restWalk(ai);
  // Separation remains possible under MOVEMENT zero, but it no longer gives
  // an actor a second BaseMove-sized step on top of its walk.
  const crowding = separationDisplacement(doid, actor, crowd.spatialIndex, crowd.heroDoids);
  // Each body round it, as this walk meets it (npc-move.js `bodyRule`).
  const met = bodiesMet(actor, crowding.near, {
    playersSide: crowd.spatialIndex.playersSide,
    walkingAt: turn.victim.doid,
  });
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
    kind: "walk",
    steering: intent.steering,
  });
  /**
   * A walk the scenery or the crowd would not take is not taken, and a body
   * that did not walk is at rest: the next walk sets off from standing, as
   * any walk from standing does (`npcWalkingSpeed`). Kept up instead, a body
   * held at a wall, or behind another monster, would set off at full speed
   * the moment it was let go.
   */
  if (step?.refused || step?.blocked) restWalk(ai);
  if (!intent.throughBodies) afterStep(session, ai, turn.now, step, passing);
  if (!step) return { walked: false, among: met.bodies };
  placeNpc(session, doid, actor, step);
  return { walked: step.travel > 0.001, among: met.bodies };
};

/**
 * The face stage, once it has moved and acted: its victim, whichever way it
 * walked — round a corner, backing off, along a wall (npc-facing.js), unless
 * its behaviour turns it otherwise (`face`). A swing faced its victim as it
 * went (`act`), and one still under way keeps the heading it went with.
 */
const turnAfter = (session, doid, actor, turn, reason, walked, behaviour) => {
  if (reason === "swung" || reason === "locked") return;
  if (behaviour.face) behaviour.face(session, doid, actor, turn, reason, walked);
  else face(session, doid, actor, turn.target);
};

/**
 * One actor's tick, `state` being the match's (matchStateOf); answers with the
 * state it came to, or null for no change.
 *
 * Async, and waited on actor by actor, though only a swing has anything to
 * wait for: what a tick sets going without waiting — a smashed prop's
 * monsters coming out — lands between two actors' ticks, and the actors
 * that come out this tick are ticked this tick. Run through at once, they
 * were ticked the next (scenario/smashing on the harness).
 */
const tickActor = async (session, state, crowd, doid, actor, now, deltaSeconds) => {
  const { ai } = actor;
  if (heldByHit(session, doid, actor, now)) return null;

  const picked = pickTarget(crowd, actor, now);
  // Nothing to go for — a pet resting by its owner, an ally or a beast with
  // nobody to fight: it stays where it is, lifted out of any body it is
  // inside, as an idle monster is (npc-crowd.js `separateIdleNpc`).
  if (picked === LET_GO || !picked) {
    const said = picked === LET_GO ? letGo(session, doid, actor) : null;
    separateIdleNpc(session, doid, actor, crowd.spatialIndex, crowd.heroDoids, crowd.heroes, deltaSeconds);
    return said;
  }
  const { victim } = picked;
  const behaviour = behaviourOf(ai, picked);
  const fights = behaviour.fights !== false;
  let said = behaviour.said ?? null;
  const target = victim.position;
  // Its body and the victim's, asked once: neither changes in the tick.
  const radius = bodyRadius(actor);
  const bodies = contact(actor, victim.actor);
  const cycle = teleportsOnCycle(actor);

  // Put somewhere else instead of walking (behaviours/pet.js `snapBackSpot`):
  // it has nothing to do with what it fought or the way it was going.
  const placed = behaviour.placeAt?.(state.navigation, actor, victim) ?? null;
  if (placed) {
    clearNpcTarget(actor);
    placeNpc(session, doid, actor, { next: placed, travel: distanceTo(actor.position, placed) });
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

  // Aggro and disengagement (npc-targeting.js `notice`).
  const noticed = fights ? notice(actor, target) : null;
  if (noticed === "idle") {
    // Release AI already returned above while a cage exit was active.
    // Outside awareness the only permitted motion is resolving a body
    // overlap; no route, facing change or chase state is created.
    separateIdleNpc(session, doid, actor, crowd.spatialIndex, crowd.heroDoids, crowd.heroes, deltaSeconds);
    return said;
  }
  if (noticed === "noticed") said = "chase";
  if (noticed === "let-go") return letGo(session, doid, actor);

  // Off the floor between teleports, still in its fight: nothing else of the
  // tick is its own. Out of a fight, it stands down (`standDown`).
  if (actor.teleportHidden) {
    if (!fights) {
      standDown(session, doid, actor);
      return said;
    }
    return cycle && comeBack(session, doid, actor, target, bodies, now) ? "teleport-in" : said;
  }

  // Its cycle is its fight's: out of a fight, a teleporter walks.
  if (cycle && fights) {
    const phase = teleportTurn(session, doid, actor, now);
    if (phase) return phase.said ?? said;
  }

  const may = whatItMayDo(session, doid, ai, now);
  const route = behaviour.routes === false
    ? NO_ROUTE_ASKED
    : routeToTarget(session, actor, target, now, crowd.heroes, (behaviour.routeReach ?? reachOf)(ai, bodies), victim.actor);
  if (state.debugAi && route.waypoint) traceRoute(doid, actor, route, target);
  /**
   * The tick as each stage leaves it for the next, act included
   * (npc-act.js `act`). `distance` is how far it stands from its target:
   * before its walk, then, once it has walked, after it; `pressed` how far
   * its walk asked to go at its victim and `advanced` how much nearer the
   * walk brought it; `stopAt` where its walk ends.
   */
  const turn = {
    session,
    doid,
    actor,
    ai,
    victim,
    target,
    radius,
    bodies,
    route,
    heroes: crowd.heroes,
    navigation: state.navigation,
    now,
    deltaSeconds,
    mobility: may.mobility,
    topSpeed: ai.moveSpeed * may.mobility,
    swinging: may.swinging,
    attackLocked: may.attackLocked,
    cannotAttack: may.cannotAttack,
    distance: distanceTo(actor.position, target),
    stopAt: (behaviour.stopAt ?? walkEndsAt)(actor, bodies),
    away: null,
    pressed: 0,
    advanced: 0,
    fleeing: false,
    actGate: behaviour.actGate,
    seesAlways: behaviour.seesAlways === true,
  };
  turn.away = behaviour.prepare?.(turn) ?? null;
  const intent = swingIntent(ai, may, now, deltaSeconds) ?? behaviour.intent(turn);
  const before = { x: actor.position.x, y: actor.position.y };
  const { walked, among } = move(session, state, crowd, doid, actor, intent, turn);
  behaviour.moved?.(turn, intent, before, among);

  turn.fleeing = behaviour.fleeing?.(turn) ?? false;
  // A contact swing is made at the walk's end or on the way in (npc-act.js `heldShort`).
  const distance = distanceTo(actor.position, target);
  turn.pressed = towards(intent, before, target);
  turn.advanced = turn.distance - distance;
  turn.distance = distance;
  const reason = fights ? await act(session, turn) : "not-fighting";
  behaviour.acted?.(turn, reason);
  if (cycle) teleportAttacked(ai, now);
  turnAfter(session, doid, actor, turn, reason, walked, behaviour);
  return stateAfterAct(reason, turn.fleeing, route, said);
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
    for (const [doid, actor] of actors) if (actor.ai) settle(actor.ai, letGo(session, doid, actor));
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

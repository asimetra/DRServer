import { bodyRadius } from "./body.js";
import {
  hasLineOfSight,
  isPositionBlocked,
  moveWithNavigation,
  nearestClearPosition,
} from "./navigation.js";
import { keptOutOfHeroes } from "./npc-move.js";
import { searchRoute } from "./route-memo.js";

/**
 * Where a monster walks next on its way to a target, as one value.
 *
 * `routeToTarget` answers with a `Route`:
 *
 *   waypoint   the point to walk at this tick, or null when there is none;
 *   sees       the body has a straight line at its own radius to the target,
 *              so the waypoint is the target;
 *   blocked    the latest route search to this target found no route. Kept
 *              while the body escapes the scenery, which does not search;
 *   steers     it walks straight at the target without seeing it: the
 *              waypoint is the target, and the walk slides along what it meets
 *              (see the blocked tick in `tickNpcAi`);
 *   exhausted  the route's points are used up, so there is no waypoint;
 *   escaping   the body is in the scenery and the waypoint is the way out.
 *
 * What it takes to give that answer — the route in hand, how far along it the
 * body is, when and for what it was searched — is this module's and kept on
 * `ai.routing`, which nothing else reads or writes: `forgetRoute` and
 * `searchAgain` are how the rest of the AI says the route no longer holds.
 */

/** How long a route is followed before it is searched again from where the body stands. */
const ROUTE_REFRESH_MS = 1000;
/** A failed search is dear (it exhausts every cell the body can reach), so it is retried less often. */
const FAILED_PATH_RETRY_MS = 2000;

const squaredDistanceTo = (from, to) => {
  const x = to.x - from.x;
  const y = to.y - from.y;
  return x * x + y * y;
};

const route = (waypoint, { sees = false, blocked = false, steers = false, exhausted = false, escaping = false } = {}) => ({
  waypoint,
  sees,
  blocked,
  steers,
  exhausted,
  escaping,
});

/** The route of one that does not route: a stationary boss neither searches nor looks. */
export const NO_ROUTE_ASKED = Object.freeze(route(null));

/** The target is gone or changed hands: nothing of the old route carries over. */
export const forgetRoute = (ai) => {
  ai.routing = null;
};

/**
 * The body was put somewhere its route does not start from — a teleport — so
 * the next call searches again from there. The last search's verdict stands
 * until that search replaces it.
 */
export const searchAgain = (ai) => {
  if (ai.routing) ai.routing = { ...ai.routing, points: null };
};

/** For DR_DEBUG_AI: how the waypoint was come by. */
export const describeRoute = (ai, { sees, blocked }) => {
  if (blocked) return "no route";
  if (sees) return "direct";
  return `via path ${ai.routing?.next ?? 0}/${ai.routing?.points?.length ?? 0}`;
};

/**
 * A body in the scenery gets out before it goes anywhere.
 *
 * Neither route finds a way from inside a collider: a sight line skips its
 * first point and so reads clear from a body half in the bars, and the grid
 * search starts in a cell it can never leave. The first walked it along the
 * face of the jail, one refused step at a time; the second gave up and left
 * it "blocked" in the cage for the rest of the floor. So it is sent to open
 * ground first — the cage's own mouth if it was let out of one, else the
 * nearest clear spot towards its target — and `moveWithNavigation` lets a
 * buried body take the steps that bring it out.
 */
const wayOut = (navigation, actor, target, heroes, radius) => {
  const { ai } = actor;
  const escapableWithoutHeroes = (candidate) => {
    const permitted = keptOutOfHeroes(candidate, actor, heroes);
    if (isPositionBlocked(navigation, permitted, radius)) return false;
    // Clear ground across the collider is not useful when the first step has
    // to go deeper into it. `moveWithNavigation` permits only progress out.
    const firstMove = moveWithNavigation(
      navigation,
      actor.position,
      {
        x: permitted.x - actor.position.x,
        y: permitted.y - actor.position.y,
      },
      radius
    );
    return squaredDistanceTo(firstMove, actor.position) > 0.01;
  };
  // A way out the body does not fit at, or the player physically closes off,
  // is no way out. Re-evaluate an old target as heroes move through the room.
  if (
    ai.escape &&
    (isPositionBlocked(navigation, ai.escape, radius) || !escapableWithoutHeroes(ai.escape))
  ) {
    ai.escape = null;
  }
  ai.escape ??= nearestClearPosition(navigation, actor.position, radius, {
    towards: target,
    accept: escapableWithoutHeroes,
  });
  return ai.escape;
};

/**
 * The route in hand, searched again when there is none, it is used up, it is
 * due, the target has moved a cell or the scenery has changed. A closed route
 * should not make every NPC redo a full map search five times per second; a
 * changed target or navigation revision retries early.
 */
const currentRouting = (ai, navigation, position, target, radius, now) => {
  const routing = ai.routing;
  const points = routing?.points;
  const due =
    !Array.isArray(points) ||
    (points.length && routing.next >= points.length) ||
    now >= routing.searchAt ||
    squaredDistanceTo(routing.aimedAt, target) >= navigation.cellSize * navigation.cellSize ||
    routing.revision !== navigation.revision;
  if (!due) return routing;
  const found = searchRoute(ai, navigation, position, target, radius);
  const failed = found.length === 0;
  ai.routing = {
    points: found,
    next: 0,
    aimedAt: { ...target },
    failed,
    searchAt: now + (failed ? FAILED_PATH_RETRY_MS : ROUTE_REFRESH_MS),
    revision: navigation.revision,
  };
  return ai.routing;
};

/** Passes the points the body already stands at. */
const passReachedPoints = (routing, position, radius) => {
  const reachedDistance = Math.max(18, radius * 0.5);
  const { points } = routing;
  while (
    routing.next < points.length &&
    squaredDistanceTo(position, points[routing.next]) <= reachedDistance * reachedDistance
  ) {
    routing.next++;
  }
};

/** Where `actor` walks next on its way to `target`; see the module comment for the answer. */
export const routeToTarget = (session, actor, target, now, heroes = []) => {
  const { ai } = actor;
  const navigation = session.navigation;
  const radius = bodyRadius(actor);
  if (navigation && isPositionBlocked(navigation, actor.position, radius)) {
    // Even when there is no exit, a body inside scenery must never attack.
    // `blocked` is still the last search's: escaping does not search.
    return route(wayOut(navigation, actor, target, heroes, radius), {
      escaping: true,
      blocked: Boolean(ai.routing?.failed),
    });
  }
  ai.escape = null;
  if (!navigation || hasLineOfSight(navigation, actor.position, target, radius)) {
    forgetRoute(ai);
    return route(target, { sees: true });
  }

  const routing = currentRouting(ai, navigation, actor.position, target, radius, now);
  passReachedPoints(routing, actor.position, radius);
  /**
   * A route it cannot find is a straight walk at the target.
   *
   * The official does not plan to the nearest reachable point, nor detour: in
   * 110 engaged episodes with no route to the hero (96 captures) it steers at
   * the hero, slides along whatever it hits, and stands where the straight
   * line is blocked — that model fits its stopping point to 152 u at the
   * median against 191 for the closest reachable cell. Ranged ones shoot from
   * there, kiters keep their distance. Ours stood where the search failed,
   * which was most often a whole room away. The waypoint is the target, so the
   * walk ends at the standoff; the search still retries on its own cadence,
   * so a gate opening gives it a real route. Where the walk stops, see the
   * blocked tick in `tickNpcAi`.
   */
  if (routing.failed) return route(target, { blocked: true, steers: true });
  const waypoint = routing.points[routing.next] ?? null;
  return route(waypoint, { exhausted: waypoint === null });
};

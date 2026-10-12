import { aimAt, bodyBlocked, bodyClearSpot, bodyRadius, bodyRoute, bodyWalkClear, moveBody, seesBody } from "./body.js";
import { keptOutOfHeroes } from "./npc-move.js";

/**
 * Where a monster walks next on its way to a target, as one value.
 *
 * `routeToTarget` answers with a `Route`:
 *
 *   waypoint   the point to walk at this tick, or null when there is none;
 *   straight   the body has a clear walk at its own radius to the target
 *              (`bodyWalkClear`), so the waypoint is the target. Not sight:
 *              whether it may swing from here asks a line of no width
 *              (body.js `seesBody`), which is what "sees" means everywhere;
 *   blocked    the latest route search to this target found no route. Kept
 *              while the body escapes the scenery, which does not search;
 *   steers     it walks straight at the target without seeing it — there is
 *              no route, or the route ends short of the target and is not
 *              worth walking: the waypoint is the target, and the walk
 *              slides along what it meets and is not taken on a tick the
 *              scenery gives nothing back on (`stepNpc`, npc-move.js);
 *   exhausted  the route's points are used up, so there is no waypoint;
 *   escaping   the body is in the scenery and the waypoint is the way out.
 *
 * The body is what goes round the scenery and what sees (body.js): the route
 * is searched for the body, towards the place its body meets the victim's
 * (`aimAt`), and handed back as the points its feet walk.
 *
 * What it takes to give that answer — the route in hand, how far along it the
 * body is, when and for what it was searched — is this module's and kept on
 * `ai.routing`, which nothing else reads or writes: `forgetRoute` and
 * `searchAgain` are how the rest of the AI says the route no longer holds.
 * The way out of the scenery is kept on `ai.escape`, written here alone:
 * `wayOut` finds it, `escapeBy` hands one in.
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

const route = (waypoint, { straight = false, blocked = false, steers = false, exhausted = false, escaping = false } = {}) => ({
  waypoint,
  straight,
  blocked,
  steers,
  exhausted,
  escaping,
});

/** The route of one that does not route: a stationary boss neither searches nor looks. */
export const NO_ROUTE_ASKED = Object.freeze(route(null));

/**
 * The target is gone or changed hands: nothing of the old route carries over,
 * the way out of the scenery included. That was found from where the body
 * stood then and towards what it went for then; kept, a body put back into
 * the scenery somewhere else would head for it again (`wayOut` keeps any
 * point that is clear and that its first step makes headway towards).
 */
export const forgetRoute = (ai) => {
  ai.routing = null;
  ai.escape = null;
};

/**
 * The body is to leave the scenery by `point` — a cage's mouth, when the walk
 * out through it was given up on (npc-release.js). Held as any way out is:
 * until the body is out, it no longer leads anywhere, or the route is
 * forgotten.
 */
export const escapeBy = (ai, point) => {
  ai.escape = point;
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
export const describeRoute = (ai, { straight, blocked, steers }) => {
  if (blocked) return "no route";
  if (straight) return "direct";
  if (steers) return "route ends short, straight at it";
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
    if (bodyBlocked(navigation, actor, permitted, radius)) return false;
    // Clear ground across the collider is not useful when the first step has
    // to go deeper into it. `moveWithNavigation` permits only progress out.
    const firstMove = moveBody(
      navigation,
      actor,
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
    (bodyBlocked(navigation, actor, ai.escape, radius) || !escapableWithoutHeroes(ai.escape))
  ) {
    ai.escape = null;
  }
  ai.escape ??= bodyClearSpot(navigation, actor, actor.position, radius, {
    towards: target,
    accept: escapableWithoutHeroes,
  });
  return ai.escape;
};

/**
 * The route in hand, searched again when there is none, it is due, the target
 * has moved a cell or the scenery has changed, and when a route to the target
 * is used up. A closed route should not make every NPC redo a full map search
 * five times per second; a changed target or navigation revision retries
 * early. A route that ends short is not searched again for being used up:
 * the body stands at its end or walks straight on from it, and a search from
 * every step of that would find the same end.
 */
const currentRouting = (actor, navigation, target, radius, now) => {
  const { ai } = actor;
  const routing = ai.routing;
  const points = routing?.points;
  const due =
    !Array.isArray(points) ||
    (points.length && !points.endsShort && routing.next >= points.length) ||
    now >= routing.searchAt ||
    squaredDistanceTo(routing.aimedAt, target) >= navigation.cellSize * navigation.cellSize ||
    routing.revision !== navigation.revision;
  if (!due) return routing;
  const found = bodyRoute(ai, navigation, actor, actor.position, target, radius);
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

/**
 * Whether its body, its feet at `place`, may swing at `victim` (an actor;
 * feet at `target`) from there: within `reach`, and in sight by the line of
 * no width a swing is let go on (`seesBody`).
 */
const swingsAt = (navigation, actor, place, victim, target, reach) =>
  squaredDistanceTo(place, target) <= reach * reach && seesBody(navigation, actor, place, victim, target);

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

/**
 * Where `actor` walks next on its way to `target`, the feet of `victim` (an
 * actor, for its body; none for a point); see the module comment for the
 * answer. `reach` is how far it may swing at the target from (npc-act.js
 * `reachOf`), which decides whether a route that ends short is worth walking.
 */
export const routeToTarget = (session, actor, target, now, heroes = [], reach = Infinity, victim = null) => {
  const { ai } = actor;
  const navigation = session.navigation;
  const radius = bodyRadius(actor);
  if (navigation && bodyBlocked(navigation, actor, actor.position, radius)) {
    // Even when there is no exit, a body inside scenery must never attack.
    // `blocked` is still the last search's: escaping does not search.
    return route(wayOut(navigation, actor, target, heroes, radius), {
      escaping: true,
      blocked: Boolean(ai.routing?.failed),
    });
  }
  ai.escape = null;
  const aim = aimAt(actor, victim, target);
  if (!navigation || bodyWalkClear(navigation, actor, actor.position, aim, radius)) {
    forgetRoute(ai);
    return route(target, { straight: true });
  }

  const routing = currentRouting(actor, navigation, aim, radius, now);
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
   * so a gate opening gives it a real route. Where the walk stops, see
   * `stepNpc`.
   */
  if (routing.failed) return route(target, { blocked: true, steers: true });
  const { points } = routing;
  const waypoint = points[routing.next] ?? null;
  const exhausted = waypoint === null;
  /**
   * A route that ends short of the target — a hero in a slot the body does
   * not fit — ends at the nearest place the body can get to with the target
   * in sight (pathfind.js). It is walked, to its very end, when that end is a
   * place to swing from — the victim's body in sight from its own, by the
   * line of no width a swing is let go on (`seesBody`), and within `reach` —
   * and a better one than where the
   * body stands: it cannot swing from there, or it can and the end is nearer.
   * Otherwise the walk is the straight one the official takes when it has no
   * route, and one that has come to the end of its route with the target in
   * sight stands there: nothing nearer is in sight, so the straight walk on
   * could only take it out of sight, and the route would bring it back —
   * two chasers in tools/gap-census.js went to and fro so, every tick.
   *
   * Asking only which was nearer, a halberd knight 143 from a hero between
   * the prison's barrel racks stood there blind rather than walk to 151,
   * where it swings. Walked to whenever it was in sight, or nearer, an end
   * out of reach was a detour for nothing: of the 1380 heroes a monster cannot
   * route to in tools/gap-census.js, 21 had a chaser walk from 200 to 3400
   * units farther than before and swing no more, against 4 with the end held
   * to its reach, which swung as often (98.0% of those it could).
   */
  if (points.endsShort) {
    const end = points.at(-1);
    const swingsFrom = (place) => swingsAt(navigation, actor, place, victim, target, reach);
    const endBetter =
      swingsFrom(end) &&
      (!swingsFrom(actor.position) || squaredDistanceTo(end, target) < squaredDistanceTo(actor.position, target));
    if (endBetter) return route(exhausted ? end : waypoint);
    if (exhausted && seesBody(navigation, actor, actor.position, victim, target)) return route(null, { exhausted });
    return route(target, { steers: true, exhausted });
  }
  return route(waypoint, { exhausted });
};

/**
 * Whether `actor` can get at `candidate` (a candidate of the crowd: its
 * `actor` and `position`) to swing at it from `reach`, swinging from a place
 * `keepsTo` allows: it may swing from here, it can walk straight at it, or a
 * route search finds a way, through allowed points only, that ends at it or
 * ends short where it may swing from. Where a walk at it ends — `stopAt`
 * short of it, its walk's end (behaviours/chase.js `walkEndsAt`) — is the
 * place it swings from, and that place, not the candidate, is what
 * `keepsTo` is asked of. The route search is the one `routeToTarget` makes
 * (`bodyRoute`, and its memo), from the same place to the same point, so the
 * walk that follows a yes does not search again. A body in the scenery is
 * not asked: the way out comes first, and from inside a collider no search
 * finds anything. With no scenery, the straight walk's end is all it asks.
 */
export const canGetAt = (navigation, actor, candidate, reach, keepsTo = () => true, stopAt = 0) => {
  const { actor: victim, position: target } = candidate;
  const aim = aimAt(actor, victim, target);
  /** Where a walk from `from` straight at it ends. */
  const endsAt = (from) => {
    const apart = Math.sqrt(squaredDistanceTo(from, aim));
    if (apart <= stopAt || apart < 0.001) return from;
    return { x: aim.x + ((from.x - aim.x) / apart) * stopAt, y: aim.y + ((from.y - aim.y) / apart) * stopAt };
  };
  if (!navigation) return keepsTo(endsAt(actor.position));
  const radius = bodyRadius(actor);
  if (bodyBlocked(navigation, actor, actor.position, radius)) return true;
  if (swingsAt(navigation, actor, actor.position, victim, target, reach)) return true;
  if (keepsTo(endsAt(actor.position)) && bodyWalkClear(navigation, actor, actor.position, aim, radius)) return true;
  const points = bodyRoute(actor.ai, navigation, actor, actor.position, aim, radius);
  if (!points.length) return false;
  if (points.endsShort) return points.every(keepsTo) && swingsAt(navigation, actor, points.at(-1), victim, target, reach);
  return points.slice(0, -1).every(keepsTo) && keepsTo(endsAt(points.at(-2) ?? actor.position));
};

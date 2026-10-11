import { collidersNear } from "./collider-index.js";
import { hasLineOfSight, isPositionBlocked, isWithinFloor } from "./clearance.js";
import { depthInto, surfaceNormal } from "./geometry.js";

/**
 * A body moving through the floor: a step taken in substeps, slid along what
 * it meets, let out of what it is already in; and the nearest ground a body
 * can be put on.
 */

/**
 * A refused step, turned to run along the surface it hit.
 *
 * Axis slides alone cannot get round anything round: a body walking straight
 * at a statue's circle, or at a slanted box, is refused on both axes and stands
 * against it for good. The step keeps its part along the collider it would
 * reach deepest into and loses the part into it.
 */
const slideAlongSurface = (navigation, position, step, radius, options) => {
  const attempted = { x: position.x + step.x, y: position.y + step.y };
  let deepest = null;
  let deepestDepth = 0;
  for (const collider of collidersNear(navigation, attempted, radius, options)) {
    const depth = depthInto(attempted, radius, collider);
    if (depth > deepestDepth) {
      deepest = collider;
      deepestDepth = depth;
    }
  }
  const normal = deepest && surfaceNormal(position, deepest);
  if (!normal) return null;
  const into = step.x * normal.x + step.y * normal.y;
  if (into >= 0) return null;
  const along = { x: step.x - into * normal.x, y: step.y - into * normal.y };
  if (Math.hypot(along.x, along.y) < 0.01) return null;
  const slid = { x: position.x + along.x, y: position.y + along.y };
  return isPositionBlocked(navigation, slid, radius, options) ? null : slid;
};

/** Each collider an actor reaches into and its penetration depth. */
const penetrationsAt = (navigation, point, radius, options) => {
  const penetrations = new Map();
  for (const collider of collidersNear(navigation, point, radius, options)) {
    const depth = depthInto(point, radius, collider);
    if (depth > 0) penetrations.set(collider, depth);
  }
  return penetrations;
};

/**
 * Applies a swept move, falling back to axis sliding when separation nudges into a wall.
 *
 * A body already in the scenery may still move out of it. A step that ends
 * blocked is refused, and for a body that starts blocked every step does: a
 * knight left 19 units into a jail by its release, a monster a closing gate
 * came down on, a cage member whose exit was given up on — each stood where it
 * was for the rest of the floor, facing a player it could see. So a step is
 * also taken when it leaves the body less buried than it was. It never lets a
 * body into anything: it only lets one out.
 */
export const moveWithNavigation = (
  navigation,
  from,
  displacement,
  radius = 0,
  options
) => {
  if (!navigation) {
    return { x: from.x + displacement.x, y: from.y + displacement.y };
  }

  const length = Math.hypot(displacement.x, displacement.y);
  if (length < 0.001) return { ...from };
  const substepLength = Math.max(8, radius > 0 ? radius * 0.4 : 12);
  const steps = Math.max(1, Math.ceil(length / substepLength));
  const step = { x: displacement.x / steps, y: displacement.y / steps };
  const position = { ...from };

  for (let index = 0; index < steps; index++) {
    const full = { x: position.x + step.x, y: position.y + step.y };
    if (!isPositionBlocked(navigation, full, radius, options)) {
      position.x = full.x;
      position.y = full.y;
      continue;
    }

    // Asked only once a step is refused: this is the hot path.
    const buried =
      isPositionBlocked(navigation, position, radius, options) &&
      isWithinFloor(navigation, position, radius)
        ? penetrationsAt(navigation, position, radius, options)
        : new Map();
    const canStand = (point) => {
      if (!isPositionBlocked(navigation, point, radius, options)) return true;
      if (!buried.size || !isWithinFloor(navigation, point, radius)) return false;

      const next = penetrationsAt(navigation, point, radius, options);
      let improved = false;
      for (const [collider, depth] of next) {
        const before = buried.get(collider);
        // Escaping one wall never pays for entering another or moving deeper
        // into a wall the body was already touching.
        if (before === undefined || depth > before + 0.01) return false;
        if (depth < before - 0.01) improved = true;
      }
      for (const collider of buried.keys()) {
        if (!next.has(collider)) improved = true;
      }
      return improved;
    };
    if (buried.size && canStand(full)) {
      position.x = full.x;
      position.y = full.y;
      continue;
    }
    const slid = buried.size ? null : slideAlongSurface(navigation, position, step, radius, options);
    if (slid) {
      position.x = slid.x;
      position.y = slid.y;
      continue;
    }

    const xOnly = { x: position.x + step.x, y: position.y };
    const yOnly = { x: position.x, y: position.y + step.y };
    const canX = canStand(xOnly);
    const canY = canStand(yOnly);
    if (canX && (!canY || Math.abs(step.x) >= Math.abs(step.y))) position.x = xOnly.x;
    else if (canY) position.y = yOnly.y;
    else break;
  }
  return position;
};

/**
 * The closest ground an actor of this size can actually stand on.
 *
 * Searched outward from the point, and forward first: a cage's spawn sits at
 * the back of it, so the way out is the way the room lies. Returns null only if
 * nothing within reach is clear, which means the actor is walled in rather than
 * merely standing in the wall.
 */
export const nearestClearPosition = (
  navigation,
  origin,
  radius = 0,
  { reach = 240, reachableFrom = null, towards = null, accept = () => true } = {}
) => {
  if (!navigation || !origin) return null;
  const isClear = (candidate) =>
    !isPositionBlocked(navigation, candidate, radius) && accept(candidate);
  if (isClear(origin)) return origin;

  const step = Math.max(16, Math.round(radius / 2));
  /**
   * Searched towards somewhere before anywhere. Which way is "out" is a
   * property of the floor, not a constant — the tutorial's cages happen to face
   * +Y and an earlier version simply assumed so, which is the same mistake that
   * put a release cluster behind its own cage. When a direction is known it
   * leads; otherwise the ring is walked in a fixed order so the answer is still
   * the same every time.
   */
  const ring = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
    [0.7, 0.7],
    [-0.7, 0.7],
    [0.7, -0.7],
    [-0.7, -0.7],
  ];
  const lead = towards
    ? (() => {
        const dx = towards.x - origin.x;
        const dy = towards.y - origin.y;
        const length = Math.hypot(dx, dy);
        return length < 0.001 ? [] : [[dx / length, dy / length]];
      })()
    : [];
  const directions = [...lead, ...ring];

  /**
   * Clear ground is not enough on its own: the far side of a wall is clear too,
   * and an actor put there is as stuck as one left inside the wall. So a
   * candidate has to be visible from somewhere that matters — the room the
   * player is in — before it is accepted.
   *
   * Two passes rather than one test, so that a floor whose geometry defeats the
   * sight line still places its actor somewhere standable instead of nowhere.
   */
  const scan = (accept) => {
    for (let distance = step; distance <= reach; distance += step) {
      for (const [dx, dy] of directions) {
        const candidate = { x: origin.x + dx * distance, y: origin.y + dy * distance };
        if (!isClear(candidate)) continue;
        return candidate;
      }
    }
    return null;
  };

  if (reachableFrom) {
    const reachable = scan((candidate) =>
      hasLineOfSight(navigation, candidate, reachableFrom, radius)
    );
    if (reachable) return reachable;
  }
  return scan(() => true);
};

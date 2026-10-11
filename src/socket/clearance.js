import { anyColliderAt, canGather, clearOfGathered, gatherNear } from "./collider-index.js";
import { onAuthoredTile, tileAt } from "./tiles.js";

/**
 * Whether a body circle is clear of the floor: at a point
 * (`isPositionBlocked`) and swept along a line (`hasLineOfSight`). Clear is
 * inside the floor's bounds, on a laid tile, and overlapping no active
 * collider.
 *
 * The line is sampled and each sample put to the point test; `sweepIsClear`
 * is the same samples and the same tests, with the colliders near a run of
 * them gathered once. Each public test has a twin past its guards, on bare
 * coordinates, for the hot loops of the route search.
 */

/** Whether a body circle at (x, y) lies wholly inside the floor's bounds. */
const insideBounds = (bounds, x, y, radius) =>
  x - radius >= bounds.minX && x + radius <= bounds.maxX && y - radius >= bounds.minY && y + radius <= bounds.maxY;

/** Inside the floor's bounds and on one of its tiles; colliders aside. */
export const isWithinFloor = (navigation, point, radius) => withinFloorAt(navigation, point.x, point.y, radius);

export const withinFloorAt = (navigation, x, y, radius) =>
  insideBounds(navigation.bounds, x, y, radius) &&
  (!navigation.tileKeys.size || onAuthoredTile(navigation, x, y));

/** True when an actor circle would overlap authored navigation geometry. */
export const isPositionBlocked = (
  navigation,
  point,
  radius = 0,
  { ignoredColliders } = {}
) => {
  if (!navigation) return false;
  return blockedAt(navigation, point.x, point.y, radius, ignoredColliders);
};

/** `isPositionBlocked` past its guards, on a bare coordinate pair. */
export const blockedAt = (navigation, x, y, radius, ignoredColliders) => {
  if (!withinFloorAt(navigation, x, y, radius)) return true;
  return anyColliderAt(navigation, x, y, radius, ignoredColliders);
};

/** Samples a swept actor circle so a fast tick cannot tunnel through a thin wall. */
export const hasLineOfSight = (
  navigation,
  from,
  to,
  radius = 0,
  options
) => {
  if (!navigation) return true;
  return lineIsClear(navigation, from.x, from.y, to.x, to.y, radius, options);
};

/** `hasLineOfSight` past its guard, between bare coordinate pairs. */
export const lineIsClear = (navigation, fromX, fromY, toX, toY, radius, options) => {
  const distanceX = fromX - toX;
  const distanceY = fromY - toY;
  const distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY);
  const step = Math.max(8, Math.min(24, radius > 0 ? radius * 0.5 : 16));
  const samples = Math.max(1, Math.ceil(distance / step));
  if (!(samples >= 1)) return true;
  // Read once rather than per sample; destructured exactly as
  // `isPositionBlocked` does, so the options it accepts are the same.
  const ignoredColliders = ignoredCollidersOf(options);

  const spanX = toX - fromX;
  const spanY = toY - fromY;
  if (samples > 1 && canSweep(navigation, fromX, fromY, radius, ignoredColliders)) {
    return sweepIsClear(navigation, fromX, fromY, spanX, spanY, samples, radius, ignoredColliders);
  }
  for (let index = 1; index <= samples; index++) {
    const ratio = index / samples;
    if (blockedAt(navigation, fromX + spanX * ratio, fromY + spanY * ratio, radius, ignoredColliders)) {
      return false;
    }
  }
  return true;
};

const ignoredCollidersOf = ({ ignoredColliders } = {}) => ignoredColliders;

/** How many samples of a sight line share one gathering of nearby colliders. */
const SWEEP_CHUNK = 8;

/**
 * Whether `sweepIsClear` may answer for this sight line: plain numbers, a
 * radius that is not negative, the point-test grid in force, and an ignore
 * list that is a set or nothing. Anything else is sampled one point at a time.
 */
const canSweep = (navigation, fromX, fromY, radius, ignoredColliders) =>
  typeof fromX === "number" &&
  typeof fromY === "number" &&
  typeof radius === "number" &&
  radius >= 0 &&
  canGather(navigation) &&
  (ignoredColliders === undefined || ignoredColliders === null || ignoredColliders instanceof Set);

/**
 * The same samples, the same tests on each, gathered rather than looked up.
 *
 * A sight line is clear only if every sample is, so the order samples are
 * tested in cannot change the answer, only how soon a blocked one is found.
 * That frees two things:
 *
 * - The floor's bounds are asked of the first and last samples alone. Each
 *   coordinate of a sample, `from + span * (index / samples)`, never decreases
 *   or never increases with the index — every step of it rounds monotonically
 *   — so every sample lies between those two, and if both keep the body inside
 *   the bounds, all of them do.
 * - The colliders near a run of samples are gathered once: every entry in the
 *   grid cells under the run's box whose own box reaches that box. An entry
 *   that reaches one sample's square reaches the run's box, which holds the
 *   square, and shares a cell with it — so each sample still meets exactly the
 *   entries its own lookup would have, and is put to the same box test and the
 *   same overlap test.
 *
 * Which tile a sample stands on is still asked of every sample, since a line
 * can clip a missing tile between two laid ones; only a repeat of the tile
 * just asked about is answered from memory.
 */
const sweepIsClear = (navigation, fromX, fromY, spanX, spanY, samples, radius, ignoredColliders) => {
  const { bounds } = navigation;
  const firstRatio = 1 / samples;
  const firstX = fromX + spanX * firstRatio;
  const firstY = fromY + spanY * firstRatio;
  const lastRatio = samples / samples;
  const lastX = fromX + spanX * lastRatio;
  const lastY = fromY + spanY * lastRatio;
  if (!insideBounds(bounds, firstX, firstY, radius) || !insideBounds(bounds, lastX, lastY, radius)) return false;

  const anyTile = !navigation.tileKeys.size;
  const { tileSize } = navigation;
  let tileColumn = NaN;
  let tileRow = NaN;
  let tileLaid = false;
  const index = navigation.colliderIndex;

  for (let first = 1; first <= samples; first += SWEEP_CHUNK) {
    const last = Math.min(samples, first + SWEEP_CHUNK - 1);
    const startRatio = first / samples;
    const endRatio = last / samples;
    const startX = fromX + spanX * startRatio;
    const startY = fromY + spanY * startRatio;
    const endX = fromX + spanX * endRatio;
    const endY = fromY + spanY * endRatio;
    const count = gatherNear(
      index,
      Math.min(startX, endX) - radius,
      Math.max(startX, endX) + radius,
      Math.min(startY, endY) - radius,
      Math.max(startY, endY) + radius,
      ignoredColliders
    );

    for (let sample = first; sample <= last; sample++) {
      const ratio = sample / samples;
      const x = fromX + spanX * ratio;
      const y = fromY + spanY * ratio;
      if (count < 0) {
        if (blockedAt(navigation, x, y, radius, ignoredColliders)) return false;
        continue;
      }
      if (!anyTile) {
        const column = Math.floor(x / tileSize);
        const row = Math.floor(y / tileSize);
        if (column !== tileColumn || row !== tileRow) {
          tileColumn = column;
          tileRow = row;
          tileLaid = tileAt(navigation, column, row);
        }
        if (!tileLaid) return false;
      }
      if (!clearOfGathered(x, y, radius, count)) return false;
    }
  }
  return true;
};

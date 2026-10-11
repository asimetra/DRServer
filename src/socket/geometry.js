/**
 * One collider's shape, and the questions asked of one shape at a time: the
 * box it covers, whether a body circle overlaps it, how deep, and which way is
 * out. Nothing here knows about a floor, its index or a route; the floor-wide
 * questions are clearance.js's, built on these.
 *
 * A collider is a circle `{type: "circle", x, y, radius}` or a rectangle
 * `{type: "rectangle", x, y, halfWidth, halfHeight, angle}` turned by `angle`
 * about its centre.
 */

export const squaredDistance = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/**
 * An offset turned through an angle, given as its cosine and sine: into a
 * rectangle's own frame with those of minus its angle, back out with those of
 * the angle itself. The one place that rotation is written; two functions
 * rather than one returning a pair, so the point tests allocate nothing.
 */
export const turnedX = (x, y, cosine, sine) => x * cosine - y * sine;
export const turnedY = (x, y, cosine, sine) => x * sine + y * cosine;

/** The axis-aligned box a collider occupies, rotation included. */
export const boundsOf = (collider) => {
  if (collider.type === "circle") {
    const r = collider.radius;
    return { minX: collider.x - r, maxX: collider.x + r, minY: collider.y - r, maxY: collider.y + r };
  }
  const cosine = Math.abs(Math.cos(collider.angle));
  const sine = Math.abs(Math.sin(collider.angle));
  const spanX = collider.halfWidth * cosine + collider.halfHeight * sine;
  const spanY = collider.halfWidth * sine + collider.halfHeight * cosine;
  return {
    minX: collider.x - spanX,
    maxX: collider.x + spanX,
    minY: collider.y - spanY,
    maxY: collider.y + spanY,
  };
};

/**
 * Whether a body circle at (x, y) overlaps a rectangle, whose (cosine, sine)
 * are those of minus its angle: worked out once per collider by the index
 * (collider-index.js), or on the spot by `overlapsAt`. On a bare coordinate
 * pair, so the hot loops build no point object per probe.
 */
export const rectangleOverlapsAt = (x, y, radius, collider, cosine, sine) => {
  const offsetX = x - collider.x;
  const offsetY = y - collider.y;
  const localX = turnedX(offsetX, offsetY, cosine, sine);
  const localY = turnedY(offsetX, offsetY, cosine, sine);
  const closestX = Math.max(-collider.halfWidth, Math.min(collider.halfWidth, localX));
  const closestY = Math.max(-collider.halfHeight, Math.min(collider.halfHeight, localY));
  const dx = localX - closestX;
  const dy = localY - closestY;
  return dx * dx + dy * dy < radius * radius || (radius === 0 && dx === 0 && dy === 0);
};

export const circleOverlapsAt = (x, y, radius, collider) => {
  const dx = x - collider.x;
  const dy = y - collider.y;
  return dx * dx + dy * dy < (radius + collider.radius) ** 2;
};

/**
 * Whether a line of no width from (fromX, fromY) to (toX, toY) meets a
 * collider, the line's first point left out: some point of it is one the
 * point test of no width (radius 0 above) finds inside. Exact, so a board
 * of any thickness stops it.
 *
 * A circle holds the points nearer its centre than its radius; the line
 * meets it when its point nearest the centre does. That point may be the
 * first one, left out — but a circle holds the points around any it holds.
 */
export const segmentMeetsCircle = (fromX, fromY, toX, toY, collider) => {
  const spanX = toX - fromX;
  const spanY = toY - fromY;
  const lengthSquared = spanX * spanX + spanY * spanY;
  const along =
    lengthSquared > 0
      ? Math.max(0, Math.min(1, ((collider.x - fromX) * spanX + (collider.y - fromY) * spanY) / lengthSquared))
      : 1;
  const dx = fromX + spanX * along - collider.x;
  const dy = fromY + spanY * along - collider.y;
  return dx * dx + dy * dy < collider.radius * collider.radius;
};

/**
 * The same of a rectangle, whose (cosine, sine) are those of minus its angle
 * as for `rectangleOverlapsAt`. A rectangle holds its edge, so the line meets
 * it when the stretch of the line inside it — cut down slab by slab, in the
 * rectangle's own frame — is not empty and is more than the first point.
 */
export const segmentMeetsRectangle = (fromX, fromY, toX, toY, collider, cosine, sine) => {
  const startOffsetX = fromX - collider.x;
  const startOffsetY = fromY - collider.y;
  const endOffsetX = toX - collider.x;
  const endOffsetY = toY - collider.y;
  const startX = turnedX(startOffsetX, startOffsetY, cosine, sine);
  const startY = turnedY(startOffsetX, startOffsetY, cosine, sine);
  const spanX = turnedX(endOffsetX, endOffsetY, cosine, sine) - startX;
  const spanY = turnedY(endOffsetX, endOffsetY, cosine, sine) - startY;
  const { halfWidth, halfHeight } = collider;
  let enter = 0;
  let leave = 1;
  // Each side as `rate * along <= room`: -halfWidth <= x, x <= halfWidth, and the same of y.
  for (let side = 0; side < 4; side++) {
    const rate = side === 0 ? -spanX : side === 1 ? spanX : side === 2 ? -spanY : spanY;
    const room = side === 0 ? startX + halfWidth : side === 1 ? halfWidth - startX : side === 2 ? startY + halfHeight : halfHeight - startY;
    if (rate === 0) {
      if (room < 0) return false;
      continue;
    }
    const along = room / rate;
    if (rate < 0) {
      if (along > enter) enter = along;
    } else if (along < leave) {
      leave = along;
    }
    if (enter > leave) return false;
  }
  return leave > 0;
};

/** `segmentMeetsCircle` or `segmentMeetsRectangle`, with the rotation an index entry holds. */
export const segmentMeetsEntry = (fromX, fromY, toX, toY, entry) => {
  const { collider } = entry;
  if (collider.type === "circle") return segmentMeetsCircle(fromX, fromY, toX, toY, collider);
  if (collider.type === "rectangle") {
    return segmentMeetsRectangle(fromX, fromY, toX, toY, collider, entry.cosine, entry.sine);
  }
  return false;
};

/** Whether a body circle at (x, y) overlaps a collider of either shape, its rotation taken here. */
export const overlapsAt = (x, y, radius, collider) => {
  if (collider.type === "circle") return circleOverlapsAt(x, y, radius, collider);
  if (collider.type === "rectangle") {
    return rectangleOverlapsAt(x, y, radius, collider, Math.cos(-collider.angle), Math.sin(-collider.angle));
  }
  return false;
};

/**
 * The same, with the rotation an index entry holds for its collider; the
 * index's point tests and the gathered ones all ask through this.
 */
export const entryOverlapsAt = (x, y, radius, entry) => {
  const { collider } = entry;
  if (collider.type === "circle") return circleOverlapsAt(x, y, radius, collider);
  if (collider.type === "rectangle") return rectangleOverlapsAt(x, y, radius, collider, entry.cosine, entry.sine);
  return false;
};

/** How far an actor circle reaches into one collider; 0 or less when it does not. */
export const depthInto = (point, radius, collider) => {
  if (collider.type === "circle") {
    return radius + collider.radius - Math.sqrt(squaredDistance(point, collider));
  }
  if (collider.type !== "rectangle") return 0;
  const cosine = Math.cos(-collider.angle);
  const sine = Math.sin(-collider.angle);
  const offsetX = point.x - collider.x;
  const offsetY = point.y - collider.y;
  const localX = turnedX(offsetX, offsetY, cosine, sine);
  const localY = turnedY(offsetX, offsetY, cosine, sine);
  const outsideX = Math.abs(localX) - collider.halfWidth;
  const outsideY = Math.abs(localY) - collider.halfHeight;
  if (outsideX <= 0 && outsideY <= 0) return radius - Math.max(outsideX, outsideY);
  return radius - Math.hypot(Math.max(0, outsideX), Math.max(0, outsideY));
};

/** The way out of a collider's surface nearest `point`, as a unit vector; null inside its core. */
export const surfaceNormal = (point, collider) => {
  if (collider.type === "circle") {
    const dx = point.x - collider.x;
    const dy = point.y - collider.y;
    const length = Math.hypot(dx, dy);
    return length < 0.001 ? null : { x: dx / length, y: dy / length };
  }
  const cosine = Math.cos(-collider.angle);
  const sine = Math.sin(-collider.angle);
  const offsetX = point.x - collider.x;
  const offsetY = point.y - collider.y;
  const localX = turnedX(offsetX, offsetY, cosine, sine);
  const localY = turnedY(offsetX, offsetY, cosine, sine);
  const dx = localX - Math.max(-collider.halfWidth, Math.min(collider.halfWidth, localX));
  const dy = localY - Math.max(-collider.halfHeight, Math.min(collider.halfHeight, localY));
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return null;
  const worldCosine = Math.cos(collider.angle);
  const worldSine = Math.sin(collider.angle);
  return {
    x: turnedX(dx, dy, worldCosine, worldSine) / length,
    y: turnedY(dx, dy, worldCosine, worldSine) / length,
  };
};

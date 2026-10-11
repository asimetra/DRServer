import { hasLineOfSight, isPositionBlocked } from "./clearance.js";
import { overlapsAt, squaredDistance, turnedX, turnedY } from "./geometry.js";
import { activeCollidersOf } from "./navigation-objects.js";

/** The way out of a triggerable cage, for what a generator spawns inside one. */

/** The floor's wired objects, as the cages a prisoner may be standing in (navigation.js). */
const wiredObjects = (navigation) => [...navigation.objects.values()].filter((record) => record.wired);

const activeTriggerCollidersAt = (navigation, point, radius) => {
  const colliders = [];
  for (const record of wiredObjects(navigation)) {
    for (const collider of activeCollidersOf(record)) {
      if (overlapsAt(point.x, point.y, radius, collider)) colliders.push(collider);
    }
  }
  return colliders;
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

/** The active colliders of every wired object one of `colliders` belongs to: the whole cage. */
const cagesHolding = (navigation, colliders) => {
  const cage = new Set();
  for (const record of wiredObjects(navigation)) {
    const active = activeCollidersOf(record);
    if (active.some((collider) => colliders.includes(collider))) {
      for (const collider of active) cage.add(collider);
    }
  }
  return cage;
};

/** How far a release looks along one direction for ground outside the cage. */
const RELEASE_REACH = 600;
const RELEASE_STEP = 8;

/** Standable points just beyond each face of one cage piece. */
const rectangleReleaseCandidates = (origin, radius, collider) => {
  const cosine = Math.cos(-collider.angle);
  const sine = Math.sin(-collider.angle);
  const offsetX = origin.x - collider.x;
  const offsetY = origin.y - collider.y;
  const localX = turnedX(offsetX, offsetY, cosine, sine);
  const localY = turnedY(offsetX, offsetY, cosine, sine);
  const gap = radius + RELEASE_STEP;
  const candidates = [
    { x: collider.halfWidth + gap, y: clamp(localY, -collider.halfHeight, collider.halfHeight) },
    { x: -collider.halfWidth - gap, y: clamp(localY, -collider.halfHeight, collider.halfHeight) },
    { x: clamp(localX, -collider.halfWidth, collider.halfWidth), y: collider.halfHeight + gap },
    { x: clamp(localX, -collider.halfWidth, collider.halfWidth), y: -collider.halfHeight - gap },
  ];
  const worldCosine = Math.cos(collider.angle);
  const worldSine = Math.sin(collider.angle);
  // Not `collider.x + turnedX(...)`: the sum is taken left to right, and
  // grouping the turn first would move a candidate by a rounding.
  return candidates.map((candidate) => ({
    x: collider.x + candidate.x * worldCosine - candidate.y * worldSine,
    y: collider.y + candidate.x * worldSine + candidate.y * worldCosine,
  }));
};

const circleReleaseCandidates = (origin, radius, collider, target) => {
  const sourceAngle = Math.atan2(origin.y - collider.y, origin.x - collider.x);
  const targetAngle = target
    ? Math.atan2(target.y - collider.y, target.x - collider.x)
    : sourceAngle;
  const baseAngle =
    Number.isFinite(sourceAngle) &&
    Math.hypot(origin.x - collider.x, origin.y - collider.y) > 0.001
      ? sourceAngle
      : targetAngle;
  const distance = collider.radius + radius + RELEASE_STEP;
  return Array.from({ length: 8 }, (_, index) => {
    const angle = baseAngle + (index * Math.PI) / 4;
    return {
      x: collider.x + Math.cos(angle) * distance,
      y: collider.y + Math.sin(angle) * distance,
    };
  });
};

/**
 * Finds the mouth of the triggerable enclosure that contains a generator.
 *
 * The mouth is the cage's front: every monster the official lets out of one
 * leaves that way — 242 of 242 from the Knight Fortress jails, 6 of 6 from a
 * mirrored Aztec one whose generator sits to one side. The front is the facing
 * of the cage object, not of any piece of it: an Aztec jail is three slanted
 * boxes, and taking each box's own "front" led nowhere. Nothing in the data
 * marks a door, and taking whichever face was nearest the player walked a wave
 * out through the side of the bridge-tile jail into the gap by the water, where
 * it jammed.
 *
 * So the release walks straight out along the facing to the first ground a
 * body fits on, through the whole cage — every piece of its trigger group,
 * which is all the walk ignores. A front shut by something else falls back to
 * the sides, the one nearer the player first, and last to the back.
 */
export const findCageReleasePath = (navigation, origin, radius = 0, target = null) => {
  if (!navigation || !origin) return null;
  const enclosedBy = activeTriggerCollidersAt(navigation, origin, radius);
  if (!enclosedBy.length) return null;
  const ignoredColliders = cagesHolding(navigation, enclosedBy);

  const facing = Number(enclosedBy[0].facing ?? 0);
  const front = { x: -Math.sin(facing), y: Math.cos(facing) };
  const sides = [
    { x: front.y, y: -front.x },
    { x: -front.y, y: front.x },
  ];
  if (target) {
    const toward = (direction) => (target.x - origin.x) * direction.x + (target.y - origin.y) * direction.y;
    sides.sort((left, right) => toward(right) - toward(left));
  }
  const back = { x: -front.x, y: -front.y };

  for (const direction of [front, ...sides, back]) {
    for (let distance = RELEASE_STEP; distance <= RELEASE_REACH; distance += RELEASE_STEP) {
      const point = { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance };
      // Something that is not the cage stands in the way: not this direction.
      if (isPositionBlocked(navigation, point, radius, { ignoredColliders })) break;
      if (isPositionBlocked(navigation, point, radius)) continue;
      // Out of the cage, with a step's room, as the doorway is not the wall.
      const beyond = { x: point.x + direction.x * RELEASE_STEP, y: point.y + direction.y * RELEASE_STEP };
      const release = isPositionBlocked(navigation, beyond, radius) ? point : beyond;
      if (hasLineOfSight(navigation, origin, release, radius, { ignoredColliders })) {
        return { target: release, ignoredColliders };
      }
      break;
    }
  }

  /**
   * Some Aztec cages put an offset generator behind slanted pieces, so none of
   * the four object axes passes through the narrow mouth. Keep the authored
   * front as first refusal above, then fall back to the enclosing pieces' faces.
   * A candidate must be outside the complete cage, and its walk may ignore only
   * that cage; unrelated floor geometry still rejects it.
   */
  const candidates = enclosedBy.flatMap((collider) =>
    collider.type === "circle"
      ? circleReleaseCandidates(origin, radius, collider, target)
      : rectangleReleaseCandidates(origin, radius, collider)
  );
  const reference = target ?? origin;
  candidates.sort(
    (left, right) => squaredDistance(left, reference) - squaredDistance(right, reference)
  );
  for (const candidate of candidates) {
    if (isPositionBlocked(navigation, candidate, radius)) continue;
    if (hasLineOfSight(navigation, origin, candidate, radius, { ignoredColliders })) {
      return { target: candidate, ignoredColliders };
    }
  }
  return null;
};

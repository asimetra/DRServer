/**
 * Whether a pair of numbers is a place.
 *
 * Shared rather than local to the position handler, because the same claim
 * arrives on more than one field and the same answer applies to all of them: a
 * coordinate that is not a number is not somewhere, whatever it is attached to.
 *
 * This is about the shape of the message and not about our reading of the game,
 * which is why it is refused outright rather than counted. No amount of lag
 * turns a position into NaN. Across 54 recordings the official client sent
 * 34850 coordinates, none non-finite, none past a million, all inside 0..8946 —
 * which is ten tiles of nine hundred, so the limit below is generous by a
 * hundredfold.
 *
 * Left unchecked it poisons whatever reads it. The hero's position feeds
 * pickups, proximity triggers, the floor exit, monster targeting and the reach
 * audit; a placeable's feeds a spawn that then sits somewhere no navigation
 * query can answer about.
 */
const COORDINATE_LIMIT = 1e6;

export const isPlausiblePosition = (at) =>
  Number.isFinite(at?.x) &&
  Number.isFinite(at?.y) &&
  Math.abs(at.x) <= COORDINATE_LIMIT &&
  Math.abs(at.y) <= COORDINATE_LIMIT;

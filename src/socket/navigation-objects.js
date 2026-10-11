/**
 * The colliders an object has in the floor at each stage of its life (see
 * "Every object's colliders", navigation.js): standing `on`, switched `off`
 * by its wiring, `broken` and kept as its off shapes, or `gone`.
 */
const SHAPES_OF = { on: "on", off: "off", broken: "off", gone: null };

/** The colliders an object's record has in the floor now. */
export const activeCollidersOf = (record) => {
  const shapes = SHAPES_OF[record.state];
  return shapes ? record[shapes] : [];
};

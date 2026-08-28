/**
 * Which way an actor is facing, and where that puts something in front of it.
 *
 * Heading crosses the wire in **degrees**. The client settles it:
 * ActorGameObject.getHeadingAsVector is
 *
 *   (heading + offset) * 3.141592653589793 / 180
 *
 * and every authored heading agrees — an arrow trap faces 90 or 270, not 1.57
 * or 4.71. The value arrives here straight off field FLID_HERO_HEADING with no
 * conversion, so anything taking a cosine of it must convert first.
 *
 * Timeline spawn actions add their own `headingOffsetAngle`, also in degrees,
 * before the conversion — which is exactly the shape of the formula above.
 */
export const headingRadians = (heading, offsetDegrees = 0) =>
  ((Number.isFinite(heading) ? heading : 0) + Number(offsetDegrees ?? 0)) * (Math.PI / 180);

/** A point `reach` units in front of `origin`, along `heading` plus an offset. */
export const inFrontOf = (origin, heading, reach, offsetDegrees = 0) => {
  const angle = headingRadians(heading, offsetDegrees);
  return {
    x: origin.x + Math.cos(angle) * reach,
    y: origin.y + Math.sin(angle) * reach,
  };
};

/**
 * Where an attack timeline's authored colliders land, in world space.
 *
 * `xOffset` runs along the facing and `yOffset` across it, which is what makes
 * a fissure a crack racing outward rather than a ring around its owner, and a
 * mace's arc sweep past the wall it hangs from.
 *
 * Every rectangle in the game authors `halfWidth`/`halfHeight` — 148 of them,
 * and not one carries `width`/`height`. Reading the latter gave all 57 attacks
 * with a rectangular timeline a zero-sized shape, and a shape of no size
 * touches nothing.
 */
export const worldColliders = (origin, heading, colliders = []) => {
  const angle = headingRadians(heading);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);

  return colliders.map((collider) => {
    const along = Number(collider.xOffset ?? 0);
    const across = Number(collider.yOffset ?? 0);
    const centre = {
      x: origin.x + along * cosine - across * sine,
      y: origin.y + along * sine + across * cosine,
    };

    // The frame is carried through: for a trap it is *when* in the swing this
    // shape is dangerous, and dropping it flattened a moving hazard into one
    // zone that hurt for as long as it was up.
    const frame = Number(collider.frame ?? 0);

    if (String(collider.type).toLowerCase() === "circlecollider") {
      return { type: "circle", ...centre, frame, radius: Math.abs(Number(collider.radius ?? 0)) };
    }
    return {
      type: "rectangle",
      ...centre,
      frame,
      halfWidth: Math.abs(Number(collider.halfWidth ?? 0)),
      halfHeight: Math.abs(Number(collider.halfHeight ?? 0)),
      angle: angle + headingRadians(collider.rotation ?? 0),
    };
  });
};

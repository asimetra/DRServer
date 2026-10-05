/**
 * The ring a ranked lobby draws around its queue (settings.ring): standing
 * inside it is being queued (adapter.js, inRingNow), so the player has to be
 * able to see where it is.
 *
 * Its edge is the arena's own skull piles. A pile is an Npc row, which the
 * server can put anywhere; the arena's flat decor (its skulls, cobbles and
 * cracks) is drawn by the client from its own tile file and cannot be placed
 * one piece at a time. The lobby floor is harmless, so nothing breaks them
 * (combat.js, applyDamage).
 *
 * A pile stops a hero — its box in library_server.json is 102×68 and a hero is
 * about 44 across — so the sides are laid close enough that nobody slips
 * between two, and the way in is one pile left out at the middle of the top
 * and of the bottom edge.
 */

export const RING_PILE = "CASTLE_ARENA_SMASH_SKULL";

/** The pile's blocking box, and the most daylight left between two. */
const PILE = { width: 102, height: 68 };
const MOST_DAYLIGHT = 8;

/** Points from `from` to `to`, both ends included, no further apart than `most`, an odd count. */
const evenly = (from, to, most) => {
  let count = Math.ceil((to - from) / most) + 1;
  if (count % 2 === 0) count += 1;
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
};

/**
 * Where the piles go, corners first along the top and bottom edges, then the
 * sides between them. The middle pile of the top and bottom rows is the gap.
 */
export const ringPiles = (ring) => {
  if (!ring) return [];
  const { x0, y0, x1, y1 } = ring;
  const across = evenly(x0, x1, PILE.width + MOST_DAYLIGHT);
  const middle = (across.length - 1) / 2;
  const rows = [y0, y1].flatMap((y) => across.filter((_, i) => i !== middle).map((x) => ({ x, y })));
  const down = evenly(y0, y1, PILE.height + MOST_DAYLIGHT).slice(1, -1);
  const sides = [x0, x1].flatMap((x) => down.map((y) => ({ x, y })));
  return [...rows, ...sides].map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }));
};

/** The ring's piles as the lobby floor places them (floors.js, quietFloor). */
export const ringMarkers = (ring, constant = RING_PILE) =>
  ringPiles(ring).map((at, index) => ({ id: `ranked-ring-${index}`, constant, ...at }));

/**
 * A place inside the ring to put a hero down: just through its bottom way in,
 * clear of the piles and of the pillar (ranked-lobby.test.js walks to it).
 */
export const ringSpot = (ring) => (ring ? { x: Math.round((ring.x0 + ring.x1) / 2), y: ring.y1 - 60 } : null);

export const insideRing = (ring, at) =>
  Boolean(ring && at) && at.x >= ring.x0 && at.x <= ring.x1 && at.y >= ring.y0 && at.y <= ring.y1;

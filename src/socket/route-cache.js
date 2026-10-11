import { boundsOf } from "./geometry.js";

/**
 * What the route search keeps between searches, per actor radius: which cells
 * a body fits in and where (the cell's anchor), and which steps between
 * neighbouring anchors can be walked. And when it forgets: navigation.js
 * reports every collider that came or went (`invalidatePathfinding`), and the
 * next search at a radius forgets the answers within reach of them.
 *
 * Apart from the search so the dependency runs one way: the navigation state
 * tells the cache what changed, and neither needs the search. How far an
 * answer reaches is decided by the anchors, so they are here too.
 */

/**
 * Records a change of colliders, and which route answers it could alter.
 *
 * `revision` moves on every change exactly as before; it is what tells an NPC
 * its route may be stale. The per-radius route caches, though, used to be
 * dropped whole each time, and a floor whose spike traps cycle every couple of
 * seconds dropped them about sixteen times a second — every search after that
 * worked out from scratch hundreds of cells and links nowhere near the trap.
 *
 * Each cached answer can only depend on colliders within a known reach of its
 * cell (see `forgetAround`), so only the answers within that reach of a
 * collider that came or went are forgotten. The rest are what a fresh search
 * would work out again, to the bit: the point test (`blockedAt`, and
 * `clearOfGathered` on a sight line's or a cell's gathered entries) puts only
 * colliders whose box reaches the probe to the overlap test, and is a plain
 * any-overlap, so neither a far collider, nor how many more a gathering
 * picked up, nor the order of the index can change it.
 *
 * The forgetting itself waits for the next search at that radius, which is
 * the only reader: a trap that goes up and down four times between two
 * searches is forgotten around once, and a radius nobody searches at costs a
 * set insertion. `changed` is every collider that may have been added or
 * removed — the old set and the new one together; one in both is forgotten
 * around for nothing.
 */
export const invalidatePathfinding = (navigation, changed) => {
  navigation.revision++;
  const caches = navigation.pathfinding.byRadius;
  if (!caches.size) return;
  for (const [radiusKey, cache] of caches) {
    if (!cache.local) {
      caches.delete(radiusKey);
      continue;
    }
    for (const collider of changed) cache.pending.add(collider);
    // A floor rebuilding wholesale: starting over is cheaper than forgetting piecemeal.
    if (cache.pending.size > MAX_PENDING_COLLIDERS) caches.delete(radiusKey);
  }
};

/**
 * How far an anchor keeps clear of what it stands beside. At exactly a body's
 * width the walk to it rounds a hair into the wall and every step is refused.
 */
export const ANCHOR_MARGIN = 2;

/**
 * Where in a cell a body may stand, nearest its centre first, in fractions of
 * the cell: a 5 by 5 lattice, 12 units apart on the usual 60-unit cell.
 */
const ANCHOR_OFFSETS = (() => {
  const steps = [-0.4, -0.2, 0, 0.2, 0.4];
  return steps
    .flatMap((dx) => steps.map((dy) => [dx, dy]))
    .sort(([ax, ay], [bx, by]) => ax * ax + ay * ay - (bx * bx + by * by));
})();
export const ANCHOR_X = ANCHOR_OFFSETS.map(([dx]) => dx);
export const ANCHOR_Y = ANCHOR_OFFSETS.map(([, dy]) => dy);

/** How far from its centre, in cells, an anchor can sit. */
const ANCHOR_REACH = Math.max(...ANCHOR_OFFSETS.flat().map(Math.abs));

/** Radii kept at once; a floor has a few monster sizes, so this is never reached in play. */
const MAX_CACHED_RADII = 32;

/** Changed colliders a radius may owe before its answers are dropped whole instead. */
const MAX_PENDING_COLLIDERS = 512;

/**
 * The route answers for one actor radius: per cell, 0 not yet asked, 1 shut, 2
 * open at its centre, 3 open off-centre with its anchor in `anchors`; per cell
 * and direction, whether the step to that neighbour can be walked, with its
 * corner in `vias` when it needs one. Typed arrays because the search asks
 * about every neighbour of every cell it opens, and because forgetting a
 * region is then a few row fills. An entry left in `anchors` or `vias` after
 * its cell or link is forgotten is never read: both are only consulted for a
 * state of 3, which is written together with a fresh entry.
 *
 * `local` is false for a radius that is not an ordinary number. How far its
 * answers reach cannot be bounded, so any collider change drops them whole, as
 * every change used to.
 */
export const routeCacheFor = (navigation, radius, columns, rows) => {
  const caches = navigation.pathfinding.byRadius;
  const radiusKey = String(radius);
  let cache = caches.get(radiusKey);
  if (
    !cache ||
    cache.columns !== columns ||
    cache.rows !== rows ||
    cache.minX !== navigation.bounds.minX ||
    cache.minY !== navigation.bounds.minY ||
    cache.cellSize !== navigation.cellSize
  ) {
    if (cache) caches.delete(radiusKey);
    else if (caches.size >= MAX_CACHED_RADII) caches.delete(caches.keys().next().value);
    cache = {
      radius,
      local: true,
      columns,
      rows,
      minX: navigation.bounds.minX,
      minY: navigation.bounds.minY,
      cellSize: navigation.cellSize,
      state: new Uint8Array(columns * rows),
      anchors: new Map(),
      links: new Uint16Array(columns * rows),
      vias: new Map(),
      // Colliders changed since this radius last searched; see invalidatePathfinding.
      pending: new Set(),
    };
    caches.set(radiusKey, cache);
  }
  // String(radius) is the key, so "26" and 26 would share one; either taints it.
  if (typeof radius !== "number" || !Number.isFinite(radius)) cache.local = false;
  if (cache.pending.size) {
    for (const collider of cache.pending) forgetAround(navigation, cache, boundsOf(collider));
    cache.pending.clear();
  }
  return cache;
};

/**
 * Forgets the cached cells and links of one radius that a collider with this
 * box could change.
 *
 * A cell's answer probes points at most ANCHOR_REACH cells from its centre with
 * a circle of radius + ANCHOR_MARGIN, and the point test lets only colliders
 * whose box reaches the probe circle's square decide (a gathering may collect
 * more, but each probe applies the same box test before the overlap test). So
 * a collider whose box stays beyond centre ± (ANCHOR_REACH·cell + radius +
 * ANCHOR_MARGIN) cannot change that cell. A link walks between the two cells' anchors, through a
 * corner of the box they span, with a circle of `radius`, and rests on both
 * cells' answers; every point it tests is within one cell of its own cell's
 * reach. One more cell is taken on every side of both, which more than covers
 * the rounding of a point interpolated between two anchors.
 */
const forgetAround = (navigation, cache, box) => {
  const { columns, rows, cellSize, minX, minY } = cache;
  if (
    !Number.isFinite(box.minX) ||
    !Number.isFinite(box.maxX) ||
    !Number.isFinite(box.minY) ||
    !Number.isFinite(box.maxY)
  ) {
    // Never seen in authored data; whatever it is, forget everything.
    cache.state.fill(0);
    cache.links.fill(0);
    return;
  }
  const reach = ANCHOR_REACH * cellSize + Math.abs(cache.radius) + ANCHOR_MARGIN;
  // A cell's centre is min + (index + 0.5)·cellSize.
  const first = (low, origin) => Math.max(0, Math.floor((low - origin) / cellSize - 0.5) - 1);
  const last = (high, origin, count) =>
    Math.min(count - 1, Math.ceil((high - origin) / cellSize - 0.5) + 1);
  const forget = (array, margin) => {
    const fromX = first(box.minX - margin, minX);
    const toX = last(box.maxX + margin, minX, columns);
    if (fromX > toX) return;
    const toY = last(box.maxY + margin, minY, rows);
    for (let y = first(box.minY - margin, minY); y <= toY; y++) {
      array.fill(0, y * columns + fromX, y * columns + toX + 1);
    }
  };
  forget(cache.state, reach);
  forget(cache.links, reach + cellSize);
};

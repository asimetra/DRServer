import { boundsOf, entryOverlapsAt, overlapsAt } from "./geometry.js";

/**
 * The active colliders of one navigation, laid out so a query near a point
 * meets only the few that can reach it: 300-unit buckets, whose order decides
 * which collider `collidersNear` names first, and a 150-unit grid for the
 * point test, which has no order. Built whole with the colliders and kept in
 * step as trigger groups and obstacles swap theirs (navigation.js).
 *
 * Also the gathering a sight line or a cell's probes do: the entries near a
 * whole stretch collected once, stamped so none is collected twice, and the
 * point test run against that collection (`gatherNear`, `clearOfGathered`).
 */

/**
 * How wide a bucket in the collider index is.
 *
 * Colliders on a catacombs floor run 30 to 580 units across, so 300 keeps the
 * largest of them inside a handful of buckets while leaving the common small
 * ones in one. Smaller buckets index faster but cost more memory and more
 * bucket visits per query; this is the middle of that.
 */
const INDEX_CELL = 300;

/**
 * The most buckets the index lays out as a flat array. A floor is 30 by 30
 * buckets at most; anything past this lives in the keyed overflow alone.
 */
const INDEX_GRID_LIMIT = 1 << 16;

/**
 * The flat part of the collider index: one slot per bucket inside the floor's
 * bounds, which is every bucket a standing query can reach, since a circle
 * that leaves the bounds is refused before the index is asked.
 *
 * Only where a bucket is kept changes. Each bucket holds the same entries in
 * the same order as it did under its `"x,y"` key, and a bucket outside the
 * range still lives under that key in `cells` — so the walk over buckets, and
 * everything that depends on its order, is the one it was.
 */
const indexGridFor = (bounds) => {
  const minX = Math.floor(bounds?.minX / INDEX_CELL);
  const minY = Math.floor(bounds?.minY / INDEX_CELL);
  const columns = Math.floor(bounds?.maxX / INDEX_CELL) - minX + 1;
  const rows = Math.floor(bounds?.maxY / INDEX_CELL) - minY + 1;
  if (!(columns > 0 && rows > 0 && columns * rows <= INDEX_GRID_LIMIT)) {
    return { minX: 0, minY: 0, columns: 0, rows: 0, buckets: [] };
  }
  return { minX, minY, columns, rows, buckets: new Array(columns * rows).fill(null) };
};

/** The bucket at index cell (x, y), or a falsy value when there is none. */
const bucketAt = (index, x, y) => {
  const { grid } = index;
  const column = x - grid.minX;
  const row = y - grid.minY;
  if (column >= 0 && column < grid.columns && row >= 0 && row < grid.rows) {
    return grid.buckets[column * grid.rows + row];
  }
  return index.cells.get(`${x},${y}`);
};

const addToBucket = (index, x, y, entry) => {
  const { grid } = index;
  const column = x - grid.minX;
  const row = y - grid.minY;
  if (column >= 0 && column < grid.columns && row >= 0 && row < grid.rows) {
    const slot = column * grid.rows + row;
    const bucket = grid.buckets[slot];
    if (bucket) bucket.push(entry);
    else grid.buckets[slot] = [entry];
    return;
  }
  const key = `${x},${y}`;
  const bucket = index.cells.get(key);
  if (bucket) bucket.push(entry);
  else index.cells.set(key, [entry]);
};

const removeFromBucket = (index, x, y, entry) => {
  const { grid } = index;
  const column = x - grid.minX;
  const row = y - grid.minY;
  if (column >= 0 && column < grid.columns && row >= 0 && row < grid.rows) {
    const slot = column * grid.rows + row;
    const bucket = grid.buckets[slot];
    if (!bucket) return;
    const at = bucket.indexOf(entry);
    if (at >= 0) bucket.splice(at, 1);
    if (!bucket.length) grid.buckets[slot] = null;
    return;
  }
  const key = `${x},${y}`;
  const bucket = index.cells.get(key);
  if (!bucket) return;
  const at = bucket.indexOf(entry);
  if (at >= 0) bucket.splice(at, 1);
  if (!bucket.length) index.cells.delete(key);
};

/**
 * How wide a cell of the point-test grid is.
 *
 * The 300-unit buckets above decide the order `collidersNear` hands colliders
 * back in, and that order decides which wall a slide turns along, so they stay
 * as they are. Whether a point is blocked has no order: any collider that
 * overlaps it answers the same. So the point test walks a finer grid of its
 * own, where a body's square meets fewer colliders than the seven or so a
 * 300-unit bucket holds. 75, 100 and 150 time the same on real floors; 150
 * costs half the memory of 100, about 60 KiB a floor.
 */
const FINE_CELL = 150;

/** The most cells the point-test grid lays out; past it the test uses the buckets. */
const FINE_GRID_LIMIT = 1 << 18;

/**
 * The point-test grid over the floor's bounds, empty to start.
 *
 * An entry is listed in every cell its box covers, clipped to the grid. A
 * query whose square lies inside the grid then meets every entry whose box it
 * reaches — the cells they share are inside the grid — which are exactly the
 * entries the buckets would have handed it after their box test. A query that
 * leaves the grid, or a box that is not a box (a minimum past its maximum,
 * which the buckets list by rounding alone), sends the test back to the
 * buckets, so the grid never has to be right about either.
 */
const fineGridFor = (bounds) => {
  const minX = Math.floor(bounds?.minX / FINE_CELL);
  const minY = Math.floor(bounds?.minY / FINE_CELL);
  const columns = Math.floor(bounds?.maxX / FINE_CELL) - minX + 1;
  const rows = Math.floor(bounds?.maxY / FINE_CELL) - minY + 1;
  if (!(columns > 0 && rows > 0 && columns * rows <= FINE_GRID_LIMIT)) {
    return { minX: 0, minY: 0, maxX: -1, maxY: -1, rows: 0, cells: [], unordered: 0 };
  }
  return {
    minX,
    minY,
    maxX: minX + columns - 1,
    maxY: minY + rows - 1,
    rows,
    cells: new Array(columns * rows).fill(null),
    unordered: 0,
  };
};

const isOrderedBox = (entry) => entry.minX <= entry.maxX && entry.minY <= entry.maxY;

const addToFineGrid = (fine, entry) => {
  if (!isOrderedBox(entry)) fine.unordered++;
  const fromX = Math.max(fine.minX, Math.floor(entry.minX / FINE_CELL));
  const toX = Math.min(fine.maxX, Math.floor(entry.maxX / FINE_CELL));
  const fromY = Math.max(fine.minY, Math.floor(entry.minY / FINE_CELL));
  const toY = Math.min(fine.maxY, Math.floor(entry.maxY / FINE_CELL));
  for (let x = fromX; x <= toX; x++) {
    for (let y = fromY; y <= toY; y++) {
      const slot = (x - fine.minX) * fine.rows + (y - fine.minY);
      const cell = fine.cells[slot];
      if (cell) cell.push(entry);
      else fine.cells[slot] = [entry];
    }
  }
};

const removeFromFineGrid = (fine, entry) => {
  if (!isOrderedBox(entry)) fine.unordered--;
  const fromX = Math.max(fine.minX, Math.floor(entry.minX / FINE_CELL));
  const toX = Math.min(fine.maxX, Math.floor(entry.maxX / FINE_CELL));
  const fromY = Math.max(fine.minY, Math.floor(entry.minY / FINE_CELL));
  const toY = Math.min(fine.maxY, Math.floor(entry.maxY / FINE_CELL));
  for (let x = fromX; x <= toX; x++) {
    for (let y = fromY; y <= toY; y++) {
      const slot = (x - fine.minX) * fine.rows + (y - fine.minY);
      const cell = fine.cells[slot];
      if (!cell) continue;
      const at = cell.indexOf(entry);
      if (at >= 0) cell.splice(at, 1);
      if (!cell.length) fine.cells[slot] = null;
    }
  }
};

/**
 * An index entry: the collider, its box laid flat on the entry, and its
 * rotation. The entry is its own box wherever one is read.
 */
const indexEntry = (collider, box, cosine, sine) => ({
  collider,
  minX: box.minX,
  maxX: box.maxX,
  minY: box.minY,
  maxY: box.maxY,
  cosine,
  sine,
  // Which sight line last gathered this entry; see `sweepIsClear`.
  gathered: 0,
});

/**
 * A uniform grid over the active colliders, rebuilt with them.
 *
 * `isPositionBlocked` tested every collider on the floor against a circle of
 * radius 26 — 762 of them on a catacombs floor spread over five thousand by
 * eight thousand units, where at most a handful can be within reach of any one
 * point. It was the single most expensive function on the server: 695ms of the
 * 1493ms of real work in a six-session profile.
 *
 * The rotation terms are precomputed here for the same reason. `angle` cannot
 * change without the colliders being rebuilt, so taking its cosine and sine on
 * every test of every rectangle was work with a constant answer.
 */
export const buildColliderIndex = (navigation) => {
  const index = {
    forColliders: navigation.colliders,
    cells: new Map(),
    entriesByCollider: new Map(),
    grid: indexGridFor(navigation.bounds),
    fine: fineGridFor(navigation.bounds),
    sweepStamp: 0,
  };
  const prepared = navigation.colliders.map((collider) =>
    indexEntry(
      collider,
      boundsOf(collider),
      // Negated once, because rectangleOverlapsAt rotates the point *into* the
      // collider's frame rather than the other way about.
      collider.type === "rectangle" ? Math.cos(-collider.angle) : 0,
      collider.type === "rectangle" ? Math.sin(-collider.angle) : 0
    )
  );

  for (const entry of prepared) {
    index.entriesByCollider.set(entry.collider, entry);
    const fromX = Math.floor(entry.minX / INDEX_CELL);
    const toX = Math.floor(entry.maxX / INDEX_CELL);
    const fromY = Math.floor(entry.minY / INDEX_CELL);
    const toY = Math.floor(entry.maxY / INDEX_CELL);
    for (let x = fromX; x <= toX; x++) {
      for (let y = fromY; y <= toY; y++) addToBucket(index, x, y, entry);
    }
    addToFineGrid(index.fine, entry);
  }
  // Grown one push at a time, most cells hold ten times the room they use; a
  // copy holds its entries, in their order, and no more.
  const { cells: fineCells } = index.fine;
  for (let slot = 0; slot < fineCells.length; slot++) {
    if (fineCells[slot]) fineCells[slot] = fineCells[slot].slice();
  }
  /**
   * Tied to the exact array it was built from.
   *
   * Callers narrow the collider set by spreading the navigation object and
   * replacing `colliders` — `{ ...navigation, colliders: staticColliders }` is
   * how the wall audit asks what the static geometry alone would say. That
   * spread copies the index too, so an index that only knew its own contents
   * would answer for colliders the caller had just excluded, silently. It did:
   * the audit moved a hit from trigger geometry to static.
   *
   * Holding the source array makes the check an identity comparison, and a
   * narrowed copy falls back to the linear scan by itself.
   */
  navigation.colliderIndex = index;
};

const addColliderToIndex = (navigation, collider) => {
  if (!collider || navigation.colliderIndex?.entriesByCollider.has(collider)) return false;
  const entry = indexEntry(
    collider,
    boundsOf(collider),
    collider.type === "rectangle" ? Math.cos(-(collider.angle ?? 0)) : 0,
    collider.type === "rectangle" ? Math.sin(-(collider.angle ?? 0)) : 0
  );
  for (let x = Math.floor(entry.minX / INDEX_CELL); x <= Math.floor(entry.maxX / INDEX_CELL); x++) {
    for (let y = Math.floor(entry.minY / INDEX_CELL); y <= Math.floor(entry.maxY / INDEX_CELL); y++) {
      addToBucket(navigation.colliderIndex, x, y, entry);
    }
  }
  addToFineGrid(navigation.colliderIndex.fine, entry);
  navigation.colliderIndex.entriesByCollider.set(collider, entry);
  navigation.colliders.push(collider);
  return true;
};

const removeColliderFromIndex = (navigation, collider) => {
  const index = navigation.colliderIndex;
  const entry = index?.entriesByCollider.get(collider);
  if (!entry) return false;
  for (let x = Math.floor(entry.minX / INDEX_CELL); x <= Math.floor(entry.maxX / INDEX_CELL); x++) {
    for (let y = Math.floor(entry.minY / INDEX_CELL); y <= Math.floor(entry.maxY / INDEX_CELL); y++) {
      removeFromBucket(index, x, y, entry);
    }
  }
  removeFromFineGrid(index.fine, entry);
  index.entriesByCollider.delete(collider);
  const at = navigation.colliders.indexOf(collider);
  if (at >= 0) navigation.colliders.splice(at, 1);
  return true;
};

export const replaceIndexedColliders = (navigation, remove, add) => {
  for (const collider of remove ?? []) removeColliderFromIndex(navigation, collider);
  for (const collider of add ?? []) addColliderToIndex(navigation, collider);
};

/** The colliders whose boxes an actor circle at `point` could reach, through the index when there is one. */
export const collidersNear = (navigation, point, radius, { ignoredColliders } = {}) => {
  const reaches = (box) =>
    !(
      point.x + radius < box.minX ||
      point.x - radius > box.maxX ||
      point.y + radius < box.minY ||
      point.y - radius > box.maxY
    );
  const cached = navigation.colliderIndex;
  const index = cached?.forColliders === navigation.colliders ? cached.cells : null;
  if (!index) {
    return navigation.colliders.filter(
      (collider) => !ignoredColliders?.has(collider) && reaches(boundsOf(collider))
    );
  }
  const found = new Set();
  for (let x = Math.floor((point.x - radius) / INDEX_CELL); x <= Math.floor((point.x + radius) / INDEX_CELL); x++) {
    for (let y = Math.floor((point.y - radius) / INDEX_CELL); y <= Math.floor((point.y + radius) / INDEX_CELL); y++) {
      for (const entry of bucketAt(cached, x, y) || []) {
        if (!ignoredColliders?.has(entry.collider) && reaches(entry)) found.add(entry.collider);
      }
    }
  }
  return [...found];
};

/**
 * Whether a body circle at (x, y) overlaps any active collider. The floor's
 * bounds and tiles are the caller's to ask first (`blockedAt`, clearance.js).
 *
 * Only the colliders whose bucket the query circle touches.
 *
 * A point and a radius of 26 cannot reach anything more than 26 units away,
 * so the buckets covering that square are the whole candidate set. Falls back
 * to the flat list when there is no index, which keeps a hand-built
 * navigation object in a test working without one.
 */
export const anyColliderAt = (navigation, x, y, radius, ignoredColliders) => {
  const cached = navigation.colliderIndex;
  if (cached?.forColliders !== navigation.colliders || !cached.cells) {
    for (const collider of navigation.colliders) {
      if (ignoredColliders?.has(collider)) continue;
      if (overlapsAt(x, y, radius, collider)) return true;
    }
    return false;
  }

  const left = x - radius;
  const right = x + radius;
  const top = y - radius;
  const bottom = y + radius;

  const { fine } = cached;
  if (typeof x === "number" && typeof y === "number" && typeof radius === "number" && radius >= 0 && !fine.unordered) {
    const fineFromX = Math.floor(left / FINE_CELL);
    const fineToX = Math.floor(right / FINE_CELL);
    const fineFromY = Math.floor(top / FINE_CELL);
    const fineToY = Math.floor(bottom / FINE_CELL);
    if (fineFromX >= fine.minX && fineToX <= fine.maxX && fineFromY >= fine.minY && fineToY <= fine.maxY) {
      for (let cellX = fineFromX; cellX <= fineToX; cellX++) {
        for (let cellY = fineFromY; cellY <= fineToY; cellY++) {
          const cell = fine.cells[(cellX - fine.minX) * fine.rows + (cellY - fine.minY)];
          if (!cell) continue;
          for (let at = 0; at < cell.length; at++) {
            const entry = cell[at];
            const { collider } = entry;
            if (ignoredColliders?.has(collider)) continue;
            if (right < entry.minX || left > entry.maxX || bottom < entry.minY || top > entry.maxY) {
              continue;
            }
            if (entryOverlapsAt(x, y, radius, entry)) return true;
          }
        }
      }
      return false;
    }
  }

  const fromX = Math.floor(left / INDEX_CELL);
  const toX = Math.floor(right / INDEX_CELL);
  const fromY = Math.floor(top / INDEX_CELL);
  const toY = Math.floor(bottom / INDEX_CELL);

  for (let cellX = fromX; cellX <= toX; cellX++) {
    for (let cellY = fromY; cellY <= toY; cellY++) {
      const bucket = bucketAt(cached, cellX, cellY);
      if (!bucket) continue;
      for (let at = 0; at < bucket.length; at++) {
        const entry = bucket[at];
        const { collider } = entry;
        if (ignoredColliders?.has(collider)) continue;
        // The box is the bucket's own filter: one collider can be listed in
        // several buckets, and most of a bucket is not near the point.
        if (right < entry.minX || left > entry.maxX || bottom < entry.minY || top > entry.maxY) {
          continue;
        }
        if (entryOverlapsAt(x, y, radius, entry)) return true;
      }
    }
  }
  return false;
};

/** Entries near the stretch of sight line being tested; reused, never held. */
const sweepCandidates = [];

/** Whether the point-test grid answers for this navigation's colliders. */
export const canGather = (navigation) => {
  const index = navigation.colliderIndex;
  return index?.forColliders === navigation.colliders && Boolean(index.cells) && !index.fine.unordered;
};

/**
 * Puts in `sweepCandidates` each entry in the grid cells under a box whose
 * own box reaches it, once, and returns how many; -1 when the box leaves the
 * grid and nothing was gathered.
 *
 * Any entry that reaches a square inside the box is among them, and so is
 * every entry `blockedAt` would have put to its overlap test for that square:
 * they share a cell with it, and the cells under the square are under the box.
 */
export const gatherNear = (index, left, right, top, bottom, ignoredColliders) => {
  const { fine } = index;
  const fromCellX = Math.floor(left / FINE_CELL);
  const toCellX = Math.floor(right / FINE_CELL);
  const fromCellY = Math.floor(top / FINE_CELL);
  const toCellY = Math.floor(bottom / FINE_CELL);
  if (!(fromCellX >= fine.minX && toCellX <= fine.maxX && fromCellY >= fine.minY && toCellY <= fine.maxY)) {
    return -1;
  }
  // Each index counts its own gatherings, and an entry belongs to one index.
  if (index.sweepStamp === 0x3fffffff) clearSweepStamps(index);
  const stamp = ++index.sweepStamp;
  let count = 0;
  for (let cellX = fromCellX; cellX <= toCellX; cellX++) {
    for (let cellY = fromCellY; cellY <= toCellY; cellY++) {
      const cell = fine.cells[(cellX - fine.minX) * fine.rows + (cellY - fine.minY)];
      if (!cell) continue;
      for (let at = 0; at < cell.length; at++) {
        const entry = cell[at];
        if (entry.gathered === stamp) continue;
        entry.gathered = stamp;
        if (ignoredColliders?.has(entry.collider)) continue;
        if (right < entry.minX || left > entry.maxX || bottom < entry.minY || top > entry.maxY) continue;
        sweepCandidates[count++] = entry;
      }
    }
  }
  return count;
};

/**
 * Whether a body at (x, y) is clear of the first `count` gathered entries: the
 * box test and overlap test `blockedAt` gives each entry, without the floor.
 */
export const clearOfGathered = (x, y, radius, count) => {
  const left = x - radius;
  const right = x + radius;
  const top = y - radius;
  const bottom = y + radius;
  for (let at = 0; at < count; at++) {
    const entry = sweepCandidates[at];
    if (right < entry.minX || left > entry.maxX || bottom < entry.minY || top > entry.maxY) continue;
    if (entryOverlapsAt(x, y, radius, entry)) return false;
  }
  return true;
};

/** After the stamp wraps, so an entry stamped long ago is not taken as gathered. */
const clearSweepStamps = (index) => {
  for (const entry of index.entriesByCollider.values()) entry.gathered = 0;
  for (const cell of index.fine.cells) {
    if (cell) for (const entry of cell) entry.gathered = 0;
  }
  index.sweepStamp = 0;
};

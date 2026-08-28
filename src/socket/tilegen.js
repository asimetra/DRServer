/**
 * Laying out a floor from a theme's tile library.
 *
 * Most dungeons are not authored. The server picks the tiles and says where they
 * go, and the client draws whatever it is told — so a generated floor is a list
 * of (x, y, tileId) on the same 900-unit grid an authored one uses.
 *
 * The one hard rule is connectivity, and it is not a guess. Every adjacent pair
 * in the authored tutorial floor matches exactly across the seam: twenty pairs,
 * twenty matches, including walls meeting walls. So two tiles may sit next to
 * each other only when
 *
 *     a.exits[direction] === b.exits[opposite(direction)]
 *
 * Openings come in two widths (5 and 15) and 0 is a wall, so a narrow doorway
 * cannot be placed against a wide one and neither can be placed against a wall.
 */

export const TILE_SIZE = 900;

/** Floor.buildWalls runs the client's edges from the origin out to twelve tiles. */
export const WORLD_TILES = 12;

/** 0 north, 1 east, 2 south, 3 west — the order the exits array is written in. */
const DIRECTIONS = [
  { dx: 0, dy: -TILE_SIZE },
  { dx: TILE_SIZE, dy: 0 },
  { dx: 0, dy: TILE_SIZE },
  { dx: -TILE_SIZE, dy: 0 },
];

const opposite = (direction) => (direction + 2) % 4;

const exitsOf = (tile) => tile?.exits ?? [0, 0, 0, 0];

/** Deterministic per seed: the same seed lays the same floor out twice. */
const makeRandom = (seed) => {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 0x100000) / 0x100000;
  };
};

const pick = (items, random) => items[Math.floor(random() * items.length)] ?? null;

/**
 * Tiles this theme offers for a role at this difficulty. A node's TierRank sits
 * between a tile's minTier and maxTier, which is how a library serves the whole
 * map without every floor looking like the last.
 */
export const candidates = (library, { category, tier = 1 }) =>
  (library?.LETiles ?? []).filter(
    (tile) =>
      (!category || tile.category === category) &&
      (tile.minTier ?? 1) <= tier &&
      (tile.maxTier ?? 99) >= tier
  );

/** Whether a tile can sit at a place, given whatever is already around it. */
const fits = (tile, x, y, placed) =>
  DIRECTIONS.every((step, direction) => {
    const neighbour = placed.get(`${x + step.dx},${y + step.dy}`);
    if (!neighbour) return true;
    return exitsOf(tile)[direction] === exitsOf(neighbour.tile)[opposite(direction)];
  });

/** The open sides of a placed tile that have nothing behind them yet. */
const openSides = (entry, placed) =>
  DIRECTIONS.map((step, direction) => ({ step, direction }))
    .filter(({ step, direction }) => {
      if (!exitsOf(entry.tile)[direction]) return false;
      return !placed.has(`${entry.x + step.dx},${entry.y + step.dy}`);
    })
    .map(({ step, direction }) => ({
      direction,
      x: entry.x + step.dx,
      y: entry.y + step.dy,
    }));

/**
 * Lays out one floor and returns the tiles in the shape the wire wants.
 *
 * Grown rather than planned: start on a STARTING_TILE and keep attaching to
 * whatever opening is still free. A floor that cannot reach its target size —
 * because the library ran out of tiles that fit — is returned short rather than
 * abandoned, since a small floor is playable and no floor is not.
 */
const growFloor = (
  library,
  { tier = 1, tileCount = 8, seed = 1, categories = ["BASIC_TILE", "TRAP_TILE", "PUZZLE_TILE"] } = {}
) => {
  const random = makeRandom(seed);
  const placed = new Map();
  const put = (tile, x, y) => {
    placed.set(`${x},${y}`, { tile, x, y });
    return placed.get(`${x},${y}`);
  };

  const starts = candidates(library, { category: "STARTING_TILE", tier });
  const start = pick(starts, random);
  if (!start) return { tiles: [], spawnTile: null };
  put(start, 0, 0);

  const body = categories.flatMap((category) => candidates(library, { category, tier }));

  /**
   * Grown to well under the asked-for size, because sealing finishes the job.
   *
   * Closing every opening adds rooms — measured at roughly one and a half to
   * twice what was grown — so growing to the full number and then sealing
   * overshoots by half again. A tier's NumTiles is the floor it wants, not the
   * skeleton, so the skeleton is the smaller figure.
   */
  const growTo = Math.max(3, Math.round(tileCount * 0.6));

  while (placed.size < growTo) {
    const frontier = [...placed.values()].flatMap((entry) => openSides(entry, placed));
    if (!frontier.length) break;

    const where = pick(frontier, random);
    const usable = body.filter((tile) => fits(tile, where.x, where.y, placed));
    if (!usable.length) {
      // Nothing in the library closes this seam. Leave it: an opening with
      // nothing behind it is a wall the player walks up to, not a hole.
      const spot = `${where.x},${where.y}`;
      placed.set(spot, { tile: null, x: where.x, y: where.y, blocked: true });
      continue;
    }
    put(pick(usable, random), where.x, where.y);
  }

  /**
   * Sealing: every remaining opening gets something behind it.
   *
   * A door with nothing behind it is not a wall the player walks up to — the
   * doorway is cut into the tile's own geometry, so it is a hole in the edge of
   * the floor. Growth to a target size leaves about seven of them per layout.
   *
   * Openings are closed with whatever fits, preferring tiles that bring the
   * fewest new openings with them, so sealing converges instead of sprawling.
   * A seam nothing in the library can close fails the layout, and the caller
   * grows another.
   */
  const newOpenings = (tile, x, y) =>
    DIRECTIONS.reduce((count, step, direction) => {
      if (!exitsOf(tile)[direction]) return count;
      return placed.has(`${x + step.dx},${y + step.dy}`) ? count : count + 1;
    }, 0);

  let sealed = true;
  for (let pass = 0; pass < 200; pass++) {
    const seams = [...placed.values()].flatMap((entry) => openSides(entry, placed));
    if (!seams.length) break;

    const seam = seams[0];
    const usable = body
      .filter((tile) => fits(tile, seam.x, seam.y, placed))
      .sort((left, right) => newOpenings(left, seam.x, seam.y) - newOpenings(right, seam.x, seam.y));

    if (!usable.length) {
      sealed = false;
      break;
    }
    // Among the tightest, still a choice, so layouts do not all end the same.
    const fewest = newOpenings(usable[0], seam.x, seam.y);
    put(pick(usable.filter((tile) => newOpenings(tile, seam.x, seam.y) === fewest), random), seam.x, seam.y);
  }

  /**
   * A floor needs somewhere to go. The exit tile carries the trigger that ends
   * the floor, so a layout without one is a room the player cannot leave.
   *
   * It goes on the opening furthest from the start, which is as close to "the
   * far end" as a grown layout has, and only where the library has an exit that
   * closes that seam. A floor that cannot take one is still returned — better a
   * dead end than nothing — and the caller can see it has no exit.
   */
  const reach = (entry) => Math.abs(entry.x) + Math.abs(entry.y);
  const seams = [...placed.values()]
    .flatMap((entry) => openSides(entry, placed))
    .sort((left, right) => reach(right) - reach(left));

  const exits = candidates(library, { category: "EXIT_TILE", tier });
  let placedExit = false;
  for (const seam of seams) {
    const usable = exits.filter((tile) => fits(tile, seam.x, seam.y, placed));
    if (!usable.length) continue;
    put(pick(usable, random), seam.x, seam.y);
    placedExit = true;
    break;
  }

  /**
   * If no open seam will take one, turn the furthest room into the exit instead.
   *
   * A grown layout can close itself off, and then the choice is between a floor
   * with no way out and one room that leads somewhere. The replacement is
   * checked against its neighbours like any other placement, so the seams stay
   * honest — it only differs in taking a square that is already occupied.
   */
  if (!placedExit) {
    const rooms = [...placed.values()]
      .filter((entry) => !(entry.x === 0 && entry.y === 0) && !entry.blocked)
      .sort((left, right) => reach(right) - reach(left));

    for (const room of rooms) {
      placed.delete(`${room.x},${room.y}`);
      const usable = exits.filter((tile) => fits(tile, room.x, room.y, placed));
      if (usable.length) {
        put(pick(usable, random), room.x, room.y);
        placedExit = true;
        break;
      }
      placed.set(`${room.x},${room.y}`, room);
    }
  }

  for (const [key, entry] of placed) if (entry.blocked) placed.delete(key);

  /**
   * Shifted into the positive quadrant, because the client's world starts at
   * the origin.
   *
   * Floor.buildWalls runs its edges from (0,0) out to twelve tiles, so a tile
   * laid at a negative coordinate sits outside the world and the player meets an
   * invisible wall at x or y zero — which is what "cannot cross a tile boundary"
   * looks like. Every captured layout from the real server is non-negative: x
   * from 0 to 8100, y from 0 to 5400.
   *
   * Growing outward from the origin is still the simplest way to build one, so
   * the layout is moved afterwards rather than the growth constrained.
   */
  const entries = [...placed.values()];
  const offsetX = -Math.min(...entries.map((entry) => entry.x));
  const offsetY = -Math.min(...entries.map((entry) => entry.y));

  const width = Math.max(...entries.map((entry) => entry.x)) + offsetX;
  const height = Math.max(...entries.map((entry) => entry.y)) + offsetY;

  return {
    sealed,
    /** The client's world is twelve tiles square; anything past it is unreachable. */
    insideWorld: width < WORLD_TILES * TILE_SIZE && height < WORLD_TILES * TILE_SIZE,
    hasExit: placedExit,
    tiles: entries.map((entry) => ({
      x: entry.x + offsetX,
      y: entry.y + offsetY,
      tileId: entry.tile.id,
    })),
    spawnTile: { x: offsetX, y: offsetY },
  };
};

/** Every adjacency in a layout agrees across the seam. Exported for tests. */
export const isConnected = (library, tiles) => {
  const byId = new Map((library?.LETiles ?? []).map((tile) => [tile.id, tile]));
  const placed = new Map(tiles.map((tile) => [`${tile.x},${tile.y}`, byId.get(tile.tileId)]));

  for (const tile of tiles) {
    const self = byId.get(tile.tileId);
    for (const [direction, step] of DIRECTIONS.entries()) {
      const neighbour = placed.get(`${tile.x + step.dx},${tile.y + step.dy}`);
      if (!neighbour) continue;
      if (exitsOf(self)[direction] !== exitsOf(neighbour)[opposite(direction)]) return false;
    }
  }
  return true;
};

/**
 * A floor with a way out of it.
 *
 * Growing can close itself off — the layout runs into its own walls before any
 * seam will take an exit. Across the real theme libraries that happens to about
 * one attempt in fifteen and never produces a bad seam, so the answer is simply
 * to lay it out again. Successive seeds are derived from the one asked for, so
 * the result is still the same every time for the same input.
 */
export const generateFloor = (library, options = {}) => {
  const seed = options.seed ?? 1;
  const wanted = options.tileCount ?? 8;
  /**
   * Big enough counts as well as open enough. Growth can wall itself in after
   * two rooms and still find somewhere to put an exit, which passes "has a way
   * out" while being nothing like the floor that was asked for. Two thirds of
   * the requested size is the bar; below it, try again.
   */
  /**
   * Close to the size asked for, not merely in the region of it.
   *
   * A tier's NumTiles is a floor's room count and the real server lands on it:
   * four entries to node 50004, whose tier says fourteen, came back with 14, 14,
   * 13 and 14. A window of two thirds to one and a half was wide enough to hand
   * back eleven or seventeen for the same node, so attempts are now judged by
   * how near they come and the nearest is kept.
   */
  let best = null;
  let bestMiss = Infinity;

  for (let attempt = 0; attempt < 24; attempt++) {
    const layout = growFloor(library, { ...options, seed: seed + attempt * 7919 });
    const usable = layout.sealed && layout.insideWorld && layout.hasExit;
    const miss = Math.abs(layout.tiles.length - wanted);

    if (usable && miss <= 1) return layout;
    if (usable && miss < bestMiss) {
      best = layout;
      bestMiss = miss;
      continue;
    }
    /**
     * Failing that, the least bad one. Fitting inside the world comes first:
     * a room the client has no floor under is not a room, while one that is
     * smaller than asked for or has an unsealed edge is still somewhere to
     * play.
     */
    if (!best) best = layout;
  }
  // Two dozen unsuitable layouts means the library cannot serve this size; the
  // nearest of them is still somewhere to play.
  return best;
};

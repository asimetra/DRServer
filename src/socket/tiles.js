/**
 * The tiles a floor actually laid. Its bounds are a rectangle and its tiles
 * are not: ground inside the bounds between two laid tiles may be no ground
 * at all.
 */

/** Whether this point belongs to one of the tiles the floor actually laid. */
export const isOnAuthoredTile = (navigation, point) => {
  if (!navigation || !point) return false;
  if (!navigation.tileKeys.size) return true;
  return onAuthoredTile(navigation, point.x, point.y);
};

/** The most tiles the authored-tile lookup lays out flat; a floor uses about a hundred. */
const TILE_GRID_LIMIT = 1 << 16;

/**
 * `tileKeys` as a flat array over the tile rows and columns it spans.
 *
 * Every collision test asks whether its point is on a laid tile, and building
 * the `"x,y"` string to ask the set cost more than the rest of the test. Each
 * slot holds exactly what the set answers for that slot's key, worked out by
 * asking it once; a tile outside the span is still asked by key, so the answer
 * does not depend on the span being right, only the speed does.
 */
const buildTileGrid = (tileKeys, tileSize) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const key of tileKeys) {
    const [x, y] = String(key).split(",").map(Number);
    const column = Math.floor(x / tileSize);
    const row = Math.floor(y / tileSize);
    if (!Number.isFinite(column) || !Number.isFinite(row)) continue;
    minX = Math.min(minX, column);
    maxX = Math.max(maxX, column);
    minY = Math.min(minY, row);
    maxY = Math.max(maxY, row);
  }
  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const grid = { forKeys: tileKeys, size: tileSize, count: tileKeys.size, minX, minY, columns: 0, rows: 0, cells: null };
  if (!(columns > 0 && rows > 0 && columns * rows <= TILE_GRID_LIMIT)) return grid;
  grid.columns = columns;
  grid.rows = rows;
  grid.cells = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const tileX = (minX + column) * tileSize;
      const tileY = (minY + row) * tileSize;
      grid.cells[row * columns + column] = tileKeys.has(`${tileX},${tileY}`) ? 1 : 0;
    }
  }
  return grid;
};

/** The tile grid for this navigation's current tiles, built on first use. */
const tileGridOf = (navigation) => {
  const cached = navigation.tileGrid;
  if (
    cached &&
    cached.forKeys === navigation.tileKeys &&
    Object.is(cached.size, navigation.tileSize) &&
    cached.count === navigation.tileKeys.size
  ) {
    return cached;
  }
  navigation.tileGrid = buildTileGrid(navigation.tileKeys, navigation.tileSize);
  return navigation.tileGrid;
};

/** `isOnAuthoredTile` past its guards, on a bare coordinate pair. */
export const onAuthoredTile = (navigation, x, y) => {
  const { tileSize } = navigation;
  return tileAt(navigation, Math.floor(x / tileSize), Math.floor(y / tileSize));
};

/** Whether tile (column, row), in units of `tileSize`, is laid. */
export const tileAt = (navigation, column, row) => {
  const grid = tileGridOf(navigation);
  const gridColumn = column - grid.minX;
  const gridRow = row - grid.minY;
  if (gridColumn >= 0 && gridColumn < grid.columns && gridRow >= 0 && gridRow < grid.rows) {
    return grid.cells[gridRow * grid.columns + gridColumn] === 1;
  }
  const { tileSize } = navigation;
  return navigation.tileKeys.has(`${column * tileSize},${row * tileSize}`);
};

/**
 * Whether every point of a line of no width from (fromX, fromY) to (toX, toY),
 * its first point left out, is on a laid tile, as `onAuthoredTile` asks of
 * one point. The tile boundaries the line crosses cut it into stretches, each
 * on one tile, asked of the point halfway along it; the last point is asked
 * on its own, as it may lie on a boundary. A line through a corner of four
 * tiles is on the two it passes between, not the one it touches at a point.
 */
export const segmentOnLaidTiles = (navigation, fromX, fromY, toX, toY) => {
  if (!navigation.tileKeys.size) return true;
  const size = navigation.tileSize;
  const spanX = toX - fromX;
  const spanY = toY - fromY;
  // The next tile line each coordinate crosses, and how far along it crosses.
  let lineX = spanX > 0 ? Math.floor(fromX / size) + 1 : Math.ceil(fromX / size) - 1;
  let lineY = spanY > 0 ? Math.floor(fromY / size) + 1 : Math.ceil(fromY / size) - 1;
  let crossX = spanX ? (lineX * size - fromX) / spanX : Infinity;
  let crossY = spanY ? (lineY * size - fromY) / spanY : Infinity;
  let at = 0;
  for (;;) {
    const next = Math.min(crossX, crossY, 1);
    if (next > at) {
      const half = (at + next) / 2;
      if (!onAuthoredTile(navigation, fromX + spanX * half, fromY + spanY * half)) return false;
    }
    if (next >= 1) break;
    if (crossX === next) {
      lineX += Math.sign(spanX);
      crossX = (lineX * size - fromX) / spanX;
    }
    if (crossY === next) {
      lineY += Math.sign(spanY);
      crossY = (lineY * size - fromY) / spanY;
    }
    at = next;
  }
  return onAuthoredTile(navigation, toX, toY);
};

/**
 * Whether a straight movement claim stays on authored floor tiles.
 *
 * This deliberately asks only about tile topology, not wall colliders. The
 * native-client corpus still exposes a small collider disagreement, while not
 * one honest claim leaves the authored tile set. Keeping the predicates apart
 * lets the exact rule ship without inheriting the uncertain one.
 *
 * Amanatides/Woo grid traversal visits crossed tile cells rather than sampling
 * world distance. Work is bounded by the number of floor tiles crossed, so a
 * client cannot turn a long coordinate into thousands of collision queries.
 */
export const segmentStaysOnAuthoredTiles = (navigation, from, to) => {
  if (!navigation || !from || !to) return false;
  if (!navigation.tileKeys.size) return true;
  if (!isOnAuthoredTile(navigation, from) || !isOnAuthoredTile(navigation, to)) return false;

  const size = navigation.tileSize;
  let cellX = Math.floor(from.x / size);
  let cellY = Math.floor(from.y / size);
  const endX = Math.floor(to.x / size);
  const endY = Math.floor(to.y / size);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const deltaX = stepX ? size / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const deltaY = stepY ? size / Math.abs(dy) : Number.POSITIVE_INFINITY;
  let nextX = stepX > 0 ? (cellX + 1) * size : cellX * size;
  let nextY = stepY > 0 ? (cellY + 1) * size : cellY * size;
  let maxX = stepX ? Math.abs((nextX - from.x) / dx) : Number.POSITIVE_INFINITY;
  let maxY = stepY ? Math.abs((nextY - from.y) / dy) : Number.POSITIVE_INFINITY;
  const present = (x, y) => tileAt(navigation, x, y);

  while (cellX !== endX || cellY !== endY) {
    if (maxX < maxY) {
      cellX += stepX;
      maxX += deltaX;
    } else if (maxY < maxX) {
      cellY += stepY;
      maxY += deltaY;
    } else {
      /**
       * Crossing a grid corner touches both side cells. A point could squeeze
       * through the zero-width diagonal, but a hero body cannot; require both
       * sides as well as the destination cell.
       */
      if (!present(cellX + stepX, cellY) || !present(cellX, cellY + stepY)) return false;
      cellX += stepX;
      cellY += stepY;
      maxX += deltaX;
      maxY += deltaY;
    }
    if (!present(cellX, cellY)) return false;
  }
  return true;
};

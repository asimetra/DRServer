import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "../config.js";

const DEFAULT_CELL_SIZE = 60;

/**
 * `library_server.json` — the shape of everything that can be collided with,
 * actors included. Held once loaded, because collision tests are on the hot
 * path and cannot await.
 */
let navigationShapes = null;
let navigationShapesPromise;

/**
 * Ours before theirs, the same way tile libraries and the rules table resolve.
 *
 * This library is keyed by constant and holds the shape of everything that can
 * be hit or walked into. A constant this server invents gets its artwork from
 * the NPC row and its *body* from here — so a new row with no entry here is a
 * thing you can see and cannot touch, which is exactly how a standing stone
 * came to be unhittable.
 */
const collisionLibraryFile = () => {
  if (config.contentDir) {
    const ours = path.join(config.contentDir, "Resources", "Levels", "library_server.json");
    if (existsSync(ours)) return ours;
  }
  return path.join(config.resourcesDir, "Levels", "library_server.json");
};

export const loadNavigationLibrary = () => {
  navigationShapesPromise ??= fs
    .readFile(collisionLibraryFile(), "utf8")
    .then((raw) => {
      navigationShapes = new Map(JSON.parse(raw).map((entry) => [entry.constant, entry]));
      return navigationShapes;
    });
  return navigationShapesPromise;
};

export const navigationEntryFor = (constant) => navigationShapes?.get(constant) ?? null;

/**
 * Where an actor actually collides, which is not where it stands.
 *
 * Every actor in the library carries its body as a circle offset **up** from
 * its position — `{radius: 22, x: 0, y: -22}` for all six heroes, and the same
 * −22 for 97 of the 122 monsters. The position on the wire is the feet and the
 * body sits above it: `FloorObject.worldCenter` is exactly that offset applied,
 * and the client's own hit detection queries Box2D bodies built there.
 *
 * Testing the raw position instead put every damage zone 22 units too low
 * relative to the actor, so a floor trap caught you standing past it and missed
 * you walking into it from below. The capture is unambiguous: of 25 recorded
 * spike hits, 18 landed with the hero's *position* below the trap origin, and
 * applying this brings 24 of the 25 inside the authored shape to within three
 * units — against 6 of 25 without it.
 */
export const collisionPointOf = (actor, position) => {
  const shape = navigationEntryFor(actor?.constant)?.navCollisions?.[0];
  if (!shape || !position) return position;
  return { x: position.x + Number(shape.x ?? 0), y: position.y + Number(shape.y ?? 0) };
};

const squaredDistance = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

const activeTriggerColliders = (navigation) => {
  const colliders = [];
  for (const group of navigation.triggerGroups.values()) {
    colliders.push(...(group.on ? group.onColliders : group.offColliders));
  }
  return colliders;
};

/**
 * How wide a bucket in the collider index is.
 *
 * Colliders on a catacombs floor run 30 to 580 units across, so 300 keeps the
 * largest of them inside a handful of buckets while leaving the common small
 * ones in one. Smaller buckets index faster but cost more memory and more
 * bucket visits per query; this is the middle of that.
 */
const INDEX_CELL = 300;

/** The axis-aligned box a collider occupies, rotation included. */
const boundsOf = (collider) => {
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
const buildColliderIndex = (navigation) => {
  const cells = new Map();
  const prepared = navigation.colliders.map((collider) => ({
    collider,
    box: boundsOf(collider),
    // Negated once, because overlapsRectangle rotates the point *into* the
    // collider's frame rather than the other way about.
    cosine: collider.type === "rectangle" ? Math.cos(-collider.angle) : 0,
    sine: collider.type === "rectangle" ? Math.sin(-collider.angle) : 0,
  }));

  for (const entry of prepared) {
    const { box } = entry;
    const fromX = Math.floor(box.minX / INDEX_CELL);
    const toX = Math.floor(box.maxX / INDEX_CELL);
    const fromY = Math.floor(box.minY / INDEX_CELL);
    const toY = Math.floor(box.maxY / INDEX_CELL);
    for (let x = fromX; x <= toX; x++) {
      for (let y = fromY; y <= toY; y++) {
        const key = `${x},${y}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(entry);
        else cells.set(key, [entry]);
      }
    }
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
  navigation.colliderIndex = { forColliders: navigation.colliders, cells };
};

const rebuildActiveColliders = (navigation) => {
  navigation.colliders = [
    ...navigation.staticColliders,
    ...activeTriggerColliders(navigation),
    ...[...navigation.obstacles.values()].flat(),
  ];
  buildColliderIndex(navigation);
};

const invalidatePathfinding = (navigation) => {
  navigation.revision++;
  navigation.pathfinding.blockedCellsByRadius.clear();
};

/** Creates mutable per-session state from a cached floor navigation definition. */
export const createNavigationState = (definition) => {
  if (!definition) return null;

  const navigation = {
    bounds: { ...definition.bounds },
    cellSize: definition.cellSize ?? DEFAULT_CELL_SIZE,
    tileSize: definition.tileSize ?? 900,
    tileKeys: new Set((definition.tiles ?? []).map((tile) => `${tile.x},${tile.y}`)),
    staticColliders: [...(definition.staticColliders ?? [])],
    triggerGroups: new Map(),
    obstacles: new Map(),
    colliders: [],
    revision: 0,
    // A route search lazily records which grid cells are blocked for a given
    // actor radius. The geometry only changes when navigation revision does,
    // so later NPCs do not repeat the same collider checks.
    pathfinding: { blockedCellsByRadius: new Map() },
  };

  for (const [id, group] of definition.triggerColliders ?? []) {
    navigation.triggerGroups.set(id, {
      on: group.initialOn ?? true,
      onColliders: [...(group.onColliders ?? [])],
      offColliders: [...(group.offColliders ?? [])],
    });
  }
  rebuildActiveColliders(navigation);
  return navigation;
};

/** Keeps server pathing in sync with NPCGameObject.triggerState. */
export const setNavigationTriggerState = (navigation, id, on) => {
  const group = navigation?.triggerGroups.get(id);
  if (!group || group.on === on) return false;
  group.on = on;
  invalidatePathfinding(navigation);
  rebuildActiveColliders(navigation);
  return true;
};

/** Adds an actor-backed obstacle such as a smashable barrel or wooden box. */
export const addNavigationObstacle = (navigation, id, colliders) => {
  if (!navigation || !colliders?.length) return false;
  navigation.obstacles.set(id, [...colliders]);
  invalidatePathfinding(navigation);
  rebuildActiveColliders(navigation);
  return true;
};

/** Removes an actor-backed obstacle when the corresponding object is destroyed. */
export const removeNavigationObstacle = (navigation, id) => {
  if (!navigation?.obstacles.delete(id)) return false;
  invalidatePathfinding(navigation);
  rebuildActiveColliders(navigation);
  return true;
};

/** Whether this point belongs to one of the tiles the floor actually laid. */
export const isOnAuthoredTile = (navigation, point) => {
  if (!navigation || !point) return false;
  if (!navigation.tileKeys.size) return true;
  const { tileSize } = navigation;
  const tileX = Math.floor(point.x / tileSize) * tileSize;
  const tileY = Math.floor(point.y / tileSize) * tileSize;
  return navigation.tileKeys.has(`${tileX},${tileY}`);
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
  const present = (x, y) => navigation.tileKeys.has(`${x * size},${y * size}`);

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

const overlapsRectangle = (
  point,
  radius,
  collider,
  cosine = Math.cos(-collider.angle),
  sine = Math.sin(-collider.angle)
) => {
  const offsetX = point.x - collider.x;
  const offsetY = point.y - collider.y;
  const localX = offsetX * cosine - offsetY * sine;
  const localY = offsetX * sine + offsetY * cosine;
  const closestX = Math.max(-collider.halfWidth, Math.min(collider.halfWidth, localX));
  const closestY = Math.max(-collider.halfHeight, Math.min(collider.halfHeight, localY));
  const dx = localX - closestX;
  const dy = localY - closestY;
  return dx * dx + dy * dy < radius * radius || (radius === 0 && dx === 0 && dy === 0);
};

const overlapsCircle = (point, radius, collider) =>
  squaredDistance(point, collider) < (radius + collider.radius) ** 2;

/** True when an actor circle would overlap authored navigation geometry. */
export const isPositionBlocked = (
  navigation,
  point,
  radius = 0,
  { ignoredColliders } = {}
) => {
  if (!navigation) return false;
  const { bounds } = navigation;
  if (
    point.x - radius < bounds.minX ||
    point.x + radius > bounds.maxX ||
    point.y - radius < bounds.minY ||
    point.y + radius > bounds.maxY ||
    !isOnAuthoredTile(navigation, point)
  ) {
    return true;
  }

  /**
   * Only the colliders whose bucket the query circle touches.
   *
   * A point and a radius of 26 cannot reach anything more than 26 units away,
   * so the buckets covering that square are the whole candidate set. Falls back
   * to the flat list when there is no index, which keeps a hand-built
   * navigation object in a test working without one.
   */
  const cached = navigation.colliderIndex;
  const index = cached?.forColliders === navigation.colliders ? cached.cells : null;
  if (!index) {
    for (const collider of navigation.colliders) {
      if (ignoredColliders?.has(collider)) continue;
      if (collider.type === "circle") {
        if (overlapsCircle(point, radius, collider)) return true;
      } else if (collider.type === "rectangle") {
        if (overlapsRectangle(point, radius, collider)) return true;
      }
    }
    return false;
  }

  const fromX = Math.floor((point.x - radius) / INDEX_CELL);
  const toX = Math.floor((point.x + radius) / INDEX_CELL);
  const fromY = Math.floor((point.y - radius) / INDEX_CELL);
  const toY = Math.floor((point.y + radius) / INDEX_CELL);

  for (let x = fromX; x <= toX; x++) {
    for (let y = fromY; y <= toY; y++) {
      const bucket = index.get(`${x},${y}`);
      if (!bucket) continue;
      for (const entry of bucket) {
        const { collider } = entry;
        if (ignoredColliders?.has(collider)) continue;
        // The box is the bucket's own filter: one collider can be listed in
        // several buckets, and most of a bucket is not near the point.
        const { box } = entry;
        if (
          point.x + radius < box.minX ||
          point.x - radius > box.maxX ||
          point.y + radius < box.minY ||
          point.y - radius > box.maxY
        ) {
          continue;
        }
        if (collider.type === "circle") {
          if (overlapsCircle(point, radius, collider)) return true;
        } else if (collider.type === "rectangle") {
          if (overlapsRectangle(point, radius, collider, entry.cosine, entry.sine)) return true;
        }
      }
    }
  }
  return false;
};

/** Samples a swept actor circle so a fast tick cannot tunnel through a thin wall. */
export const hasLineOfSight = (
  navigation,
  from,
  to,
  radius = 0,
  options
) => {
  if (!navigation) return true;
  const distance = Math.sqrt(squaredDistance(from, to));
  const step = Math.max(8, Math.min(24, radius > 0 ? radius * 0.5 : 16));
  const samples = Math.max(1, Math.ceil(distance / step));

  for (let index = 1; index <= samples; index++) {
    const ratio = index / samples;
    if (
      isPositionBlocked(
        navigation,
        {
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
        },
        radius,
        options
      )
    ) {
      return false;
    }
  }
  return true;
};

const colliderBlocksPosition = (point, radius, collider) => {
  if (collider.type === "circle") return overlapsCircle(point, radius, collider);
  if (collider.type === "rectangle") return overlapsRectangle(point, radius, collider);
  return false;
};

const activeTriggerCollidersAt = (navigation, point, radius) => {
  const colliders = [];
  for (const group of navigation.triggerGroups.values()) {
    for (const collider of group.on ? group.onColliders : group.offColliders) {
      if (colliderBlocksPosition(point, radius, collider)) colliders.push(collider);
    }
  }
  return colliders;
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const rectangleReleaseCandidates = (origin, radius, collider) => {
  const cosine = Math.cos(-collider.angle);
  const sine = Math.sin(-collider.angle);
  const offsetX = origin.x - collider.x;
  const offsetY = origin.y - collider.y;
  const localX = offsetX * cosine - offsetY * sine;
  const localY = offsetX * sine + offsetY * cosine;
  const gap = radius + 8;
  const candidates = [
    { x: collider.halfWidth + gap, y: clamp(localY, -collider.halfHeight, collider.halfHeight) },
    { x: -collider.halfWidth - gap, y: clamp(localY, -collider.halfHeight, collider.halfHeight) },
    { x: clamp(localX, -collider.halfWidth, collider.halfWidth), y: collider.halfHeight + gap },
    { x: clamp(localX, -collider.halfWidth, collider.halfWidth), y: -collider.halfHeight - gap },
  ];
  const worldCosine = Math.cos(collider.angle);
  const worldSine = Math.sin(collider.angle);
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
  const baseAngle = Number.isFinite(sourceAngle) && Math.hypot(origin.x - collider.x, origin.y - collider.y) > 0.001
    ? sourceAngle
    : targetAngle;
  const distance = collider.radius + radius + 8;
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
 * The work is intentionally local and bounded: a rectangle supplies four
 * faces and a circle eight directions. Unlike a radial map scan, this never
 * runs A* while a wave is being created. The returned collider set is only
 * ignored during that NPC's short exit movement; it is not a global door
 * override.
 */
export const findCageReleasePath = (navigation, origin, radius = 0, target = null) => {
  if (!navigation || !origin) return null;
  const enclosedBy = activeTriggerCollidersAt(navigation, origin, radius);
  if (!enclosedBy.length) return null;

  const ignoredColliders = new Set(enclosedBy);
  const candidates = enclosedBy.flatMap((collider) =>
    collider.type === "circle"
      ? circleReleaseCandidates(origin, radius, collider, target)
      : rectangleReleaseCandidates(origin, radius, collider)
  );
  candidates.sort((left, right) => {
    const reference = target ?? origin;
    return squaredDistance(left, reference) - squaredDistance(right, reference);
  });

  for (const candidate of candidates) {
    if (isPositionBlocked(navigation, candidate, radius)) continue;
    if (hasLineOfSight(navigation, origin, candidate, radius, { ignoredColliders })) {
      return { target: candidate, ignoredColliders };
    }
  }
  return null;
};

class MinHeap {
  constructor() {
    this.items = [];
  }

  get length() {
    return this.items.length;
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      const child =
        right < this.items.length && this.items[right].priority < this.items[left].priority
          ? right
          : left;
      if (this.items[child].priority >= last.priority) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

const octileDistance = (ax, ay, bx, by) => {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
};

const nearestOpenCell = (cell, columns, rows, blocked) => {
  if (!blocked(cell.x, cell.y)) return cell;
  for (let radius = 1; radius <= 5; radius++) {
    for (let y = cell.y - radius; y <= cell.y + radius; y++) {
      for (let x = cell.x - radius; x <= cell.x + radius; x++) {
        if (x < 0 || y < 0 || x >= columns || y >= rows) continue;
        if (Math.max(Math.abs(x - cell.x), Math.abs(y - cell.y)) !== radius) continue;
        if (!blocked(x, y)) return { x, y };
      }
    }
  }
  return null;
};

/** A* over the authored floor collision geometry, returning compressed world waypoints. */
export const findPath = (navigation, start, goal, radius = 0) => {
  if (!navigation) return [goal];
  if (hasLineOfSight(navigation, start, goal, radius)) return [{ ...goal }];

  const { bounds, cellSize } = navigation;
  const columns = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSize));
  const clamp = (value, max) => Math.max(0, Math.min(max - 1, value));
  const toCell = (point) => ({
    x: clamp(Math.floor((point.x - bounds.minX) / cellSize), columns),
    y: clamp(Math.floor((point.y - bounds.minY) / cellSize), rows),
  });
  const toWorld = (x, y) => ({
    x: bounds.minX + x * cellSize + cellSize / 2,
    y: bounds.minY + y * cellSize + cellSize / 2,
  });
  const keyFor = (x, y) => y * columns + x;
  const radiusKey = String(radius);
  const blockedCache =
    navigation.pathfinding.blockedCellsByRadius.get(radiusKey) ?? new Map();
  navigation.pathfinding.blockedCellsByRadius.set(radiusKey, blockedCache);
  const blocked = (x, y) => {
    const key = keyFor(x, y);
    if (!blockedCache.has(key)) {
      blockedCache.set(key, isPositionBlocked(navigation, toWorld(x, y), radius));
    }
    return blockedCache.get(key);
  };

  const startCell = toCell(start);
  const goalCell = nearestOpenCell(toCell(goal), columns, rows, blocked);
  if (!goalCell) return [];

  const startKey = keyFor(startCell.x, startCell.y);
  const goalKey = keyFor(goalCell.x, goalCell.y);
  const open = new MinHeap();
  const cost = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  open.push({ key: startKey, x: startCell.x, y: startCell.y, priority: 0 });

  const directions = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, 1, Math.SQRT2],
  ];

  // The authored floor bounds make this a finite search. Do not impose an
  // arbitrary node ceiling: it turns a valid route on a larger floor into a
  // false "blocked" result, which strands enemies in place for the player.
  while (open.length) {
    const current = open.pop();
    if (closed.has(current.key)) continue;
    if (current.key === goalKey) break;
    closed.add(current.key);

    for (const [dx, dy, stepCost] of directions) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (x < 0 || y < 0 || x >= columns || y >= rows || blocked(x, y)) continue;
      // Do not cut diagonally through the corner of two colliders.
      if (dx !== 0 && dy !== 0 && (blocked(current.x + dx, current.y) || blocked(current.x, current.y + dy))) {
        continue;
      }

      const key = keyFor(x, y);
      const nextCost = cost.get(current.key) + stepCost;
      if (nextCost >= (cost.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      cost.set(key, nextCost);
      cameFrom.set(key, current.key);
      open.push({
        key,
        x,
        y,
        priority: nextCost + octileDistance(x, y, goalCell.x, goalCell.y),
      });
    }
  }

  if (goalKey !== startKey && !cameFrom.has(goalKey)) return [];

  const raw = [];
  let key = goalKey;
  while (key !== startKey) {
    raw.unshift(toWorld(key % columns, Math.floor(key / columns)));
    key = cameFrom.get(key);
    if (key === undefined) return [];
  }

  const compressed = [];
  let anchor = start;
  let index = 0;
  while (index < raw.length) {
    let farthest = index;
    for (let candidate = raw.length - 1; candidate >= index; candidate--) {
      if (hasLineOfSight(navigation, anchor, raw[candidate], radius)) {
        farthest = candidate;
        break;
      }
    }
    compressed.push(raw[farthest]);
    anchor = raw[farthest];
    index = farthest + 1;
  }

  if (hasLineOfSight(navigation, anchor, goal, radius)) {
    // The last grid-cell center can itself be the corner that clears an
    // obstacle. Replacing it with the exact target would make the preceding
    // segment cut back through that obstacle on multi-corner routes.
    if (squaredDistance(anchor, goal) > 0.001) compressed.push({ ...goal });
  }
  return compressed;
};

/** Applies a swept move, falling back to axis sliding when separation nudges into a wall. */
export const moveWithNavigation = (
  navigation,
  from,
  displacement,
  radius = 0,
  options
) => {
  if (!navigation) {
    return { x: from.x + displacement.x, y: from.y + displacement.y };
  }

  const length = Math.hypot(displacement.x, displacement.y);
  if (length < 0.001) return { ...from };
  const substepLength = Math.max(8, radius > 0 ? radius * 0.4 : 12);
  const steps = Math.max(1, Math.ceil(length / substepLength));
  const step = { x: displacement.x / steps, y: displacement.y / steps };
  const position = { ...from };

  for (let index = 0; index < steps; index++) {
    const full = { x: position.x + step.x, y: position.y + step.y };
    if (!isPositionBlocked(navigation, full, radius, options)) {
      position.x = full.x;
      position.y = full.y;
      continue;
    }

    const xOnly = { x: position.x + step.x, y: position.y };
    const yOnly = { x: position.x, y: position.y + step.y };
    const canX = !isPositionBlocked(navigation, xOnly, radius, options);
    const canY = !isPositionBlocked(navigation, yOnly, radius, options);
    if (canX && (!canY || Math.abs(step.x) >= Math.abs(step.y))) position.x = xOnly.x;
    else if (canY) position.y = yOnly.y;
    else break;
  }
  return position;
};

/**
 * The closest ground an actor of this size can actually stand on.
 *
 * Searched outward from the point, and forward first: a cage's spawn sits at
 * the back of it, so the way out is the way the room lies. Returns null only if
 * nothing within reach is clear, which means the actor is walled in rather than
 * merely standing in the wall.
 */
export const nearestClearPosition = (
  navigation,
  origin,
  radius = 0,
  { reach = 240, reachableFrom = null, towards = null } = {}
) => {
  if (!navigation || !origin) return null;
  if (!isPositionBlocked(navigation, origin, radius)) return origin;

  const step = Math.max(16, Math.round(radius / 2));
  /**
   * Searched towards somewhere before anywhere. Which way is "out" is a
   * property of the floor, not a constant — the tutorial's cages happen to face
   * +Y and an earlier version simply assumed so, which is the same mistake that
   * put a release cluster behind its own cage. When a direction is known it
   * leads; otherwise the ring is walked in a fixed order so the answer is still
   * the same every time.
   */
  const ring = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
    [0.7, 0.7],
    [-0.7, 0.7],
    [0.7, -0.7],
    [-0.7, -0.7],
  ];
  const lead = towards
    ? (() => {
        const dx = towards.x - origin.x;
        const dy = towards.y - origin.y;
        const length = Math.hypot(dx, dy);
        return length < 0.001 ? [] : [[dx / length, dy / length]];
      })()
    : [];
  const directions = [...lead, ...ring];

  /**
   * Clear ground is not enough on its own: the far side of a wall is clear too,
   * and an actor put there is as stuck as one left inside the wall. So a
   * candidate has to be visible from somewhere that matters — the room the
   * player is in — before it is accepted.
   *
   * Two passes rather than one test, so that a floor whose geometry defeats the
   * sight line still places its actor somewhere standable instead of nowhere.
   */
  const scan = (accept) => {
    for (let distance = step; distance <= reach; distance += step) {
      for (const [dx, dy] of directions) {
        const candidate = { x: origin.x + dx * distance, y: origin.y + dy * distance };
        if (isPositionBlocked(navigation, candidate, radius)) continue;
        if (accept(candidate)) return candidate;
      }
    }
    return null;
  };

  if (reachableFrom) {
    const reachable = scan((candidate) =>
      hasLineOfSight(navigation, candidate, reachableFrom, radius)
    );
    if (reachable) return reachable;
  }
  return scan(() => true);
};

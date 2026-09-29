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
  const entriesByCollider = new Map();
  const prepared = navigation.colliders.map((collider) => ({
    collider,
    box: boundsOf(collider),
    // Negated once, because overlapsRectangle rotates the point *into* the
    // collider's frame rather than the other way about.
    cosine: collider.type === "rectangle" ? Math.cos(-collider.angle) : 0,
    sine: collider.type === "rectangle" ? Math.sin(-collider.angle) : 0,
  }));

  for (const entry of prepared) {
    entriesByCollider.set(entry.collider, entry);
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
  navigation.colliderIndex = { forColliders: navigation.colliders, cells, entriesByCollider };
};

const addColliderToIndex = (navigation, collider) => {
  if (!collider || navigation.colliderIndex?.entriesByCollider.has(collider)) return false;
  const entry = {
    collider,
    box: boundsOf(collider),
    cosine: collider.type === "rectangle" ? Math.cos(-(collider.angle ?? 0)) : 0,
    sine: collider.type === "rectangle" ? Math.sin(-(collider.angle ?? 0)) : 0,
  };
  const { box } = entry;
  for (let x = Math.floor(box.minX / INDEX_CELL); x <= Math.floor(box.maxX / INDEX_CELL); x++) {
    for (let y = Math.floor(box.minY / INDEX_CELL); y <= Math.floor(box.maxY / INDEX_CELL); y++) {
      const key = `${x},${y}`;
      const bucket = navigation.colliderIndex.cells.get(key);
      if (bucket) bucket.push(entry);
      else navigation.colliderIndex.cells.set(key, [entry]);
    }
  }
  navigation.colliderIndex.entriesByCollider.set(collider, entry);
  navigation.colliders.push(collider);
  return true;
};

const removeColliderFromIndex = (navigation, collider) => {
  const index = navigation.colliderIndex;
  const entry = index?.entriesByCollider.get(collider);
  if (!entry) return false;
  const { box } = entry;
  for (let x = Math.floor(box.minX / INDEX_CELL); x <= Math.floor(box.maxX / INDEX_CELL); x++) {
    for (let y = Math.floor(box.minY / INDEX_CELL); y <= Math.floor(box.maxY / INDEX_CELL); y++) {
      const key = `${x},${y}`;
      const bucket = index.cells.get(key);
      if (!bucket) continue;
      const at = bucket.indexOf(entry);
      if (at >= 0) bucket.splice(at, 1);
      if (!bucket.length) index.cells.delete(key);
    }
  }
  index.entriesByCollider.delete(collider);
  const at = navigation.colliders.indexOf(collider);
  if (at >= 0) navigation.colliders.splice(at, 1);
  return true;
};

const replaceIndexedColliders = (navigation, remove, add) => {
  for (const collider of remove ?? []) removeColliderFromIndex(navigation, collider);
  for (const collider of add ?? []) addColliderToIndex(navigation, collider);
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
  navigation.pathfinding.linksByRadius.clear();
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
    pathfinding: { blockedCellsByRadius: new Map(), linksByRadius: new Map() },
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
  const previous = group.on ? group.onColliders : group.offColliders;
  const next = on ? group.onColliders : group.offColliders;
  group.on = on;
  replaceIndexedColliders(navigation, previous, next);
  invalidatePathfinding(navigation);
  return true;
};

/** Adds an actor-backed obstacle such as a smashable barrel or wooden box. */
export const addNavigationObstacle = (navigation, id, colliders) => {
  if (!navigation || !colliders?.length) return false;
  const previous = navigation.obstacles.get(id) ?? [];
  replaceIndexedColliders(navigation, previous, colliders);
  navigation.obstacles.set(id, [...colliders]);
  invalidatePathfinding(navigation);
  return true;
};

/** Removes an actor-backed obstacle when the corresponding object is destroyed. */
export const removeNavigationObstacle = (navigation, id) => {
  const colliders = navigation?.obstacles.get(id);
  if (!colliders) return false;
  replaceIndexedColliders(navigation, colliders, []);
  navigation.obstacles.delete(id);
  invalidatePathfinding(navigation);
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

/** Inside the floor's bounds and on one of its tiles; colliders aside. */
const isWithinFloor = (navigation, point, radius) => {
  const { bounds } = navigation;
  return (
    point.x - radius >= bounds.minX &&
    point.x + radius <= bounds.maxX &&
    point.y - radius >= bounds.minY &&
    point.y + radius <= bounds.maxY &&
    isOnAuthoredTile(navigation, point)
  );
};

/** How far an actor circle reaches into one collider; 0 or less when it does not. */
const depthInto = (point, radius, collider) => {
  if (collider.type === "circle") {
    return radius + collider.radius - Math.sqrt(squaredDistance(point, collider));
  }
  if (collider.type !== "rectangle") return 0;
  const cosine = Math.cos(-collider.angle);
  const sine = Math.sin(-collider.angle);
  const offsetX = point.x - collider.x;
  const offsetY = point.y - collider.y;
  const localX = offsetX * cosine - offsetY * sine;
  const localY = offsetX * sine + offsetY * cosine;
  const outsideX = Math.abs(localX) - collider.halfWidth;
  const outsideY = Math.abs(localY) - collider.halfHeight;
  if (outsideX <= 0 && outsideY <= 0) return radius - Math.max(outsideX, outsideY);
  return radius - Math.hypot(Math.max(0, outsideX), Math.max(0, outsideY));
};

/** The colliders whose boxes an actor circle at `point` could reach, through the index when there is one. */
const collidersNear = (navigation, point, radius, { ignoredColliders } = {}) => {
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
      for (const entry of index.get(`${x},${y}`) ?? []) {
        if (!ignoredColliders?.has(entry.collider) && reaches(entry.box)) found.add(entry.collider);
      }
    }
  }
  return [...found];
};

/** The way out of a collider's surface nearest `point`, as a unit vector; null inside its core. */
const surfaceNormal = (point, collider) => {
  if (collider.type === "circle") {
    const dx = point.x - collider.x;
    const dy = point.y - collider.y;
    const length = Math.hypot(dx, dy);
    return length < 0.001 ? null : { x: dx / length, y: dy / length };
  }
  const cosine = Math.cos(-collider.angle);
  const sine = Math.sin(-collider.angle);
  const offsetX = point.x - collider.x;
  const offsetY = point.y - collider.y;
  const localX = offsetX * cosine - offsetY * sine;
  const localY = offsetX * sine + offsetY * cosine;
  const dx = localX - Math.max(-collider.halfWidth, Math.min(collider.halfWidth, localX));
  const dy = localY - Math.max(-collider.halfHeight, Math.min(collider.halfHeight, localY));
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return null;
  const worldCosine = Math.cos(collider.angle);
  const worldSine = Math.sin(collider.angle);
  return {
    x: (dx * worldCosine - dy * worldSine) / length,
    y: (dx * worldSine + dy * worldCosine) / length,
  };
};

/**
 * A refused step, turned to run along the surface it hit.
 *
 * Axis slides alone cannot get round anything round: a body walking straight
 * at a statue's circle, or at a slanted box, is refused on both axes and stands
 * against it for good. The step keeps its part along the collider it would
 * reach deepest into and loses the part into it.
 */
const slideAlongSurface = (navigation, position, step, radius, options) => {
  const attempted = { x: position.x + step.x, y: position.y + step.y };
  let deepest = null;
  let deepestDepth = 0;
  for (const collider of collidersNear(navigation, attempted, radius, options)) {
    const depth = depthInto(attempted, radius, collider);
    if (depth > deepestDepth) {
      deepest = collider;
      deepestDepth = depth;
    }
  }
  const normal = deepest && surfaceNormal(position, deepest);
  if (!normal) return null;
  const into = step.x * normal.x + step.y * normal.y;
  if (into >= 0) return null;
  const along = { x: step.x - into * normal.x, y: step.y - into * normal.y };
  if (Math.hypot(along.x, along.y) < 0.01) return null;
  const slid = { x: position.x + along.x, y: position.y + along.y };
  return isPositionBlocked(navigation, slid, radius, options) ? null : slid;
};

/** Each collider an actor reaches into and its penetration depth. */
const penetrationsAt = (navigation, point, radius, options) => {
  const penetrations = new Map();
  for (const collider of collidersNear(navigation, point, radius, options)) {
    const depth = depthInto(point, radius, collider);
    if (depth > 0) penetrations.set(collider, depth);
  }
  return penetrations;
};

/** True when an actor circle would overlap authored navigation geometry. */
export const isPositionBlocked = (
  navigation,
  point,
  radius = 0,
  { ignoredColliders } = {}
) => {
  if (!navigation) return false;
  if (!isWithinFloor(navigation, point, radius)) return true;

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

/** The active colliders of every trigger group one of `colliders` belongs to: the whole cage. */
const cagesHolding = (navigation, colliders) => {
  const cage = new Set();
  for (const group of navigation.triggerGroups.values()) {
    const active = group.on ? group.onColliders : group.offColliders;
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
  const localX = offsetX * cosine - offsetY * sine;
  const localY = offsetX * sine + offsetY * cosine;
  const gap = radius + RELEASE_STEP;
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

/**
 * Where in a cell a body may stand, nearest its centre first, in fractions of
 * the cell: a 5 by 5 lattice, 12 units apart on the usual 60-unit cell.
 */
/**
 * How far an anchor keeps clear of what it stands beside. At exactly a body's
 * width the walk to it rounds a hair into the wall and every step is refused.
 */
const ANCHOR_MARGIN = 2;

/** A link between two anchors needing no corner; shared, since most are. */
const DIRECT_LINK = Object.freeze({ via: null });

const ANCHOR_OFFSETS = (() => {
  const steps = [-0.4, -0.2, 0, 0.2, 0.4];
  return steps
    .flatMap((dx) => steps.map((dy) => [dx, dy]))
    .sort(([ax, ay], [bx, by]) => ax * ax + ay * ay - (bx * bx + by * by));
})();

/**
 * A* over the authored floor collision geometry, returning compressed world waypoints.
 *
 * A cell is open when a body fits somewhere in it, not only at its centre, and
 * the route runs through that spot — the cell's anchor. Asking the centre alone
 * closed any gap the grid happened to straddle: a doorway a knight fits with 26
 * units to spare was found at 9 of 20 alignments to the grid, and the monster
 * stood at it, "blocked", with the player on the other side. Anchors find a gap
 * 12 units wider than the body at every alignment. An open floor costs what it
 * did, since a cell whose centre is clear stops there; the extra probes are
 * spent in cells against a wall.
 */
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
  /**
   * Per radius, per cell: 0 not yet asked, 1 shut, 2 open at its centre, 3 open
   * off-centre, with the off-centre anchors beside it. Arrays rather than maps,
   * since the search asks about every neighbour of every cell it opens.
   */
  let cells = navigation.pathfinding.blockedCellsByRadius.get(radiusKey);
  if (!cells || cells.state.length !== columns * rows) {
    cells = { state: new Uint8Array(columns * rows), anchors: new Map() };
    navigation.pathfinding.blockedCellsByRadius.set(radiusKey, cells);
  }
  const SHUT = 1;
  const CENTRED = 2;
  const stateOf = (x, y) => {
    const key = keyFor(x, y);
    if (cells.state[key] === 0) {
      const centreX = bounds.minX + x * cellSize + cellSize / 2;
      const centreY = bounds.minY + y * cellSize + cellSize / 2;
      cells.state[key] = SHUT;
      for (const [dx, dy] of ANCHOR_OFFSETS) {
        const point = { x: centreX + dx * cellSize, y: centreY + dy * cellSize };
        if (isPositionBlocked(navigation, point, radius + ANCHOR_MARGIN)) continue;
        if (dx === 0 && dy === 0) {
          cells.state[key] = CENTRED;
        } else {
          cells.state[key] = 3;
          cells.anchors.set(key, point);
        }
        break;
      }
    }
    return cells.state[key];
  };
  /** Where a body can stand in this cell, or null when nowhere in it. */
  const anchorOf = (x, y) => {
    const state = stateOf(x, y);
    if (state === SHUT) return null;
    return state === CENTRED ? toWorld(x, y) : cells.anchors.get(keyFor(x, y));
  };
  const blocked = (x, y) => stateOf(x, y) === SHUT;
  /**
   * How to get from one cell's anchor to its neighbour's: `{ via }`, or null
   * when a body cannot.
   *
   * The step between two anchors has to be walkable, centres included: a thin
   * slanted board can run between two clear centres. Answers are kept per
   * radius until the floor's colliders change, so each is worked out once. When
   * the straight step clips the wall — the
   * anchor in a doorway sits to one side of the centres above and below it — a
   * right-angled one is tried through either corner of the pair, which is the
   * walk into a doorway and out of it.
   */
  const linkCache = navigation.pathfinding.linksByRadius.get(radiusKey) ?? new Map();
  navigation.pathfinding.linksByRadius.set(radiusKey, linkCache);
  const linkBetween = (from, to) => {
    const linkKey = keyFor(from.x, from.y) * columns * rows + keyFor(to.x, to.y);
    if (!linkCache.has(linkKey)) linkCache.set(linkKey, walkBetween(from, to));
    return linkCache.get(linkKey);
  };
  const walkBetween = (from, to) => {
    const a = anchorOf(from.x, from.y);
    const b = anchorOf(to.x, to.y);
    if (hasLineOfSight(navigation, a, b, radius)) return DIRECT_LINK;
    for (const corner of [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]) {
      if (
        !isPositionBlocked(navigation, corner, radius) &&
        hasLineOfSight(navigation, a, corner, radius) &&
        hasLineOfSight(navigation, corner, b, radius)
      ) {
        return { via: corner };
      }
    }
    return null;
  };
  const viaInto = new Map();

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
      // A start cell with no anchor holds no body but this one, which is already
      // there; one that has an anchor is left through it like any other.
      let via = null;
      if (current.key !== startKey || !blocked(startCell.x, startCell.y)) {
        const link = linkBetween(current, { x, y });
        if (!link) continue;
        via = link.via;
      }

      const key = keyFor(x, y);
      const nextCost = cost.get(current.key) + stepCost;
      if (nextCost >= (cost.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      cost.set(key, nextCost);
      cameFrom.set(key, current.key);
      viaInto.set(key, via);
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
    const anchor = anchorOf(key % columns, Math.floor(key / columns));
    raw.unshift({ x: anchor.x, y: anchor.y });
    const via = viaInto.get(key);
    if (via) raw.unshift({ ...via });
    key = cameFrom.get(key);
    if (key === undefined) return [];
  }
  /**
   * The body's own cell first. It stands somewhere in that cell, not at its
   * anchor, and in a doorway the step from where it stands to the next cell can
   * clip the wall the anchor is clear of. Dropped below when it can be seen past.
   */
  if (!blocked(startCell.x, startCell.y)) {
    const anchor = anchorOf(startCell.x, startCell.y);
    raw.unshift({ x: anchor.x, y: anchor.y });
  }

  const compressed = [];
  let anchor = start;
  let index = 0;
  while (index < raw.length) {
    let farthest = -1;
    for (let candidate = raw.length - 1; candidate >= index; candidate--) {
      if (hasLineOfSight(navigation, anchor, raw[candidate], radius)) {
        farthest = candidate;
        break;
      }
    }
    // Not even the next point can be walked to: this is no route, and handing
    // it out would send the body through whatever is in the way.
    if (farthest < 0) return [];
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

/**
 * Applies a swept move, falling back to axis sliding when separation nudges into a wall.
 *
 * A body already in the scenery may still move out of it. A step that ends
 * blocked is refused, and for a body that starts blocked every step does: a
 * knight left 19 units into a jail by its release, a monster a closing gate
 * came down on, a cage member whose exit was given up on — each stood where it
 * was for the rest of the floor, facing a player it could see. So a step is
 * also taken when it leaves the body less buried than it was. It never lets a
 * body into anything: it only lets one out.
 */
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

    // Asked only once a step is refused: this is the hot path.
    const buried =
      isPositionBlocked(navigation, position, radius, options) &&
      isWithinFloor(navigation, position, radius)
        ? penetrationsAt(navigation, position, radius, options)
        : new Map();
    const canStand = (point) => {
      if (!isPositionBlocked(navigation, point, radius, options)) return true;
      if (!buried.size || !isWithinFloor(navigation, point, radius)) return false;

      const next = penetrationsAt(navigation, point, radius, options);
      let improved = false;
      for (const [collider, depth] of next) {
        const before = buried.get(collider);
        // Escaping one wall never pays for entering another or moving deeper
        // into a wall the body was already touching.
        if (before === undefined || depth > before + 0.01) return false;
        if (depth < before - 0.01) improved = true;
      }
      for (const collider of buried.keys()) {
        if (!next.has(collider)) improved = true;
      }
      return improved;
    };
    if (buried.size && canStand(full)) {
      position.x = full.x;
      position.y = full.y;
      continue;
    }
    const slid = buried.size ? null : slideAlongSurface(navigation, position, step, radius, options);
    if (slid) {
      position.x = slid.x;
      position.y = slid.y;
      continue;
    }

    const xOnly = { x: position.x + step.x, y: position.y };
    const yOnly = { x: position.x, y: position.y + step.y };
    const canX = canStand(xOnly);
    const canY = canStand(yOnly);
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
  { reach = 240, reachableFrom = null, towards = null, accept = () => true } = {}
) => {
  if (!navigation || !origin) return null;
  const isClear = (candidate) =>
    !isPositionBlocked(navigation, candidate, radius) && accept(candidate);
  if (isClear(origin)) return origin;

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
        if (!isClear(candidate)) continue;
        return candidate;
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

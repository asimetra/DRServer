import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { buildColliderIndex, replaceIndexedColliders } from "./collider-index.js";
import { invalidatePathfinding } from "./route-cache.js";

/**
 * A floor's navigation: the collision library, and the per-session state built
 * from a floor's definition — static colliders, trigger groups, obstacles, the
 * index over the active set, and the revision that tells a route it may be
 * stale. The questions asked of that state are answered by the modules
 * re-exported at the end, which with this file are the API the rest of the
 * server imports from here:
 *
 * - geometry.js        one collider's shape: box, overlap, depth, normal
 * - collider-index.js  the active colliders, bucketed for nearby queries
 * - tiles.js           the tiles the floor laid
 * - clearance.js       point and swept-line tests against the whole floor
 * - route-cache.js     the route search's per-radius answers and their forgetting
 * - pathfind.js        findPath
 * - movement.js        moveWithNavigation, nearestClearPosition
 * - cage-release.js    findCageReleasePath
 *
 * Each of them imports only those above it in the list, and none imports this
 * file.
 */

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
 *
 * At the size the actor is drawn, as its radius is (body.js): the client
 * builds the circle from the actor's own transform, so the offset scales
 * with it. `actor.scale` is the scale it was generated at; one that carries
 * none is taken at 1. Over about 472,000 official monster samples in 39 rows,
 * the offset that best keeps the body out of the walls, divided by the row's
 * `Scale`, is -21.5 to -22.1 for every row; KNIGHT_HALBERD (Scale 1.2) is in
 * the walls on 3.0% of samples at -24, 0.03% at -26 and 4.1% at -30, and on
 * 5.2% at the unscaled -22. Heroes the same: GHOST_SAMURAI fits best at -26,
 * which is -22 x 1.176.
 */
export const bodyOffsetOf = (actor) => {
  const shape = navigationEntryFor(actor?.constant)?.navCollisions?.[0];
  if (!shape) return null;
  const scale = Number(actor.scale) > 0 ? Number(actor.scale) : 1;
  return { x: Number(shape.x ?? 0) * scale, y: Number(shape.y ?? 0) * scale };
};

export const collisionPointOf = (actor, position) => {
  const offset = bodyOffsetOf(actor);
  if (!offset || !position) return position;
  return { x: position.x + offset.x, y: position.y + offset.y };
};

const activeTriggerColliders = (navigation) => {
  const colliders = [];
  for (const group of navigation.triggerGroups.values()) {
    colliders.push(...(group.on ? group.onColliders : group.offColliders));
  }
  return colliders;
};

const rebuildActiveColliders = (navigation) => {
  navigation.colliders = [
    ...navigation.staticColliders,
    ...activeTriggerColliders(navigation),
    ...[...navigation.obstacles.values()].flat(),
  ];
  buildColliderIndex(navigation);
};

/** Creates mutable per-session state from a cached floor navigation definition. */
export const createNavigationState = (definition) => {
  if (!definition) return null;

  const navigation = {
    bounds: { ...definition.bounds },
    cellSize: definition.cellSize ?? DEFAULT_CELL_SIZE,
    tileSize: definition.tileSize ?? 900,
    tileKeys: new Set((definition.tiles ?? []).map((tile) => `${tile.x},${tile.y}`)),
    // `tileKeys` laid out flat for the collision tests, built on first use.
    tileGrid: null,
    staticColliders: [...(definition.staticColliders ?? [])],
    triggerGroups: new Map(),
    obstacles: new Map(),
    colliders: [],
    revision: 0,
    // A route search lazily records, per actor radius, which grid cells are
    // open and which steps between neighbours can be walked, so later NPCs do
    // not repeat the same collider checks. A collider change forgets only the
    // answers near it: see invalidatePathfinding, route-cache.js.
    pathfinding: { byRadius: new Map() },
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
  invalidatePathfinding(navigation, [...previous, ...next]);
  return true;
};

/** Adds an actor-backed obstacle such as a smashable barrel or wooden box. */
export const addNavigationObstacle = (navigation, id, colliders) => {
  if (!navigation || !colliders?.length) return false;
  const previous = navigation.obstacles.get(id) ?? [];
  replaceIndexedColliders(navigation, previous, colliders);
  navigation.obstacles.set(id, [...colliders]);
  invalidatePathfinding(navigation, [...previous, ...colliders]);
  return true;
};

/** Removes an actor-backed obstacle when the corresponding object is destroyed. */
export const removeNavigationObstacle = (navigation, id) => {
  const colliders = navigation?.obstacles.get(id);
  if (!colliders) return false;
  replaceIndexedColliders(navigation, colliders, []);
  navigation.obstacles.delete(id);
  invalidatePathfinding(navigation, colliders);
  return true;
};

export { findCageReleasePath } from "./cage-release.js";
export { hasLineOfSight, isPositionBlocked } from "./clearance.js";
export { moveWithNavigation, nearestClearPosition } from "./movement.js";
export { findPath } from "./pathfind.js";
export { isOnAuthoredTile, segmentStaysOnAuthoredTiles } from "./tiles.js";

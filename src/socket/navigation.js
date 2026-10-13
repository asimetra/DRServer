import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { buildColliderIndex, replaceIndexedColliders } from "./collider-index.js";
import { activeCollidersOf } from "./navigation-objects.js";
import { invalidatePathfinding } from "./route-cache.js";

/**
 * A floor's navigation: the collision library, and the per-session state built
 * from a floor's definition — static colliders, every object's record (see
 * "Every object's colliders" below), the index over the active set, and the
 * revision that tells a route it may be stale. The questions asked of that state are answered by the modules
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
  let byScale = offsetsByShape.get(shape);
  if (!byScale) offsetsByShape.set(shape, (byScale = new Map()));
  let offset = byScale.get(scale);
  if (!offset) {
    offset = Object.freeze({ x: Number(shape.x ?? 0) * scale, y: Number(shape.y ?? 0) * scale });
    byScale.set(scale, offset);
  }
  return offset;
};
/** Each shape's offset at each scale, worked out once: asked for every body near every monster every tick, and never changed (frozen). */
const offsetsByShape = new WeakMap();

/**
 * Where an actor's body is: its feet moved by its shape's offset.
 *
 * `into` is for the loops that ask this of every actor many times a second
 * and only read the answer: the point is written into it rather than made.
 * The hazard grid asks it of every trap victim each contact tick and a flying
 * shot of every actor on the other side; in the sim:ai run measured at
 * `eachTrapVictim` (trap-attacks.js) writing instead of making took the
 * grid's sampled garbage from 2.4 to 1.5 GB and the shots' from 1.3 to
 * 0.4 GB. Without an offset the feet are the answer either way, and are
 * returned as they are.
 */
export const collisionPointOf = (actor, position, into = null) => {
  const offset = bodyOffsetOf(actor);
  if (!offset || !position) return position;
  const x = position.x + offset.x;
  const y = position.y + offset.y;
  if (!into) return { x, y };
  into.x = x;
  into.y = y;
  return into;
};

/**
 * Every object's colliders, owned by one record over its life.
 *
 * An object with a shape in the floor — a gate the wiring opens, a spike bed,
 * a barricade, a smashable prop, a secret wall — has one record, keyed by
 * what addresses it (a triggerable's placement id, an actor's doid), holding
 * the shapes it has `on` and `off` and the stage of its life it is at:
 *
 *   on      standing, its `on` shapes (NPCGameObject's navCollisions)
 *   off     switched off by its wiring, its `off` shapes (navCollisions_off)
 *   broken  killed but kept: a `PermCorpse` row — a gate, a secret wall —
 *           stands broken, its `off` shapes, until the floor ends; the
 *           official switches its trigger state to 0 and never sends it dead
 *           (158 of 158 such deaths in its captures)
 *   gone    killed and taken away: a barricade, a defence orb, a killable
 *           trap, a smashed prop or cage; nothing (the official sends its
 *           barricades, orbs and catacomb tomb and statue traps dead and
 *           destroys them at once, 174 of 174)
 *
 * `wired` marks the floor's triggerables, the records its wiring switches
 * (`setNavigationTriggerState`) and the cages a generator's prisoners walk
 * out of (cage-release.js). Broken and gone are for good: the wiring no
 * longer moves them.
 */
const rebuildActiveColliders = (navigation) => {
  navigation.colliders = [
    ...navigation.staticColliders,
    ...[...navigation.objects.values()].flatMap(activeCollidersOf),
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
    objects: new Map(),
    colliders: [],
    revision: 0,
    // A route search lazily records, per actor radius, which grid cells are
    // open and which steps between neighbours can be walked, so later NPCs do
    // not repeat the same collider checks. A collider change forgets only the
    // answers near it: see invalidatePathfinding, route-cache.js.
    pathfinding: { byRadius: new Map() },
  };

  for (const [id, group] of definition.triggerColliders ?? []) {
    navigation.objects.set(id, {
      on: [...(group.onColliders ?? [])],
      off: [...(group.offColliders ?? [])],
      state: (group.initialOn ?? true) ? "on" : "off",
      wired: true,
    });
  }
  rebuildActiveColliders(navigation);
  return navigation;
};

/**
 * Puts `record` in as the object's, its colliders with it. Every collider
 * change ends here, and each forgets the
 * routes near what changed (`invalidatePathfinding`), so a trap toggling or a
 * wall breaking sends the monsters near it searching again.
 */
const changeObject = (navigation, id, record) => {
  const before = navigation.objects.get(id);
  const previous = before ? activeCollidersOf(before) : [];
  const current = activeCollidersOf(record);
  if (record.state === "gone") navigation.objects.delete(id);
  else navigation.objects.set(id, record);
  replaceIndexedColliders(navigation, previous, current);
  invalidatePathfinding(navigation, [...previous, ...current]);
  return true;
};

/** Keeps server pathing in sync with NPCGameObject.triggerState: a wired object switched on or off. */
export const setNavigationTriggerState = (navigation, id, on) => {
  const record = navigation?.objects?.get(id);
  if (!record?.wired || (record.state !== "on" && record.state !== "off")) return false;
  const state = on ? "on" : "off";
  if (record.state === state) return false;
  return changeObject(navigation, id, { ...record, state });
};

/**
 * Puts an actor's shape in the floor as it is generated — a smashable barrel,
 * a wooden box, a gate, a secret wall: standing on `colliders`, `off` the
 * shapes it is left with if it breaks and stays (`retireNavigationObject`).
 */
export const addNavigationObstacle = (navigation, id, colliders, off = []) => {
  if (!navigation || !colliders?.length) return false;
  return changeObject(navigation, id, { on: [...colliders], off: [...off], state: "on", wired: false });
};

/** Takes an actor's shape out of the floor. */
export const removeNavigationObstacle = (navigation, id) => {
  const record = navigation?.objects?.get(id);
  if (!record || record.wired) return false;
  return changeObject(navigation, id, { ...record, state: "gone" });
};

/**
 * What is left of an object once it is killed: `broken` it stays as its off
 * shapes until the floor ends, otherwise it is gone. The one call for a
 * death, whatever placed the object.
 */
export const retireNavigationObject = (navigation, id, { broken = false } = {}) => {
  const record = navigation?.objects?.get(id);
  if (!record || record.state === "broken") return false;
  return changeObject(navigation, id, { ...record, state: broken ? "broken" : "gone" });
};

export { activeCollidersOf } from "./navigation-objects.js";
export { findCageReleasePath } from "./cage-release.js";
export { hasLineOfSight, isPositionBlocked } from "./clearance.js";
export { moveWithNavigation, nearestClearPosition } from "./movement.js";
export { cellAnchorAt, findPath } from "./pathfind.js";
export { isOnAuthoredTile, segmentStaysOnAuthoredTiles } from "./tiles.js";

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { envSetting } from "../env.js";
import { generateFloor } from "./tilegen.js";
import { sealedRooms } from "./secrets.js";
import {
  mapNode,
  coliseumTier,
  customMap,
  npcForConstant,
  propForConstant,
} from "../gamemaster.js";
import { readJsonFile } from "../json-file.js";
import { loadNavigationLibrary } from "./navigation.js";
import { info, warn } from "../log.js";

/**
 * Floor layouts ship with the client. `Resources/Levels/<theme>/<area>/
 * db_floor_*.json` holds a `tileLibrary` path plus a `tiles` array of
 * `{ type, tileId, x, y }`, which is exactly the DungeonTileUsage shape the
 * server streams over the wire — so a first pass can forward one verbatim
 * instead of generating anything.
 */

const floorCatalog = readJsonFile(config.floorCatalogFile);

// The collision library is navigation's; it describes actors as well as walls.


const degreesToRadians = (degrees = 0) => (degrees * Math.PI) / 180;

/**
 * Which way a placed object actually faces.
 *
 * A tile mirrors an object with `flip` rather than by turning it, so a wall trap
 * aiming left and one aiming right are the same rotation and differ only in a
 * boolean. Sending the rotation alone pointed a quarter of the game's wall traps
 * — 74 of 284 — at the wall behind them, and they looked identical to the ones
 * that worked, because the mirroring is the only difference.
 *
 * The official server bakes it in: a capture generates the ice caves' flipped
 * gargoyle at `heading 180, flip 1` against a tile that says rotation 0. So the
 * flip still crosses the wire for the artwork, and the heading carries the
 * facing. Mirroring across the vertical axis is `180 - rotation`, which leaves
 * the ones firing along Y untouched — as it should, since mirroring left for
 * right does not change what points down.
 */
export const facingOf = (object) => {
  const rotation = Number(object.rotation ?? 0);
  if (!object.flip) return object.rotation;
  return ((180 - rotation) % 360 + 360) % 360;
};

/** Mirrors FloorObject's scale/flip/rotation transform for authored colliders. */
const transformColliders = (object, worldPosition, colliders = []) => {
  const objectAngle = degreesToRadians(object.rotation ?? 0);
  const objectCosine = Math.cos(objectAngle);
  const objectSine = Math.sin(objectAngle);
  const scale = Number.isFinite(object.scale) ? object.scale : 1;
  const scaleX = object.flip ? -scale : scale;
  const scaleY = scale;

  return colliders.map((collider) => {
    const localX = (collider.x ?? 0) * scaleX;
    const localY = (collider.y ?? 0) * scaleY;
    const center = {
      x: worldPosition.x + localX * objectCosine - localY * objectSine,
      y: worldPosition.y + localX * objectSine + localY * objectCosine,
    };

    if (collider.type === "circle") {
      return {
        type: "circle",
        ...center,
        radius: Math.abs((collider.radius ?? 0) * scale),
      };
    }

    const localAngle = degreesToRadians(collider.rotation ?? 0);
    const localAxisX = Math.cos(localAngle) * scaleX;
    const localAxisY = Math.sin(localAngle) * scaleY;
    const worldAxisX = localAxisX * objectCosine - localAxisY * objectSine;
    const worldAxisY = localAxisX * objectSine + localAxisY * objectCosine;
    return {
      type: "rectangle",
      ...center,
      halfWidth: Math.abs((collider.halfWidth ?? 0) * scale),
      halfHeight: Math.abs((collider.halfHeight ?? 0) * scale),
      angle: Math.atan2(worldAxisY, worldAxisX),
    };
  });
};

/** Collision geometry keeps where it came from for audit/selective enforcement. */
const sourcedColliders = (object, worldPosition, colliders, sourceKind, sourceState = null) =>
  transformColliders(object, worldPosition, colliders).map((collider) => ({
    ...collider,
    sourceKind,
    sourceConstant: object.constant ?? "",
    sourceState,
  }));

/**
 * The constant on the proximity trigger that ends a floor.
 *
 * Every theme library carries these — 63 in nordic/caves, 23 in castle/arena —
 * and they sit on EXIT_TILE tiles. Reaching one is what advances the dungeon:
 * clearing a floor only opens the gate in front of it.
 */
export const EXIT_TRIGGER = "JASONS_DUNGEON_EXIT";

/**
 * The generator whose clearing ends the floor — the one holding the boss
 * reward.
 *
 * Found by following the wiring rather than by matching a constant: a reward
 * generator is simply one whose signal reaches a FLOOR_COMPLETION_IMMEDIATE.
 * That holds whatever the tile calls its chest, which is the point, since the
 * nine theme libraries do not agree on names.
 */
export const rewardGeneratorIds = (floor) => {
  const completions = new Set(
    (floor.placements?.triggerable ?? [])
      .filter((triggerable) => triggerable.constant === "FLOOR_COMPLETION_IMMEDIATE")
      .map((triggerable) => triggerable.id)
  );
  if (!completions.size) return new Set();

  const reaches = (id, depth = 0, seen = new Set()) => {
    if (depth > 8 || seen.has(id)) return false;
    seen.add(id);
    for (const target of floor.wiring.get(id) ?? []) {
      if (completions.has(target)) return true;
      if (reaches(target, depth + 1, seen)) return true;
    }
    return false;
  };

  return new Set(
    (floor.placements?.generator ?? [])
      .filter((generator) => reaches(generator.id))
      .map((generator) => generator.id)
  );
};

/** Where this floor ends, in world coordinates. Empty on a final floor. */
export const exitsOf = (floor) =>
  (floor.placements?.trigger ?? []).filter((trigger) => trigger.constant === EXIT_TRIGGER);

/**
 * Reads the tile library and resolves everything the client deliberately skips.
 *
 * TileFactory.buildingProp ignores LEHeroSpawnProp, LENPC, LENPCGenerator and
 * LECollectable outright (`tile.ignoredAProp()`) — those are the server's job.
 * So spawn points and monster placements have to be read here and turned into
 * distributed objects, or the dungeon renders as scenery with nobody in it.
 *
 * Object coordinates are tile-local; world position is simply
 * `tile.position + object.position` (Prop.parseFromTileJson).
 */
/**
 * How each server-owned object type is turned into a placement record. Adding
 * support for a new type means adding one entry here and one builder in
 * dungeon.js — nothing else needs to know about it.
 */
/**
 * Whether an `LEProp` names something only the server can put on the floor.
 *
 * Cached because a library asks the same question for thousands of objects and
 * the answer is a property of the game master, not of the tile.
 */
const serverOwnedPropCache = new Map();
const serverOwnedProp = async (constant) => {
  if (!constant) return false;
  if (serverOwnedPropCache.has(constant)) return serverOwnedPropCache.get(constant);
  const owned = !(await propForConstant(constant)) && Boolean(await npcForConstant(constant));
  serverOwnedPropCache.set(constant, owned);
  return owned;
};

const PLACEMENT_READERS = {
  LEHeroSpawnProp: (object, at) => ({ kind: "heroSpawn", ...at }),

  LENPC: (object, at) => ({
    kind: "npc",
    ...at,
    // Kept because an NPC_LIFE_TRIGGER names its subject by this id.
    id: object.id,
    constant: object.constant,
    /**
     * A name, if this one is meant to be able to talk. Read here so a map can
     * say "this one has a voice" without knowing what talking is — see
     * socket/speech.js, which is the only place that decides.
     */
    voice: object.voice,
    /**
     * The hero constant a speaker wears, if it is meant to be talked to rather
     * than looked at. A speaker with a body shows a chat balloon and a nametag;
     * one without is a line in a log that is usually closed. It costs the
     * monster artwork, so the map decides — see socket/speech.js.
     */
    voiceHero: object.voiceHero,
  }),

  LECollectable: (object, at) => ({
    kind: "collectable",
    ...at,
    constant: object.constant,
  }),

  LENPCGenerator: (object, at) => ({
    kind: "generator",
    ...at,
    id: object.id,
    /**
     * Either a real NPC constant (KNIGHT, LION…) or a role placeholder
     * (FODDER/BRUISER/MINIBOSS) resolved per dungeon — see gamemaster.js.
     */
    spawnConstant: object.spawnConstant,
    maxPopulation: object.maxPopulation ?? 1,
    maxSpawns: object.maxSpawns ?? 1,
    spawnInterval: object.spawnInterval ?? 1,
    clearsOnAllDead: false,
  }),

  /**
   * Gates, jails and traps. Despite the name these are not the visible doors'
   * logic — they *are* the doors: CASTLE_ARENA_GATE_A and friends resolve to
   * GameMaster NPC rows with CharType PROP, so they spawn like any other actor.
   *
   * TileFactory handles exactly one constant here (SEND_LOCAL_CLIENT_EVENT,
   * which registers a local event) and silently drops the rest, which is why
   * nothing appeared where the doors should be.
   */
  LETriggerable: (object, at) =>
    object.constant === "SEND_LOCAL_CLIENT_EVENT"
      ? null
      : {
          kind: "triggerable",
          ...at,
          id: object.id,
          constant: object.constant,
          // Locale key for FLOOR_MESSAGE_TRIGGERABLE, empty on the rest.
          textKey: object.textKey || undefined,
        },

  /**
   * Proximity sensors. The client only builds these for one constant
   * (PROXIMITY_LOCAL_HERO drives a purely local event); deciding that a trap or
   * gate should fire is the server's call, and it has the hero's position
   * already.
   */
  LETrigger: (object, at) => ({
    kind: "trigger",
    ...at,
    id: object.id,
    constant: object.constant,
    /**
     * NPC_LIFE_TRIGGER watches one specific actor and says which: the boss
     * tile's trigger carries the minotaur's own placement id. There is no
     * proximity involved, so guessing by radius would pick the wrong actor —
     * the trigger sits 216 units from a boss it covers with a radius of 150.
     */
    npcId: object.npcId,
    radius: object.radius ?? 150,
    startDelay: object.startDelay,
    intervalTime: object.intervalTime,
    /**
     * ASYM_AUTO_TIMER_TRIGGER's two halves, in place of `intervalTime`. A mace
     * hangs in its arc far longer than it rests — 3.5 against 0.5 in the ice
     * caves — and a symmetric timer cannot say that.
     */
    onTime: object.onTime,
    offTime: object.offTime,
    triggerOnce: object.triggerOnce ?? false,
    /**
     * What this place says to whoever walks into it.
     *
     * Deliberately not `textKey`, which everywhere else names a locale entry
     * the client looks up — an unknown one draws as "mia:WHATEVER". This is
     * literal, because it goes to the player over chat, which is the one text
     * channel that needs nothing installed on their side.
     *
     * None of the game's own tiles carry it, so no authored floor changes.
     */
    chatText: object.chatText,
    /**
     * Whose line it is. A trigger naming a speaker says its text as that
     * placement; without one it is the room speaking, which is the difference
     * between a keeper greeting you and a sign you have walked past.
     */
    speaker: object.speaker,
    /**
     * Whether hitting this again is another event. See reportNpcDamage: the
     * game's own damage triggers latch, and a thing meant to be knocked
     * repeatedly does not.
     */
    repeats: object.repeats ?? false,
    /**
     * A buff to put on this trigger's subject when it fires — the visual way of
     * saying "this one". The client draws it on the actor itself, pulsing its
     * body, and the HUD icon is inside an `isOwner` guard so marking a stone
     * never reaches the player's bar.
     */
    highlight: object.highlight,
    /**
     * Where this leads, if it is a doorway. A map names a destination node and
     * nothing here knows what going somewhere involves — see socket/doors.js.
     */
    destination: object.destination,
  }),

  /**
   * Boolean logic wiring — AND_GATE, NOT_GATE, OR_GATE, RESET_TIMER_GATE —
   * that connects triggers to triggerables. These are not drawable, but their
   * resting and runtime states drive doors, traps, generators and navigation.
   */
  LETriggerGate: (object, at) => ({
    kind: "logicGate",
    ...at,
    id: object.id,
    constant: object.constant,
    resetTime: object.resetTime,
    startDelay: object.startDelay,
    /**
     * How many rising inputs a `COUNTER_GATE` wants before it opens.
     *
     * Dropped here, it fell through to `gate.threshold ?? 1` in the runtime, so
     * both counter puzzles in the game opened on the first input instead of the
     * eighth. The catacombs author them as eight pressure zones feeding two and
     * four NPC generators — a room that should take a party spreading out
     * released its monsters as soon as anybody stepped on anything.
     */
    threshold: object.threshold,
    /**
     * Carried but only acted on where its meaning is established: a counter
     * that has finished counting stays finished. Six AND gates and one OR gate
     * in the catacombs also author it and what it means there — a latch, or a
     * single delivery — is not settled by anything measured yet, so
     * `evaluateGate` leaves them alone.
     */
    triggerOnce: object.triggerOnce,
  }),
};

PLACEMENT_READERS.LENPCGeneratorWithAllSpawnsDeadTrigger = (object, at) => ({
  ...PLACEMENT_READERS.LENPCGenerator(object, at),
  clearsOnAllDead: true,
});

/**
 * Exported so a client can rebuild the floor it was told about.
 *
 * The generate carries the library and the tile list, which is everything this
 * needs — so the probe can raise the same geometry the server is judging its
 * movement against, and walk around walls instead of through them.
 */
/**
 * Where a level file lives, ours before theirs.
 *
 * The content directory is not only for the client. This server reads a tile
 * library too — to work out what a floor is made of, which props block, which
 * monsters stand where — so if the client is handed an overridden library and
 * this side keeps reading the shipped one, the two disagree about the room the
 * player is standing in. One lookup, checked in one order, keeps them the same
 * file.
 *
 * Ours first because an override that loses to the original is not an override.
 */
export const levelsFile = (relative) => {
  const rest = String(relative).replace(/^Resources\/Levels\//, "").replace(/^Resources\//, "");
  const wanted = rest.startsWith("Levels/") ? rest : path.join("Levels", rest);
  if (config.contentDir) {
    const ours = path.join(config.contentDir, "Resources", wanted);
    if (existsSync(ours)) return ours;
  }
  return path.join(config.resourcesDir, wanted);
};

/**
 * The tile list the floor opens with: everything except the rooms being held
 * back. Each withheld tile goes on the wire later, appended to this list, when
 * the wall in its doorway breaks — see revealSecretRoom in dungeon.js.
 */
const visibleTiles = (tiles, secrets) => {
  const hidden = new Set(secrets.map((room) => room.tile));
  return hidden.size ? tiles.filter((tile) => !hidden.has(tile)) : tiles;
};

const emptyPlacements = () => ({
  heroSpawn: [],
  npc: [],
  collectable: [],
  generator: [],
  triggerable: [],
  trigger: [],
  logicGate: [],
});

/**
 * What a reveal rebuilds. The triggers and the hero spawn are left on the floor
 * whatever happens: the wiring is read once, at floor build, and a trigger shut
 * inside a room nobody can enter cannot fire anyway.
 */
const REVEALED_KINDS = new Set(["npc", "collectable", "generator", "triggerable"]);

export const readPlacements = async (libraryPath, tiles) => {
  const file = levelsFile(libraryPath);
  const library = JSON.parse(await fs.readFile(file, "utf8"));

  const definitionsById = new Map(library.LETiles.map((tile) => [tile.id, tile]));
  const navigationDefinitions = await loadNavigationLibrary();
  /**
   * The rooms this floor will not admit to having yet — see secrets.js. Their
   * placements are read exactly like everyone else's and then set aside, so
   * revealing one later is the same work as building it now, minus the wait.
   */
  const sealed = sealedRooms(definitionsById, tiles);
  const withheld = new Map(
    [...sealed].map(([instance, room]) => [instance, { ...room, placements: emptyPlacements() }])
  );
  const staticColliders = [];
  const triggerColliders = new Map();
  const byKind = emptyPlacements();

  /**
   * A placed tile brings its own object ids, and a layout places the same tile
   * more than once. Their ids are only unique *within* a definition, so two
   * copies of an arena tile hand the floor two buttons called 897.13140538 —
   * and every map keyed by placement id (`triggerableDoids`, `signalIncoming`,
   * `triggerableHazards`) silently keeps one of them. One arena layout comes
   * out with 163 placements holding 130 distinct ids: 33 traps and triggers
   * where one copy shadows the other, which is one button in a row of five
   * doing nothing while its neighbours work.
   *
   * Prefixing with the instance makes them distinct. The wiring survives it
   * because every one of the 7090 resolvable `LETriggers` links has both ends
   * inside one tile definition — no link crosses a tile — so a link applies to
   * each copy separately, with that copy's prefix on both ends.
   */
  const localId = (instance, id) => (id === undefined || id === null ? id : `${instance}:${id}`);
  const linksByDefinition = new Map();
  for (const link of library.LETriggers ?? []) {
    for (const definition of library.LETiles) {
      const ids = definition.LEObjects ?? [];
      if (!ids.some(({ id }) => id === link.triggerId || id === link.triggerableId)) continue;
      linksByDefinition.set(definition.id, [...(linksByDefinition.get(definition.id) ?? []), link]);
      break;
    }
  }

  const wiring = new Map();

  for (const [instance, tile] of tiles.entries()) {
    const definition = definitionsById.get(tile.tileId);
    if (!definition) continue;

    for (const link of linksByDefinition.get(definition.id) ?? []) {
      const source = localId(instance, link.triggerId);
      wiring.set(source, [...(wiring.get(source) ?? []), localId(instance, link.triggerableId)]);
    }

    const background = definition.LEBackground;
    const backgroundNavigation = background && navigationDefinitions.get(background.constant);
    if (backgroundNavigation?.navCollisions?.length) {
      staticColliders.push(
        ...sourcedColliders(
          background,
          {
            x: tile.x + (background.x ?? 0),
            y: tile.y + (background.y ?? 0),
          },
          backgroundNavigation.navCollisions,
          "LEBackground"
        )
      );
    }

    for (const object of definition.LEObjects ?? []) {
      const navigationEntry = navigationDefinitions.get(object.constant);
      const worldPosition = {
        x: tile.x + (object.x ?? 0),
        y: tile.y + (object.y ?? 0),
      };
      if (object.type === "LEProp" && navigationEntry?.navCollisions?.length) {
        staticColliders.push(
          ...sourcedColliders(
            object,
            worldPosition,
            navigationEntry.navCollisions,
            "LEProp"
          )
        );
      } else if (
        object.type === "LETriggerable" &&
        object.constant !== "SEND_LOCAL_CLIENT_EVENT" &&
        (navigationEntry?.navCollisions?.length || navigationEntry?.navCollisions_off?.length)
      ) {
        const group = triggerColliders.get(localId(instance, object.id)) ?? {
          onColliders: [],
          offColliders: [],
        };
        group.onColliders.push(
          ...sourcedColliders(
            object,
            worldPosition,
            navigationEntry.navCollisions,
            "LETriggerable",
            "on"
          )
        );
        group.offColliders.push(
          ...sourcedColliders(
            object,
            worldPosition,
            navigationEntry.navCollisions_off,
            "LETriggerable",
            "off"
          )
        );
        triggerColliders.set(localId(instance, object.id), group);
      }

      /**
       * An LEProp the client will not draw is the server's after all.
       *
       * `TileFactory.buildProp` calls `Prop.validatePropConstant`, which looks
       * the constant up in the *Prop* table and nowhere else. A miss is not a
       * fallback — it logs `invalid prop constant` and returns, so the object
       * is simply absent from the floor.
       *
       * Most of the time that never happens: 30 927 of the LEProp entries in
       * the libraries do have a Prop row. But 198 of them, across seventeen
       * constants, live in the *Npc* table instead — the caves' ice
       * stalagmites, its ground spikes and towers, the arena's chopper statue —
       * and the official generates every one of those as a distributed object.
       *
       * The same constants are also authored as LENPC elsewhere in the same
       * libraries (ICESTALAGMITE_A appears 46 times as one and 35 as the
       * other), which is why they were half-present and easy to miss: the
       * floors that used the LENPC spelling looked right.
       *
       * Read as an npc, because that is what the game master says it is.
       */
      const read =
        PLACEMENT_READERS[object.type] ??
        (object.type === "LEProp" && (await serverOwnedProp(object.constant))
          ? PLACEMENT_READERS.LENPC
          : null);
      if (!read) continue; // client-owned (LEProp, LEBackground, triggers…)

      const at = {
        x: tile.x + (object.x ?? 0),
        y: tile.y + (object.y ?? 0),
        // Server-owned actors are omitted by TileFactory, so their tile-local
        // visual transform has to cross the wire with their world position.
        // Leaving these behind makes wall traps float at heading zero.
        heading: facingOf(object),
        scale: object.scale,
        flip: object.flip ? 1 : 0,
        /**
         * Which scene-graph layer to draw on — `background`, `ground`,
         * `foreground`. The client reads it off the tile for everything it
         * builds itself (Prop.parseFromTileJson), so the objects it skips need
         * it forwarded or they all arrive on the default and a wall trap draws
         * behind its own flame.
         */
        layer: object.layer,
      };
      // `npcId` is an NPC_LIFE_TRIGGER naming its subject, and a triggerable's
      // `id` is what the wiring reaches it by — both are ids inside this tile,
      // so both take the instance prefix or they stop matching the placements.
      const placement = read(
        {
          ...object,
          id: localId(instance, object.id),
          ...(object.npcId === undefined ? {} : { npcId: localId(instance, object.npcId) }),
          // `speaker` names another placement in the same tile, so it takes the
          // prefix for the same reason `npcId` does. Without it a trigger points
          // at an id no placement has and the line loses its name.
          ...(object.speaker === undefined ? {} : { speaker: localId(instance, object.speaker) }),
        },
        at
      );
      if (placement) {
        // LENPC scenery is omitted by TileFactory and generated by the server.
        // Keep its authored shape on the placement so it can block AI while
        // alive and be removed from navigation when smashed.
        if (object.type === "LENPC" && navigationEntry?.navCollisions?.length) {
          placement.navigationColliders = transformColliders(
            object,
            worldPosition,
            navigationEntry.navCollisions
          );
        }
        if (object.type === "LETriggerable" && navigationEntry?.combatCollisions?.length) {
          placement.combatColliders = transformColliders(
            object,
            worldPosition,
            navigationEntry.combatCollisions
          );
        }
        const room = withheld.get(instance);
        if (room && REVEALED_KINDS.has(placement.kind)) room.placements[placement.kind].push(placement);
        else byKind[placement.kind].push(placement);
      }
    }
  }

  const [firstSpawn] = byKind.heroSpawn;

  return {
    placements: byKind,
    /**
     * One entry per withheld room, carrying its tile, what opens it and
     * everything that stands inside it.
     *
     * Navigation deliberately keeps the room — its cells, its colliders and its
     * bounds are all below, built from the whole tile list. The room is walled
     * off rather than missing, so nothing can path into it before the wall
     * breaks, and leaving it in means a reveal has no navigation work to do.
     */
    secrets: [...withheld].map(([instance, room]) => ({
      tile: tiles[instance],
      openedBy: room.openedBy,
      placements: room.placements,
    })),
    wiring,
    navigation: {
      bounds: {
        minX: Math.min(...tiles.map((tile) => tile.x)),
        minY: Math.min(...tiles.map((tile) => tile.y)),
        maxX: Math.max(...tiles.map((tile) => tile.x)) + 900,
        maxY: Math.max(...tiles.map((tile) => tile.y)) + 900,
      },
      tileSize: 900,
      cellSize: 60,
      tiles: tiles.map(({ x, y }) => ({ x, y })),
      staticColliders,
      triggerColliders,
    },
    /** Where to place the player; falls back to the first tile. */
    spawn: firstSpawn ?? (tiles.length ? { x: tiles[0].x, y: tiles[0].y } : { x: 0, y: 0 }),
  };
};

const cache = new Map();

export const loadFloor = async (name = "arena_gauntlet") => {
  if (cache.has(name)) return cache.get(name);

  /**
   * Either a catalogue nickname or the path CustomMaps gives. The catalogue is
   * kept as an override — it is how the tests name the two tutorial floors —
   * but nothing has to be listed there for a node to load.
   */
  const relative = floorCatalog.floors[name] ?? (name.endsWith(".json") ? name : null);
  if (!relative) throw new Error(`Unknown floor "${name}"`);

  const file = levelsFile(relative);
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);

  const tiles = parsed.tiles.map((tile) => ({
    x: tile.x,
    y: tile.y,
    tileId: tile.tileId,
  }));

  const placements = await readPlacements(parsed.tileLibrary, tiles);

  const floor = {
    name,
    tileLibrary: parsed.tileLibrary,
    ...placements,
    tiles: visibleTiles(tiles, placements.secrets),
  };

  const counts = Object.entries(floor.placements)
    .map(([kind, list]) => `${list.length} ${kind}`)
    .join(", ");
  info(`floors: loaded "${name}" — ${floor.tiles.length} tiles, ${counts}`);
  cache.set(name, floor);
  return floor;
};

/**
 * A floor laid out from a theme's library rather than read from a file.
 *
 * Everything downstream is the same: the tiles go on the same grid, and their
 * LEObjects are read by the same reader an authored floor uses, so the monsters,
 * chests and traps a tile carries arrive without any of it knowing where the
 * layout came from.
 */
export const buildFloor = async (tileLibrary, { tier = 1, tileCount = 9, seed = 1 } = {}) => {
  const file = levelsFile(tileLibrary);
  const library = JSON.parse(await fs.readFile(file, "utf8"));

  const layout = generateFloor(library, { tier, tileCount, seed });
  const placements = await readPlacements(tileLibrary, layout.tiles);

  const floor = {
    name: `${tileLibrary}#${seed}`,
    tileLibrary,
    generated: true,
    hasExit: layout.hasExit,
    ...placements,
    tiles: visibleTiles(layout.tiles, placements.secrets),
  };

  const counts = Object.entries(floor.placements)
    .map(([kind, list]) => `${list.length} ${kind}`)
    .join(", ");
  info(
    `floors: generated ${layout.tiles.length} tiles from ${tileLibrary} ` +
      `(tier ${tier}, seed ${seed})${layout.hasExit ? "" : " — no exit"} — ${counts}`
  );
  return floor;
};

/**
 * The floor files a CustomMaps row names, if we actually have them.
 *
 * The row lists them one column at a time — `Floor1`, `Floor2` — as paths from
 * the game root, so they are cut down to what `loadFloor` joins on. A row is
 * only usable whole: half an authored map is a floor the player cannot finish,
 * which is worse than a laid-out one, so a single missing file gives up on all
 * of them.
 */
const authoredFloorFiles = async (custom) => {
  const files = [];
  for (let floor = 1; floor <= Math.max(1, Number(custom.NumFloors ?? 1)); floor++) {
    const named = custom[`Floor${floor}`];
    if (!named) return [];
    const relative = named.replace(/^Resources\/Levels\//, "");
    try {
      await fs.access(levelsFile(relative));
    } catch {
      return [];
    }
    files.push(relative);
  }
  return files;
};

/**
 * What a map node's floors are made of.
 *
 * A run is a **sequence**, and the two kinds mix. A captured Icewater Caverns
 * Boss run is the proof: two floors under one area, both on node 50009.
 *
 *   floor 2000  nordic/caves/tiles.json, 14 tiles  = ICE_CAVES_BOSS.NumTiles
 *   floor 2001  five tiles, and they are byte for byte
 *               db_floor_ICE_CAVES_PAPA_YETI_BOSS.json
 *
 * So a boss node is an approach laid out from its tier, then the authored map
 * at the end of it. The tier says how many to lay out (MinFloors) and the
 * CustomMaps row how many are authored (NumFloors); 1 + 1 there, and 0 + 2 for
 * the tutorial, which is two authored floors and no approach.
 *
 * Reading only the authored side dropped the approach and opened a boss node
 * on its boss.
 */
export const floorPlanForMapNode = async (mapNodeId, { seed } = {}) => {
  const node = await mapNode(mapNodeId);
  if (!node) return null;

  const override = floorCatalog.mapNodes[String(mapNodeId)];
  if (override) {
    const names = Array.isArray(override) ? override : [override];
    return { floors: names.map((file) => ({ authored: file })) };
  }

  const custom = node.CustomTileset ? await customMap(node.CustomTileset) : null;
  const authored = custom ? await authoredFloorFiles(custom) : [];
  if (custom && !authored.length) {
    /**
     * The row names its floors and we do not have them.
     *
     * Only four of the twelve authored floor files came out of the client;
     * the other eight lived on the real server. Loading the default in their
     * place put the Knight Fortress arena under every boss on the map —
     * Icewater, the Catacombs, Cretaceous Park — quietly and with its own
     * wiring, which is not a boss battle in the wrong scenery so much as a
     * different dungeon wearing the node's name.
     *
     * Laying one out from the row's own theme is wrong in a smaller way: the
     * rooms are not the authored ones and the boss is not in them, but the
     * tiles, the tier and the floor count are the node's own.
     */
    warn(
      `floors: "${node.CustomTileset}" names ${custom.NumFloors ?? 1} floor file(s) we do not have — ` +
        `laying out ${mapNodeId} "${node.Name}" from its theme instead`
    );
  }

  const tier = await coliseumTier(node.TierRank);
  if (!tier?.TileSet) {
    return {
      floors: authored.length
        ? authored.map((file) => ({ authored: file }))
        : [{ authored: floorCatalog.defaultFloor }],
    };
  }

  /**
   * How many floors are laid out before the authored ones.
   *
   * A node with no authored map is all approach, and then a tier reporting zero
   * still has to run a floor. A boss node's tier reports the approach only —
   * ICE_CAVES_BOSS says 1, and the run was that one plus the authored map.
   */
  const laidOut = authored.length
    ? Number(tier.MinFloors ?? 0)
    : Math.max(1, Number(tier.MinFloors ?? 1));
  const tileCount = Math.max(3, Number(tier.NumTiles ?? 9));
  /**
   * Tiles gate themselves by minTier/maxTier, which run 1..10, while a tier's
   * LeagueRank runs 1..39 across the whole map. Clamping keeps the deepest
   * nodes drawing from the hardest tiles a library actually has rather than
   * from none at all.
   */
  const tileTier = Math.min(10, Math.max(1, Number(tier.LeagueRank ?? 1)));

  /**
   * A fresh layout per run, not per node.
   *
   * Four entries to node 50004 in one capture produced four different tile
   * lists — 372, 366, 360 and 376 bytes, no two alike. Seeding from the node
   * would have handed the player the same rooms every time they walked back in,
   * which is the opposite of what the game does.
   *
   * DR_FLOOR_SEED pins it when a particular layout needs looking at twice.
   */
  const runSeed =
    seed ??
    (envSetting("FLOOR_SEED")
      ? Number(envSetting("FLOOR_SEED"))
      : Math.floor(Math.random() * 0x7fffffff));

  const floors = [];
  for (let index = 0; index < laidOut; index++) {
    floors.push({
      generated: {
        tileLibrary: tier.TileSet,
        tier: tileTier,
        tileCount,
        // Or every floor of a run would be the same room twice.
        seed: runSeed + index * 104729,
      },
    });
  }
  for (const file of authored) floors.push({ authored: file });

  /**
   * The level every NPC on this run is generated at.
   *
   * `ColiseumTiers` names it per tier, and the corpus agrees without exception:
   * of the 21 distinct NPC levels the official sent across 54 captures, every
   * one is some tier's `MinLevel`. The arena run is the clean case — node 50150
   * is `ARENA_INFINITE`, whose MinLevel is 100, and its NPCs arrive at 100.
   *
   * It was read from the hero before this, which fitted the same numbers for a
   * levelled account and would have priced a low tier at the hero's strength
   * the moment the two parted company.
   */
  // The tier travels with the plan: its level prices the NPCs and its quotas
  // stock the floor. See src/socket/population.js.
  return { floors, tier, npcLevel: Math.max(1, Number(tier.MinLevel ?? 1)) };
};

/**
 * Every tile library the run will need, in first-seen order.
 *
 * The area advertises these once and the client preloads them there —
 * `DistributedDungionArea.postGenerate` fires a single CacheLoadRequest with the
 * whole list, and each floor afterwards names one path that DungeonFloorFactory
 * expects to find already cached.
 *
 * Announcing only the first floor's library is right for every dungeon the game
 * ships, because a run stays in one theme. It is wrong for a run that does not,
 * and the failure is not graceful: the second floor asks the cache for a library
 * that was never fetched.
 */
export const tileLibrariesFor = async (plan) => {
  const libraries = [];
  for (const descriptor of plan?.floors ?? []) {
    const library = descriptor.generated
      ? descriptor.generated.tileLibrary
      : (await loadFloor(descriptor.authored)).tileLibrary;
    if (library && !libraries.includes(library)) libraries.push(library);
  }
  return libraries;
};

/**
 * The nth floor of a run, laid out or authored as its own descriptor says.
 *
 * The two kinds are interchangeable from here on: both return the same shape,
 * so a dungeon does not need to know which it is running.
 */
export const loadFloorAt = async (plan, index) => {
  const descriptor = plan?.floors?.[Math.min(index, (plan.floors?.length ?? 1) - 1)];
  if (!descriptor) throw new Error(`No floor ${index} in this plan`);
  if (descriptor.authored) return loadFloor(descriptor.authored);

  const { tileLibrary, tier, tileCount, seed } = descriptor.generated;
  return buildFloor(tileLibrary, { tier, tileCount, seed });
};

/** How many floors a run has. */
export const floorCountOf = (plan) => Math.max(1, plan?.floors?.length ?? 1);

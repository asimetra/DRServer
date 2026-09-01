/**
 * What the area tells the client to load before the floor arrives.
 *
 * `DistributedDungionArea` carries three lists — `tileLibrary`, `cacheNpc` and
 * `cacheSWC` — and its `postGenerate` turns them into a `CacheLoadRequestNpcEvent`
 * that `LoadingScreenState.TickleCacheWithEvent` drains: tile libraries through
 * `TrickleCacheLoader.tilelibrary`, npc rows through `npcVector`, art through
 * `swfVector`, and then `AssetLoader.stopTrackingLoads()`.
 *
 * This server sent the first list and left the other two empty, which looks
 * harmless — a preload is only a preload — but it is not. Flash resolves a class
 * against the `applicationDomain` of the SWF it came from, so a movie clip whose
 * library was never loaded has nowhere to be found. The client says so and
 * carries on:
 *
 *   Could not resolve applicationDomain for SwfAsset
 *   ./Resources/Art2D/FX/db_fx_library.swf while looking for class:
 *   db_fx_FireBombExplosion_fire_off. rootType=null
 *
 * Thirty-nine of those in one run of ours, none in a recording of the official's.
 * The objects behind them are `BURNING_FIRE_PLACEABLE_ALL` and
 * `MINE_PLACEABLE_ALL` — the traps reported as dealing damage while drawing
 * nothing. They were generated correctly the whole time; the art was simply not
 * in the process.
 *
 * Both lists come from the game master rather than from a naming convention:
 * `Npc.SwfFilepath` for anything a tile spawns, `Prop.SwfFilepath` for the
 * scenery, and `Resources/Art2D/FX/db_fx_library.swf` falls out of the first of
 * those on its own, because that is where the mine's art actually lives.
 */
import path from "node:path";
import { config } from "../config.js";
import { readJsonFile } from "../json-file.js";
import { levelsFile } from "./floors.js";
import { npcForConstant, propForConstant } from "../gamemaster.js";
import { enemyPoolFor } from "./population.js";
import { warn } from "../log.js";

/** Tile-library scans are pure and a run asks for the same one many times. */
const scanned = new Map();

/**
 * Every constant a library's tiles can put on a floor.
 *
 * Whole-library rather than per-tile on purpose: a laid-out floor has not
 * chosen its tiles when the area generate goes out, and a preload that covers
 * more than the floor uses costs a little memory, while one that covers less
 * costs a missing sprite. The official's own lists are supersets of what it
 * placed in three of the recordings, so this is the side it errs on too.
 */
const constantsIn = (tileLibrary) => {
  const cached = scanned.get(tileLibrary);
  if (cached) return cached;

  /**
   * Ours before theirs, like every other reader of a level file. Without it a
   * library this server added is unreadable *here* while being perfectly
   * readable everywhere else, and the failure is silent in the worst way: the
   * floor lays correctly and the preload comes back empty, so the client
   * reaches a movie clip whose art was never loaded and draws nothing without
   * complaining. An invisible room that logs no error.
   */
  const file = levelsFile(tileLibrary);

  let library;
  try {
    library = readJsonFile(file);
  } catch (error) {
    // A library we cannot read is a floor we cannot lay; that failure belongs
    // to the floor loader, and a preload should not be the thing that reports it.
    warn(`precache: could not read ${tileLibrary} — ${error.message}`);
    scanned.set(tileLibrary, { spawned: [], scenery: [] });
    return scanned.get(tileLibrary);
  }

  const spawned = new Set();
  const scenery = new Set();
  for (const tile of library.LETiles ?? []) {
    for (const background of [].concat(tile.LEBackground ?? [])) {
      if (background?.constant) scenery.add(background.constant);
    }
    for (const object of tile.LEObjects ?? []) {
      if (!object?.constant) continue;
      // LEProp is scenery; everything else on a tile becomes an actor.
      (object.type === "LEProp" ? scenery : spawned).add(object.constant);
    }
  }

  const found = { spawned: [...spawned], scenery: [...scenery] };
  scanned.set(tileLibrary, found);
  return found;
};

/**
 * The two cache lists for a run, from its plan and the tier it will stock from.
 *
 * A tile authors `FODDER`, `BRUISER` and `MINIBOSS` placeholders and the
 * enemies those become are the tier's business. `resolveSpawnConstant` picks
 * one of them, which is what placing a monster needs and not what loading its
 * art needs, so the placeholders are left to fall through here and the whole
 * pool is added below instead.
 */
export const preloadFor = async (tileLibraries, { gm, tierConstant } = {}) => {
  const npcIds = new Set();
  const swfs = new Set();

  const add = async (constant) => {
    const npc = await npcForConstant(constant);
    if (npc) {
      npcIds.add(npc.Id);
      if (npc.SwfFilepath) swfs.add(npc.SwfFilepath);
      return;
    }
    const prop = await propForConstant(constant);
    if (prop?.SwfFilepath) swfs.add(prop.SwfFilepath);
  };

  for (const library of new Set(tileLibraries ?? [])) {
    const { spawned, scenery } = constantsIn(library);
    for (const constant of [...spawned, ...scenery]) await add(constant);
  }

  // What the tiles do not name: the monsters the tier stocks the floor with.
  const pool = enemyPoolFor(gm, tierConstant);
  for (const role of Object.values(pool)) {
    for (const constant of role) await add(constant);
  }

  /**
   * A late joiner may bring any inventory pet after the area preload has
   * already completed. There are only five persistent pet rows, so preloading
   * that bounded set once avoids a missing sprite without rebuilding the area
   * or making matchmaking depend on which member entered first.
   */
  for (const pet of gm?.raw?.Npc ?? []) {
    if (pet.CharType === "PET" && pet.UsePetUI) await add(pet.Constant);
  }

  return { cacheNpcs: [...npcIds], cacheSwfs: [...swfs] };
};

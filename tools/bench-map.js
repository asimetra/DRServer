#!/usr/bin/env node
/**
 * A workbench: one room per thing you want to look at, and nothing else.
 *
 *   node tools/bench-map.js --theme nordic/temple --only MINE_PLACEABLE_ALL
 *   node tools/bench-map.js --theme nordic/temple --only A,B,C --name frostgaard
 *   DR_FLOOR_CATALOG=config/floors.bench-frostgaard.json npm start
 *
 * `trap-map.js` searches layouts for coverage, which is right for "does this
 * trap work at all" and wrong for "let me stand in front of this one and
 * watch". A searched floor is sixteen rooms of everything, the thing under test
 * is three rooms away behind a corridor, and half of what surrounds it is other
 * traps making their own noise.
 *
 * This does not search. It takes the tiles that carry what was asked for, picks
 * the smallest set covering all of it, and lays them in a straight line next to
 * a starting room. A floor does not have to be a dungeon: one tile with a spawn
 * beside one tile with nine mines is a complete, playable answer to "do the
 * mines still chain".
 *
 * The floor stands on its own — every tile the layout names is written out, the
 * hero spawns on the first, and walking east goes through each subject in turn.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFloor } from "../src/socket/floors.js";
import { initialTargetState, trackTriggers } from "../src/socket/triggers.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const levels = path.join(root, "local-data", "Resources", "Levels");

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

/** Tiles are laid on a grid this wide; the libraries author them at 900. */
const TILE_SIZE = 900;

/** 0 north, 1 east, 2 south, 3 west — the order a tile writes its exits in. */
const DIRECTIONS = [
  { dx: 0, dy: -TILE_SIZE },
  { dx: TILE_SIZE, dy: 0 },
  { dx: 0, dy: TILE_SIZE },
  { dx: -TILE_SIZE, dy: 0 },
];
const opposite = (direction) => (direction + 2) % 4;
const exitsOf = (tile) => tile?.exits ?? [0, 0, 0, 0];

/**
 * Whether a tile may sit at a place, given whatever is already around it.
 *
 * The rule is the layout generator's and it is not a guess: every adjacent pair
 * in the authored tutorial floor matches exactly across the seam. Openings come
 * in two widths and zero is a wall, so a narrow doorway cannot meet a wide one
 * and neither can meet a wall.
 *
 * It has to be checked in all four directions, which is why a bench cannot
 * simply be a row: the temple's starting room opens east only, its mine room
 * opens north and south only, and no amount of putting them side by side makes
 * a door between them.
 */
const fits = (tile, x, y, placed) =>
  DIRECTIONS.every((step, direction) => {
    const neighbour = placed.get(`${x + step.dx},${y + step.dy}`);
    return !neighbour || exitsOf(tile)[direction] === exitsOf(neighbour)[opposite(direction)];
  });

/** Places with a door onto them and nothing there yet. */
const frontier = (placed) => {
  const open = [];
  for (const [at, tile] of placed) {
    const [x, y] = at.split(",").map(Number);
    DIRECTIONS.forEach((step, direction) => {
      if (!exitsOf(tile)[direction]) return;
      const next = `${x + step.dx},${y + step.dy}`;
      if (!placed.has(next)) open.push({ x: x + step.dx, y: y + step.dy });
    });
  }
  return open;
};

/** Which node the bench answers for, plus every node of its own theme. */
const MAP_NODE = "50002";

const main = async () => {
  const theme = argument("theme");
  const only = (argument("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!theme || !only.length) {
    console.error("usage: node tools/bench-map.js --theme <theme> --only A[,B,...] [--name x]");
    process.exit(2);
  }

  const slug = `bench-${(argument("name") ?? only.join("-")).toLowerCase()}`;
  const outputDir = path.join(levels, slug);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const libraryPath = path.join(levels, theme, "tiles.json");
  const library = JSON.parse(await fs.readFile(libraryPath, "utf8"));

  /** What each tile carries of what was asked for, and where the hero can start. */
  const carries = new Map();
  const starts = [];
  for (const tile of library.LETiles ?? []) {
    const found = new Map();
    let spawns = false;
    for (const object of tile.LEObjects ?? []) {
      if (object.type === "LEHeroSpawnProp") spawns = true;
      if (only.includes(object.constant)) found.set(object.constant, (found.get(object.constant) ?? 0) + 1);
    }
    if (spawns) starts.push(tile);
    if (found.size) carries.set(tile.id, { tile, found });
  }

  if (!starts.length) {
    console.error(`${theme} has no tile with a hero spawn`);
    process.exit(2);
  }

  /**
   * Grown outwards from the starting room, with corridors where a door is
   * needed.
   *
   * The subject tiles are not chosen up front. Which tile carries a mine is a
   * much weaker constraint than which tile will open onto the room before it —
   * the temple's starting room has one door, east, and its mine room has two,
   * north and south — so picking a tile for its contents and then discovering
   * it cannot be reached leaves the bench with a wall where the subject should
   * be. Every tile carrying the constant is tried instead, hardest constant
   * first, and one that covers several subjects at once is preferred.
   *
   * A subject that still cannot be attached is reported rather than laid behind
   * a wall, because a room you cannot walk into is worse than a missing one.
   */
  const start = starts.sort((a, b) => (a.LEObjects?.length ?? 0) - (b.LEObjects?.length ?? 0))[0];
  const corridors = (library.LETiles ?? []).filter(
    (tile) => exitsOf(tile).filter(Boolean).length >= 2 && !carries.has(tile.id)
  );

  const placed = new Map([["0,0", start]]);
  const order = [{ x: 0, y: 0, tile: start, role: "start" }];

  const attach = (subject) => {
    for (const spot of frontier(placed)) {
      if (!fits(subject, spot.x, spot.y, placed)) continue;
      placed.set(`${spot.x},${spot.y}`, subject);
      order.push({ ...spot, tile: subject, role: "subject" });
      return true;
    }
    for (const spot of frontier(placed)) {
      for (const corridor of corridors) {
        if (!fits(corridor, spot.x, spot.y, placed)) continue;
        placed.set(`${spot.x},${spot.y}`, corridor);
        for (const next of frontier(placed)) {
          if (!fits(subject, next.x, next.y, placed)) continue;
          placed.set(`${next.x},${next.y}`, subject);
          order.push({ ...spot, tile: corridor, role: "corridor" });
          order.push({ ...next, tile: subject, role: "subject" });
          return true;
        }
        placed.delete(`${spot.x},${spot.y}`);
      }
    }
    return false;
  };

  /**
   * What a bench has to cover is a constant *in a state*, not just a constant.
   *
   * A trap that rests raised and one that rests retracted are the same row and
   * two different things to look at, and which you get is a property of the
   * room: of the temple's spike tiles, 786 holds 24 raised and none retracted,
   * 148 holds 5 retracted and none raised, and 1103 holds three of each. Asking
   * only for the constant picks whichever tile the search reaches first and
   * quietly answers half the question — the bench that prompted this had 24
   * spikes in it and not one the player could walk over.
   *
   * So each subject is wanted twice, armed and idle, and a room is worth taking
   * for either. A state no room in the library offers is reported rather than
   * pretended.
   */
  const restingStates = async (tile) => {
    const file = path.join(slug, `_probe_${tile.id}.json`);
    await fs.writeFile(path.join(levels, file), JSON.stringify({
      tileLibrary: `Resources/Levels/${theme}/tiles.json`,
      tiles: [{ type: "LEFloorTile", tileId: tile.id, x: 0, y: 0 }],
    }));
    const floor = await loadFloor(file);
    const session = {};
    trackTriggers(session, floor);
    const states = new Set();
    for (const placement of floor.placements.triggerable ?? []) {
      if (!only.includes(placement.constant)) continue;
      states.add(`${placement.constant}|${initialTargetState(session, placement.id) ? "armed" : "idle"}`);
    }
    await fs.rm(path.join(levels, file), { force: true });
    return states;
  };

  for (const entry of carries.values()) entry.states = await restingStates(entry.tile);

  const remaining = new Set();
  for (const entry of carries.values()) for (const state of entry.states) remaining.add(state);
  const unreachable = only
    .filter((c) => !["armed", "idle"].some((s) => remaining.has(`${c}|${s}`)))
    .map((c) => `${c} (no room places it at all)`);

  const stranded = [];
  while (remaining.size) {
    const options = [...carries.values()]
      .filter((entry) => ![...placed.values()].includes(entry.tile))
      .map((entry) => ({
        entry,
        gain: [...entry.states].filter((state) => remaining.has(state)).length,
      }))
      .filter(({ gain }) => gain > 0)
      .sort((x, y) => y.gain - x.gain);

    if (!options.length) break;
    const taken = options.find(({ entry }) => attach(entry.tile));
    if (!taken) {
      for (const state of options[0].entry.states) {
        if (remaining.delete(state)) stranded.push(state.replace("|", " "));
      }
      continue;
    }
    for (const state of taken.entry.states) remaining.delete(state);
  }
  for (const state of remaining) stranded.push(state.replace("|", " "));

  /**
   * Shifted so the whole floor sits at or past the origin.
   *
   * Growing outwards from the starting room puts rooms north and west of it, at
   * negative coordinates — and a floor does not live there. `Floor.buildWalls`
   * runs the client's edges from the origin outwards, and across 216 official
   * tiles not one is at a negative coordinate: the smallest x is 900 and the
   * smallest y is 0. A room laid outside that draws its doorway and has no
   * ground behind it, which is a passage you can see and cannot walk through.
   */
  const cells = [...placed].map(([at, tile]) => {
    const [x, y] = at.split(",").map(Number);
    return { tile, x, y };
  });
  const shiftX = -Math.min(...cells.map((cell) => cell.x));
  const shiftY = -Math.min(...cells.map((cell) => cell.y));
  for (const entry of order) { entry.x += shiftX; entry.y += shiftY; }
  const tiles = cells.map(({ tile, x, y }) => ({
    type: "LEFloorTile",
    tileId: tile.id,
    x: x + shiftX,
    y: y + shiftY,
  }));



  const file = `${slug}/db_floor_BENCH.json`;
  await fs.writeFile(
    path.join(levels, file),
    `${JSON.stringify({
      _comment:
        `generated by tools/bench-map.js — ${theme}, one room per subject: ` +
        only.join(", "),
      tileLibrary: `Resources/Levels/${theme}/tiles.json`,
      tiles,
    }, null, 1)}\n`
  );

  // Served on this theme's own nodes too, so the door in the UI leads to it.
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  const tiers = new Set(
    (gm.raw.ColiseumTiers ?? [])
      .filter((tier) => String(tier.TileSet) === `Resources/Levels/${theme}/tiles.json`)
      .map((tier) => tier.Constant)
  );
  const nodes = (gm.raw.MapPage ?? []).filter((node) => tiers.has(node.TierRank));

  const catalogue = { defaultFloor: "arena_gauntlet", floors: { bench: file }, mapNodes: {} };
  catalogue.mapNodes[MAP_NODE] = [file];
  for (const node of nodes) catalogue.mapNodes[String(node.Id)] = [file];
  catalogue._note =
    `Generated by tools/bench-map.js from ${theme}. One room per subject, ` +
    `hero starts on the first. Run with DR_FLOOR_CATALOG=config/floors.${slug}.json.`;

  await fs.writeFile(
    path.join(root, "config", `floors.${slug}.json`),
    `${JSON.stringify(catalogue, null, 2)}\n`
  );

  console.log(`${placed.size} room(s):\n`);
  for (const entry of order) {
    const found = carries.get(entry.tile.id)?.found;
    const what = entry.role === "start"
      ? "start — the hero appears here"
      : entry.role === "corridor"
        ? "corridor"
        : [...(found ?? [])].map(([c, n]) => `${c}×${n}`).join("  ");
    console.log(`   (${String(entry.x / TILE_SIZE).padStart(2)},${String(entry.y / TILE_SIZE).padStart(2)})  ${entry.tile.id.padEnd(22)} ${what}`);
  }
  if (stranded.length) {
    console.log(`\nno room offering these would open onto the bench: ${stranded.join(", ")}`);
  }
  if (unreachable.length) console.log(`\nnot placed by any room in ${theme}: ${unreachable.join(", ")}`);
  if (nodes.length) console.log(`\nalso served on ${nodes.length} node(s) of ${theme}`);
  console.log(`\nwrote config/floors.${slug}.json — run with\n  DR_FLOOR_CATALOG=config/floors.${slug}.json npm start`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

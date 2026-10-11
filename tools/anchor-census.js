#!/usr/bin/env node
/**
 * Route cells that read shut although a body fits somewhere in them.
 *
 *   node tools/anchor-census.js                       the library floors (seeds 1-3) and the scenario floors
 *   node tools/anchor-census.js --root ../other       another checkout's route search, same cells
 *   node tools/anchor-census.js --seeds 1 --radii 35,42
 *   node tools/anchor-census.js --smashed            every prop broken, as a floor ends
 *
 * The route search (pathfind.js) enters each 60-unit cell at an anchor: the
 * first point of a lattice round the cell's centre where the body, two units
 * to spare (`ANCHOR_MARGIN`), stands clear. A cell where no lattice point
 * does is shut, and a corridor that only has room between the lattice points
 * is shut along its length. This counts, per radius, the cells the root's
 * search calls shut and the ones among them where the body does stand clear
 * somewhere within the lattice's reach of the centre (four tenths of a cell
 * each way): what a search that missed nothing would open.
 *
 * Whether a body fits is asked exactly as the search asks a point — the
 * root's own `isPositionBlocked` at the radius plus the margin — at every
 * point of a one-unit grid near the lattice points the body nearly fits at:
 * those clear of everything at the radius less the farthest any point of the
 * lattice's square sits from its nearest lattice point. A point clear at the
 * full radius has a lattice point that near it clear at the smaller one, so
 * nothing the grid could find is skipped.
 *
 * Each floor is laid out with its props standing, as a floor in play starts,
 * or with `--smashed` with every one of them broken, the ground they stood on
 * open.
 * Radii: 35 (no row's shape), 42 (a KNIGHT drawn at 1.2) and every other
 * radius an enemy that walks is built with, below 80.
 */
import path from "node:path";
import { argument, flag, importFrom, listArgument, TOOL_ROOT } from "./equivalence-lib.js";

const LIBRARIES = [
  "castle/arena",
  "castle/catacombs",
  "castle/prison",
  "jungle/aztec",
  "jungle/dino",
  "jungle/tribal",
  "nordic/caves",
  "nordic/temple",
  "nordic/village",
];
const SCENARIO_FLOORS = [
  "scenario-test/db_floor_GAPS_CASTLE_PRISON.json",
  "scenario-test/db_floor_GAPS_CASTLE_CATACOMBS.json",
  "scenario-test/db_floor_POCKET_NORDIC_CAVES.json",
];
const LATTICE = [-0.4, -0.2, 0, 0.2, 0.4];
const MARGIN = 2;

const main = async () => {
  const root = path.resolve(argument("root", TOOL_ROOT));
  const seeds = listArgument("seeds", ["1", "2", "3"]).map(Number);
  const [floors, navigation, body, gamemaster, pathfind, routeCache] = await Promise.all([
    importFrom(root, "src/socket/floors.js"),
    importFrom(root, "src/socket/navigation.js"),
    importFrom(root, "src/socket/body.js"),
    importFrom(root, "src/gamemaster.js"),
    importFrom(root, "src/socket/pathfind.js"),
    importFrom(root, "src/socket/route-cache.js"),
  ]);
  /**
   * The root's own answer for a cell: its `cellAnchorAt` (pathfind.js) where
   * it has one, else its lattice asked point by point, as its search does.
   */
  const opensCell = pathfind.cellAnchorAt
    ? (nav, centre, radius) => Boolean(pathfind.cellAnchorAt(nav, radius, centre.x, centre.y))
    : (nav, centre, radius) =>
        routeCache.ANCHOR_X.some(
          (dx, at) =>
            !navigation.isPositionBlocked(
              nav,
              { x: centre.x + dx * nav.cellSize, y: centre.y + routeCache.ANCHOR_Y[at] * nav.cellSize },
              radius + routeCache.ANCHOR_MARGIN
            )
        );
  await navigation.loadNavigationLibrary();
  const gm = await gamemaster.loadGameMaster();
  const rowRadii = gm.raw.Npc.filter((row) => row.CharType === "ENEMY" && row.IsMover)
    .map((row) => Math.round(body.authoredBodyRadius(row, row.Constant) * 10) / 10)
    .filter((radius) => radius < 80);
  const radii = argument("radii")
    ? listArgument("radii", []).map(Number)
    : [...new Set([35, 42, ...rowRadii])].sort((a, b) => a - b);

  const worlds = [];
  for (const library of LIBRARIES) {
    for (const seed of seeds) {
      worlds.push({ name: `${library} s${seed}`, floor: await floors.buildFloor(`Resources/Levels/${library}/tiles.json`, { tier: 10, tileCount: 24, seed }) });
    }
  }
  for (const name of SCENARIO_FLOORS) worlds.push({ name, floor: await floors.loadFloor(name) });

  const totals = new Map(radii.map((radius) => [radius, { cells: 0, shut: 0, missed: 0 }]));
  const examples = [];
  const started = Date.now();
  for (const { name, floor } of worlds) {
    const nav = navigation.createNavigationState(floor.navigation);
    let id = 0;
    for (const placement of flag("smashed") ? [] : (floor.placements.npc ?? [])) {
      if (placement.navigationColliders?.length) navigation.addNavigationObstacle(nav, `prop${id++}`, placement.navigationColliders);
    }
    const { bounds, cellSize } = nav;
    const columns = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
    const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize);
    // The farthest a point of the lattice's square is from its nearest lattice point.
    const slack = (Math.SQRT2 / 2) * (LATTICE[1] - LATTICE[0]) * cellSize;
    const reach = LATTICE.at(-1) * cellSize;
    for (const radius of radii) {
      const total = totals.get(radius);
      const probe = radius + MARGIN;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < columns; cx++) {
          const centre = { x: bounds.minX + (cx + 0.5) * cellSize, y: bounds.minY + (cy + 0.5) * cellSize };
          if (!navigation.isOnAuthoredTile(nav, centre)) continue;
          total.cells++;
          const ask = opensCell(nav, centre, radius) ? "open" : askCell(navigation, nav, { centre, cellSize, probe, slack, reach });
          if (ask === "open") continue;
          total.shut++;
          if (ask === "missed") {
            total.missed++;
            if (examples.length < Number(argument("examples", 12))) examples.push(`${name} r${radius} cell centre ${centre.x},${centre.y}`);
          }
        }
      }
    }
  }
  console.log(`${root}: ${worlds.length} floors, ${((Date.now() - started) / 1000).toFixed(1)} s`);
  let cells = 0;
  let missed = 0;
  for (const [radius, total] of totals) {
    cells += total.cells;
    missed += total.missed;
    console.log(`  r ${String(radius).padStart(5)}  cells ${total.cells}  shut ${total.shut}  a body fits in ${total.missed}`);
  }
  console.log(`  all radii: ${missed} cells of ${cells} read shut where a body fits`);
  for (const example of examples) console.log(`    ${example}`);
};

/** For a cell the search shuts: "missed" when a body fits in it after all, else "shut". */
const askCell = (navigation, nav, { centre, cellSize, probe, slack, reach }) => {
  const lattice = [];
  for (const dx of LATTICE) for (const dy of LATTICE) lattice.push({ x: centre.x + dx * cellSize, y: centre.y + dy * cellSize });
  for (const point of lattice) {
    if (navigation.isPositionBlocked(nav, point, Math.max(0, probe - slack))) continue;
    for (let x = Math.max(centre.x - reach, point.x - slack); x <= Math.min(centre.x + reach, point.x + slack); x++) {
      for (let y = Math.max(centre.y - reach, point.y - slack); y <= Math.min(centre.y + reach, point.y + slack); y++) {
        if (!navigation.isPositionBlocked(nav, { x, y }, probe)) return "missed";
      }
    }
  }
  return "shut";
};

main().catch((problem) => {
  console.error(problem.stack ?? problem);
  process.exit(1);
});

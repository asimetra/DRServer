import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { generateFloor, isConnected, candidates, TILE_SIZE } from "../src/socket/tilegen.js";

const library = async (path) =>
  JSON.parse(await fs.readFile(`local-data/Resources/Levels/${path}`, "utf8"));

/**
 * A theme library, not the tutorial's. That one holds fifteen tiles authored
 * for one floor and has no dead ends, so sealing a layout built from it sprawls
 * past two hundred rooms — it was never meant to be generated from. The nine
 * theme libraries are what the ninety-four generated nodes actually draw on.
 */
const TUTORIAL = "castle/arena/tiles.json";

/**
 * The connectivity rule is measured, not assumed: every adjacent pair in the
 * authored tutorial floor matches exactly across the seam — twenty pairs,
 * twenty matches, walls against walls included. A generated floor has to hold
 * to the same rule or the player walks into a doorway that opens onto a wall.
 */
test("a generated floor agrees with itself across every seam", async () => {
  const lib = await library(TUTORIAL);

  for (const seed of [1, 2, 3, 7, 42, 1000]) {
    const { tiles } = generateFloor(lib, { tier: 1, tileCount: 9, seed });
    assert.ok(tiles.length > 1, `seed ${seed} laid out nothing`);
    assert.ok(isConnected(lib, tiles), `seed ${seed} produced a mismatched seam`);
  }
});

test("the same seed lays out the same floor", async () => {
  const lib = await library(TUTORIAL);
  const first = generateFloor(lib, { tier: 1, tileCount: 9, seed: 99 });
  const second = generateFloor(lib, { tier: 1, tileCount: 9, seed: 99 });

  assert.deepEqual(first.tiles, second.tiles);
  assert.notDeepEqual(
    first.tiles,
    generateFloor(lib, { tier: 1, tileCount: 9, seed: 100 }).tiles,
    "and a different one lays out a different floor"
  );
});

test("tiles land on the grid the client draws on", async () => {
  const lib = await library(TUTORIAL);
  const { tiles } = generateFloor(lib, { tier: 1, tileCount: 9, seed: 5 });

  for (const tile of tiles) {
    assert.equal(tile.x % TILE_SIZE, 0);
    assert.equal(tile.y % TILE_SIZE, 0);
    /**
     * Inside the world, not merely on the grid. Floor.buildWalls runs the
     * client's edges from the origin out to twelve tiles, so a negative
     * coordinate puts a room outside the walls and the player cannot reach it.
     * Every captured layout from the real server is non-negative.
     */
    assert.ok(tile.x >= 0 && tile.y >= 0, `(${tile.x},${tile.y}) is outside the world`);
    assert.ok(tile.x < 12 * TILE_SIZE && tile.y < 12 * TILE_SIZE);
  }
  assert.equal(new Set(tiles.map((tile) => `${tile.x},${tile.y}`)).size, tiles.length, "no two share a square");
});

// A node's TierRank picks which tiles a theme offers, which is how one library
// serves the whole map without every floor looking like the last.
test("difficulty selects from the library rather than taking all of it", async () => {
  const lib = await library(TUTORIAL);
  const low = candidates(lib, { category: "BASIC_TILE", tier: 1 });
  const high = candidates(lib, { category: "BASIC_TILE", tier: 10 });

  assert.ok(low.length, "tier one has something to build with");
  for (const tile of low) assert.ok((tile.minTier ?? 1) <= 1 && (tile.maxTier ?? 99) >= 1);
  for (const tile of high) assert.ok((tile.minTier ?? 1) <= 10 && (tile.maxTier ?? 99) >= 10);
});

test("a floor starts on a starting tile", async () => {
  const lib = await library(TUTORIAL);
  const { tiles, spawnTile } = generateFloor(lib, { tier: 1, tileCount: 6, seed: 11 });
  const byId = new Map(lib.LETiles.map((tile) => [tile.id, tile]));

  /**
   * A layout is grown from the origin and then shifted whole into the positive
   * quadrant, because the client's world starts there — so the starting tile is
   * wherever the shift put it, which is what spawnTile reports.
   */
  const first = tiles.find((tile) => tile.x === spawnTile.x && tile.y === spawnTile.y);
  assert.ok(first, "the spawn names a tile that was placed");
  assert.equal(byId.get(first.tileId).category, "STARTING_TILE");
});

/**
 * A generated floor has to be playable, not just well shaped: the hero needs
 * somewhere to arrive and the floor needs the trigger that ends it. Both come
 * out of the tiles' own LEObjects, read by the same reader an authored floor
 * goes through — so nothing downstream needs to know where the layout came
 * from.
 */
test("a generated floor arrives with a spawn, an exit and its contents", async () => {
  const { buildFloor } = await import("../src/socket/floors.js");
  const floor = await buildFloor(
    "Resources/Levels/castle/arena/db_tiles_TUTORIAL_LEVEL.json",
    { tier: 1, tileCount: 9, seed: 3 }
  );

  assert.ok(floor.spawn, "somewhere to arrive");
  assert.ok(floor.hasExit, "and somewhere to leave");
  assert.ok(
    (floor.placements.trigger ?? []).some((trigger) => trigger.constant === "JASONS_DUNGEON_EXIT"),
    "the trigger that ends a floor came with the exit tile"
  );
  assert.ok((floor.placements.npc ?? []).length > 0, "and the tiles brought their monsters");
});

// Growing can close a layout off before any seam will take an exit. Across the
// real libraries that happens about once in fifteen attempts, so it lays out
// again rather than handing back a room with no way out.
test("every floor gets a way out", async () => {
  const lib = await library(TUTORIAL);
  for (let seed = 1; seed <= 25; seed++) {
    const floor = generateFloor(lib, { tier: 1, tileCount: 9, seed });
    assert.ok(floor.hasExit, `seed ${seed} produced a dead end`);
    assert.ok(isConnected(lib, floor.tiles), `seed ${seed} produced a mismatched seam`);
  }
});

/**
 * Which nodes are laid out and which are read from a file is not a decision we
 * get to make: twelve of the game's hundred and six name a CustomTileset — the
 * tutorial, the gauntlets, the boss battles — and the other ninety-four name
 * none.
 */
test("a node is authored or generated according to its own data", async () => {
  const { floorPlanForMapNode } = await import("../src/socket/floors.js");

  const tutorial = await floorPlanForMapNode(50002);
  assert.ok(
    tutorial.floors.every((floor) => floor.authored),
    "the tutorial is two authored files and no approach"
  );

  const iceCaves = await floorPlanForMapNode(50008);
  assert.ok(
    iceCaves.floors.every((floor) => floor.generated),
    "Icewater Caverns 1-3 names no map, so every floor is laid out"
  );
  assert.match(iceCaves.floors[0].generated.tileLibrary, /nordic\/caves/);
  // Its tier says two floors, and a captured run of it was two floors long.
  assert.equal(iceCaves.floors.length, 2);
});

test("a generated node comes out the size its tier asks for", async () => {
  const { floorPlanForMapNode, buildFloor } = await import("../src/socket/floors.js");

  for (const nodeId of [50003, 50006, 50008, 50078]) {
    const plan = await floorPlanForMapNode(nodeId);
    const { tileLibrary, tier, tileCount } = plan.floors[0].generated;
    const floor = await buildFloor(tileLibrary, { tier, tileCount, seed: nodeId });

    assert.ok(floor.hasExit, `node ${nodeId} has a way out`);
    assert.ok(
      floor.tiles.length >= Math.floor(tileCount * 0.67),
      `node ${nodeId} wanted ${tileCount} tiles and got ${floor.tiles.length}`
    );
    assert.ok(floor.placements.npc.length > 0, `node ${nodeId} brought its monsters`);
  }
});

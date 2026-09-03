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

/**
 * The treasure rooms, which were never placed at all.
 *
 * `SECRET_TILE` was missing from the categories a floor's body is grown from,
 * so thirty-six authored rooms — a dead end holding ten to twenty-two
 * collectables, several times what an ordinary room carries — could not appear
 * on any floor. Not hidden: absent.
 *
 * The rate is measured off the wire, per tile and never per floor: the official
 * builds small floors — 9.4 tiles on average, 10 median, 15 at the largest —
 * and a floor grown to a different size is not comparable to one of them. The
 * tiers agree, asking for 2 to 18 with a median of 7.
 *
 * Accumulating each floor object's tile list across 118 floor births gives 22
 * secret rooms in 1110 tiles, 1.98%. Ours sits just under it at 1.69%, because
 * a room is only placed where something shuts it — see the tests below, which
 * are the property that matters more than the count.
 *
 * Every one of the 478 distinct tile ids the official placed is in a library we
 * hold, so nothing here is measured against a partial view.
 */
test("secret rooms are placed, at something like the rate the official does", async () => {
  const themes = [
    "castle/arena", "castle/catacombs", "castle/prison",
    "jungle/aztec", "jungle/dino", "jungle/tribal",
    "nordic/caves", "nordic/temple", "nordic/village",
  ];

  let tiles = 0;
  let secret = 0;
  for (const theme of themes) {
    const lib = await library(`${theme}/tiles.json`);
    const categoryOf = new Map(
      (lib.LETiles ?? []).map((tile) => [String(tile.id), tile.category])
    );
    for (let seed = 1; seed <= 40; seed++) {
      const floor = generateFloor(lib, { tier: 3, tileCount: 12, seed });
      for (const tile of floor.tiles) {
        tiles += 1;
        if (categoryOf.get(String(tile.tileId)) === "SECRET_TILE") secret += 1;
      }
    }
  }

  assert.ok(tiles > 3000, "enough floors to measure a rate on");
  const rate = (100 * secret) / tiles;
  assert.ok(rate > 0.6 && rate < 2.6, `secret rooms at ${rate.toFixed(2)}%, official is 1.98%`);
});

/**
 * And every one of them is shut, which is the whole of what makes it secret.
 *
 * Seam matching alone will hang a room off any northward opening, and only
 * three per hundred of those happen to carry a wall — so the first version of
 * this placed rooms that stood open, 63% of them against the official's 5%.
 * Twenty-one of the twenty-two secret rooms in the official floor payloads are
 * shut: fifteen by a `WALL_SECRET` in the doorway of the tile below, five by a
 * `PROXIMITY_TRIGGER` of their own, one by a wall inside the room itself.
 *
 * Asked of the layout rather than the library, because the same room is secret
 * behind one tile and not behind another.
 */
test("a secret room is never placed somewhere nothing shuts it", async () => {
  const themes = ["castle/arena", "castle/catacombs", "castle/prison", "nordic/caves", "nordic/temple", "nordic/village"];

  const shutsItself = (tile) =>
    (tile?.LEObjects ?? []).some(
      (object) =>
        (object.type === "LETrigger" && /PROXIMITY/.test(object.constant ?? "")) ||
        /WALL_SECRET/.test(object.constant ?? "")
    );
  const shutsTheRoomAbove = (tile) =>
    (tile?.LEObjects ?? []).some(
      (object) => /WALL_SECRET/.test(object.constant ?? "") && Number(object.y) < 150
    );

  let rooms = 0;
  for (const theme of themes) {
    const lib = await library(`${theme}/tiles.json`);
    const byId = new Map((lib.LETiles ?? []).map((tile) => [String(tile.id), tile]));

    for (let seed = 1; seed <= 40; seed++) {
      const floor = generateFloor(lib, { tier: 3, tileCount: 12, seed });
      const at = new Map(floor.tiles.map((tile) => [`${tile.x},${tile.y}`, byId.get(String(tile.tileId))]));

      for (const tile of floor.tiles) {
        const room = byId.get(String(tile.tileId));
        if (room?.category !== "SECRET_TILE") continue;
        rooms += 1;
        // Its one opening is south, so the tile below holds the door.
        const below = at.get(`${tile.x},${tile.y + TILE_SIZE}`);
        assert.ok(
          shutsItself(room) || shutsTheRoomAbove(below),
          `${theme} seed ${seed}: a secret room at ${tile.x},${tile.y} nothing shuts`
        );
      }
    }
  }
  assert.ok(rooms > 20, `enough rooms to be worth asserting on, saw ${rooms}`);
});

test("every secret room a library offers is a one-way dead end", async () => {
  for (const theme of ["castle/arena", "nordic/caves", "castle/prison"]) {
    const lib = await library(`${theme}/tiles.json`);
    const rooms = candidates(lib, { category: "SECRET_TILE", tier: 3 });
    assert.ok(rooms.length, `${theme} offers some`);
    for (const room of rooms) {
      assert.deepEqual(room.exits, [0, 0, 5, 0], `${theme} secret room opens south and nowhere else`);
    }
  }
});

test("no two secret rooms are placed touching", async () => {
  /**
   * Reported from a test map: two treasure rooms side by side, each with its
   * own breakable door, one wall apart. None of the 22 secret rooms in the
   * official payloads touches another on any of the eight sides, and only one
   * of 118 recorded floors carries two rooms at all. Ours produced 15 flat
   * pairs and 13 corner pairs over 1800 floors before the layout rule.
   *
   * Diagonals are asserted with the rest: a room is meant to be come upon, and
   * a second one showing through the corner gives the first away.
   */
  const around = [-TILE_SIZE, 0, TILE_SIZE]
    .flatMap((dx) => [-TILE_SIZE, 0, TILE_SIZE].map((dy) => [dx, dy]))
    .filter(([dx, dy]) => dx || dy);

  let rooms = 0;
  for (const theme of ["castle/arena", "castle/prison", "nordic/caves", "nordic/village"]) {
    const lib = await library(`${theme}/tiles.json`);
    const byId = new Map((lib.LETiles ?? []).map((tile) => [String(tile.id), tile]));

    for (let seed = 1; seed <= 60; seed++) {
      const floor = generateFloor(lib, { tier: 1, tileCount: 24, seed });
      const at = new Map(
        floor.tiles.map((tile) => [`${tile.x},${tile.y}`, byId.get(String(tile.tileId))])
      );

      for (const tile of floor.tiles) {
        if (byId.get(String(tile.tileId))?.category !== "SECRET_TILE") continue;
        rooms += 1;
        for (const [dx, dy] of around) {
          assert.notEqual(
            at.get(`${tile.x + dx},${tile.y + dy}`)?.category,
            "SECRET_TILE",
            `${theme} seed ${seed}: rooms at ${tile.x},${tile.y} and ${tile.x + dx},${tile.y + dy} touch`
          );
        }
      }
    }
  }
  assert.ok(rooms > 20, `enough rooms to be worth asserting on, saw ${rooms}`);
});

test("a secret wall always has a treasure room behind it", async () => {
  /**
   * Reported from a test map as two breakable doors back to back: an
   * `EXIT_TILE` laid down above a doorway that already held a
   * `CASTLE_ARENA_WALL_SECRET`, so the wall and the exit gate stood 75 units
   * apart in the same seam.
   *
   * The wider fault was that the grower read a sealed doorway as ordinary
   * passage. Of 789 walls over 1800 floors, 88 had a treasure room behind them;
   * the rest had a corridor, and 43 of those were the way out and 10 the tile
   * the player starts on.
   *
   * There is no blank door either, which took a second look at the evidence to
   * see. Four of the official's walls appear to shut nothing, but three were
   * never broken in the capture — the room behind them was simply never
   * revealed — and the fourth is `1756.1363807809773`, whose `WALL_SECRET` sits
   * on a north edge with no doorway in it at all. Every wall a player actually
   * opened had a room behind it: 15 of 15.
   *
   * So the assertion is exact, and the doorway is checked rather than assumed,
   * because that scenery tile would otherwise fail it.
   */
  const isWall = (object) =>
    object.type === "LENPC" && /WALL_SECRET/.test(object.constant ?? "");
  const sealsNorth = (definition) =>
    (definition?.LEObjects ?? []).some((object) => isWall(object) && Number(object.y) < 150);

  let walls = 0;
  for (const theme of ["castle/arena", "castle/prison", "nordic/caves", "nordic/village"]) {
    const lib = await library(`${theme}/tiles.json`);
    const byId = new Map((lib.LETiles ?? []).map((tile) => [String(tile.id), tile]));

    for (let seed = 1; seed <= 60; seed++) {
      const floor = generateFloor(lib, { tier: 1, tileCount: 24, seed });
      const at = new Map(
        floor.tiles.map((tile) => [`${tile.x},${tile.y}`, byId.get(String(tile.tileId))])
      );

      for (const tile of floor.tiles) {
        const definition = byId.get(String(tile.tileId));
        // A wall on a solid edge is scenery; only a doorway can shut a room.
        if (!sealsNorth(definition) || !(Number(definition.exits?.[0]) > 0)) continue;
        walls += 1;
        const behind = at.get(`${tile.x},${tile.y - TILE_SIZE}`);
        assert.equal(
          behind?.category,
          "SECRET_TILE",
          `${theme} seed ${seed}: the wall at ${tile.x},${tile.y} shuts ` +
            `${behind ? `a ${behind.category}` : "nothing at all"}`
        );
      }
    }
  }
  assert.ok(walls > 20, `enough walls to be worth asserting on, saw ${walls}`);
});

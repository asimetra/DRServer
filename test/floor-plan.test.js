import test from "node:test";
import assert from "node:assert/strict";
import { floorPlanForMapNode, floorCountOf, loadFloorAt } from "../src/socket/floors.js";

/**
 * Which floors a node runs, resolved from the data rather than a hand-written
 * list — and a run is a sequence, not one kind or the other.
 *
 * `MapPage.CustomTileset` names a CustomMaps row carrying the authored files;
 * the node's tier says how many floors are laid out before them. A captured
 * Icewater Caverns Boss run is one of each.
 */

const kinds = (plan) => plan.floors.map((floor) => (floor.authored ? "authored" : "generated"));

test("the tutorial is two authored floors and no approach", async () => {
  const plan = await floorPlanForMapNode(50002);

  assert.deepEqual(kinds(plan), ["authored", "authored"]);
  assert.match(plan.floors[0].authored, /TUTORIAL_LEVEL_1/);
  assert.match(plan.floors[1].authored, /TUTORIAL_LEVEL_final/);
});

/**
 * Measured, not guessed. socket-20260815-225311.jsonl holds one run of node
 * 50009 under a single area:
 *
 *   floor 2000  nordic/caves/tiles.json, 14 tiles = ICE_CAVES_BOSS.NumTiles
 *   floor 2001  five tiles, byte for byte db_floor_ICE_CAVES_PAPA_YETI_BOSS
 *
 * Reading only the authored side gave one floor and opened the node on its
 * boss.
 */
test("a boss node lays out an approach, then loads its authored map", async () => {
  const plan = await floorPlanForMapNode(50009, { seed: 1 });

  assert.equal(floorCountOf(plan), 2, "the captured run was two floors");
  assert.deepEqual(kinds(plan), ["generated", "authored"]);
  assert.match(plan.floors[1].authored, /ICE_CAVES_PAPA_YETI_BOSS/);

  const approach = await loadFloorAt(plan, 0);
  assert.ok(approach.generated, "the first floor is laid out");
  assert.match(approach.tileLibrary, /nordic\/caves/);

  const boss = await loadFloorAt(plan, 1);
  assert.equal(boss.tiles.length, 5, "and the second is the authored five");
});

test("a node whose tier asks for no approach is authored throughout", async () => {
  const plan = await floorPlanForMapNode(50005); // ARENA_BOSS reports MinFloors 0

  assert.deepEqual(kinds(plan), ["authored"]);
  assert.match(plan.floors[0].authored, /ARENA_GAUNTLET\.json/);
});

/**
 * 50056 is the second Knight Fortress boss and names ARENA_GAUNTLET_2. Its file
 * shipped, but nothing listed it, so it used to load the first gauntlet.
 */
test("two nodes on the same theme get their own map", async () => {
  const first = await floorPlanForMapNode(50005);
  const second = await floorPlanForMapNode(50056);

  assert.notEqual(first.floors.at(-1).authored, second.floors.at(-1).authored);
  assert.match(second.floors.at(-1).authored, /ARENA_GAUNTLET_2/);
});

test("every boss node ends on its own authored map", async () => {
  // ColiseumTiers.MinFloors is the generated approach and
  // CustomMaps.NumFloors the authored ending. The deliberate zeroes on 50005
  // and 50035 are why those two open directly on their authored encounter.
  const bosses = new Map([
    [50002, "AA"], [50005, "A"], [50009, "GA"], [50014, "GA"],
    [50020, "GAA"], [50026, "GA"], [50035, "A"], [50043, "GA"],
    [50051, "GGA"], [50056, "GA"], [50069, "GGA"], [50083, "GGAA"],
  ]);

  const finals = [];
  for (const [id, expectedShape] of bosses) {
    const plan = await floorPlanForMapNode(id, { seed: 1 });
    const shape = kinds(plan).map((kind) => kind[0].toUpperCase()).join("");
    assert.equal(shape, expectedShape, `${id} has the wrong generated/authored floor sequence`);
    const last = plan.floors.at(-1);
    assert.ok(last.authored, `${id} does not end on an authored map`);
    finals.push(last.authored);
  }
  assert.equal(new Set(finals).size, bosses.size, "and no two of them share one");
});

test("an ordinary dungeon is laid out throughout", async () => {
  const plan = await floorPlanForMapNode(50008, { seed: 1 });

  assert.deepEqual(kinds(plan), ["generated", "generated"]);
  assert.match(plan.floors[0].generated.tileLibrary, /nordic\/caves/);
});

/** Or every floor of a run would be the same room twice. */
test("each laid-out floor of a run gets its own seed", async () => {
  const plan = await floorPlanForMapNode(50008, { seed: 7 });
  const seeds = plan.floors.map((floor) => floor.generated.seed);

  assert.equal(new Set(seeds).size, seeds.length);
});

/**
 * The area preloads tile libraries once, for the whole run.
 *
 * DistributedDungionArea.postGenerate fires a single CacheLoadRequest carrying
 * the list, and every floor afterwards names a path DungeonFloorFactory expects
 * to find already cached. Announcing only the first floor's library is right for
 * every dungeon the game ships, because a run stays in one theme — and wrong the
 * moment one does not, with the second floor asking for a library that was never
 * fetched.
 */
test("a run announces every tile library it will need", async () => {
  const { tileLibrariesFor } = await import("../src/socket/floors.js");

  const oneTheme = await tileLibrariesFor({
    floors: [{ authored: "castle/arena/db_floor_TUTORIAL_LEVEL_1.json" },
             { authored: "castle/arena/db_floor_TUTORIAL_LEVEL_final.json" }],
  });
  assert.equal(oneTheme.length, 1, "the tutorial is one theme twice over");

  const mixed = await tileLibrariesFor({
    floors: [
      { generated: { tileLibrary: "Resources/Levels/nordic/caves/tiles.json" } },
      { generated: { tileLibrary: "Resources/Levels/jungle/aztec/tiles.json" } },
      { generated: { tileLibrary: "Resources/Levels/nordic/caves/tiles.json" } },
    ],
  });
  assert.deepEqual(mixed, [
    "Resources/Levels/nordic/caves/tiles.json",
    "Resources/Levels/jungle/aztec/tiles.json",
  ], "each one once, in the order the run meets them");
});

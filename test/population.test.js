import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { loadFloor } from "../src/socket/floors.js";
import { createNavigationState, loadNavigationLibrary } from "../src/socket/navigation.js";
import { enemyPoolFor, markersFor, populationFor, stockFloor } from "../src/socket/population.js";

const tierOf = (gm, constant) =>
  gm.raw.ColiseumTiers.find((row) => row.Constant === constant);

test("a tier's enemies are sorted into the roles DungeonEnemy gives them", async () => {
  const gm = await loadGameMaster();

  // The arena row reads BRUTE=F KNIGHT=F KNIGHT_MARKSMAN=F KNIGHT_HALBERD=B
  // KNIGHT_THROWING=F JUGGERNAUT=M.
  const arena = enemyPoolFor(gm, "ARENA_INFINITE");
  assert.deepEqual(arena.bruiser, ["KNIGHT_HALBERD"]);
  assert.deepEqual(arena.miniboss, ["JUGGERNAUT"]);
  assert.deepEqual(arena.fodder.sort(), ["BRUTE", "KNIGHT", "KNIGHT_MARKSMAN", "KNIGHT_THROWING"]);

  const tutorial = enemyPoolFor(gm, "CASTLE_TIER1");
  assert.deepEqual(tutorial.fodder, ["KNIGHT_TUTORIAL"]);
  assert.deepEqual(tutorial.bruiser, ["BRUTE"]);

  // A tier the table says nothing about stocks nothing.
  assert.deepEqual(enemyPoolFor(gm, "NO_SUCH_TIER"), {
    fodder: [],
    bruiser: [],
    miniboss: [],
  });
});

test("the count lands inside the tier's quota", async () => {
  const gm = await loadGameMaster();

  /**
   * `CASTLE_TIER1` authors exactly six bruisers, and the official sends exactly
   * six — the one quota in the table with no range to hide in.
   */
  const tutorial = tierOf(gm, "CASTLE_TIER1");
  for (let seed = 0; seed < 20; seed += 1) {
    const random = () => (seed + 0.5) / 20;
    const stock = populationFor(gm, tutorial, random);
    const bruisers = stock.filter((entry) => entry.role === "bruiser").length;
    const fodder = stock.filter((entry) => entry.role === "fodder").length;
    assert.equal(bruisers, 6, "six, as the tier says and the corpus shows");
    assert.ok(fodder >= 35 && fodder <= 49, `fodder ${fodder} within 35-49`);
  }
});

test("fodder is dealt across the pool rather than piled on one constant", async () => {
  const gm = await loadGameMaster();
  const stock = populationFor(gm, tierOf(gm, "ARENA_INFINITE"), () => 0.5);
  const fodder = stock.filter((entry) => entry.role === "fodder");
  const counts = new Map();
  for (const entry of fodder) counts.set(entry.constant, (counts.get(entry.constant) ?? 0) + 1);

  // The recorded arena floor split 31 fodder 8/8/8/7 over its four constants.
  assert.equal(counts.size, 4);
  const spread = [...counts.values()].sort();
  assert.ok(spread.at(-1) - spread[0] <= 1, `evenly dealt, got ${spread.join("/")}`);
});

/**
 * Monsters stand where the tile says, and gather there.
 *
 * A tile authors `FODDER`, `BRUISER` and `MINIBOSS` placeholders and the
 * official fills each with a real enemy of that role — where a tile says
 * FODDER the corpus carries an ICE_IMP 334 times and a BABY_YETI 312. They
 * come about 2.7 to a marker: 13% land exactly on one and 62% within 80 units.
 *
 * An earlier cut scattered them around random points inside each tile. It
 * matched the spacing and still played wrong, which is the report this exists
 * to hold: "the mob placement definitely does not match the real game".
 */
test("a floor's spawn markers are what the tiles authored", async () => {
  const floor = await loadFloor("tutorial");
  const markers = markersFor(floor);
  assert.equal(markers.fodder.length, 18);
  assert.equal(markers.bruiser.length, 5);
  for (const marker of [...markers.fodder, ...markers.bruiser]) {
    assert.ok(Number.isFinite(marker.x) && Number.isFinite(marker.y));
  }
});

test("monsters are stocked onto the markers, not scattered", async () => {
  await loadNavigationLibrary();
  const gm = await loadGameMaster();
  const floor = await loadFloor("tutorial");
  const navigation = createNavigationState(floor.navigation);
  const markers = markersFor(floor);

  const stock = stockFloor(gm, { floor, navigation, tier: tierOf(gm, "CASTLE_TIER1") });
  assert.ok(stock.length > 0);

  const near = stock.filter((entry) => {
    const pool = markers[entry.role];
    return pool.some((marker) => Math.hypot(marker.x - entry.x, marker.y - entry.y) <= 150);
  });
  const share = near.length / stock.length;
  assert.ok(share > 0.75, `${Math.round(share * 100)}% within 150 of a marker of their role`);

  // And on the marker itself often enough to look placed rather than sprinkled.
  const exact = stock.filter((entry) =>
    markers[entry.role].some((marker) => marker.x === entry.x && marker.y === entry.y)
  );
  assert.ok(exact.length > 0, "some stand exactly where the tile put them");
});

test("stocking a floor names a constant and a place for each", async () => {
  await loadNavigationLibrary();
  const gm = await loadGameMaster();
  const floor = await loadFloor("tutorial");
  const navigation = createNavigationState(floor.navigation);

  const stock = stockFloor(gm, { floor, navigation, tier: tierOf(gm, "CASTLE_TIER1") });
  assert.ok(stock.length > 0);
  for (const entry of stock) {
    assert.ok(["KNIGHT_TUTORIAL", "BRUTE"].includes(entry.constant), entry.constant);
    assert.ok(Number.isFinite(entry.x) && Number.isFinite(entry.y));
  }
});

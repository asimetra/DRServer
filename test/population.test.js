import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { loadFloor } from "../src/socket/floors.js";
import { createNavigationState, loadNavigationLibrary } from "../src/socket/navigation.js";
import {
  enemyPoolFor,
  isStockedRoleMarker,
  markersFor,
  minibossesForFloor,
  populationFor,
  stockFloor,
} from "../src/socket/population.js";

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

test("stocked role markers are positions, while unstocked and named NPCs remain actors", async () => {
  const gm = await loadGameMaster();

  assert.equal(isStockedRoleMarker(gm, "CASTLE_TIER1", "FODDER"), true);
  assert.equal(isStockedRoleMarker(gm, "CASTLE_TIER1", "BRUISER"), true);
  assert.equal(isStockedRoleMarker(gm, "CASTLE_TIER1", "KNIGHT_TUTORIAL"), false);
  assert.equal(isStockedRoleMarker(gm, "NO_SUCH_TIER", "FODDER"), false);
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

test("Infinite population shrinks to its authored role floors without crossing minima", async () => {
  const gm = await loadGameMaster();
  const tier = gm.raw.ColiseumTiers.find((row) => row.Constant === "ARENA_INFINITE");
  const definition = gm.raw.InfiniteDungeons[0];
  const first = populationFor(gm, tier, () => 0, {
    infiniteDefinition: definition,
    floorNumber: 1,
  });
  const deep = populationFor(gm, tier, () => 0, {
    infiniteDefinition: definition,
    floorNumber: 55,
  });
  const count = (rows, role) => rows.filter((row) => row.role === role).length;

  assert.ok(count(deep, "fodder") <= count(first, "fodder"));
  assert.ok(count(deep, "bruiser") <= count(first, "bruiser"));
  assert.ok(count(deep, "fodder") >= Math.round(count(first, "fodder") * 0.35));
  assert.ok(count(deep, "bruiser") >= Math.round(count(first, "bruiser") * 0.75));
  // Minibosses author a drop of 0 to a floor of 0: none, from the first floor (97 captured floors, 1 miniboss).
  assert.equal(count(first, "miniboss"), 0);
  assert.equal(count(deep, "miniboss"), 0);
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

/**
 * A quota short of the markers leaves some empty, and which ones is a draw.
 * Dealt in tile order, the last tile's markers — the exit tile, often — were
 * the empty ones on every floor; the official's empty markers are anywhere.
 */
test("which markers a short quota fills is drawn, not the tiles' order", async () => {
  const gm = await loadGameMaster();
  const tier = { Constant: "CATACOMBS_A", MinMiniboss: 2, MaxMiniboss: 2, MinFodder: 0, MaxFodder: 0, MinBruiser: 0, MaxBruiser: 0 };
  const floor = {
    placements: { npc: Array.from({ length: 6 }, (_, i) => ({ kind: "npc", constant: "MINIBOSS", x: 1000 * i, y: 0 })) },
  };
  const seeded = (seed) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const filled = new Set();
  for (let run = 1; run <= 24; run += 1) {
    const stock = stockFloor(gm, { floor, navigation: null, tier, random: seeded(run) });
    assert.equal(stock.length, 2, "the quota, each on a marker of its own");
    for (const entry of stock) {
      const index = floor.placements.npc.findIndex((marker) => marker.x === entry.x && marker.y === entry.y);
      assert.ok(index >= 0, "exactly on a marker: the first of each marker's share stands on it");
      filled.add(index);
    }
  }
  assert.ok(filled.size >= 5, `over 24 floors the quota landed on ${filled.size} different markers, not always the first two`);
});

/**
 * Minibosses are the dungeon's, not each floor's: the captured two-floor
 * runs carry the tier's count across both floors (ARENA_D 4-6: 2+2, 1+4,
 * 2+3, 2+4), dealt one by one onto markers drawn from the whole dungeon's.
 */
test("the miniboss quota is the dungeon's, dealt over its floors by their markers", () => {
  const tier = { MinMiniboss: 6, MaxMiniboss: 6 };
  let sumOfBoth = 0, first = 0, second = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const a = minibossesForFloor(tier, { seed, byFloor: [2, 1], index: 0 });
    const b = minibossesForFloor(tier, { seed, byFloor: [2, 1], index: 1 });
    assert.equal(a + b, 6, "the two floors together carry the quota, every run");
    first += a; second += b; sumOfBoth += a + b;
  }
  assert.equal(sumOfBoth, 1200);
  assert.ok(first / second > 1.6 && first / second < 2.5, `two markers against one: ${first} vs ${second}`);

  assert.equal(minibossesForFloor(tier, { seed: 7, byFloor: [0, 3], index: 0 }), 0, "a floor with no marker gets none");
  assert.equal(minibossesForFloor(tier, { seed: 7, byFloor: [0, 3], index: 1 }), 6, "and the other carries the whole count");
  assert.equal(minibossesForFloor(tier, { seed: 7, byFloor: [4], index: 0 }), 6, "a run of one floor is the quota as before");
});

import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import {
  DEFAULT_LEAGUES,
  leagueAt,
  leagueOf,
  leaguesOf,
  nextLeague,
  parseLeagues,
  placesIn,
} from "../src/ranked/leagues.js";
import { NEW_PLAYER } from "../src/ranked/rating.js";

const names = (list) => list.map((league) => league.name);

test("everybody starts in the first league, and a rating is in the last band whose start it has reached", () => {
  assert.equal(leagueOf(NEW_PLAYER.rating).name, "Wooden");
  assert.deepEqual(
    names([0, 1049, 1050, 1199, 1200, 5000, -40].map((rating) => leagueOf(rating))),
    ["Wooden", "Wooden", "Silver", "Silver", "Gold", "Gold", "Wooden"],
    "the top league is never a band"
  );
});

test("the top league is the top 3% of the board, among those in the band under it", () => {
  const dragon = DEFAULT_LEAGUES.at(-1);
  assert.equal(placesIn(dragon, 100), 3);
  assert.equal(placesIn(dragon, 16), 0, "too few on the board for it");
  assert.deepEqual(
    names([1, 2, 3, 4].map((place) => leagueAt({ rating: 1320, place, of: 100 }))),
    ["Dragon", "Dragon", "Dragon", "Gold"]
  );
  assert.equal(leagueAt({ rating: 1190, place: 1, of: 100 }).name, "Silver", "first, but not yet Gold");
  assert.equal(leagueAt({ rating: 1400, place: null, of: 100 }).name, "Gold", "no place, no share");
});

test("the next league is the next band's start, or the top league's share", () => {
  assert.deepEqual(nextLeague({ rating: 1000, place: 40, of: 100 }), { league: "Silver", from: 1050 });
  assert.deepEqual(nextLeague({ rating: 1250, place: 9, of: 100 }), { league: "Dragon", top: 0.03 });
  assert.equal(nextLeague({ rating: 1400, place: 1, of: 100 }), null, "nothing above the top");
});

test("the shipped leagues: bands from 0, 1050 and 1200 under the game's chest tiers, and a top 3%", () => {
  assert.deepEqual(leaguesOf(config.ranked.leagues), DEFAULT_LEAGUES);
  assert.equal(leaguesOf(null), DEFAULT_LEAGUES, "unset is the defaults");
});

test("a league list that cannot be read is refused, and says why", () => {
  const band = (name, from) => ({ name, from, color: "#ffffff" });
  for (const [list, why] of [
    [[], /non-empty/],
    [[{ name: "", from: 0, color: "#ffffff" }], /name/],
    [[{ name: "A", from: 0, color: "#fff" }], /colour/],
    [[band("A", 0), band("B", 0)], /above/],
    [[{ name: "A", from: "x", color: "#ffffff" }], /number/],
    [[{ name: "A", top: 0.1, color: "#ffffff" }], /only the last/],
    [[band("A", 0), { name: "B", top: 0.1, color: "#ffffff" }, band("C", 900)], /only the last/],
    [[band("A", 0), { name: "B", top: 1.5, color: "#ffffff" }], /between 0 and 1/],
  ]) {
    assert.throws(() => parseLeagues(list), why);
  }
});

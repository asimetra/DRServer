import assert from "node:assert/strict";
import test from "node:test";

import {
  FLOOR,
  K,
  NEW_PLAYER,
  byStanding,
  displayRating,
  expectedScore,
  newPlayer,
  rateMatch,
  ratingRules,
  replayRatings,
} from "../src/ranked/rating.js";

const at = (rating) => ({ rating });

/** MCSR Ranked's own example: "the standard 20" for a race between equals. */
test("a race between equals moves each player 20, one up and one down", () => {
  const { first, second } = rateMatch(at(500), at(500), 1);
  assert.equal(first.rating, 520);
  assert.equal(second.rating, 480);
});

test("the gap decides the step: an upset moves the most, beating somebody far below almost nothing", () => {
  const upset = rateMatch(at(500), at(900), 1);
  assert.deepEqual([upset.first.rating, upset.second.rating], [536, 864]);
  const expected = rateMatch(at(900), at(500), 1);
  assert.deepEqual([expected.first.rating, expected.second.rating], [904, 496]);
  assert.equal(rateMatch(at(700), at(500), 0).first.rating, 670, "losing to somebody 200 below costs 30");
});

test("no race moves a rating by K or more", () => {
  for (const gap of [0, 50, 200, 400, 800, 1600]) {
    for (const score of [0, 0.5, 1]) {
      const { first } = rateMatch(at(1000), at(1000 + gap), score);
      assert.ok(Math.abs(first.rating - 1000) <= K, `gap ${gap}, score ${score}`);
    }
  }
});

test("a draw between equals changes nothing; against somebody stronger it lifts the weaker", () => {
  const even = rateMatch(at(500), at(500), 0.5);
  assert.deepEqual([even.first.rating, even.second.rating], [500, 500]);
  const uneven = rateMatch(at(500), at(700), 0.5);
  assert.deepEqual([uneven.first.rating, uneven.second.rating], [510, 690]);
});

test("nobody goes below the floor; the winner still gets the whole step", () => {
  // A 20-point gap is a step of 19; the loser has only 10 above the floor to give.
  const { first, second } = rateMatch(at(FLOOR + 30), at(FLOOR + 10), 1);
  assert.equal(second.rating, FLOOR);
  assert.equal(first.rating, FLOOR + 49);
  assert.equal(expectedScore(500, 500), 0.5);
});

test("the scale is the operator's: where everybody starts, the most a race moves, the floor", () => {
  const small = { start: 100, k: 8, floor: 0 };
  assert.deepEqual(newPlayer(small), { rating: 100 });
  const { first, second } = rateMatch(at(100), at(100), 1, small);
  assert.deepEqual([first.rating, second.rating], [104, 96]);
  const replayed = replayRatings([{ state: "finished", players: [1, 2], winner: 2 }], small);
  assert.deepEqual([replayed.get(1).rating, replayed.get(2).rating], [96, 104]);
  assert.equal(rateMatch(at(3), at(3), 0, small).first.rating, 0, "and the floor is that scale's");
  assert.throws(() => ratingRules({ start: 100, floor: 200 }), /floor/);
  assert.throws(() => ratingRules({ k: 0 }), /k must/);
});

test("a rating is shown as the whole number it is", () => {
  assert.deepEqual(displayRating({ rating: 512, games: 3 }), { rating: 512 });
});

test("a board is ordered by rating, then by more races, then by the older account", () => {
  const rows = [
    { accountId: 3, rating: 520, games: 1 },
    { accountId: 2, rating: 540, games: 2 },
    { accountId: 1, rating: 520, games: 1 },
    { accountId: 4, rating: 520, games: 4 },
  ];
  assert.deepEqual(rows.sort(byStanding).map((row) => row.accountId), [2, 4, 1, 3]);
});

/**
 * Ratings are a projection of the match log: the same log replayed gives the
 * same ratings, and a match that was voided simply is not in it.
 */
test("replaying the match log reproduces the ratings, and void or cancelled matches move nothing", () => {
  const log = [
    { state: "finished", players: [1, 2], winner: 1 },
    { state: "finished", players: [2, 3], winner: 3 },
    { state: "finished", players: [1, 3], winner: null }, // a draw
    { state: "void", players: [1, 2], winner: null },
    { state: "cancelled", players: [2, 3], winner: null },
  ];
  const once = replayRatings(log);
  const twice = replayRatings(log);
  assert.deepEqual(once, twice);
  assert.equal(once.get(1).games, 2);
  assert.equal(once.get(2).games, 2);
  assert.equal(once.get(3).games, 2);
  assert.ok(once.get(1).rating > NEW_PLAYER.rating);
  assert.ok(once.get(2).rating < NEW_PLAYER.rating);
});

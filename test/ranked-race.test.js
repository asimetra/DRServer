import assert from "node:assert/strict";
import test from "node:test";

import { createRace } from "../src/modes/ranked/race.js";

/**
 * docs/ranked.md, "Outcomes": every row of that table is a test here. Times
 * are seconds from the pairing, so the cases read like the table does.
 */
const A = 101;
const B = 202;
const s = (seconds) => seconds * 1000;

const rules = {
  maxDurationMs: s(30 * 60),
  forfeitWindowMs: s(120),
  drawWindowMs: s(5),
};

/** A race both players have started, A at `aStart` and B at `bStart`. */
const running = ({ aStart = 10, bStart = 10 } = {}) => {
  const race = createRace({ id: "r1", spec: { mapNodeId: 50006, seed: 7 }, players: [A, B], rules, at: 0 });
  race.loading(s(1));
  race.started(A, s(aStart));
  race.started(B, s(bStart));
  return race;
};

test("a race is running only once both players' floors are ready", () => {
  const race = createRace({ id: "r1", spec: {}, players: [A, B], rules, at: 0 });
  assert.equal(race.state, "paired");
  race.loading(s(1));
  assert.equal(race.state, "loading");
  race.started(A, s(4));
  assert.equal(race.state, "loading");
  race.started(B, s(9));
  assert.equal(race.state, "running");
});

test("the shorter time from each player's own start wins, not the first across the line", () => {
  // B's floor was ready 3 s later; B crosses 2 s later on the wall clock but
  // took a second less.
  const race = running({ aStart: 10, bStart: 13 });
  race.finished(A, s(110)); // 100 s
  assert.equal(race.result, null, "not certain while B's own clock is short of 100 s");
  race.finished(B, s(112)); // 99 s
  assert.equal(race.result.state, "finished");
  assert.equal(race.result.winner, B);
  assert.equal(race.result.reason, "faster");
  assert.equal(race.players.get(B).elapsedMs, s(99));
});

test("a finish is declared as soon as the other player's own clock passes it", () => {
  const race = running({ aStart: 10, bStart: 13 });
  race.finished(A, s(110)); // 100 s
  race.tick(s(112)); // B at 99 s: still possible
  assert.equal(race.result, null);
  race.tick(s(113)); // B at 100 s: no longer faster
  assert.equal(race.result.winner, A);
  assert.equal(race.result.reason, "faster");
});

test("the same time to the millisecond is a draw", () => {
  const race = running({ aStart: 10, bStart: 12 });
  race.finished(A, s(110));
  race.finished(B, s(112));
  assert.equal(race.result.state, "finished");
  assert.equal(race.result.winner, null);
  assert.equal(race.result.reason, "same_time");
});

for (const cause of ["left", "dropped", "failed"]) {
  test(`a player who ${cause === "failed" ? "fails their run" : cause} while running loses, decided once the draw window has passed`, () => {
    const race = running();
    race.lost(A, s(400), cause);
    assert.equal(race.result, null, "the other has the draw window to lose too");
    race.tick(s(404));
    assert.equal(race.result, null);
    race.tick(s(405));
    assert.equal(race.result.winner, B);
    assert.equal(race.result.reason, "opponent_lost");
    assert.equal(race.players.get(A).cause, cause);
    assert.equal(race.result.forfeit, undefined, "not a forfeit this late");
  });
}

test("both losing within the draw window is a draw", () => {
  const race = running();
  race.lost(A, s(400), "failed");
  race.lost(B, s(403), "failed");
  assert.equal(race.result.state, "finished");
  assert.equal(race.result.winner, null);
  assert.equal(race.result.reason, "both_lost");
});

test("the first loss decides: a later loss by the other changes nothing", () => {
  const race = running();
  race.lost(A, s(400), "failed");
  race.tick(s(406));
  assert.equal(race.result.winner, B);
  race.lost(B, s(410), "left");
  assert.equal(race.result.winner, B);
});

test("a loss after the other has finished hands them the race at once", () => {
  const race = running({ aStart: 10, bStart: 30 });
  race.finished(A, s(110)); // 100 s; B's clock is at 80 s
  race.lost(B, s(115), "left");
  assert.equal(race.result.winner, A);
});

test("losing in the first minutes is recorded as a forfeit", () => {
  const race = running();
  race.lost(A, s(60), "left"); // 50 s into A's race
  race.tick(s(65));
  assert.equal(race.result.winner, B);
  assert.equal(race.result.forfeit, A);
});

test("nobody finishing within the time limit is a draw", () => {
  const race = running({ aStart: 10, bStart: 12 });
  race.tick(s(10 + 30 * 60 - 1));
  assert.equal(race.result, null);
  race.tick(s(12 + 30 * 60));
  assert.equal(race.result.winner, null);
  assert.equal(race.result.reason, "time");
});

test("leaving or dropping before the race runs cancels it, and says whose doing it was", () => {
  for (const before of ["paired", "loading", "one started"]) {
    const race = createRace({ id: "r1", spec: {}, players: [A, B], rules, at: 0 });
    if (before !== "paired") race.loading(s(1));
    if (before === "one started") race.started(A, s(5));
    race.lost(B, s(6), "dropped");
    assert.equal(race.result.state, "cancelled", before);
    assert.equal(race.result.blame, B, before);
    assert.equal(race.result.winner, null, before);
  }
});

test("a race the server could not run is void, whoever was ahead", () => {
  const race = running({ aStart: 10, bStart: 30 });
  race.finished(A, s(110)); // ahead, not yet certain: B's clock is at 80 s
  assert.equal(race.result, null);
  race.voided(s(111), "worker_died");
  assert.equal(race.result.state, "void");
  assert.equal(race.result.winner, null);
  assert.equal(race.result.reason, "worker_died");

  const early = createRace({ id: "r2", spec: {}, players: [A, B], rules, at: 0 });
  early.voided(s(2), "start_failed");
  assert.equal(early.result.state, "void");
});

test("once decided, a race does not change", () => {
  const race = running();
  race.lost(A, s(400), "left");
  race.tick(s(406));
  const decided = race.result;
  race.finished(B, s(500));
  race.voided(s(501), "server_stopped");
  race.tick(s(9999));
  assert.deepEqual(race.result, decided);
});

test("events about somebody not in the race are refused", () => {
  const race = running();
  assert.throws(() => race.finished(999, s(20)), /not in race r1/);
});

test("the timeline records what happened to each player, in order", () => {
  const race = running();
  race.note(A, "floor_cleared", { floor: 1 }, s(50));
  race.finished(A, s(110));
  race.tick(s(111));
  const types = race.timeline.map((entry) => `${entry.player ?? "-"}:${entry.type}`);
  assert.deepEqual(types, [
    "-:paired",
    "-:loading",
    `${A}:started`,
    `${B}:started`,
    "-:running",
    `${A}:floor_cleared`,
    `${A}:finished`,
    "-:decided",
  ]);
});

test("both offering a draw ends the race void, with nobody to blame; one offering changes nothing", () => {
  const race = running();
  assert.equal(race.offerDraw(A, s(100)), false);
  assert.equal(race.result, null, "one asking is a question, not an answer");
  assert.equal(race.offerDraw(A, s(101)), false, "asked once");
  assert.equal(race.offerDraw(B, s(130)), true);
  assert.equal(race.result.state, "void");
  assert.equal(race.result.reason, "agreed");
  assert.equal(race.result.blame, undefined);
  assert.deepEqual(race.timeline.filter((e) => e.type === "draw_offered").map((e) => e.player), [A, B]);

  const decided = running();
  decided.lost(A, s(400), "left");
  decided.tick(s(406));
  assert.equal(decided.offerDraw(B, s(410)), false, "a decided race is not called off");
  assert.equal(decided.result.winner, B);
});

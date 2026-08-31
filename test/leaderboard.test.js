import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "leaderboard-"));
process.env.ODS_DATA_DIR = scratch;

const { BOARDS, boardFor, rankable, recordRuns, MAX_BOARD_SIZE } =
  await import("../src/leaderboard.js");

test.after(() => {
  delete process.env.ODS_DATA_DIR;
  fs.rmSync(scratch, { recursive: true, force: true });
});

let node = 50000;
const aNode = () => node++;

const run = (over = {}) => ({
  account_id: 1,
  name: "Player",
  avatar_id: 1,
  hero_id: 101,
  map_node_id: 50003,
  party_size: 1,
  started_at: "2026-08-31T12:00:00.000Z",
  finished_at: "2026-08-31T12:02:00.000Z",
  duration_ms: 120_000,
  success: true,
  floors: 1,
  kills: 10,
  damage: 500,
  gold: 100,
  xp: 250,
  trophies: 12,
  rankable: true,
  ...over,
});

test("the fastest clear leads the speedrun board", async () => {
  const map_node_id = aNode();
  await recordRuns([
    run({ account_id: 1, map_node_id, duration_ms: 90_000 }),
    run({ account_id: 2, map_node_id, duration_ms: 60_000 }),
    run({ account_id: 3, map_node_id, duration_ms: 120_000 }),
  ]);

  const board = await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 });

  assert.deepEqual(
    board.map((entry) => [entry.rank, entry.account_id, entry.value]),
    [[1, 2, 60_000], [2, 1, 90_000], [3, 3, 120_000]]
  );
});

test("a standing only moves when it is beaten", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 1, map_node_id, duration_ms: 60_000 })]);
  await recordRuns([run({ account_id: 1, map_node_id, duration_ms: 95_000 })]);

  const [best] = await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 });
  assert.equal(best.value, 60_000, "a slower run does not replace a faster one");

  await recordRuns([run({ account_id: 1, map_node_id, duration_ms: 45_000 })]);
  const [better] = await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 });
  assert.equal(better.value, 45_000);
});

/**
 * A walk-out is not a fast clear, and the board says so. Experience is not
 * gated the same way: what a failed run earned was still earned.
 */
test("only a finished run reaches the speedrun board", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 9, map_node_id, duration_ms: 1_000, success: false })]);

  assert.deepEqual(await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 }), []);
});

/**
 * Heroes and party sizes are separate races. Ranking them together would make
 * the board about the roster rather than the players.
 */
test("a hero and a party size rank on their own board", async () => {
  const map_node_id = aNode();
  await recordRuns([
    run({ account_id: 1, map_node_id, hero_id: 101, party_size: 1, duration_ms: 90_000 }),
    run({ account_id: 2, map_node_id, hero_id: 106, party_size: 1, duration_ms: 30_000 }),
    run({ account_id: 3, map_node_id, hero_id: 101, party_size: 4, duration_ms: 20_000 }),
  ]);

  const solo = await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 });
  assert.deepEqual(solo.map((e) => e.account_id), [1], "the other two are elsewhere");
});

test("experience and clears accumulate rather than replace", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 40, map_node_id, xp: 300 })]);
  await recordRuns([run({ account_id: 40, map_node_id, xp: 200 })]);

  const experience = (await boardFor("experience", {})).find((e) => e.account_id === 40);
  const clears = (await boardFor("clears", {})).find((e) => e.account_id === 40);

  assert.equal(experience.value, 500, "two runs, both counted");
  assert.equal(clears.value, 2);
});

/**
 * Infinite Island has no last floor, so a clear time is not a thing that
 * exists there — and its own measure, depth, is not paid out yet.
 */
test("Infinite is off the boards", () => {
  assert.equal(rankable("DUNGEON"), true);
  assert.equal(rankable("BOSS"), true);
  assert.equal(rankable("INFINITE"), false);
});

test("a run with no start time is kept out of the boards", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 77, map_node_id, rankable: false })]);

  assert.deepEqual(await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 }), []);
});

/**
 * The board is read by a web front end over the internal API, so the size it
 * asks for is capped rather than trusted.
 */
test("the board size is capped", async () => {
  const map_node_id = aNode();
  await recordRuns(
    Array.from({ length: 8 }, (_, index) =>
      run({ account_id: 200 + index, map_node_id, duration_ms: 10_000 + index })
    )
  );

  const asked = await boardFor("speedrun", {
    node: map_node_id, hero: 101, party: 1, limit: 10_000,
  });
  assert.ok(asked.length <= MAX_BOARD_SIZE);

  const three = await boardFor("speedrun", {
    node: map_node_id, hero: 101, party: 1, limit: 3,
  });
  assert.equal(three.length, 3);
});

test("an unknown board is not a board", async () => {
  assert.equal(await boardFor("mostGold", {}), null);
  assert.deepEqual(Object.keys(BOARDS), ["speedrun", "experience", "clears"]);
});

/**
 * The history is kept whole even though nothing draws a board from it — the
 * boards are bounded and the history is what a later question is answered from.
 */
test("every run is written to the history", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 501, map_node_id, kills: 42 })]);

  const lines = fs
    .readFileSync(path.join(scratch, "dungeon-runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const mine = lines.find((entry) => entry.account_id === 501);
  assert.equal(mine.kills, 42, "the columns no board reads are still recorded");
  assert.equal(mine.map_node_id, map_node_id);
});

/**
 * The trophy count travels with a standing.
 *
 * Denormalised the way the name already is, so drawing a board is one read
 * rather than a read and an account load per row — and the count as it stood
 * when the record was set is the more honest number to show beside it.
 */
test("a standing carries the trophies its holder had", async () => {
  const map_node_id = aNode();
  await recordRuns([
    run({ account_id: 61, map_node_id, duration_ms: 70_000, trophies: 38 }),
    run({ account_id: 62, map_node_id, duration_ms: 80_000, trophies: 4 }),
  ]);

  const board = await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 });
  assert.deepEqual(board.map((e) => [e.account_id, e.trophies]), [[61, 38], [62, 4]]);
});

test("a run recorded without trophies reads as none rather than missing", async () => {
  const map_node_id = aNode();
  const { trophies, ...withoutTrophies } = run({ account_id: 63, map_node_id });
  await recordRuns([withoutTrophies]);

  const [entry] = await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 });
  assert.equal(entry.trophies, 0);
});

/**
 * Titles come from trophies, and trophies are bounded.
 *
 * A trophy is the first clear of a boss node, one each, and the game has twelve
 * boss nodes — so the ladder is 0 to 12 and every player climbs it at their own
 * pace. That is what lets a title be general rather than weekly: a ranking
 * title would belong to the same five people forever, while this one is only a
 * question of how much of the game somebody has beaten.
 */
test("a title is earned by beating bosses, and tops out at twelve", async () => {
  const { TITLES, titleFor } = await import("../src/leaderboard.js");

  assert.equal(titleFor(0), null, "nobody is called anything for turning up");
  assert.equal(titleFor(1).name, "Challenger", "the first boss is worth a name");
  assert.equal(titleFor(4).name, "Challenger");
  assert.equal(titleFor(5).name, "Hunter");
  assert.equal(titleFor(9).name, "Slayer");
  assert.equal(titleFor(12).name, "Champion");

  // Twelve is the ceiling because twelve is how many boss nodes exist.
  assert.equal(TITLES[0].at, 12);
  assert.equal(titleFor(99).name, "Champion", "there is nowhere above it");
});

test("the tiers are the rarity ladder", async () => {
  const { titleFor } = await import("../src/leaderboard.js");
  assert.deepEqual(
    [12, 9, 5, 1].map((n) => titleFor(n).tier),
    ["legendary", "rare", "uncommon", "common"]
  );
});

test("a board entry carries the holder's title", async () => {
  const map_node_id = aNode();
  await recordRuns([
    run({ account_id: 71, map_node_id, duration_ms: 60_000, trophies: 12 }),
    run({ account_id: 72, map_node_id, duration_ms: 70_000, trophies: 6 }),
    run({ account_id: 73, map_node_id, duration_ms: 80_000, trophies: 0 }),
  ]);

  const board = await boardFor("speedrun", { node: map_node_id, hero: 101, party: 1 });
  assert.deepEqual(board.map((e) => e.title?.name ?? null), ["Champion", "Hunter", null]);
});

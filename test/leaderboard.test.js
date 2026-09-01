import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "leaderboard-"));
process.env.ODS_DATA_DIR = scratch;

const { BOARDS, boardFor, rankable, recordRuns, runsSince, MAX_BOARD_SIZE } =
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

test("clears accumulate rather than replace", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 40, map_node_id })]);
  await recordRuns([run({ account_id: 40, map_node_id })]);

  const clears = (await boardFor("clears", {})).find((e) => e.account_id === 40);
  assert.equal(clears.value, 2);
});

/**
 * The experience board ranks what a hero holds, not what runs have paid out.
 * A run's own xp is history; `hero_xp` is the figure the training screen reads.
 * It is a best, so it replaces when beaten and stands when it is not — and a
 * run by a less-practised hero moves nothing.
 */
test("the experience standing is the most a hero holds, replaced only when beaten", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 40, map_node_id, hero_id: 101, xp: 300, hero_xp: 12_400 })]);
  await recordRuns([run({ account_id: 40, map_node_id, hero_id: 101, xp: 200, hero_xp: 12_600 })]);
  await recordRuns([run({ account_id: 40, map_node_id, hero_id: 106, xp: 500, hero_xp: 90 })]);

  const experience = (await boardFor("hero_experience", {})).find((e) => e.account_id === 40);
  assert.equal(experience.value, 12_600, "a worse run does not replace a better one");
  assert.equal(experience.hero_id, 101, "the hero that set it is the hero on the standing");
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
  assert.equal(await boardFor("experience", {}), null, "the old name ranks nothing any more");
  assert.deepEqual(Object.keys(BOARDS), ["speedrun", "hero_experience", "clears"]);
});

/**
 * The old board's standings meant something else — what runs paid out, summed —
 * and no rule turns that into the figure the board ranks now. They are swept
 * rather than shown, and everything else in the file survives the sweep.
 */
test("the old experience board's standings are swept at startup", async () => {
  const bestsFile = path.join(scratch, "dungeon-bests.json");
  const bests = JSON.parse(fs.readFileSync(bestsFile, "utf8"));
  bests.experience = { 5: { value: 999_999, name: "Ghost of the old board" } };
  fs.writeFileSync(bestsFile, JSON.stringify(bests));

  const { purgeLegacyExperienceBoard } = await import("../src/leaderboard.js");
  await purgeLegacyExperienceBoard();

  const swept = JSON.parse(fs.readFileSync(bestsFile, "utf8"));
  assert.ok(!("experience" in swept), "the accumulated total is gone");
  assert.ok("speedrun" in swept, "and the boards that still mean what they meant do not");
});

/**
 * The board ranks what heroes hold, and heroes held plenty before the board
 * existed. Startup lifts the best avatar of every account in, and a run that
 * set a standing the seed cannot beat stays standing — with the hero that set
 * it.
 */
test("the hero experience board is seeded from the accounts themselves", async () => {
  const { createNewAccount, loadAccount, saveAccount } = await import("../src/accounts.js");
  const { seedHeroExperienceStandings } = await import("../src/leaderboard.js");

  const veteran = await createNewAccount({});
  const account = await loadAccount(veteran.id);
  account.name = "Old Hand";
  account.account_avatars[0].experience = 366_773;
  await saveAccount(account);

  await recordRuns([run({ account_id: 90, hero_id: 106, xp: 10, hero_xp: 400_000 })]);
  await seedHeroExperienceStandings();

  const board = await boardFor("hero_experience", {});
  const seeded = board.find((e) => e.account_id === veteran.id);
  assert.ok(seeded, "the account's banked experience reached the board");
  assert.equal(seeded.value, 366_773);
  assert.equal(seeded.name, "Old Hand");
  assert.equal(seeded.hero_id, account.account_avatars[0].avatar_id);

  const fromRun = board.find((e) => e.account_id === 90);
  assert.equal(fromRun.value, 400_000, "a standing from a run is not lowered by the seed");
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

/**
 * And so does the hero it was set on.
 *
 * Same argument as the trophies: a board is one read rather than a read plus an
 * account load per row, and a time belongs to the hero who set it whatever that
 * player is running now. Only the id is stored — the name and the picture are
 * the GameMaster's answer and are put on at the API's edge.
 */
test("a standing carries the hero it was set on", async () => {
  const map_node_id = aNode();
  await recordRuns([
    run({ account_id: 64, map_node_id, hero_id: 105, duration_ms: 70_000 }),
    run({ account_id: 65, map_node_id, hero_id: 105, duration_ms: 80_000 }),
  ]);

  const board = await boardFor("speedrun", { node: map_node_id, hero: 105, party: 1 });
  assert.deepEqual(board.map((e) => e.hero_id), [105, 105]);
});

/**
 * A best is somebody's, on a hero. Unlike a lifetime total there is a single
 * hero behind the figure — whoever set it — so the standing carries them, and
 * keeps carrying them while the record stands.
 */
test("the experience standing keeps the hero that set it", async () => {
  const map_node_id = aNode();
  await recordRuns([run({ account_id: 66, map_node_id, hero_id: 101, xp: 100, hero_xp: 5_000 })]);
  await recordRuns([run({ account_id: 66, map_node_id, hero_id: 106, xp: 500, hero_xp: 90 })]);

  const mine = (await boardFor("hero_experience", {})).find((e) => e.account_id === 66);
  assert.equal(mine.hero_id, 101, "the record still belongs to the hero that set it");
  assert.equal(mine.value, 5_000);
});

test("a run recorded without a hero reads as none rather than missing", async () => {
  const map_node_id = aNode();
  const { hero_id, ...withoutHero } = run({ account_id: 67, map_node_id });
  await recordRuns([withoutHero]);

  const [entry] = await boardFor("speedrun", { node: map_node_id, hero: undefined, party: 1 });
  assert.equal(entry.hero_id, null);
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

/**
 * Counting a day's runs, and the shortcut that does not work.
 *
 * Walking the file backwards until a row falls outside the window wants it to
 * be ordered by `finished_at`, and it is not: rows are appended when a run is
 * recorded, so a long run finishing after a short one puts the later timestamp
 * first. Written that way the count came back zero with two runs in the window.
 */
test("a day's runs are counted however the file is ordered", async () => {
  const map_node_id = aNode();
  const now = new Date().toISOString();
  const longAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

  // Deliberately out of order: recent, then old, then recent.
  await recordRuns([run({ account_id: 81, map_node_id, finished_at: now })]);
  await recordRuns([run({ account_id: 82, map_node_id, finished_at: longAgo })]);
  await recordRuns([run({ account_id: 83, map_node_id, finished_at: now })]);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const counted = await runsSince(since);

  assert.ok(counted >= 2, `two runs are inside the window, counted ${counted}`);
});

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { warn } from "./log.js";

/**
 * What a finished run leaves behind, and the boards read off it.
 *
 * Two shapes, because they answer different questions and cost different
 * things:
 *
 *   runs    append-only, one row per run, never updated. The history. Grows
 *           with play — measured at 1.7 minutes a run, so a hundred players at
 *           an hour a day is about 3,500 rows and 170 MB a year.
 *   bests   one row per thing being ranked, replaced when beaten. Bounded by
 *           players times boards rather than by play, so a board is a small
 *           indexed read rather than an aggregate over the history.
 *
 * The second is the whole reason a leaderboard is cheap. Nothing queries the
 * history to draw a board, so the history can grow without the boards slowing
 * down, and it can be trimmed or rolled up later without the boards noticing.
 *
 * None of this is on the account's write path. A run record is written after
 * the report is generated, through its own store, and a failure here is logged
 * and dropped — a leaderboard is not worth failing a run over.
 */

const usingDatabase = () => config.storage === "postgres";

let database = null;
const db = async () => {
  database ??= await import("./storage/postgres.js");
  return database;
};

/**
 * The boards, and what each one means by "better".
 *
 * Deliberately short. A metric that everyone converges on is not a
 * competition: in a fixed dungeon the enemy count is set by the floor build,
 * so kills and total damage are very nearly constant and rank nobody. Gold is
 * partly the reward roll's luck. Damage taken sounds like skill and is mostly
 * party composition — somebody else tanking is not a worse run.
 *
 * What survives that filter is time, and two measures of how long somebody has
 * been playing.
 */
export const BOARDS = Object.freeze({
  /**
   * Fastest clear, and the only one scoped to a dungeon.
   *
   * Per hero and party size as well as per node, because the spread between
   * heroes is wider than the spread between players, and a four-player clear is
   * not the same race as a solo one. A single global speedrun board would rank
   * whichever hero is strongest and nothing else.
   *
   * Successful runs only: a walk-out is not a fast clear.
   */
  speedrun: { better: "lower", scope: "node", successOnly: true },
  /** Experience earned, all heroes together. Levels stop at 100; this does not. */
  experience: { better: "higher", scope: "player", successOnly: false },
  /** Dungeons finished, ever. The plainest measure of having been here a while. */
  clears: { better: "higher", scope: "player", successOnly: true },
});

/**
 * What a player is called, from what they have beaten.
 *
 * Trophies are the game's own completion measure and a bounded one: a trophy is
 * the first clear of a boss node, one each, and there are twelve boss nodes.
 * So the ladder runs 0 to 12 and everybody climbs it at their own pace — which
 * is what makes a title worth having without needing a weekly reset to keep it
 * reachable. A ranking title would belong to five people forever.
 *
 * The tiers are the rarity ladder again, because that is the vocabulary the
 * player already reads: twelve of twelve is legendary and there is nowhere
 * above it, and the first boss is worth being called something.
 */
export const TITLES = Object.freeze([
  { at: 12, name: "Champion", tier: "legendary" },
  { at: 9,  name: "Slayer",   tier: "rare" },
  { at: 5,  name: "Hunter",   tier: "uncommon" },
  { at: 1,  name: "Challenger", tier: "common" },
]);

/** The highest title a trophy count has earned, or null below the first. */
export const titleFor = (trophies) =>
  TITLES.find((title) => Number(trophies ?? 0) >= title.at) ?? null;

/**
 * Infinite Island is not on any board.
 *
 * It has no last floor — `InfiniteDungeons` scales health and damage per floor
 * and never stops — so a clear time is not a thing that exists there. Its own
 * measure is depth, which this server does not pay the authored floor rewards
 * for yet, so ranking it would rank a subsystem rather than the players.
 */
export const rankable = (nodeType) => nodeType !== "INFINITE";

const file = (name) => path.join(config.dataDir, name);
const RUNS_FILE = "dungeon-runs.jsonl";
const BESTS_FILE = "dungeon-bests.json";

const readJson = async (name, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file(name), "utf8"));
  } catch (problem) {
    if (problem.code !== "ENOENT") warn(`leaderboard: could not read ${name}: ${problem.message}`);
    return fallback;
  }
};

/**
 * Replaced whole, through a temporary file, the way accounts are. The bests are
 * bounded — players times boards — so there is nothing to gain from anything
 * cleverer, and a half-written board is worse than a stale one.
 */
let temporaryId = 0;
const writeJson = async (name, value) => {
  await fs.mkdir(config.dataDir, { recursive: true });
  const target = file(name);
  const temporary = `${target}.${process.pid}.${++temporaryId}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  } catch (problem) {
    await fs.rm(temporary, { force: true });
    throw problem;
  }
};

/** The key a run competes under, which is what `scope` decides. */
const keyFor = (metric, run) =>
  BOARDS[metric].scope === "node"
    ? `${metric}:${run.map_node_id}:${run.hero_id}:${run.party_size}`
    : `${metric}`;

const valueFor = (metric, run) => {
  if (metric === "speedrun") return run.duration_ms;
  if (metric === "experience") return run.xp;
  return 1;
};

/**
 * Which standings one run touches, and by how much.
 *
 * Shared by both backends so a board cannot mean one thing in a file and
 * another in a table — the file store folds these in memory, Postgres folds the
 * same list in SQL.
 */
/**
 * The trophy count rides along with a standing.
 *
 * Denormalised on purpose, the way the name already is: a board is then one
 * read rather than a read and a fan-out of account loads. It is the count as it
 * stood when the record was set, which is also the more honest number to show
 * beside a record.
 */
export const boardEntriesFor = (run) =>
  Object.entries(BOARDS)
    .filter(([, board]) => !board.successOnly || run.success)
    .map(([metric]) => ({
      metric,
      key: keyFor(metric, run),
      value: valueFor(metric, run),
    }));

const beats = (metric, value, standing) => {
  if (standing === undefined) return true;
  return BOARDS[metric].better === "lower" ? value < standing : value > standing;
};

/**
 * Folds one run into the bests.
 *
 * `higher` boards that count rather than measure — clears — accumulate instead
 * of replacing, which is what makes "how many" a board at all.
 */
const foldRun = (bests, run) => {
  for (const [metric, board] of Object.entries(BOARDS)) {
    if (board.successOnly && !run.success) continue;
    const key = keyFor(metric, run);
    const row = (bests[key] ??= {});
    const value = valueFor(metric, run);
    const standing = row[run.account_id]?.value;

    if (metric === "clears" || metric === "experience") {
      row[run.account_id] = {
        value: (standing ?? 0) + value,
        at: run.finished_at,
        name: run.name,
        trophies: run.trophies ?? 0,
      };
      continue;
    }
    if (beats(metric, value, standing)) {
      row[run.account_id] = {
        value,
        at: run.finished_at,
        name: run.name,
        trophies: run.trophies ?? 0,
      };
    }
  }
  return bests;
};

/**
 * Records finished runs and folds them into the boards.
 *
 * Takes a list because a party finishes together, and one write for four
 * players is one write.
 */
export const recordRuns = async (runs) => {
  const rankableRuns = runs.filter((run) => run && run.rankable !== false);
  if (!rankableRuns.length) return 0;

  if (usingDatabase()) {
    await (await db()).recordRuns(rankableRuns, boardEntriesFor);
    return rankableRuns.length;
  }

  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.appendFile(
    file(RUNS_FILE),
    `${rankableRuns.map((run) => JSON.stringify(run)).join("\n")}\n`,
    "utf8"
  );
  const bests = await readJson(BESTS_FILE, {});
  for (const run of rankableRuns) foldRun(bests, run);
  await writeJson(BESTS_FILE, bests);
  return rankableRuns.length;
};

/**
 * One board, ordered and cut.
 *
 * `limit` is capped rather than trusted: this is read by a web front end over
 * the internal API, and an unbounded top-N is an unbounded response.
 */
export const MAX_BOARD_SIZE = 100;

export const boardFor = async (metric, { node, hero, party, limit = 20 } = {}) => {
  const board = BOARDS[metric];
  if (!board) return null;

  const size = Math.max(1, Math.min(MAX_BOARD_SIZE, Number(limit) || 20));
  const key =
    board.scope === "node" ? `${metric}:${node}:${hero}:${party}` : `${metric}`;

  if (usingDatabase()) {
    const rows = await (await db()).boardRows(key, {
      ascending: board.better === "lower",
      limit: size,
    });
    return rows.map((entry, index) => ({ rank: index + 1, ...entry }));
  }

  const rows = (await readJson(BESTS_FILE, {}))[key] ?? {};
  return Object.entries(rows)
    .map(([accountId, entry]) => ({
      account_id: Number(accountId),
      name: entry.name ?? null,
      trophies: entry.trophies ?? 0,
      title: titleFor(entry.trophies),
      value: entry.value,
      at: entry.at,
    }))
    .sort((a, b) => (board.better === "lower" ? a.value - b.value : b.value - a.value))
    .slice(0, size)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
};

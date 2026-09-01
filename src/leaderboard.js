import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { info, warn } from "./log.js";
import { accountTrophies } from "./map-progress.js";

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
  /**
   * The most experience a single hero holds.
   *
   * Not what runs have paid out over a lifetime — that is a record of runs,
   * and the website's front page used to keep it under this name. What a
   * player means by "most experience" is the figure the training screen reads:
   * what the hero itself has banked, the same number the levels come from,
   * capped where the hero's ladder caps. Replaced when beaten, like a best,
   * because it is one.
   */
  hero_experience: { better: "higher", scope: "player", successOnly: false },
  /**
   * Trophies: the boss nodes a player has beaten, twelve at the top.
   *
   * The run record carries the holder's total as it stood when the run ended,
   * so any run — a first clear or a replay — refreshes a standing that is
   * otherwise a best. The bounded ladder is what makes ranking it fair: the
   * top of this board is a completion table, not a wide-open race.
   */
  trophies: { better: "higher", scope: "player", successOnly: false },
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
  if (metric === "hero_experience") return run.hero_xp ?? 0;
  if (metric === "trophies") return run.trophies ?? 0;
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
 * The trophy count and the hero ride along with a standing.
 *
 * Denormalised on purpose, the way the name already is: a board is then one
 * read rather than a read and a fan-out of account loads. Both are as they
 * stood when the record was set, which is also the more honest thing to show
 * beside a record — a time was set by the hero who set it, whatever that
 * player is playing now.
 *
 * Only the hero's id is kept. Its name and its picture are the GameMaster's
 * answer and it is already loaded in this process, so resolving them at read
 * time is a lookup in a Map rather than a second copy of the name to keep in
 * step with the tables.
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
 * The one board that counts rather than measures — clears — accumulates
 * instead of replacing, which is what makes "how many" a board at all. Every
 * other standing, the hero experience among them, is a best: it moves only
 * when beaten.
 */
const foldRun = (bests, run) => {
  for (const [metric, board] of Object.entries(BOARDS)) {
    if (board.successOnly && !run.success) continue;
    const key = keyFor(metric, run);
    const row = (bests[key] ??= {});
    const value = valueFor(metric, run);
    const standing = row[run.account_id]?.value;

    if (metric === "clears") {
      row[run.account_id] = {
        value: (standing ?? 0) + value,
        at: run.finished_at,
        name: run.name,
        trophies: run.trophies ?? 0,
        hero_id: run.hero_id ?? null,
      };
      continue;
    }
    if (beats(metric, value, standing)) {
      row[run.account_id] = {
        value,
        at: run.finished_at,
        name: run.name,
        trophies: run.trophies ?? 0,
        hero_id: run.hero_id ?? null,
      };
    }
  }
  return bests;
};

/**
 * The board the `hero_experience` board replaced, under its old name.
 *
 * `experience` used to accumulate what runs paid out — a lifetime record of
 * runs, which is not what the board ranks any more and cannot be converted
 * into it. Startup deletes it once; the key is never written again, so the
 * delete is safe to meet on every boot after the first.
 */
const LEGACY_EXPERIENCE_KEY = "experience";

export const purgeLegacyExperienceBoard = async () => {
  if (usingDatabase()) {
    await (await db()).purgeBoard(LEGACY_EXPERIENCE_KEY);
    return;
  }
  const bests = await readJson(BESTS_FILE, null);
  if (bests && LEGACY_EXPERIENCE_KEY in bests) {
    delete bests[LEGACY_EXPERIENCE_KEY];
    await writeJson(BESTS_FILE, bests);
  }
};

/**
 * Seeds the player-scoped boards from the accounts themselves.
 *
 * Every other board is folded from runs, and a standing only a run can set is
 * a standing nobody has until they finish one — but these rank figures every
 * account already holds: the experience banked on its best hero, the boss
 * nodes its mask says it has beaten. Loading each account runs the repairs,
 * so the trophy count this seed reads is the mask's own answer rather than a
 * column a legacy import left short.
 *
 * Never lowers a standing a run set. A run keeps feeding both boards from
 * there, and the seed re-runs on every boot, so a hero whose experience
 * arrived outside a ranked run — Infinite Island pays no standing — is caught
 * up too.
 *
 * The file store loads each account once a boot; that is the price of the
 * boards living in their own small file, and it is paid once, at startup.
 */
export const seedStandings = async () => {
  const { listAccountIds, loadAccount } = await import("./accounts.js");
  const { loadGameMaster } = await import("./gamemaster.js");
  const gm = await loadGameMaster();
  const database = usingDatabase();
  const bests = database ? null : await readJson(BESTS_FILE, {});
  let seeded = 0;

  const offer = async (key, accountId, entry) => {
    if (database) {
      await (await db()).seedStanding(key, accountId, entry);
      seeded += 1;
      return;
    }
    const row = (bests[key] ??= {})[accountId];
    if (row === undefined || entry.value > row.value) {
      bests[key][accountId] = entry;
      seeded += 1;
    }
  };

  for (const id of await listAccountIds()) {
    const account = await loadAccount(id);
    const name = account.name ?? null;
    const at = new Date().toISOString();
    const best = (account.account_avatars ?? []).reduce(
      (top, avatar) =>
        Number(avatar.experience ?? 0) > Number(top?.experience ?? 0) ? avatar : top,
      null
    );
    const experience = Number(best?.experience ?? 0);
    const trophies = accountTrophies(account, gm);
    if (experience) {
      await offer("hero_experience", id, {
        value: experience,
        at,
        name,
        trophies: account.trophies ?? 0,
        hero_id: best.avatar_id ?? null,
      });
    }
    if (trophies) {
      await offer("trophies", id, {
        value: trophies,
        at,
        name,
        trophies,
        hero_id: best?.avatar_id ?? null,
      });
    }
  }
  if (seeded) {
    if (!database) await writeJson(BESTS_FILE, bests);
    info(`leaderboard: ${seeded} standing(s) seeded from the accounts`);
  }
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
 * How much has happened, for the front page.
 *
 * Counted off the history rather than kept as a running total, because the
 * history is already being written and a counter that can drift from it is a
 * second source of truth for no gain. The window is a day, which is the only
 * span a front page has ever wanted.
 */
export const runsSince = async (since) => {
  if (usingDatabase()) return (await db()).runsSince(since);

  try {
    const lines = (await fs.readFile(file(RUNS_FILE), "utf8")).split("\n");
    let count = 0;
    /*
     * Every line, rather than walking back from the end until one falls outside
     * the window. That shortcut wants the file to be ordered by time and it is
     * not: rows are appended when a run is recorded, and a party finishing a
     * long run after somebody else finished a short one puts the later
     * `finished_at` first. Written the quick way it counted zero.
     */
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).finished_at >= since) count += 1;
      } catch {
        // A half-written last line is worth skipping rather than throwing.
      }
    }
    return count;
  } catch (problem) {
    if (problem.code !== "ENOENT") warn(`leaderboard: could not count runs: ${problem.message}`);
    return 0;
  }
};

/**
 * One player's own standing on the boards that are about them.
 *
 * Only the whole-account boards: "your clears" and "your experience" are single
 * keys, while a speedrun standing is per node, hero and party size and there is
 * no one answer to "your speedrun". A character panel wants the first two.
 */
export const standingsFor = async (accountId) => {
  const wanted = Object.entries(BOARDS).filter(([, board]) => board.scope === "player");
  const standings = {};

  for (const [metric] of wanted) {
    if (usingDatabase()) {
      const rows = await (await db()).boardRows(metric, { ascending: false, limit: 500 });
      standings[metric] = rows.find((row) => row.account_id === Number(accountId))?.value ?? 0;
      continue;
    }
    const row = (await readJson(BESTS_FILE, {}))[metric] ?? {};
    standings[metric] = row[accountId]?.value ?? 0;
  }
  return standings;
};

/**
 * One board, ordered and cut.
 *
 * `limit` is capped rather than trusted: this is read by a web front end over
 * the internal API, and an unbounded top-N is an unbounded response.
 */
export const MAX_BOARD_SIZE = 100;

/**
 * What a row looks like leaving here, whichever store it came out of.
 *
 * The rank and the title are computed rather than stored: the rank is the
 * position in this answer, and the title is a rule about the trophy count that
 * would otherwise have to be written down twice and kept in step. Applying both
 * in one place is what stops a board meaning one thing in a file and another in
 * a table.
 */
const asEntry = (entry, index) => ({
  rank: index + 1,
  account_id: Number(entry.account_id),
  name: entry.name ?? null,
  trophies: entry.trophies ?? 0,
  title: titleFor(entry.trophies),
  hero_id: entry.hero_id ?? null,
  value: entry.value,
  at: entry.at,
});

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
    return rows.map(asEntry);
  }

  const rows = (await readJson(BESTS_FILE, {}))[key] ?? {};
  return Object.entries(rows)
    .map(([accountId, entry]) => ({ account_id: accountId, ...entry }))
    .sort((a, b) => (board.better === "lower" ? a.value - b.value : b.value - a.value))
    .slice(0, size)
    .map(asEntry);
};

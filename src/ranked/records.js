/**
 * The ranked match log: one record per pairing, written once when it is
 * decided, never changed.
 *
 * It is the only thing ranked keeps. Ratings are replayed from it at start
 * (rating.js, `replayRatings`), so there is no second store to drift from it.
 * Records carry account ids and no names; a name is read when a page shows it,
 * so a deleted account leaves its matches — and everybody else's ratings —
 * standing without its name in them.
 *
 * Postgres when the server runs on it, a JSONL file in the data directory
 * otherwise — the same arrangement as market-history.js.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { warn } from "../log.js";

const FILE = "ranked-matches.jsonl";

const byDecided = (a, b) => a.decidedAt - b.decidedAt || String(a.id).localeCompare(String(b.id));
const involves = (accountId) => (record) => record.players?.some((id) => Number(id) === Number(accountId));
const newestFirst = (rows, limit) => [...rows].sort((a, b) => byDecided(b, a)).slice(0, limit);

const memoryBackend = () => {
  const rows = [];
  return {
    append: async (record) => {
      rows.push(record);
    },
    all: async () => [...rows].sort(byDecided),
    version: async () => `${rows.length}`,
  };
};

const fileBackend = (dataDir) => {
  const file = path.join(dataDir, FILE);
  return {
    append: async (record) => {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    },
    all: async () => {
      let text;
      try {
        text = await fs.readFile(file, "utf8");
      } catch (problem) {
        if (problem.code === "ENOENT") return [];
        throw problem;
      }
      const rows = [];
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          warn(`ranked: ${FILE} line ${index + 1} is not a record and was skipped`);
        }
      }
      return rows.sort(byDecided);
    },
    version: async () => {
      try {
        const { size, mtimeMs } = await fs.stat(file);
        return `${size}:${mtimeMs}`;
      } catch (problem) {
        if (problem.code === "ENOENT") return "none";
        throw problem;
      }
    },
  };
};

const postgresBackend = (db) => ({
  append: async (record) => (await db()).recordRankedMatch(record),
  all: async () => (await db()).rankedMatches(),
  forAccount: async (accountId, limit) => (await db()).rankedMatchesFor(accountId, limit),
  version: async () => (await db()).rankedMatchesVersion?.() ?? null,
});

/**
 * `storage` is "postgres", "file" or "memory". `db` is the postgres module, or
 * a stand-in for it; by default it is loaded the first time it is needed.
 */
export const createRecords = ({ storage, dataDir, db } = {}) => {
  let database = null;
  const loadDb = async () => {
    database ??= db ?? (await import("../storage/postgres.js"));
    return database;
  };
  const backend =
    storage === "postgres" ? postgresBackend(loadDb)
      : storage === "file" ? fileBackend(dataDir)
        : memoryBackend();

  return {
    /** True once it is kept. A failure is logged and answered false, never thrown. */
    append: async (record) => {
      try {
        await backend.append(record);
        return true;
      } catch (problem) {
        warn(`ranked: could not record match ${record?.id}: ${problem.message}`);
        return false;
      }
    },
    /** Every match, oldest first: what ratings are replayed from. */
    all: () => backend.all(),
    /**
     * A token that differs once a match has been added, read without reading
     * the log; null when the store cannot say, and then nothing is cached on it.
     */
    version: () => backend.version(),
    /** One account's matches, newest first. */
    forAccount: async (accountId, { limit = 50 } = {}) =>
      backend.forAccount
        ? backend.forAccount(accountId, limit)
        : newestFirst((await backend.all()).filter(involves(accountId)), limit),
  };
};

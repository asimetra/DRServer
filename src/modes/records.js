/**
 * What a game mode keeps across restarts: records under the mode's own name,
 * each written once and never changed. Ranked's match log (ranked/records.js)
 * is the pattern; this is that, for any mode.
 *
 * A record is `{ id, at, accounts, ...whatever the mode keeps }`: an id unique
 * within the mode, the moment it happened (ms), and the accounts it is about,
 * which is how a player's own history is found. The same id twice is kept
 * once. Account ids, never names: a name is read when something shows it.
 *
 * PostgreSQL when the server runs on it (the mode_records table), a JSONL file
 * per mode under the data directory otherwise, memory for a test.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { warn } from "../log.js";

/** A mode's name: lower-case words and dashes, which is also a safe file name. */
const MODE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

const byTime = (a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id));
const about = (accountId) => (record) => record.accounts.some((id) => Number(id) === Number(accountId));
const newestFirst = (rows, limit) => [...rows].sort((a, b) => byTime(b, a)).slice(0, limit);

/** Why a record cannot be kept, or null when it can. */
const problemWith = (record) => {
  if (!record || typeof record !== "object") return "a record is an object";
  if (typeof record.id !== "string" || !record.id) return "a record needs an id";
  if (!Number.isFinite(record.at)) return "a record needs `at`, a time in ms";
  if (!Array.isArray(record.accounts) || !record.accounts.every((id) => Number.isSafeInteger(id) && id >= 0)) {
    return "a record's `accounts` are account ids";
  }
  return null;
};

const memoryBackend = () => {
  const rows = new Map();
  return {
    append: async (record) => {
      if (!rows.has(record.id)) rows.set(record.id, record);
    },
    all: async () => [...rows.values()].sort(byTime),
    version: async () => `${rows.size}`,
  };
};

const fileBackend = (file) => {
  const read = async () => {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (problem) {
      if (problem.code === "ENOENT") return [];
      throw problem;
    }
    const rows = new Map();
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!rows.has(record.id)) rows.set(record.id, record);
      } catch {
        warn(`modes: ${file} line ${index + 1} is not a record and was skipped`);
      }
    }
    return [...rows.values()].sort(byTime);
  };
  return {
    append: async (record) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    },
    all: read,
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

const postgresBackend = (mode, db) => ({
  append: async (record) => (await db()).recordModeEntry(mode, record),
  all: async () => (await db()).modeEntries(mode),
  forAccount: async (accountId, limit) => (await db()).modeEntriesFor(mode, accountId, limit),
  version: async () => (await db()).modeEntriesVersion?.(mode) ?? null,
});

/**
 * A mode's records. `storage` is "postgres", "file" or "memory", the server's
 * own by default; `db` stands in for the postgres module in a test.
 */
export const createModeRecords = ({
  mode,
  storage = config.storage,
  dataDir = config.dataDir,
  db,
} = {}) => {
  if (typeof mode !== "string" || !MODE_NAME.test(mode)) {
    throw new Error(`a mode's records are under its name: lower-case words and dashes, not ${JSON.stringify(mode)}`);
  }
  let database = null;
  const loadDb = async () => {
    database ??= db ?? (await import("../storage/postgres.js"));
    return database;
  };
  const backend =
    storage === "postgres" ? postgresBackend(mode, loadDb)
      : storage === "file" ? fileBackend(path.join(dataDir, "modes", `${mode}.jsonl`))
        : memoryBackend();

  return {
    /** True once it is kept. A record that is not one, or a failed write, is logged and answered false. */
    append: async (record) => {
      const problem = problemWith(record);
      if (problem) {
        warn(`mode ${mode}: record not kept: ${problem}`);
        return false;
      }
      try {
        await backend.append(record);
        return true;
      } catch (failure) {
        warn(`mode ${mode}: could not keep record ${record.id}: ${failure.message}`);
        return false;
      }
    },
    /** Every record, oldest first. */
    all: () => backend.all(),
    /** The records about one account, newest first. */
    forAccount: async (accountId, { limit = 50 } = {}) =>
      backend.forAccount
        ? backend.forAccount(accountId, limit)
        : newestFirst((await backend.all()).filter(about(accountId)), limit),
    /** A token that changes once a record has been added, read without reading them; null when it cannot say. */
    version: () => backend.version(),
  };
};

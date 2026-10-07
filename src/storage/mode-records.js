/**
 * Where a game mode's records are kept (modes/records.js, which says what a
 * record is and checks it): PostgreSQL's mode_records table, a JSONL file per
 * mode under the data directory (`modes/<mode>.jsonl`), or memory for a test.
 * Each store answers `append`, `all` (oldest first) and `version`; PostgreSQL
 * also `forAccount`, which the others leave to the caller.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { warn } from "../log.js";

/** Records in the order they happened, ties by id: every store's order, and the seam's (modes/records.js). */
export const byTime = (a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id));

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
 * The store for `mode`'s records: `storage` "postgres", "file" or anything else
 * for memory; `db` stands in for the postgres module in a test.
 */
export const modeRecordStore = ({ mode, storage, dataDir, db }) => {
  if (storage === "postgres") {
    let database = null;
    return postgresBackend(mode, async () => (database ??= db ?? (await import("./postgres.js"))));
  }
  if (storage === "file") return fileBackend(path.join(dataDir, "modes", `${mode}.jsonl`));
  return memoryBackend();
};

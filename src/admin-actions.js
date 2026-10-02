/**
 * What admins did, written down.
 *
 * The internal token proves the caller is the website; the acting account
 * (internal.js) says which admin on it pressed the button. Every administrative
 * action that took effect is kept here — who, what, to whom, when, and the
 * details that matter to it — so "who restricted this account, and why" has an
 * answer that is not somebody's memory of the server log.
 *
 * The same two backends as the market history: a line a record in the data
 * directory, or a table on PostgreSQL. Append-only either way.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { warn } from "./log.js";

const usingDatabase = () => config.storage === "postgres";

let database = null;
const db = async () => {
  database ??= await import("./storage/postgres.js");
  return database;
};

const ACTIONS_FILE = "admin-actions.jsonl";
const file = () => path.join(config.dataDir, ACTIONS_FILE);

export const MAX_ACTIONS_READ = 200;

/**
 * Keeps one. A record that cannot be written is said in the log rather than
 * failing the action, which has already happened by the time it is recorded.
 */
export const recordAdminAction = async ({ actor, action, target = null, detail = {} }) => {
  const entry = {
    at: new Date().toISOString(),
    actor: Number(actor),
    action,
    target: target === null ? null : Number(target),
    detail,
  };
  try {
    if (usingDatabase()) {
      await (await db()).recordAdminAction(entry);
    } else {
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.appendFile(file(), `${JSON.stringify(entry)}\n`, "utf8");
    }
    return true;
  } catch (problem) {
    warn(`admin: could not record ${action} by ${actor}: ${problem.message}`);
    return false;
  }
};

/** Newest first; only those done to `account` when it is given. */
export const adminActions = async ({ limit = 50, account = null } = {}) => {
  const size = Math.max(1, Math.min(MAX_ACTIONS_READ, Number(limit) || 50));
  const target = account === null ? null : Number(account);
  if (usingDatabase()) return (await db()).adminActions({ limit: size, target });

  let text;
  try {
    text = await fs.readFile(file(), "utf8");
  } catch (problem) {
    if (problem.code !== "ENOENT") warn(`admin: could not read the admin actions: ${problem.message}`);
    return [];
  }
  const found = [];
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0 && found.length < size; index -= 1) {
    if (!lines[index]) continue;
    try {
      const entry = JSON.parse(lines[index]);
      if (target === null || entry.target === target) found.push(entry);
    } catch {
      // A torn last line from a crash mid-append is one record lost, not the log.
    }
  }
  return found;
};

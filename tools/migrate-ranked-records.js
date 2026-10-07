/**
 * Carries ranked's match log over to where ranked keeps it now: the mode
 * records (src/modes/records.js) under "ranked", from the ranked_matches table
 * or the ranked-matches.jsonl file it was written to before.
 *
 *   node tools/migrate-ranked-records.js
 *
 * Run once after deploying the server that moved it, with the server's own
 * ODS_STORAGE / ODS_DATABASE_URL / ODS_DATA_DIR. Safe to run again: a match
 * already carried over is kept once (the records are keyed by id), and the old
 * table or file is read, never changed or removed.
 */
// Must be first: it fills the environment config.js reads as it is evaluated.
import "../src/load-env.js";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";

const MODE = "ranked";

const fromPostgres = async () => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT to_regclass('ranked_matches') IS NOT NULL AS present");
    if (!rows[0].present) return { before: 0, carried: 0 };
    const before = Number((await client.query("SELECT count(*) AS n FROM ranked_matches")).rows[0].n);
    // `at` and `accounts` beside the match, as ranked/records.js writes them now.
    const result = await client.query(
      `INSERT INTO mode_records (mode, id, at, accounts, record)
       SELECT $1, id, decided_at, ARRAY[first_id, second_id],
              record || jsonb_build_object(
                'at', coalesce((record->>'decidedAt')::bigint, (extract(epoch FROM decided_at) * 1000)::bigint),
                'accounts', jsonb_build_array(first_id, second_id))
         FROM ranked_matches
       ON CONFLICT (mode, id) DO NOTHING`,
      [MODE]
    );
    return { before, carried: result.rowCount };
  } finally {
    await client.end();
  }
};

const readLines = async (file) => {
  try {
    return (await fs.readFile(file, "utf8")).split("\n").filter((line) => line.trim());
  } catch (problem) {
    if (problem.code === "ENOENT") return [];
    throw problem;
  }
};

const fromFile = async () => {
  const old = path.join(config.dataDir, "ranked-matches.jsonl");
  const now = path.join(config.dataDir, "modes", `${MODE}.jsonl`);
  const kept = new Set();
  for (const line of await readLines(now)) {
    try {
      kept.add(JSON.parse(line).id);
    } catch {
      // A bad line there is the records' own to skip; it keeps no id here.
    }
  }
  const lines = await readLines(old);
  const out = [];
  for (const [index, line] of lines.entries()) {
    let match;
    try {
      match = JSON.parse(line);
    } catch {
      console.warn(`${old} line ${index + 1} is not a match and was left behind`);
      continue;
    }
    if (kept.has(match.id)) continue;
    kept.add(match.id);
    out.push(JSON.stringify({ ...match, at: match.decidedAt, accounts: (match.players ?? []).map(Number) }));
  }
  if (out.length) {
    await fs.mkdir(path.dirname(now), { recursive: true });
    await fs.appendFile(now, `${out.join("\n")}\n`, "utf8");
  }
  return { before: lines.length, carried: out.length };
};

const { before, carried } = config.storage === "postgres" ? await fromPostgres() : await fromFile();
console.log(`ranked: ${before} match(es) in the old log, ${carried} carried over to the mode records (${config.storage})`);

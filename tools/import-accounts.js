#!/usr/bin/env node
/**
 * Copies the file backend's accounts into Postgres.
 *
 *   node tools/import-accounts.js                 # says what it would do
 *   node tools/import-accounts.js --write         # does it
 *   node tools/import-accounts.js --write --only 1000000005
 *
 * Switching `ODS_STORAGE` does not move anything: the two backends are separate
 * stores and the server simply starts reading the other one. A database that
 * has been started once already holds whatever a test or a probe logged in as,
 * so the accounts worth keeping and the stubs sitting on top of them have the
 * same ids — which is why this reports the difference and waits to be told.
 *
 * It reads the JSON documents directly rather than through `loadAccount`, so
 * that the repairs that run on load do not quietly rewrite what is being
 * copied, and it writes through the Postgres backend so that one row and its
 * children land together or not at all.
 */
// Must be first: it fills the environment config.js reads as it is evaluated.
import "../src/load-env.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import * as postgres from "../src/storage/postgres.js";

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const write = process.argv.includes("--write");
const only = argument("only");

/** What is worth counting when deciding which copy of an account is the real one. */
const weigh = (account) => ({
  items: account?.account_items?.length ?? 0,
  heroes: account?.account_avatars?.length ?? 0,
  gold: Number(account?.basic_currency ?? 0),
});

/**
 * Not everything under the data directory is an account.
 *
 * The leaderboard keeps `dungeon-bests.json` there, and a partial object once
 * reached `saveAccount` without an id and landed as `undefined.json`. Both
 * parse as JSON and neither has an account in it, so the id is what decides
 * rather than the extension — and what is skipped is named, because a file
 * quietly left behind is how a real account gets missed.
 */
const skipped = [];

/** The columns `accounts` requires and has no default for. Read from the schema. */
const REQUIRED = (() => {
  const sql = fsSync.readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  const body = /CREATE TABLE IF NOT EXISTS accounts \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\w/.test(line) && /NOT NULL/.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((column) => column !== "id");
})();

const readFileAccounts = async () => {
  const directory = config.dataDir;
  const names = (await fs.readdir(directory)).filter((n) => n.endsWith(".json"));
  const accounts = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(directory, name), "utf8");
    let account;
    try {
      account = JSON.parse(raw);
    } catch (err) {
      skipped.push(`${name} (not readable: ${err.message})`);
      continue;
    }
    const id = Number(account?.id);
    if (!Number.isFinite(id) || id <= 0) {
      skipped.push(`${name} (no account id)`);
      continue;
    }
    /**
     * A document that never held a whole account cannot become a row.
     *
     * Eight of these carry a test's `basic_currency` and nothing else — no
     * name, no created date, none of the columns the table requires — and the
     * whole batch is written in one transaction, so one of them refuses all
     * ninety. They are named rather than filled in: inventing a created date
     * and a key count to get a row in would be making up a player.
     */
    const missing = REQUIRED.filter((column) => account[column] === undefined);
    if (missing.length) {
      skipped.push(
        `${name} (incomplete: no ${missing.slice(0, 3).join(", ")}` +
          `${missing.length > 3 ? ` and ${missing.length - 3} more` : ""})`
      );
      continue;
    }
    if (!only || String(account.id) === String(only)) accounts.push(account);
  }
  return accounts.sort((a, b) => Number(a.id) - Number(b.id));
};

const accounts = await readFileAccounts();
if (!accounts.length) {
  console.log(`No account documents under ${config.dataDir}.`);
  process.exit(0);
}

/**
 * Child rows carry ids that have to be unique across the whole table, and the
 * files do not enforce that: each account is its own document, so nothing
 * notices when two of them are handed the same number. Postgres does, and
 * refuses the batch with a duplicate-key error that names neither account.
 *
 * Found once here, between account 1000000001's `optionsHudStyle` and account
 * 1000000005's `seenUltimatePopup`. Both are real preferences of different
 * players and neither can be dropped, so the second one is renumbered — the id
 * is bookkeeping and nothing reads it. A preference is found by its name:
 * `AlterAttribute` sends one and the handler matches on `row.name`.
 */
const CHILDREN = [
  "account_items",
  "account_avatars",
  "account_stackables",
  "account_pets",
  "account_skins",
  "account_attributes",
  "account_chests",
];

const renumbered = [];
for (const table of CHILDREN) {
  const owners = new Map();
  let highest = 0;
  for (const account of accounts) {
    for (const row of account[table] ?? []) {
      if (Number.isFinite(Number(row?.id))) highest = Math.max(highest, Number(row.id));
    }
  }
  for (const account of accounts) {
    for (const row of account[table] ?? []) {
      const id = Number(row?.id);
      if (!Number.isFinite(id)) continue;
      const owner = owners.get(id);
      if (owner === undefined) {
        owners.set(id, account.id);
        continue;
      }
      row.id = ++highest;
      owners.set(row.id, account.id);
      renumbered.push(`${table} ${id} on account ${account.id} (also ${owner}) -> ${row.id}`);
    }
  }
}

console.log(`${accounts.length} account document(s) under ${config.dataDir}`);
for (const name of skipped) console.log(`  skipped ${name}`);
for (const note of renumbered) console.log(`  renumbered ${note}`);
console.log();

let overwrites = 0;
let losses = 0;
for (const account of accounts) {
  /**
   * A database that cannot be read is not a database with nothing in it.
   *
   * Swallowing the error here reported "0 already present" for a server that
   * was simply unreachable, and the whole point of this pass is to say what
   * `--write` would overwrite — a tool that answers "nothing" when it does not
   * know is worse than one that stops.
   */
  let existing;
  try {
    existing = await postgres.loadAccount(Number(account.id));
  } catch (err) {
    console.error(`\nCould not read account ${account.id} from Postgres: ${err.message}`);
    console.error("Nothing was written. Fix the database first — `npm run db:up`, and");
    console.error("apply db/schema.sql if the server has gained tables since it was made.");
    process.exit(1);
  }
  if (!existing) continue;

  overwrites += 1;
  const there = weigh(existing);
  const here = weigh(account);
  // Only worth a line when the database holds something the file does not.
  const richer =
    there.items > here.items || there.heroes > here.heroes || there.gold > here.gold;
  if (!richer) continue;

  losses += 1;
  console.log(`  ${account.id}: the database holds more than the file`);
  console.log(`     file     items ${here.items}  heroes ${here.heroes}  gold ${here.gold}`);
  console.log(`     database items ${there.items}  heroes ${there.heroes}  gold ${there.gold}`);
}

console.log(
  `\n${accounts.length - overwrites} new, ${overwrites} already in the database` +
    (losses ? `, ${losses} of which would lose something` : "")
);

if (!write) {
  console.log("\nNothing written. Add --write to copy them in.");
  if (losses) console.log("Read the lines above first — --write overwrites the database copy.");
  process.exit(0);
}

await postgres.saveAccounts(accounts);
await postgres.close();
console.log(`\nCopied ${accounts.length} account(s) into Postgres.`);
console.log("The JSON documents are untouched; ODS_STORAGE=file still reads them.");

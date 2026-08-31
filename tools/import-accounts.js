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
import fs from "node:fs/promises";
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

const readFileAccounts = async () => {
  const directory = config.dataDir;
  const names = (await fs.readdir(directory)).filter((n) => n.endsWith(".json"));
  const accounts = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(directory, name), "utf8");
    const account = JSON.parse(raw);
    if (!only || String(account.id) === String(only)) accounts.push(account);
  }
  return accounts.sort((a, b) => Number(a.id) - Number(b.id));
};

const accounts = await readFileAccounts();
if (!accounts.length) {
  console.log(`No account documents under ${config.dataDir}.`);
  process.exit(0);
}

console.log(`${accounts.length} account document(s) under ${config.dataDir}\n`);

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

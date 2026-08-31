import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * A new account has to be whole before it is first written.
 *
 * The template's four preference rows carry a name and a value and no id, and
 * the code that gives them one runs when an account is *loaded*. Between
 * `createNewAccount` and the first load there was therefore a save of rows
 * with no id — which a JSON document accepts without a word and Postgres
 * refuses outright, so registering through the website answered "the game
 * server could not create an account" and the file backend had never shown a
 * sign of it.
 */

process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-create-"));

const { createNewAccount } = await import("../src/accounts.js");

test("a freshly registered account is written with its preferences complete", async () => {
  const account = await createNewAccount({ name: "Newcomer" });

  assert.ok(account.account_attributes?.length, "it starts with the template's preferences");
  for (const row of account.account_attributes) {
    assert.ok(
      Number.isSafeInteger(row.id) && row.id > 0,
      `preference ${row.name} was written without an id`
    );
    assert.equal(row.account_id, account.id, "and belongs to the account that owns it");
  }
});

test("the ids are distinct, so a table keyed on them accepts the row", async () => {
  const account = await createNewAccount({ name: "Second" });
  const ids = account.account_attributes.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "two preferences shared an id");
});

/**
 * What is on disk is what matters: an account repaired only in memory would
 * still have been stored without ids, and the next process to read it would
 * be the one that found out.
 */
test("and the document on disk carries them too", async () => {
  // Asked rather than assumed: whichever test file imports the configuration
  // first settles the directory, so the environment variable set above is not
  // necessarily the one in force by the time this runs.
  const { config } = await import("../src/config.js");
  const account = await createNewAccount({ name: "Third" });
  const stored = JSON.parse(
    await fs.readFile(path.join(config.dataDir, `${account.id}.json`), "utf8")
  );

  assert.ok(stored.account_attributes.length, "the preferences were stored");
  for (const row of stored.account_attributes) {
    assert.ok(Number.isSafeInteger(row.id) && row.id > 0, `${row.name} stored without an id`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { CHILD_TABLES } from "../src/storage/postgres.js";

/**
 * The two halves of the Postgres backend have to agree, and nothing makes them.
 *
 * `CHILD_TABLES` decides what is written and read back; `db/schema.sql` decides
 * what exists. A payload list missing from the first is not an error anybody
 * sees — `saveAccount` iterates the map, so a list it does not name is simply
 * never written, and `loadAccount` hands back an account without it.
 *
 * That is not hypothetical. `account_chests` was left out of both, on the
 * reasoning that captures never showed one with contents, and the result was
 * that every chest a player owned disappeared the moment their account was
 * saved. These tests exist so the next list added to the payload cannot go the
 * same way quietly.
 */
const schema = fs.readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

const columnsOf = (table) => {
  const match = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([^;]*?)\\);`,
    "s"
  ).exec(schema);
  if (!match) return null;
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"))
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(name));
};

test("every table the storage layer writes exists in the schema", () => {
  for (const table of Object.keys(CHILD_TABLES)) {
    assert.ok(columnsOf(table), `${table} is written but db/schema.sql does not create it`);
  }
});

test("every column the storage layer names exists on its table", () => {
  for (const [table, columns] of Object.entries(CHILD_TABLES)) {
    const declared = new Set(columnsOf(table) ?? []);
    for (const column of columns) {
      assert.ok(declared.has(column), `${table}.${column} is written but not declared`);
    }
  }
});

/**
 * Chests specifically, because this is the one that went wrong. The shape is
 * not guesswork: `awardTreasureChest` and `tools/grant.js` write exactly these
 * three fields, and `account/OpenChest` and `DropChest` read them back.
 */
test("chests have somewhere to live", () => {
  assert.deepEqual(CHILD_TABLES.account_chests, ["id", "account_id", "chest_id", "is_new"]);
  assert.deepEqual(columnsOf("account_chests"), ["id", "account_id", "chest_id", "is_new"]);
});

/**
 * Boosters remain unmodelled, and that is deliberate rather than forgotten:
 * nothing in this server writes a booster row, so there is no shape to store.
 * If something starts writing them, this is the reminder to give them a table
 * instead of letting them vanish the way chests did.
 */
test("boosters are still unmodelled, on purpose", () => {
  assert.equal(CHILD_TABLES.account_boosters, undefined);
  assert.equal(columnsOf("account_boosters"), null);
  assert.match(schema, /account_boosters is still unmodelled/);
});

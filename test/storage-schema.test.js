import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CHILD_TABLES,
  deduplicateSoldListings,
  initializeAccountObjectSequence,
  mergeMarketListings,
  nextId,
} from "../src/storage/postgres.js";
import { ACCOUNT_OBJECT_ID_FLOOR } from "../src/account-object-ids.js";

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

test("object ids are raised once at startup and allocated without resetting the sequence", async () => {
  const setup = [];
  await initializeAccountObjectSequence({
    query: async (text, values) => {
      setup.push({ text, values });
      return { rows: [] };
    },
  });

  assert.equal(setup.length, 1);
  assert.match(setup[0].text, /setval/);
  assert.deepEqual(setup[0].values, [ACCOUNT_OBJECT_ID_FLOOR]);
  for (const table of [...Object.keys(CHILD_TABLES), "market_sold_listings"]) {
    assert.match(setup[0].text, new RegExp(`MAX\\(id\\) AS id FROM ${table}\\b`));
  }

  const allocations = [];
  const id = await nextId({
    query: async (text) => {
      allocations.push(text);
      return { rows: [{ id: "1200000042" }] };
    },
  });
  assert.equal(id, 1_200_000_042);
  assert.deepEqual(allocations, ["SELECT nextval('account_object_id') AS id"]);
});

test("duplicate sold rows merge into one payable listing", () => {
  const sale = { id: 7, sold_at: "2026-09-29T10:00:00.000Z", sold_to: 12, proceeds: 90 };
  const open = { id: 8, sold_at: null, sold_to: null };
  assert.deepEqual(
    mergeMarketListings([{ ...sale }, open], [{ ...sale }, { ...sale }]),
    [open, sale]
  );
});

test("sold-listing cleanup keys duplicates by account, object and sale time", async () => {
  const statements = [];
  const removed = await deduplicateSoldListings({
    query: async (text) => {
      statements.push(text);
      return { rowCount: 2 };
    },
  });
  assert.equal(removed, 2);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /LOCK TABLE market_sold_listings IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(statements[1], /duplicate\.account_id = original\.account_id/);
  assert.match(statements[1], /duplicate\.id = original\.id/);
  assert.match(statements[1], /duplicate\.sold_at IS NOT DISTINCT FROM original\.sold_at/);
});

/**
 * A row that does not carry a column must leave it out of the INSERT, so the
 * column's own DEFAULT decides.
 *
 * Naming it as null instead — which `?? null` did — does not fall back to a
 * DEFAULT; it violates the NOT NULL beside it. Six of the child tables have
 * such columns, and a writer that omitted one produced a save that worked
 * against the file backend and threw against PostgreSQL. Buying a chest from
 * the store did exactly that, and `tools/grant.js` did it too:
 *
 *     null value in column "is_new" of relation "account_chests"
 *     violates not-null constraint
 */
test("a column the row does not carry is left to its default", async () => {
  const { writeAccount } = await import("../src/storage/postgres.js");
  const statements = [];
  const client = {
    query: async (text, values) => {
      statements.push({ text, values });
      return { rows: [] };
    },
  };

  await writeAccount(client, {
    id: 1000000005,
    // No `is_new`, exactly as the store's purchase path built it.
    account_chests: [{ id: 1, account_id: 1000000005, chest_id: 60004 }],
  });

  const chestInsert = statements.find(
    (statement) => statement.text.startsWith("INSERT INTO account_chests")
  );
  assert.ok(chestInsert, "the chest is written");
  assert.doesNotMatch(chestInsert.text, /is_new/, "the absent column is not named");
  assert.equal(chestInsert.values.length, 3, "and no null is passed for it");
});

/** A column the row does carry still travels, including a deliberate null. */
test("a null the row does carry is still written", async () => {
  const { writeAccount } = await import("../src/storage/postgres.js");
  const statements = [];
  const client = {
    query: async (text, values) => {
      statements.push({ text, values });
      return { rows: [] };
    },
  };

  await writeAccount(client, {
    id: 1000000005,
    // An unequipped weapon: avatar_id is cleared rather than absent, and that
    // difference is the whole distinction the writer now draws.
    account_items: [
      { id: 1, account_id: 1000000005, item_id: 11001, avatar_id: null, avatar_slot: null, is_new: 1 },
    ],
  });

  const itemInsert = statements.find(
    (statement) => statement.text.startsWith("INSERT INTO account_items")
  );
  assert.ok(itemInsert, "the item is written");
  assert.match(itemInsert.text, /avatar_id/, "an explicit null is named");
  assert.equal(itemInsert.values[itemInsert.text.match(/\(([^)]*)\)/)[1].split(", ").indexOf("avatar_id")], null);
});

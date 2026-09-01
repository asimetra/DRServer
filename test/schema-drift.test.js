import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { schemaExpects, driftBetween, isAdditiveOnly } from "../src/storage/schema-check.js";

/**
 * What the code expects of a database, read off the file that builds it.
 *
 * Twice now a server has run against a database older than itself and said so
 * only when a query reached a column that was not there — `is_new does not
 * exist`, then `tax does not exist`. Both name a column and neither says what
 * to do, and the second one surfaced as a broken page rather than as anything
 * to do with a schema.
 *
 * The compose file mounts the schema as an init script, which runs once when
 * the volume is made and never again, so a database that has been up since
 * before a column was added stays that way however many times it is restarted.
 */

test("every table in the schema is expected, with its columns", () => {
  const expected = schemaExpects(`
CREATE TABLE IF NOT EXISTS accounts (
    id      BIGINT PRIMARY KEY,
    name    TEXT   NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS web.users (
    id    BIGSERIAL PRIMARY KEY,
    email TEXT      NOT NULL
);
`);

  assert.deepEqual(expected.accounts, ["id", "name"], "a constraint line is not a column");
  assert.deepEqual(expected.users, ["id", "email"], "and a schema prefix is not part of the name");
});

/**
 * A column added later is added by an ALTER rather than by editing the CREATE,
 * so that a database which already exists gains it. Both say the same thing
 * about what the code needs and both have to be read.
 */
test("a column added by a later ALTER counts too", () => {
  const expected = schemaExpects(`
CREATE TABLE IF NOT EXISTS market_listings (
    id    BIGINT PRIMARY KEY,
    price BIGINT NOT NULL
);

ALTER TABLE IF EXISTS market_listings ADD COLUMN IF NOT EXISTS tax BIGINT;
ALTER TABLE IF EXISTS market_listings ADD COLUMN IF NOT EXISTS proceeds BIGINT;
`);

  assert.deepEqual(expected.market_listings, ["id", "price", "tax", "proceeds"]);
});

test("a missing table and a missing column are both reported, by name", () => {
  const drift = driftBetween(
    { accounts: ["id", "market_barred"], market_sales: ["id"] },
    { accounts: new Set(["id"]) }
  );

  assert.deepEqual(drift, [
    { table: "accounts", missing: ["market_barred"] },
    { table: "market_sales", missing: null },
  ]);
});

test("a database that has everything drifts by nothing", () => {
  const drift = driftBetween(
    { accounts: ["id", "name"] },
    { accounts: new Set(["id", "name", "something_extra"]) }
  );

  assert.deepEqual(drift, [], "a column the code does not know about is not its business");
});

/**
 * Whether the file is safe to run without being read first.
 *
 * The whole reason a server may apply its own schema is that this one only
 * ever adds: twelve `CREATE TABLE IF NOT EXISTS`, fifteen indexes, four
 * `ADD COLUMN IF NOT EXISTS`, and nothing that removes anything. The day
 * somebody writes a `DROP` into it, running it unattended stops being a
 * convenience and becomes a way to lose a table on a restart — so the file is
 * checked rather than trusted, and the answer decides.
 */
test("a schema that only adds is safe to apply unattended", () => {
  assert.equal(
    isAdditiveOnly(`
CREATE TABLE IF NOT EXISTS accounts (id BIGINT PRIMARY KEY);
CREATE INDEX IF NOT EXISTS accounts_id ON accounts(id);
ALTER TABLE IF EXISTS accounts ADD COLUMN IF NOT EXISTS tax BIGINT;
`),
    true
  );
});

test("and one that removes anything is not", () => {
  for (const destructive of [
    "DROP TABLE accounts;",
    "TRUNCATE accounts;",
    "DELETE FROM accounts;",
    "ALTER TABLE accounts DROP COLUMN tax;",
    "UPDATE accounts SET tax = 0;",
  ]) {
    assert.equal(
      isAdditiveOnly(`CREATE TABLE IF NOT EXISTS accounts (id BIGINT);\n${destructive}`),
      false,
      destructive
    );
  }
});

test("a word inside a comment or a name is not a statement", () => {
  assert.equal(
    isAdditiveOnly(`
-- The tables the trade window used are dropped, since nothing reads them.
CREATE TABLE IF NOT EXISTS dropped_items (id BIGINT, deleted_at TIMESTAMPTZ);
`),
    true,
    "prose about dropping is not a DROP"
  );
});

test("the shipped schema is one this server may run itself", () => {
  const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  assert.equal(isAdditiveOnly(sql), true, "db/schema.sql has gained something destructive");
});

/**
 * Read against the real file, so that a schema written in a shape this cannot
 * parse is caught here rather than by reporting a database as fine.
 */
test("the shipped schema parses into something", () => {
  const expected = schemaExpects(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));

  assert.ok(Object.keys(expected).length > 8, "the tables were not found");
  assert.ok(expected.accounts?.includes("basic_currency"), "accounts is not described");
  assert.ok(expected.account_items?.includes("modifier1"), "nor are its children");
});

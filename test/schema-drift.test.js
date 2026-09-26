import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  schemaExpects,
  driftBetween,
  isAdditiveOnly,
  indexesExpected,
  missingIndexes,
} from "../src/storage/schema-check.js";

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
 * A database made by 6ca284a has every column of market_sold_listings and only
 * the key its first version carried. The next version replaced that key with
 * two indexes, and startup drops the key — so a check that read columns alone
 * called the database current, never ran the file, and left the table with no
 * index at all.
 */
test("an index the schema creates is expected, whichever form it is written in", () => {
  const expected = indexesExpected(`
CREATE INDEX IF NOT EXISTS market_sold_listings_account ON market_sold_listings(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS market_sold_listings_sale
    ON market_sold_listings(account_id, id, sold_at);
CREATE INDEX IF NOT EXISTS users_email ON web.users (email);
`);

  assert.deepEqual(expected, {
    market_sold_listings_account: "market_sold_listings",
    market_sold_listings_sale: "market_sold_listings",
    users_email: "users",
  });
});

test("a table with every column but not its indexes is short of them", () => {
  const missing = missingIndexes(
    { market_sold_listings_account: "market_sold_listings", market_sold_listings_sale: "market_sold_listings" },
    new Set(["market_sold_listings_pkey", "market_sold_listings_account"])
  );

  assert.deepEqual(missing, [{ index: "market_sold_listings_sale", table: "market_sold_listings" }]);
});

test("every index in the shipped schema is read", () => {
  const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  const written = sql.match(/CREATE (UNIQUE )?INDEX/g).length;
  const expected = indexesExpected(sql);

  assert.equal(Object.keys(expected).length, written, "an index is written in a shape the check cannot read");
  assert.equal(expected.market_sold_listings_sale, "market_sold_listings");
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
  const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  const expected = schemaExpects(sql);

  assert.ok(Object.keys(expected).length > 8, "the tables were not found");
  assert.ok(expected.accounts?.includes("basic_currency"), "accounts is not described");
  assert.ok(expected.account_items?.includes("modifier1"), "nor are its children");

  for (const column of [
    "ingame_friends",
    "ignore_friends",
    "friend_requests",
    "infinite_progress",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE IF EXISTS accounts ADD COLUMN IF NOT EXISTS ${column}\\b`,
        "i"
      ),
      `${column} must reach existing accounts tables, not only new ones`
    );
  }
});

/**
 * The same, against a live database: the table as 97f6e8b left one made by
 * 6ca284a — every column, its old key dropped, neither index made. Startup's
 * check has to see that and run the file. PostgreSQL only.
 */
test("startup puts back the indexes a database is short of", {
  skip: process.env.ODS_STORAGE !== "postgres" && "PostgreSQL only",
}, async () => {
  const { default: pg } = await import("pg");
  const { checkDatabaseSchema } = await import("../src/preflight.js");
  const client = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
  await client.connect();
  const indexes = async () =>
    (await client.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'market_sold_listings' ORDER BY indexname"
    )).rows.map((row) => row.indexname);
  try {
    await client.query("DROP INDEX IF EXISTS market_sold_listings_account");
    await client.query("DROP INDEX IF EXISTS market_sold_listings_sale");
    assert.deepEqual(await indexes(), []);

    assert.equal(await checkDatabaseSchema(), true);
    assert.deepEqual(await indexes(), ["market_sold_listings_account", "market_sold_listings_sale"]);
  } finally {
    await client.query(
      "CREATE INDEX IF NOT EXISTS market_sold_listings_account ON market_sold_listings(account_id)"
    );
    await client.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS market_sold_listings_sale ON market_sold_listings(account_id, id, sold_at)"
    );
    await client.end();
  }
});

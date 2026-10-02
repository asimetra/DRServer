import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Node's test runner starts each test file in its own child process. Give that
 * child its own account directory before any application module is imported,
 * so one file's accounts, boards and token generations cannot affect another.
 */
if (process.env.NODE_TEST_CONTEXT && !process.env.ODS_DATA_DIR) {
  const scratch = mkdtempSync(path.join(tmpdir(), "ods-test-file-"));
  process.env.ODS_DATA_DIR = scratch;
  process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
}

/**
 * And, against PostgreSQL, its own schema.
 *
 * A database is one place, where the account directory above is one a file: a
 * suite run against it had every test file reading the accounts, names and
 * boards the files before it left behind, and half a dozen failed for that and
 * nothing else — a name already taken, an account another file had renamed, a
 * row id two fixtures both chose. So each file gets a schema made for it, with
 * the server's own tables in it, and is pointed at that through the search
 * path. Nothing outside the schema is read or written, which also makes this
 * safe against a database that holds something: the suite creates what it uses
 * and tools/run-tests.js drops it afterwards.
 */
export const TEST_SCHEMA_PREFIX = "ods_test_";

if (
  process.env.NODE_TEST_CONTEXT &&
  process.env.ODS_STORAGE === "postgres" &&
  process.env.ODS_DATABASE_URL &&
  !new URL(process.env.ODS_DATABASE_URL).searchParams.has("options")
) {
  const { default: pg } = await import("pg");
  const schema = `${TEST_SCHEMA_PREFIX}${process.pid}_${Date.now().toString(36)}`;
  const client = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  } finally {
    await client.end();
  }
  const isolated = new URL(process.env.ODS_DATABASE_URL);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
  process.env.ODS_DATABASE_URL = isolated.toString();
}

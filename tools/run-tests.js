#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the test suite against a throwaway account directory.
 *
 * Storage defaults to `data/`, which on a developer's machine is where their
 * real accounts live. Tests load accounts freely, and `loadAccount` writes an
 * account it has never seen before — so a plain `node --test` litters that
 * directory with invented ids and an `undefined.json`, next to accounts
 * somebody actually plays. Nothing warns about it, and the two are only
 * distinguishable by knowing which ids are real.
 *
 * Worse than the litter is what it implies: a test that saves under an id an
 * operator happens to use would overwrite their account. Nothing today does —
 * the fixtures that borrow real-looking ids only read — but that is luck rather
 * than a rule, and this makes it structural instead.
 *
 * `ODS_DATA_DIR` is set rather than `DR_DATA_DIR` because the former takes
 * precedence, and a test file that wants its own directory sets `ODS_DATA_DIR`
 * itself before importing the config — which still wins, because the config
 * reads the environment when it is first imported inside that file's process.
 *
 * An existing `ODS_DATA_DIR` is left alone, so CI or a developer can still
 * point the suite somewhere deliberate.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = readdirSync(path.join(root, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("test", name));
const forwarded = process.argv.slice(2);
const explicitTarget = forwarded.some((argument) => !argument.startsWith("-"));

const child = spawn(
  process.execPath,
  [
    "--import",
    path.join(root, "tools", "test-environment.js"),
    "--test",
    "--test-concurrency=1",
    ...forwarded,
    ...(explicitTarget ? [] : testFiles),
  ],
  { stdio: "inherit", cwd: root, env: process.env }
);

/**
 * Drops the schemas the test files made for themselves — see
 * tools/test-environment.js. Done here, once, because a test process cannot be
 * relied on to tidy up as it leaves: one that fails, or is killed, leaves its
 * schema behind, and the next run would find a database slowly filling with
 * them. Only schemas with the suite's own prefix are touched.
 */
const dropTestSchemas = async () => {
  if (process.env.ODS_STORAGE !== "postgres" || !process.env.ODS_DATABASE_URL) return;
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ods\\_test\\_%'"
      );
      for (const { nspname } of rows) await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
    } finally {
      await client.end();
    }
  } catch (problem) {
    console.error(`run-tests: could not drop the test schemas: ${problem.message}`);
  }
};

child.on("exit", async (code, signal) => {
  await dropTestSchemas();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

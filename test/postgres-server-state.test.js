import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * What the server keeps for itself, in a real database.
 *
 * Token revocations and content declarations used to be files beside the
 * server even on PostgreSQL, so a server whose disk was replaced on deploy
 * forgot them (storage/server-state.js). These hold the tables, the carrying
 * over of an old server's files, and the token tool, against PostgreSQL.
 *
 *   ODS_STORAGE=postgres ODS_DATABASE_URL=postgres://… npm test -- test/postgres-server-state.test.js
 */

const postgresOnly = { skip: process.env.ODS_STORAGE !== "postgres" && "PostgreSQL only" };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ods-server-state-"));
let storage;
let auth;

before(async () => {
  if (postgresOnly.skip) return;
  process.env.ODS_DATA_DIR = dataDir;
  storage = await import("../src/storage/postgres.js");
  auth = await import("../src/auth.js");
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM token_generations");
  await admin.query("DELETE FROM server_state");
  await admin.end();
});

after(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (postgresOnly.skip) return;
  await auth.keepGenerationsIn(null);
  await storage.close();
});

test("revocations made at once all count", postgresOnly, async () => {
  const generations = await Promise.all(
    Array.from({ length: 5 }, () => storage.tokenGenerationStore.bump(1_999_700_001))
  );
  assert.deepEqual(generations.sort(), [1, 2, 3, 4, 5]);
  assert.equal((await storage.tokenGenerationStore.load())["1999700001"], 5);
});

test("an old server's revocations are carried in, and only ever raise a generation", postgresOnly, async () => {
  await storage.tokenGenerationStore.bump(1_999_700_002);
  await storage.tokenGenerationStore.bump(1_999_700_002);

  const raised = await storage.importTokenGenerations({ 1999700002: 1, 1999700003: 4 });
  assert.equal(raised, 1, "the newer one in the database stays");
  const now = await storage.tokenGenerationStore.load();
  assert.equal(now["1999700002"], 2);
  assert.equal(now["1999700003"], 4);
  assert.equal(await storage.importTokenGenerations({ 1999700003: 4 }), 0, "and again is nothing");
});

test("a server document reads back as it was written", postgresOnly, async () => {
  assert.equal(await storage.readServerState("test-document"), null);
  await storage.writeServerState("test-document", { 1999700010: "knight@2" });
  await storage.writeServerState("test-document", { 1999700011: "knight@1" });
  assert.deepEqual(await storage.readServerState("test-document"), { 1999700011: "knight@1" });
});

test("starting on the database carries the files over and keeps revocations there", postgresOnly, async () => {
  fs.writeFileSync(path.join(dataDir, "token-generations.json"), JSON.stringify({ 1999700020: 3 }));
  fs.writeFileSync(path.join(dataDir, "content-declarations.json"), JSON.stringify({ 1999700020: "official" }));
  const { keepServerStateInDatabase } = await import("../src/storage/server-state.js");

  await keepServerStateInDatabase();
  assert.equal((await storage.tokenGenerationStore.load())["1999700020"], 3);
  assert.deepEqual(await storage.readServerState("content-declarations"), { 1999700020: "official" });

  const secret = "s".repeat(64);
  const before = auth.issueToken(1_999_700_020, { secret });
  assert.equal(await auth.revokeAccountTokens(1_999_700_020), 4, "a revocation goes to the table");
  assert.equal((await storage.tokenGenerationStore.load())["1999700020"], 4);
  assert.match(auth.tokenProblem(1_999_700_020, before, { secret }), /signature does not match/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "token-generations.json"), "utf8")),
    { 1999700020: 3 },
    "and the old file is left as it was"
  );
});

/** The token tool revokes where the server looks, and issues with the generation it finds there. */
test("the token tool reads and writes the table, not a file", postgresOnly, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const tool = new URL("../tools/token.js", import.meta.url).pathname;
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "ods-token-tool-pg-"));
  fs.writeFileSync(path.join(toolDir, "token-secret"), `${"t".repeat(64)}\n`, { mode: 0o600 });
  const run = (...args) =>
    promisify(execFile)(process.execPath, [tool, ...args], {
      // Everything named, so the checkout's .env (load-env.js) adds nothing.
      env: {
        PATH: process.env.PATH,
        ODS_DATA_DIR: toolDir,
        ODS_TOKEN_SECRET: "",
        ODS_STORAGE: "postgres",
        ODS_DATABASE_URL: process.env.ODS_DATABASE_URL,
        ODS_INTERNAL_TOKEN: "",
        ODS_ADMIN_ACCOUNTS: "",
      },
    });
  try {
    const { stdout } = await run("--revoke", "1999700030");
    assert.match(stdout, /generation 1/);
    assert.equal((await storage.tokenGenerationStore.load())["1999700030"], 1);
    assert.equal(fs.existsSync(path.join(toolDir, "token-generations.json")), false);

    const issued = /"API_ValidationToken": "([^"]+)"/.exec((await run("1999700030")).stdout)[1];
    assert.equal(auth.tokenProblem(1_999_700_030, issued, { secret: "t".repeat(64), generation: 1 }), null);
  } finally {
    fs.rmSync(toolDir, { recursive: true, force: true });
  }
});

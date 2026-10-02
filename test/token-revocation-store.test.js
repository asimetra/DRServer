import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Revocations kept somewhere other than a file.
 *
 * On PostgreSQL the server keeps nothing of its own on disk but this record,
 * and a server whose disk is thrown away on every deploy — a container — then
 * forgets every revocation it was told about. So there the record is a table,
 * read into memory at startup and again every few seconds (checks stay
 * synchronous; the client's login cannot wait on a query), and written through
 * when an account's tokens are revoked.
 *
 * These hold the in-memory half to the same promises the file kept, with a
 * store standing in for the database; test/postgres-server-state.test.js holds
 * the table itself.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ods-revocation-store-"));
process.env.ODS_DATA_DIR = dataDir;

const { issueToken, keepGenerationsIn, revokeAccountTokens, tokenProblem } = await import("../src/auth.js");

test.after(async () => {
  await keepGenerationsIn(null);
  delete process.env.ODS_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const secret = "s".repeat(64);
const check = (accountId, token) => tokenProblem(accountId, token, { secret });

/** A table in memory: what `load` returns is a copy, as a query's rows would be. */
const memoryStore = (initial = {}) => {
  const rows = { ...initial };
  return {
    rows,
    failing: false,
    loads: 0,
    async load() {
      this.loads += 1;
      if (this.failing) throw new Error("connection refused");
      return { ...rows };
    },
    async bump(id) {
      rows[id] = (rows[id] ?? 0) + 1;
      return rows[id];
    },
  };
};

test("what the store holds at startup is what is checked", async () => {
  const store = memoryStore({ 501: 2 });
  await keepGenerationsIn(store, { pollMs: 0 });

  assert.equal(check(501, issueToken(501, { secret, generation: 1 })), "signature does not match this account or this secret");
  assert.equal(check(501, issueToken(501, { secret })), null, "a token issued now carries the stored generation");
  assert.equal(check(502, issueToken(502, { secret, generation: 0 })), null);
  await keepGenerationsIn(null);
});

test("a revocation is written to the store, and holds at once", async () => {
  const store = memoryStore();
  await keepGenerationsIn(store, { pollMs: 0 });
  const before = issueToken(503, { secret });

  assert.equal(await revokeAccountTokens(503), 1);
  assert.equal(store.rows[503], 1, "written through, not only remembered");
  assert.match(check(503, before), /signature does not match/);
  assert.equal(check(503, issueToken(503, { secret })), null);
  assert.equal(fs.existsSync(path.join(dataDir, "token-generations.json")), false, "and no file is written");
  await keepGenerationsIn(null);
});

test("a revocation made by somebody else is seen at the next refresh", async () => {
  const store = memoryStore();
  const { refreshGenerations } = await keepGenerationsIn(store, { pollMs: 0 });
  const token = issueToken(504, { secret });

  await store.bump(504); // the token tool, or another thread
  assert.equal(check(504, token), null, "not yet read");
  await refreshGenerations();
  assert.match(check(504, token), /signature does not match/);
  await keepGenerationsIn(null);
});

/**
 * A refresh can be under way when a revocation lands, and come back with rows
 * read before it. Generations only ever go up, so what it read cannot undo it.
 */
test("a refresh that read the store before a revocation does not undo it", async () => {
  const store = memoryStore();
  const { refreshGenerations } = await keepGenerationsIn(store, { pollMs: 0 });
  const token = issueToken(505, { secret });

  const stale = { ...store.rows };
  store.load = async () => stale;
  await revokeAccountTokens(505);
  await refreshGenerations();
  assert.match(check(505, token), /signature does not match/);
  await keepGenerationsIn(null);
});

/**
 * The database going away is not a reason to sign everybody out, nor to
 * forgive anybody: what was last read stands, and checks go on against it.
 */
test("a store that cannot be read keeps what was last read", async () => {
  const store = memoryStore({ 506: 1 });
  const { refreshGenerations } = await keepGenerationsIn(store, { pollMs: 0 });
  const revoked = issueToken(506, { secret, generation: 0 });
  const current = issueToken(506, { secret });

  store.failing = true;
  await refreshGenerations();
  assert.match(check(506, revoked), /signature does not match/);
  assert.equal(check(506, current), null);
  await keepGenerationsIn(null);
});

test("a store that cannot be read at startup is a startup that fails", async () => {
  const store = memoryStore();
  store.failing = true;
  await assert.rejects(keepGenerationsIn(store, { pollMs: 0 }), /connection refused/);
  assert.equal(
    check(507, issueToken(507, { secret, generation: 0 })),
    "token revocation state is unavailable",
    "and nothing is checked against a record that was never read"
  );
  await keepGenerationsIn(null);
});

test("refreshing happens by itself, every few seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = memoryStore();
  await keepGenerationsIn(store, { pollMs: 5000 });
  const loaded = store.loads;

  t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.loads, loaded + 1);
  await keepGenerationsIn(null);
});

test("put back to the file, revocations are the file's again", async () => {
  await keepGenerationsIn(null);
  await revokeAccountTokens(508);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "token-generations.json"), "utf8"));
  assert.equal(stored["508"], 1);
});

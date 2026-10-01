import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

/**
 * Data moved at startup is moved by the one server that owns the storage.
 *
 * The move ran before the process lock, so a newer server started beside an
 * older one still running moved sold listings, then found the lock taken and
 * exited — and the older server, which knows nothing of the new table, wrote
 * them back among the open ones: the sale existed twice and was paid twice.
 * Read from the entry point itself, because the order is the whole point.
 */
test("the process lock is taken before schema repair or legacy data movement", async () => {
  const entry = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const lock = entry.indexOf("await acquireProcessLock(");
  const schema = entry.indexOf("await checkDatabaseSchema()");
  const move = entry.indexOf("await moveLegacyData()");
  const initialize = entry.indexOf("await initializeProcessStorage()");
  assert.ok(lock > 0 && schema > 0 && move > 0 && initialize > 0, "all steps are in the entry point");
  assert.ok(lock < schema && schema < move && move < initialize, "ownership precedes every mutation");
});

test("the standalone grant allocator initializes PostgreSQL while holding the process lock", async () => {
  const grant = await fs.readFile(new URL("../tools/grant.js", import.meta.url), "utf8");
  const lock = grant.indexOf("await acquireProcessLock()");
  const initialize = grant.indexOf("await initializeProcessStorage()");
  const mutate = grant.indexOf("await grant()", initialize);
  const release = grant.indexOf("await releaseProcessLock()", mutate);
  assert.ok(lock > 0 && initialize > lock && mutate > initialize && release > mutate);
});

test("startup refuses to open services after an unsafe schema check", async () => {
  const entry = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const schema = entry.indexOf("if (!(await checkDatabaseSchema()))");
  const lock = entry.indexOf("await acquireProcessLock(");
  const listeners = entry.indexOf("startWebServices()");
  assert.ok(lock > 0 && schema > lock && listeners > schema);
  assert.match(entry.slice(schema, listeners), /throw new StartupRefusal\(/);
  // The throw lands in the one handler every failed start goes through, which
  // gives the storage back before the process ends.
  const handler = entry.indexOf("await refuseToStart(problem)", listeners);
  assert.ok(handler > listeners, "the listeners start inside the guarded block");
  assert.match(entry, /const refuseToStart = async[^]*?await releaseProcessLock\?\.\(\)[^]*?process\.exit\(1\)/);
});

test("settings that refuse a start are checked before the storage is claimed", async () => {
  const entry = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const transport = entry.indexOf("ensureSafeTransport();");
  const internal = entry.indexOf("internalApiProblem();");
  const lock = entry.indexOf("await acquireProcessLock(");
  assert.ok(transport > 0 && internal > 0 && lock > 0);
  assert.ok(transport < lock && internal < lock, "a refusal claims and writes nothing");
});

test("graceful shutdown flushes content declarations with account writes", async () => {
  const entry = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(entry, /import \{[^}]*flushDeclarations[^}]*\} from "\.\/content-packs\.js"/);
  assert.match(entry, /Promise\.all\(\[\s*waitForAccountWrites\(\),\s*flushDeclarations\(\),?\s*\]\)/);
  assert.match(entry, /if \(!declarationsFlushed\) \{\s*throw new Error\(/);
  assert.match(entry, /waitForWrites:\s*waitForPersistentWrites/);
});

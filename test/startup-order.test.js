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
test("the process lock is taken before any data is moved", async () => {
  const entry = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const lock = entry.indexOf("await acquireProcessLock()");
  const move = entry.indexOf("await moveLegacyData()");
  assert.ok(lock > 0 && move > 0, "both steps are in the entry point");
  assert.ok(lock < move, "the lock comes first");
});

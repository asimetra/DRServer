import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModeRecords } from "../src/modes/records.js";

const record = (id, at, accounts, extra = {}) => ({ id, at, accounts, ...extra });

const behaves = (name, make) => {
  test(`${name}: kept once each, oldest first, and found by account newest first`, async (t) => {
    const records = make(t);
    assert.equal(await records.append(record("b", 2000, [7, 8], { depth: 4 })), true);
    assert.equal(await records.append(record("a", 1000, [7], { depth: 2 })), true);
    await records.append(record("a", 1000, [7], { depth: 99 }));
    assert.deepEqual((await records.all()).map((r) => [r.id, r.depth]), [["a", 2], ["b", 4]], "the same id twice is kept once");
    assert.deepEqual((await records.forAccount(7)).map((r) => r.id), ["b", "a"]);
    assert.deepEqual((await records.forAccount(8)).map((r) => r.id), ["b"]);
    assert.deepEqual(await records.forAccount(9), []);
  });

  test(`${name}: the version moves when a record is added`, async (t) => {
    const records = make(t);
    const before = await records.version();
    await records.append(record("c", 3000, [1]));
    assert.notEqual(await records.version(), before);
  });
};

behaves("memory", () => createModeRecords({ mode: "delve", storage: "memory" }));
behaves("file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-records-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createModeRecords({ mode: "delve", storage: "file", dataDir: dir });
});

test("a file per mode, under the data directory's modes/", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-records-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await createModeRecords({ mode: "delve", storage: "file", dataDir: dir }).append(record("x", 1, [1]));
  assert.ok(fs.existsSync(path.join(dir, "modes", "delve.jsonl")));
});

test("what is not a record is not kept, and says so by answering false", async () => {
  const records = createModeRecords({ mode: "delve", storage: "memory" });
  assert.equal(await records.append(null), false);
  assert.equal(await records.append({ at: 1, accounts: [] }), false, "no id");
  assert.equal(await records.append({ id: "x", accounts: [] }), false, "no time");
  assert.equal(await records.append({ id: "x", at: 1, accounts: ["7"] }), false, "accounts are ids");
  assert.deepEqual(await records.all(), []);
});

test("a mode's name is a safe one", () => {
  for (const bad of ["", "Delve", "../escape", "a/b", "x".repeat(41), 7]) {
    assert.throws(() => createModeRecords({ mode: bad, storage: "memory" }), undefined, String(bad));
  }
});

test("on PostgreSQL each call names the mode", async () => {
  const calls = [];
  const db = {
    recordModeEntry: async (...args) => calls.push(["record", ...args]),
    modeEntries: async (mode) => (calls.push(["all", mode]), []),
    modeEntriesFor: async (mode, id, limit) => (calls.push(["for", mode, id, limit]), []),
    modeEntriesVersion: async (mode) => (calls.push(["version", mode]), "0:0"),
  };
  const records = createModeRecords({ mode: "delve", storage: "postgres", db });
  await records.append(record("x", 1, [7]));
  await records.all();
  await records.forAccount(7, { limit: 5 });
  await records.version();
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["record", "delve"], ["all", "delve"], ["for", "delve"], ["version", "delve"]]);
  assert.deepEqual(calls[2], ["for", "delve", 7, 5]);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecords } from "../src/modes/ranked/records.js";

const match = (id, decidedAt, players, extra = {}) => ({
  id,
  state: "finished",
  decidedAt,
  players,
  winner: players[0],
  ...extra,
});

for (const storage of ["memory", "file"]) {
  test(`${storage}: the match log keeps every match, oldest first, and reads one account's newest first`, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dr-ranked-records-"));
    try {
      const records = createRecords({ storage, dataDir });
      await records.append(match("m2", 2000, [1, 3]));
      await records.append(match("m1", 1000, [1, 2]));
      await records.append(match("m3", 3000, [2, 3], { state: "void", winner: null }));

      assert.deepEqual((await records.all()).map((row) => row.id), ["m1", "m2", "m3"]);
      assert.deepEqual((await records.forAccount(1)).map((row) => row.id), ["m2", "m1"]);
      assert.deepEqual((await records.forAccount(3, { limit: 1 })).map((row) => row.id), ["m3"]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}

test("file: the log survives a restart, and one bad line does not lose the rest", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dr-ranked-records-"));
  try {
    await createRecords({ storage: "file", dataDir }).append(match("m1", 1000, [1, 2]));
    await fs.appendFile(path.join(dataDir, "modes", "ranked.jsonl"), "{not json\n");
    await createRecords({ storage: "file", dataDir }).append(match("m2", 2000, [1, 2]));
    const again = createRecords({ storage: "file", dataDir });
    assert.deepEqual((await again.all()).map((row) => row.id), ["m1", "m2"]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("postgres: a match goes in as ranked's mode record, with when it was decided and who raced", async () => {
  const queries = [];
  const db = {
    recordModeEntry: async (mode, row) => queries.push([mode, row]),
    modeEntries: async () => [],
    modeEntriesFor: async () => [],
  };
  const records = createRecords({ storage: "postgres", db });
  assert.equal(await records.append(match("m1", 1000, [1, 2])), true);
  const [[mode, row]] = queries;
  assert.equal(mode, "ranked");
  assert.deepEqual([row.id, row.at, row.accounts, row.decidedAt, row.players], ["m1", 1000, [1, 2], 1000, [1, 2]]);
});

test("a write that fails is reported, not thrown: a race result must not take the server down", async () => {
  const records = createRecords({
    storage: "postgres",
    db: { recordModeEntry: async () => { throw new Error("down"); } },
  });
  assert.equal(await records.append(match("m1", 1000, [1, 2])), false);
});

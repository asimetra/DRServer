import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProcessLockHeldError,
  acquireFileProcessLock,
} from "../src/process-lock.js";

test("one file store admits only one live writer", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-process-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireFileProcessLock(directory, { pid: 111, isAlive: () => true });

  await assert.rejects(
    () => acquireFileProcessLock(directory, { pid: 222, isAlive: () => true }),
    (problem) => problem instanceof ProcessLockHeldError && /process 111/.test(problem.message)
  );

  await release();
  const releaseSecond = await acquireFileProcessLock(directory, {
    pid: 222,
    isAlive: () => true,
  });
  await releaseSecond();
});

test("a crashed writer's lock is recovered without deleting the replacement", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-stale-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  await writeFile(lockFile, JSON.stringify({ pid: 333, token: "old" }));

  const release = await acquireFileProcessLock(directory, {
    pid: 444,
    isAlive: (pid) => pid !== 333,
  });
  const owner = JSON.parse(await readFile(lockFile, "utf8"));
  assert.equal(owner.pid, 444);
  assert.notEqual(owner.token, "old");
  await release();
});

test("an unreadable owner file is refused rather than guessed stale", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-broken-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, ".server.lock"), "not json");

  await assert.rejects(
    () => acquireFileProcessLock(directory),
    (problem) => problem instanceof ProcessLockHeldError && /unreadable/.test(problem.message)
  );
});

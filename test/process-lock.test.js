import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

/**
 * A process id alone says very little about who holds the lock.
 *
 * The owner was taken to be alive whenever *something* answered to its id. In a
 * container the server is the same id on every start, so after one unclean stop
 * it found its own id in the file, concluded the storage was in use, and
 * refused to start until somebody deleted the file by hand. On a host the same
 * happened after a power cut whenever the old id had gone to another daemon.
 */
test("a lock naming this process's own id was left by a predecessor, not held by it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-own-pid-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  await writeFile(lockFile, JSON.stringify({ pid: 1, token: "before-the-restart" }));
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(lockFile, longAgo, longAgo);

  const release = await acquireFileProcessLock(directory, { pid: 1, isAlive: () => true });
  assert.notEqual(JSON.parse(await readFile(lockFile, "utf8")).token, "before-the-restart");
  await release();
});

/**
 * The one case the file cannot settle. Two containers sharing a data directory
 * are each process 1, and neither can see the other — so a lock naming this
 * id is a dead predecessor's or a live neighbour's, and only time tells them
 * apart: a holder keeps touching its lock, a dead one does not.
 */
test("a lock with this id that somebody keeps fresh is a neighbour's, and is left alone", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-neighbour-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  await writeFile(lockFile, JSON.stringify({ pid: 1, token: "the-neighbour" }));
  const neighbour = setInterval(() => {
    const now = new Date();
    void utimes(lockFile, now, now).catch(() => undefined);
  }, 10);
  t.after(() => clearInterval(neighbour));

  await assert.rejects(
    () => acquireFileProcessLock(directory, { pid: 1, isAlive: () => true, staleAfterMs: 120 }),
    (problem) => problem instanceof ProcessLockHeldError && /kept fresh/.test(problem.message)
  );
  assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, "the-neighbour");
});

test("a lock with this id that nobody refreshes is taken once it has gone quiet", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-quiet-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  await writeFile(lockFile, JSON.stringify({ pid: 1, token: "crashed-a-moment-ago" }));

  const began = Date.now();
  const release = await acquireFileProcessLock(directory, {
    pid: 1,
    isAlive: () => true,
    staleAfterMs: 120,
  });
  assert.ok(Date.now() - began >= 100, "it waited out the doubt rather than guessing");
  await release();
});

test("a held lock is kept fresh for as long as it is held", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-heartbeat-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");

  const release = await acquireFileProcessLock(directory, { heartbeatMs: 10 });
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(lockFile, longAgo, longAgo);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const { mtimeMs } = await (await import("node:fs/promises")).stat(lockFile);
  assert.ok(Date.now() - mtimeMs < 5_000, "the holder touched its lock again");
  await release();
});

test("a lock from before the machine last booted is stale whoever has its id now", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-reboot-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  await writeFile(
    lockFile,
    JSON.stringify({ pid: 333, token: "old", bootId: "boot-before", pidNamespace: "ns", heartbeatMs: 5000 })
  );
  // A reboot takes longer than a lock stays fresh, so by now it is old.
  const beforeTheReboot = new Date(Date.now() - 120_000);
  await utimes(lockFile, beforeTheReboot, beforeTheReboot);

  const began = Date.now();
  const release = await acquireFileProcessLock(directory, {
    pid: 444,
    isAlive: () => true,
    bootId: "boot-after",
    pidNamespace: "ns",
  });
  assert.ok(Date.now() - began < 1000, "nothing to wait for");
  await release();
});

/**
 * What this process can see of another is only worth anything when the two
 * share a view. A server in a container is process 1 there; from the host,
 * process 1 is init, alive, and started at a different time — which read as
 * "that id went to somebody else", and a maintenance tool run on the host took
 * the lock from under the running server. A different boot id is the same
 * mistake across machines sharing one directory. Where the views differ, the
 * only evidence is whether the holder is still touching its lock.
 */
test("a holder this process cannot see is believed for as long as it keeps its lock fresh", async (t) => {
  for (const [what, theirs, ours] of [
    ["another container", { bootId: "boot", pidNamespace: "pid:[container]" }, { bootId: "boot", pidNamespace: "pid:[host]" }],
    ["another machine", { bootId: "their-boot", pidNamespace: "pid:[a]" }, { bootId: "our-boot", pidNamespace: "pid:[a]" }],
  ]) {
    const directory = await mkdtemp(path.join(tmpdir(), "ods-unseen-holder-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const lockFile = path.join(directory, ".server.lock");
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 1, token: "the-server", processStart: "500", heartbeatMs: 10, ...theirs })
    );
    const holder = setInterval(() => {
      const now = new Date();
      void utimes(lockFile, now, now).catch(() => undefined);
    }, 10);
    t.after(() => clearInterval(holder));

    await assert.rejects(
      () =>
        acquireFileProcessLock(directory, {
          pid: 4242,
          // What the host sees at that id: init, alive, started long before.
          isAlive: () => true,
          startOf: () => "3",
          staleAfterMs: 150,
          ...ours,
        }),
      (problem) => problem instanceof ProcessLockHeldError && /kept fresh/.test(problem.message),
      what
    );
    assert.equal(JSON.parse(await readFile(lockFile, "utf8")).token, "the-server", what);
    clearInterval(holder);
  }
});

test("a clock that disagrees about when the lock was touched does not strand it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-future-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  await writeFile(lockFile, JSON.stringify({ pid: 1, token: "left-behind" }));
  const anHourAhead = new Date(Date.now() + 3_600_000);
  await utimes(lockFile, anHourAhead, anHourAhead);

  // Nobody touches it again, and that is what decides — not what time it says.
  const release = await acquireFileProcessLock(directory, {
    pid: 1,
    isAlive: () => true,
    staleAfterMs: 120,
  });
  await release();
});

test("a holder whose lock is taken from it is told", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-taken-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  const lost = [];

  const release = await acquireFileProcessLock(directory, {
    heartbeatMs: 10,
    onLost: (problem) => lost.push(problem.message),
  });
  await writeFile(lockFile, JSON.stringify({ pid: 999_999, token: "somebody-else" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(lost.length, 1, "once, not on every beat");
  assert.match(lost[0], /taken by another process/);

  await release();
  assert.equal(
    JSON.parse(await readFile(lockFile, "utf8")).token,
    "somebody-else",
    "and it does not remove a lock that is no longer its own"
  );
});

test("an id handed to another process since does not hold the lock", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-reused-pid-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockFile = path.join(directory, ".server.lock");
  const owner = {
    pid: 333,
    token: "old",
    bootId: "same-boot",
    pidNamespace: "pid:[same]",
    processStart: "1000",
    heartbeatMs: 5000,
  };
  await writeFile(lockFile, JSON.stringify(owner));
  const sameView = { bootId: "same-boot", pidNamespace: "pid:[same]" };

  // Same boot, same id, same start: the writer itself, still running.
  await assert.rejects(
    () =>
      acquireFileProcessLock(directory, { pid: 444, isAlive: () => true, startOf: () => "1000", ...sameView }),
    (problem) => problem instanceof ProcessLockHeldError && /process 333/.test(problem.message)
  );

  // Same id, started later: somebody else. Seen directly, so nothing to wait for.
  const began = Date.now();
  const release = await acquireFileProcessLock(directory, {
    pid: 444,
    isAlive: () => true,
    startOf: () => "2500",
    ...sameView,
  });
  assert.ok(Date.now() - began < 1000);
  await release();
});

test("a lock records enough to tell its writer from a later process with the same id", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-lock-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const release = await acquireFileProcessLock(directory, {
    pid: 444,
    bootId: "this-boot",
    pidNamespace: "pid:[here]",
    startOf: (pid) => (pid === 444 ? "777" : null),
  });
  const owner = JSON.parse(await readFile(path.join(directory, ".server.lock"), "utf8"));
  assert.equal(owner.bootId, "this-boot");
  assert.equal(owner.pidNamespace, "pid:[here]");
  assert.equal(owner.processStart, "777");
  assert.equal(owner.heartbeatMs, 5000, "and that it will be kept fresh, and how often");
  await release();
});

test("a process cannot take the lock it already holds", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ods-double-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const release = await acquireFileProcessLock(directory);
  await assert.rejects(
    () => acquireFileProcessLock(directory),
    (problem) => problem instanceof ProcessLockHeldError && /already holds/.test(problem.message)
  );
  await release();

  const again = await acquireFileProcessLock(directory);
  await again();
});

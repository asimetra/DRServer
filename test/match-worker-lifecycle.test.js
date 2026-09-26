import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Workers starting and stopping badly: one that cannot start, one that never
 * finishes starting, one whose replacement keeps failing, and one stuck in a
 * loop while the server is asked to stop.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-match-worker-lifecycle-"));

const { MatchWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { dungeonMatches } = await import("../src/socket/matches.js");

const failing = new URL("./fixtures/failing-match-worker.js", import.meta.url);
const stalling = new URL("./fixtures/stalling-match-worker.js", import.meta.url);

const withFailure = async (mode, run) => {
  const previous = process.env.ODS_TEST_WORKER_FAILURE;
  process.env.ODS_TEST_WORKER_FAILURE = mode;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ODS_TEST_WORKER_FAILURE;
    else process.env.ODS_TEST_WORKER_FAILURE = previous;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a worker that cannot start fails the pool's start instead of leaving it waiting", async () => {
  await withFailure("boot", async () => {
    const pool = new MatchWorkerPool({ size: 2, workerUrl: failing, loadReportMs: 0 });
    await assert.rejects(pool.ready, /before it was ready/);
    await sleep(300);
    assert.equal(pool.spawned, 2, "and nothing was started again in a loop");
    await pool.close();
  });
});

test("a worker that never finishes starting is given up on", async () => {
  await withFailure("hang", async () => {
    const pool = new MatchWorkerPool({ size: 1, workerUrl: failing, loadReportMs: 0, startupTimeoutMs: 300 });
    await assert.rejects(pool.ready, /before it was ready|did not start/);
    await pool.close();
  });
});

test("a replacement that keeps failing is retried with backoff, then left down", async () => {
  await withFailure("replacement", async () => {
    const pool = new MatchWorkerPool({
      size: 1,
      workerUrl: failing,
      loadReportMs: 0,
      restartBackoffMs: 50,
      maxStartFailures: 3,
    });
    await pool.ready;
    await pool.workers[0].thread.terminate();
    await sleep(1500);
    assert.equal(pool.spawned, 1 + 3, "three tries after the first, and no more");
    assert.equal(pool.workers[0].alive, false);
    assert.throws(() => pool.workerFor({ id: 1 }), /no match worker is running/);
    await pool.close();
  });
});

test("stopping the server does not wait for ever on a worker stuck in a loop", async () => {
  const pool = new MatchWorkerPool({
    size: 1,
    workerUrl: stalling,
    loadReportMs: 0,
    watchdogMs: 0,
    drainTimeoutMs: 300,
  });
  await pool.ready;
  pool.workers[0].thread.postMessage({ t: "test.stall" });
  const started = Date.now();
  assert.equal(await pool.close(), true);
  assert.ok(Date.now() - started < 3000, `closed in ${Date.now() - started} ms`);
  assert.equal(pool.workers[0].alive, false);
});

test("a worker that is busy but still turning over is not mistaken for a stuck one", async () => {
  const pool = new MatchWorkerPool({
    size: 1,
    workerUrl: stalling,
    loadReportMs: 0,
    watchdogMs: 50,
    hangTimeoutMs: 300,
  });
  await pool.ready;
  const worker = pool.workers[0];
  worker.thread.postMessage({ t: "test.busy", ms: 1500, sliceMs: 100 });
  await sleep(1700);
  assert.equal(pool.workers[0], worker, "still the same worker");
  assert.equal(worker.alive, true);

  worker.thread.postMessage({ t: "test.stall" });
  await sleep(1000);
  assert.notEqual(pool.workers[0], worker, "one that stops turning over is replaced");
  await pool.close();
});

test("an operator can restart a worker, and it comes back as after a crash", async () => {
  const pool = new MatchWorkerPool({ size: 2, loadReportMs: 0 });
  await pool.ready;
  const first = pool.workers[1];
  assert.deepEqual(pool.restartWorker(1), { index: 1, players: 0, matches: 0 });
  await sleep(100);
  assert.notEqual(pool.workers[1], first, "replaced");
  await pool.workers[1].ready.promise;
  assert.deepEqual(pool.restartWorker(7), { error: "no such worker" });
  await pool.close();
});

test.after(() => {
  for (const match of [...dungeonMatches.matches.values()]) dungeonMatches.close(match);
});

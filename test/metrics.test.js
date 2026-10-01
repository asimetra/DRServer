import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { absorb, count, counters, resetCounters } from "../src/metrics.js";

/**
 * How often the things that go wrong go wrong.
 *
 * Each of these was a line in the log and nothing else, so "has anybody been
 * refused today" meant reading the log — and nobody reads a log that is fine.
 * A number that was zero yesterday is noticed.
 */
test("a counter starts at nothing and adds up", () => {
  resetCounters();
  assert.equal(counters().saves_failed, 0, "known counters are listed before they are ever hit");

  count("saves_failed");
  count("saves_failed");
  count("sockets_refused", 3);
  assert.equal(counters().saves_failed, 2);
  assert.equal(counters().sockets_refused, 3);
});

test("what a match worker counted is added to the one total", () => {
  resetCounters();
  count("timer_failures");
  absorb({ timer_failures: 4, saves_failed: 1, "not a number": "x" });
  assert.equal(counters().timer_failures, 5);
  assert.equal(counters().saves_failed, 1);
  assert.equal("not a number" in counters(), false);
});

/**
 * With match workers on, the dungeon runs in another thread, and so do its
 * failed saves and its timers. Counted where they happen, they would never
 * reach the one place anybody asks.
 */
test("a count made in a worker thread is sent to the main thread", async () => {
  const worker = new Worker(
    `
    const { count } = await import(${JSON.stringify(new URL("../src/metrics.js", import.meta.url).href)});
    count("saves_failed");
    count("saves_failed", 2);
    `,
    { eval: true, type: "module" }
  );
  const message = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await worker.terminate();
  assert.deepEqual(message, { t: "count", counts: { saves_failed: 3 } });
});

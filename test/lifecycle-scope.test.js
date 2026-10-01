import assert from "node:assert/strict";
import test from "node:test";

import { LifecycleScope } from "../src/socket/lifecycle-scope.js";

test("disposing a scope cancels its timers and every child", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const scope = new LifecycleScope("run");
  const floor = scope.child("floor");
  let timeoutHits = 0;
  let intervalHits = 0;
  floor.timeout(() => timeoutHits++, 20);
  floor.interval(() => intervalHits++, 10);

  t.mock.timers.tick(10);
  assert.equal(intervalHits, 1);
  assert.equal(scope.activeChildCount, 1);
  assert.equal(floor.activeResourceCount, 2);

  assert.equal(scope.dispose(), true);
  assert.equal(scope.dispose(), false, "scope disposal was not idempotent");
  t.mock.timers.tick(100);
  assert.equal(timeoutHits, 0);
  assert.equal(intervalHits, 1);
  assert.equal(floor.disposed, true);
  assert.equal(floor.activeResourceCount, 0);
});

test("completed timeouts release their bookkeeping", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new LifecycleScope("floor");
  let hits = 0;
  scope.timeout(() => hits++, 5);

  assert.equal(scope.activeResourceCount, 1);
  t.mock.timers.tick(5);
  assert.equal(hits, 1);
  assert.equal(scope.activeResourceCount, 0);
});

test("disposed scopes never fall back to creating live timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const scope = new LifecycleScope("closed");
  scope.dispose();
  let hits = 0;

  assert.equal(scope.timeout(() => hits++, 1), null);
  assert.equal(scope.interval(() => hits++, 1), null);
  t.mock.timers.tick(10);
  assert.equal(hits, 0);
});

test("one failing cleanup does not prevent the rest", () => {
  const errors = [];
  const cleaned = [];
  const scope = new LifecycleScope("run", {
    onError: (error) => errors.push(error.message),
  });
  scope.defer(() => cleaned.push("first"));
  scope.defer(() => { throw new Error("broken cleanup"); });
  scope.defer(() => cleaned.push("last"));

  scope.dispose();
  assert.deepEqual(cleaned, ["last", "first"]);
  assert.deepEqual(errors, ["broken cleanup"]);
});

test("a cleanup cancelled by another cleanup is not run twice", () => {
  const scope = new LifecycleScope("floor");
  let hits = 0;
  const release = scope.defer(() => hits++);
  scope.defer(() => release());

  scope.dispose();
  assert.equal(hits, 0);
});

/**
 * A timer is the one place gameplay code runs with nothing above it. A throw
 * from a buff expiring or a trap firing went straight to the process, and with
 * every dungeon in one thread that ended all of them over one.
 */
test("a timer callback that throws is reported instead of escaping", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const failures = [];
  const scope = new LifecycleScope("run", {
    onTimerError: (error, failed) => failures.push([failed.label, error.message]),
  });
  const floor = scope.child("floor");
  let ticks = 0;

  floor.timeout(() => {
    throw new Error("buff expiry went wrong");
  }, 5);
  floor.interval(() => {
    ticks += 1;
    if (ticks === 1) throw new Error("first tick went wrong");
  }, 10);

  assert.doesNotThrow(() => t.mock.timers.tick(30));
  assert.deepEqual(failures, [
    ["floor", "buff expiry went wrong"],
    ["floor", "first tick went wrong"],
  ]);
  assert.equal(ticks, 3, "an interval outlives one bad tick");
  assert.equal(floor.activeResourceCount, 1, "the failed timeout still released its bookkeeping");
  scope.dispose();
});

test("a failing timer is contained even when nobody asked to hear about it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new LifecycleScope("run");
  scope.timeout(() => {
    throw new Error("unobserved");
  }, 1);
  assert.doesNotThrow(() => t.mock.timers.tick(5));
  scope.dispose();
});

test("an interval that fails on every tick is not logged on every tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stdout.write = write;
  });

  const scope = new LifecycleScope("noisy-run");
  scope.interval(() => {
    throw new Error("the same failure every twenty milliseconds");
  }, 20);
  t.mock.timers.tick(20 * 200);
  scope.dispose();
  process.stdout.write = write;

  const about = lines.filter((line) => line.includes("noisy-run"));
  assert.ok(about.length >= 1, "it is reported");
  assert.ok(about.length <= 3, `and not two hundred times (${about.length})`);
  assert.match(about[0], /timer callback failed: Error: the same failure/);
});

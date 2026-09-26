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

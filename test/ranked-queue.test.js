import assert from "node:assert/strict";
import test from "node:test";

import { createQueue, ratingWindow } from "../src/modes/ranked/queue.js";

const s = (seconds) => seconds * 1000;

const queueOf = (players, at = 0) => {
  const queue = createQueue();
  for (const [accountId, rating] of players) {
    queue.join({ accountId, rating, at });
    queue.setReady(accountId, true);
  }
  return queue;
};

const ids = (pairs) => pairs.map((pair) => pair.map((entry) => entry.accountId).sort());

test("two ready players of similar rating are paired and leave the queue", () => {
  const queue = queueOf([[1, 1500], [2, 1550]]);
  assert.deepEqual(ids(queue.pairUp(s(1))), [[1, 2]]);
  assert.equal(queue.size, 0);
});

test("only players an adapter vouches are ready get paired", () => {
  const queue = queueOf([[1, 1500], [2, 1500]]);
  queue.setReady(2, false);
  assert.deepEqual(queue.pairUp(s(1)), []);
  assert.equal(queue.size, 2, "an unready player stays queued");
  queue.setReady(2, true);
  assert.equal(queue.pairUp(s(2)).length, 1);
});

test("the rating window starts narrow and opens to anybody the longer somebody waits", () => {
  assert.equal(ratingWindow(0), 150);
  assert.ok(ratingWindow(s(45)) > 150);
  assert.equal(ratingWindow(s(90)), Infinity);

  const queue = queueOf([[1, 1500], [2, 1900]]);
  assert.deepEqual(queue.pairUp(s(1)), [], "400 apart is too far at first");
  assert.deepEqual(ids(queue.pairUp(s(90))), [[1, 2]], "but not after a minute and a half");
});

test("the longest waiting player is paired first, with the closest rating in reach", () => {
  const queue = createQueue();
  queue.join({ accountId: 1, rating: 1500, at: 0 });
  queue.join({ accountId: 2, rating: 1640, at: s(5) });
  queue.join({ accountId: 3, rating: 1520, at: s(6) });
  for (const id of [1, 2, 3]) queue.setReady(id, true);
  assert.deepEqual(ids(queue.pairUp(s(10))), [[1, 3]]);
  assert.equal(queue.size, 1);
});

test("the same two are not paired twice running while somebody else is waiting", () => {
  const queue = queueOf([[1, 1500], [2, 1500], [3, 1500]]);
  queue.rememberOpponents(1, 2);
  const pairs = ids(queue.pairUp(s(1)));
  assert.equal(pairs.length, 1);
  assert.notDeepEqual(pairs[0], [1, 2]);
});

test("but two who are the only ones waiting may play again", () => {
  const queue = queueOf([[1, 1500], [2, 1500]]);
  queue.rememberOpponents(1, 2);
  assert.deepEqual(ids(queue.pairUp(s(1))), [[1, 2]]);
});

test("joining twice is one place, and leaving takes it away", () => {
  const queue = createQueue();
  assert.equal(queue.join({ accountId: 1, rating: 1500, at: 0 }).ok, true);
  assert.equal(queue.join({ accountId: 1, rating: 1500, at: s(3) }).ok, true);
  assert.equal(queue.size, 1);
  assert.equal(queue.entry(1).joinedAt, 0, "a second join keeps the place in line");
  queue.leave(1);
  assert.equal(queue.size, 0);
});

test("whoever cancels a pairing or forfeits waits out a cooldown that grows each time in a row", () => {
  const queue = createQueue();
  queue.penalise(1, 0);
  const first = queue.join({ accountId: 1, rating: 1500, at: s(1) });
  assert.equal(first.ok, false);
  assert.equal(first.reason, "cooldown");
  assert.equal(first.until, s(60));
  assert.equal(queue.join({ accountId: 1, rating: 1500, at: s(60) }).ok, true);

  queue.leave(1);
  queue.penalise(1, s(100));
  assert.equal(queue.join({ accountId: 1, rating: 1500, at: s(101) }).until, s(100) + s(120), "doubled");

  queue.forgive(1);
  queue.penalise(1, s(1000));
  assert.equal(queue.join({ accountId: 1, rating: 1500, at: s(1001) }).until, s(1060), "a clean match resets the run");
});

test("the cooldown stops growing at its ceiling", () => {
  const queue = createQueue();
  for (let i = 0; i < 20; i++) queue.penalise(1, 0);
  assert.equal(queue.join({ accountId: 1, rating: 1500, at: 1 }).until, s(30 * 60));
});

test("a waiting count is there for adapters to show, without names", () => {
  const queue = queueOf([[1, 1500], [2, 1500], [3, 1500]]);
  queue.setReady(3, false);
  assert.deepEqual(queue.counts(), { waiting: 3, ready: 2 });
});

test("the queue's tables do not grow for ever: old cooldowns are forgotten, and last opponents are bounded", () => {
  const queue = createQueue();
  queue.penalise(1, 0);
  queue.penalise(2, 25 * 60 * 60 * 1000);
  assert.equal(queue.cooldowns.has(1), false, "a cooldown over a day ago is forgotten, streak and all");
  assert.equal(queue.cooldowns.has(2), true);
  for (let id = 0; id < 5000; id += 2) queue.rememberOpponents(id, id + 1);
  assert.ok(queue.lastOpponents.size <= 4096);
  assert.equal(queue.lastOpponents.get(4998), 4999, "the newest are kept");
});

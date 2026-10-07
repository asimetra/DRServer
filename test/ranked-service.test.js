import assert from "node:assert/strict";
import test from "node:test";

import { createRankedService } from "../src/ranked/index.js";
import { NEW_PLAYER } from "../src/ranked/rating.js";
import { createRecords } from "../src/ranked/records.js";
import { createSpec, fixedPicker } from "../src/ranked/race-spec.js";

/**
 * The service end to end, with a hand-turned clock, an in-memory log and a
 * start adapter that only writes down what it was asked. No sockets: these are
 * the rules of docs/ranked.md as a player would meet them.
 */
const A = 101;
const B = 202;
const s = (seconds) => seconds * 1000;

const setup = ({ startFails = false, records = createRecords({ storage: "memory" }) } = {}) => {
  let now = 0;
  const notices = [];
  const starts = [];
  const service = createRankedService({
    records,
    picker: fixedPicker(createSpec({ mapNodeId: 50006, seed: 42 })),
    rules: { countdownMs: s(10), maxDurationMs: s(1800), forfeitWindowMs: s(120), drawWindowMs: s(5) },
    clock: () => now,
    start: async (race) => {
      starts.push(race);
      if (startFails) throw new Error("no floor");
    },
  });
  service.onNotice((accountId, notice) => notices.push({ accountId, ...notice }));
  const at = (seconds) => {
    now = s(seconds);
  };
  const noticesFor = (accountId, type) => notices.filter((n) => n.accountId === accountId && n.type === type);
  return { service, records, notices, noticesFor, starts, at };
};

const queueBoth = async ({ service, at }) => {
  at(0);
  assert.equal(service.join(A).ok, true);
  assert.equal(service.join(B).ok, true);
  service.ready(A, true);
  service.ready(B, true);
};

/** Paired, counted down, started, both floors ready at 20 s. */
const raceBoth = async (context) => {
  await queueBoth(context);
  context.at(1);
  await context.service.tick();
  context.at(11);
  await context.service.tick();
  context.at(20);
  context.service.runEvent(A, "started");
  context.service.runEvent(B, "started");
};

test("two ready players are paired, counted down, started together, and told each step", async () => {
  const context = setup();
  const { service, at, noticesFor, starts } = context;
  await queueBoth(context);
  assert.equal(noticesFor(A, "queued").length, 1);

  at(1);
  await service.tick();
  const [paired] = noticesFor(A, "paired");
  assert.equal(paired.opponent, B);
  assert.equal(paired.countdownSeconds, 10);
  assert.equal(starts.length, 0, "not before the countdown");

  at(11);
  await service.tick();
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].spec, createSpec({ mapNodeId: 50006, seed: 42 }));
  assert.deepEqual(starts[0].ids, [A, B]);

  at(20);
  service.runEvent(A, "started");
  service.runEvent(B, "started");
  assert.equal(noticesFor(B, "started").length, 1);
  assert.equal(service.statusOf(A).state, "in_race");
});

test("a finished race is recorded, moves both ratings, and tells both how", async () => {
  const context = setup();
  const { service, at, noticesFor, records } = context;
  await raceBoth(context);

  at(120);
  service.runEvent(A, "finished");
  await service.tick();

  const [finished] = noticesFor(A, "finished");
  assert.equal(finished.result, "win");
  assert.ok(finished.ratingChange > 0);
  assert.equal(noticesFor(B, "finished")[0].result, "loss");

  const [logged] = await records.all();
  assert.equal(logged.state, "finished");
  assert.equal(logged.winner, A);
  assert.deepEqual(logged.spec, { mapNodeId: 50006, seed: 42, rules: {} });
  assert.ok(logged.timeline.length > 0);
  assert.ok(service.ratingOf(A).rating > NEW_PLAYER.rating);
  assert.equal(service.statusOf(A).state, "idle");
});

test("ratings come back from the log when the service starts", async () => {
  const first = setup();
  await raceBoth(first);
  first.at(120);
  first.service.runEvent(A, "finished");
  await first.service.tick();

  const second = setup({ records: first.records });
  await second.service.load();
  assert.equal(second.service.ratingOf(A).rating, first.service.ratingOf(A).rating);
  assert.equal(second.service.board()[0].accountId, A);
});

test("leaving during the countdown cancels it: no rating moves, the other is queued again, the leaver waits", async () => {
  const context = setup();
  const { service, at, noticesFor, records } = context;
  await queueBoth(context);
  at(1);
  await service.tick();

  at(5);
  service.runEvent(A, "left");
  assert.equal(noticesFor(A, "cancelled")[0].reason, "left");
  assert.equal(noticesFor(B, "cancelled")[0].requeued, true);
  assert.equal(service.queue.entry(B).ready, false, "in line, but whether B can start now is the adapter's to say again");
  assert.equal(service.statusOf(B).state, "queued");
  assert.equal(service.ratingOf(A).rating, NEW_PLAYER.rating);

  const refused = service.join(A);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "cooldown");
  assert.equal((await records.all())[0].state, "cancelled");
});

test("a race the start adapter cannot begin is void, and nobody is blamed", async () => {
  const context = setup({ startFails: true });
  const { service, at, noticesFor } = context;
  await queueBoth(context);
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  assert.equal(noticesFor(A, "cancelled")[0].reason, "start_failed");
  assert.equal(service.join(A).ok, true, "no cooldown for a void race");
});

test("forfeiting early is a loss and a cooldown", async () => {
  const context = setup();
  const { service, at, noticesFor } = context;
  await raceBoth(context);
  at(40);
  service.runEvent(A, "left");
  at(46);
  await service.tick();
  assert.equal(noticesFor(A, "finished")[0].result, "loss");
  assert.equal(noticesFor(A, "finished")[0].forfeit, true);
  assert.equal(service.join(A).reason, "cooldown");
  assert.equal(service.join(B).ok, true);
});

test("nobody joins the queue while in a race, and run events for nobody's race are ignored", async () => {
  const context = setup();
  await raceBoth(context);
  assert.equal(context.service.join(A).reason, "in_race");
  assert.doesNotThrow(() => context.service.runEvent(999, "finished"));
});

test("stopping the server voids the races still running", async () => {
  const context = setup();
  await raceBoth(context);
  await context.service.stop();
  assert.equal((await context.records.all())[0].state, "void");
  assert.equal(context.noticesFor(A, "cancelled")[0].reason, "server_stopped");
});

test("progress is passed to the opponent and kept in the timeline", async () => {
  const context = setup();
  const { service, at, noticesFor } = context;
  await raceBoth(context);
  at(60);
  service.runEvent(A, "progress", { floor: 2, of: 3 });
  assert.deepEqual(noticesFor(B, "progress")[0].floor, 2);
  at(120);
  service.runEvent(A, "finished");
  await service.tick();
  assert.ok((await context.records.all())[0].timeline.some((entry) => entry.type === "progress"));
});

test("/draw asks the rival; both asking ends the race with no rating moved", async () => {
  const context = setup();
  const { service, at, noticesFor, records } = context;
  await raceBoth(context);
  at(100);
  await service.runEvent(A, "draw");
  assert.equal(noticesFor(B, "draw_offered").length, 1);
  assert.equal(service.statusOf(A).state, "in_race");
  at(130);
  await service.runEvent(B, "draw");
  assert.equal(noticesFor(A, "cancelled")[0].reason, "agreed");
  assert.equal(service.ratingOf(A).rating, service.ratingOf(B).rating);
  assert.equal((await records.all())[0].state, "void");
  assert.equal(service.join(A).ok, true, "no cooldown for a race called off together");
});

test("a match the log refuses is held, written later in order, and the board moved meanwhile", async () => {
  const written = [];
  let refusing = true;
  const records = {
    all: async () => [...written],
    append: async (record) => (refusing ? false : (written.push(record), true)),
  };
  const { service } = setup({ records });
  assert.equal(await service.keep({ id: "m1" }), false);
  assert.equal(await service.keep({ id: "m2" }), false, "behind the first, not before it");
  assert.deepEqual(service.unwritten.map((r) => r.id), ["m1", "m2"]);

  await service.writeHeld();
  assert.deepEqual(written, [], "still refusing: still held");

  refusing = false;
  await service.tick();
  assert.deepEqual(written.map((r) => r.id), ["m1", "m2"], "the next tick writes them, oldest first");
  assert.deepEqual(service.unwritten, []);
  assert.equal(await service.keep({ id: "m3" }), true, "and a new one goes straight in");
});

test("stopping makes a last try for held matches", async () => {
  const written = [];
  let refusing = true;
  const records = { all: async () => [], append: async (record) => (refusing ? false : (written.push(record), true)) };
  const { service } = setup({ records });
  await service.keep({ id: "late" });
  refusing = false;
  await service.stop();
  assert.deepEqual(written.map((r) => r.id), ["late"]);
});

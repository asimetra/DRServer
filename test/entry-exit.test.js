import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * An exit asked for while an entry is still under way.
 *
 * The exit is the one answer: it tears the entry down and says ExitComplete,
 * and the entry — however it ends afterwards — says nothing more and tears
 * nothing down a second time.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-entry-exit-"));

const { ENTRY_ERROR, FLID, handleField } = await import("../src/socket/matchmaker.js");
const { installMatchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { EntryRefusedError } = await import("../src/socket/match-entry.js");
const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");
const { OP } = await import("../src/socket/opcodes.js");
const { transitionsOf } = await import("../src/socket/session-transitions.js");

const TUTORIAL = 50002;
let nextId = 1000000900;

/** Every matchmaker answer the client was sent, in order. */
const answersIn = (sent) =>
  sent.map((frame) => {
    const reader = new PacketReader(frame.subarray(2));
    assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
    reader.u32();
    const field = reader.u16();
    if (field === FLID.ClientExitComplete) return "exit";
    if (field === FLID.ClientRequestEntryResponce) return `entry:${reader.u16()}`;
    return `field:${field}`;
  });

const connect = () => {
  const sent = [];
  return { id: nextId, accountId: nextId++, matchMakerDoid: 9001, send: (frame) => sent.push(frame), sent };
};

const entryFor = (mapNodeId) =>
  new PacketReader(
    new PacketWriter().utf("{}").u32(0).u32(mapNodeId).u32(0).u32(0).u8(0).utf("").body()
  );
const exitRequest = () => new PacketReader(new PacketWriter().u32(0).body());

/** A stand-in executor whose join the test drives, recording every leave. */
const executor = (join) => {
  const leaves = [];
  return {
    leaves,
    join,
    leave: async (session, options = {}) => {
      leaves.push(options.notifyClient === true ? "notify" : "quiet");
      dungeonMatches.remove(session);
      return true;
    },
  };
};

const settle = (session) => transitionsOf(session).idle();

/** The exit has answered — which it does before the entry it cancelled has finished. */
const exitAnswered = async (session) => {
  while (!answersIn(session.sent).includes("exit")) await new Promise((resolve) => setImmediate(resolve));
};

test("an exit before admission finishes: nothing is joined, and only the exit is answered", async (t) => {
  let joins = 0;
  const fake = executor(async () => {
    joins++;
  });
  const previous = installMatchExecutor(fake);
  t.after(() => installMatchExecutor(previous));
  const session = connect();

  handleField(session, FLID.ClientRequestEntry, entryFor(TUTORIAL));
  handleField(session, FLID.RequestExit, exitRequest());
  await settle(session);

  assert.equal(joins, 0, "the admission it won was given back instead");
  assert.equal(dungeonMatches.matchByAccount.get(session.accountId), undefined);
  assert.deepEqual(answersIn(session.sent), ["exit"]);
});

test("an exit during the join: the failing entry neither answers nor tears down again", async (t) => {
  let fail;
  const fake = executor(async (session, result, request, { onPlayerReady }) => {
    onPlayerReady();
    await new Promise((resolve, reject) => {
      fail = reject;
    });
  });
  const previous = installMatchExecutor(fake);
  t.after(() => installMatchExecutor(previous));
  const session = connect();

  handleField(session, FLID.ClientRequestEntry, entryFor(TUTORIAL));
  while (!fail) await new Promise((resolve) => setImmediate(resolve));
  handleField(session, FLID.RequestExit, exitRequest());
  await exitAnswered(session);
  assert.equal(transitionsOf(session).phase, "leaving", "still leaving until the entry has finished");
  fail(new Error("match member disconnected during entry"));
  await settle(session);

  assert.deepEqual(fake.leaves, ["notify"], "the exit's teardown, once");
  assert.deepEqual(answersIn(session.sent), [`entry:0`, "exit"], "and no Internal Error after it");
});

test("a join that completes after the exit is let go without a word", async (t) => {
  let finish;
  const fake = executor(async (session, result, request, { onPlayerReady }) => {
    await new Promise((resolve) => {
      finish = resolve;
    });
    onPlayerReady();
  });
  const previous = installMatchExecutor(fake);
  t.after(() => installMatchExecutor(previous));
  const session = connect();

  handleField(session, FLID.ClientRequestEntry, entryFor(TUTORIAL));
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  handleField(session, FLID.RequestExit, exitRequest());
  await exitAnswered(session);
  finish();
  await settle(session);

  assert.deepEqual(fake.leaves, ["notify", "quiet"]);
  assert.deepEqual(answersIn(session.sent), ["exit"], "no acceptance for a run already left");
});

test("a refusal raised once the account is held answers with its own message", async (t) => {
  const fake = executor(async () => {
    throw new EntryRefusedError("content_not_completed");
  });
  const previous = installMatchExecutor(fake);
  t.after(() => installMatchExecutor(previous));
  const session = connect();

  handleField(session, FLID.ClientRequestEntry, entryFor(TUTORIAL));
  await settle(session);

  assert.deepEqual(answersIn(session.sent), [`entry:${ENTRY_ERROR.UNAUTHORIZED_MAP}`]);
  assert.deepEqual(fake.leaves, ["notify"]);
});

test("an entry asked for while the exit is still leaving is refused, and nothing is admitted", async (t) => {
  let finishLeaving;
  let joins = 0;
  const fake = executor(async () => {
    joins++;
  });
  const leave = fake.leave;
  fake.leave = async (session, options) => {
    await new Promise((resolve) => {
      finishLeaving = resolve;
    });
    return leave(session, options);
  };
  const previous = installMatchExecutor(fake);
  t.after(() => installMatchExecutor(previous));
  const session = connect();

  handleField(session, FLID.RequestExit, exitRequest());
  while (!finishLeaving) await new Promise((resolve) => setImmediate(resolve));
  handleField(session, FLID.ClientRequestEntry, entryFor(TUTORIAL));
  assert.equal(transitionsOf(session).current.kind, "exit", "the exit is still the one under way");
  assert.equal(dungeonMatches.matchByAccount.get(session.accountId), undefined, "no admission");
  finishLeaving();
  await settle(session);

  assert.equal(joins, 0);
  assert.deepEqual(answersIn(session.sent), [`entry:${ENTRY_ERROR.GAME_NOT_ENTERABLE}`, "exit"]);
});

test("an entry while a worker is still letting the last run go is refused", () => {
  const session = connect();
  // On a worker, leaving takes the registry membership at once and the route
  // only when the worker says the run is gone.
  session.matchRoute = { leaving: true };
  handleField(session, FLID.ClientRequestEntry, entryFor(TUTORIAL));
  assert.equal(transitionsOf(session).current, null);
  assert.deepEqual(answersIn(session.sent), [`entry:${ENTRY_ERROR.GAME_NOT_ENTERABLE}`]);
});

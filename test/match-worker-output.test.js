import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The worker-to-main direction has the same bound the socket has: what a
 * session has been sent and the main thread has not yet written is limited,
 * and a session over it is closed as a saturated socket is.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-match-worker-output-"));
process.env.ODS_MAX_OUTBOUND_BUFFER_BYTES = String(64 * 1024);

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");

const pool = new MatchWorkerPool({ size: 1, loadReportMs: 0 });
const restore = installWorkerPool(pool, { installExecutor: installMatchExecutor });
await pool.ready;
test.after(async () => {
  await pool.close();
  restore();
});

const waitFor = async (check, what, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A session in a dungeon on the pool's worker, answering its own loading signals. */
const inDungeon = async (id, accountId) => {
  const sent = [];
  const session = new MemberSession({
    id,
    accountId,
    authenticated: true,
    matchMakerDoid: 11,
    presenceDoid: 12,
    objects: new Map(),
    actors: new Map(),
    closed: false,
    send: (frame) => {
      sent.push(Buffer.from(frame));
      return true;
    },
  });
  session.close = (why) => {
    session.closed = true;
    session.closedBecause = why;
    matchExecutor.leave(session);
  };
  const result = dungeonMatches.reserve({ session, mapNodeId: 50002, group: "" });
  const joined = matchExecutor.join(session, result, { mapNodeId: 50002 }, { onPlayerReady: () => {} });
  const player = await waitFor(
    () =>
      sent.find(
        (frame) =>
          frame.readUInt16LE(2) === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP &&
          frame.readUInt16LE(4) === CLID.PlayerGameObject
      ),
    "the owner player"
  );
  const playerDoid = player.readUInt32LE(6);
  const field = (fieldId, writer = (w) => w) =>
    writer(new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(playerDoid).u16(fieldId)).frame().subarray(2);
  matchExecutor.forward(session, field(185));
  matchExecutor.forward(session, field(184));
  await joined;
  return { session, sent, field };
};

/** Every /help is answered to this player alone, a few hundred bytes a time. */
const askForHelp = async ({ session, field }, times) => {
  for (let i = 0; i < times && !session.closed; i++) {
    matchExecutor.forward(session, field(182, (w) => w.utf("/help")));
    if (i % 50 === 49) await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("a session whose output the main thread is not getting through is closed like a full socket", async () => {
  // The main thread writes the frames but never tells the worker so, as if it
  // had fallen behind: everything sent stays outstanding.
  const acknowledge = pool.acknowledgeOutput;
  pool.acknowledgeOutput = () => {};
  try {
    const player = await inDungeon(1, 1000000901);
    await askForHelp(player, 400);
    await waitFor(() => player.session.closed, "the session to be closed");
    assert.match(player.session.closedBecause, /outbound buffer saturated/);
  } finally {
    pool.acknowledgeOutput = acknowledge;
  }
});

test("the same output, written and acknowledged as it goes, is nobody's problem", async () => {
  const player = await inDungeon(2, 1000000902);
  await askForHelp(player, 400);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const answered = player.sent.length;
  assert.ok(answered > 400, `${answered} frames`);
  assert.equal(player.session.closed, false);
  await matchExecutor.leave(player.session, { notifyClient: true });
});

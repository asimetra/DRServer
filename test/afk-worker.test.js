import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * An idle player in a real match worker, with the limits shortened: the worker
 * sees nothing come from the hero, marks it, and asks the main thread to send
 * the player home — which it does the way an exit does, teardown first and
 * ClientExitComplete last, the message the client's RunState goes home on.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-afk-worker-"));
process.env.ODS_AFK_WARN_MS = "300";
process.env.ODS_AFK_KICK_MS = "700";

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");
const { FLID, buildEntryResponse } = await import("../src/socket/entry-protocol.js");
const { transitionsOf } = await import("../src/socket/session-transitions.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { setMapNodeBit } = await import("../src/map-progress.js");

/** ARENA_1: an ordinary dungeon, since the tutorial sends nobody home. */
const MAP_NODE = 50003;
const MATCHMAKER_DOID = 11;

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

const fieldOf = (frame) => {
  if (frame.readUInt16LE(2) !== OP.CLIENT_OBJECT_UPDATE_FIELD) return null;
  const reader = new PacketReader(frame.subarray(2));
  reader.u16();
  return { doid: reader.u32(), field: reader.u16(), value: reader.u8() };
};

test("a player who does nothing on a worker's floor is marked, then sent back to town", async () => {
  // ARENA_1 opens once the tutorial (bit 0) is cleared by the hero playing it.
  const stored = await loadAccount(1000001101);
  const hero = stored.account_avatars.find((row) => row.id === stored.active_avatar);
  hero.completed_mapnode_mask = setMapNodeBit(hero.completed_mapnode_mask, 0);
  await saveAccount(stored);

  const sent = [];
  const session = new MemberSession({
    id: 1,
    accountId: 1000001101,
    authenticated: true,
    matchMakerDoid: MATCHMAKER_DOID,
    presenceDoid: 12,
    objects: new Map(),
    actors: new Map(),
    closed: false,
    send: (frame) => {
      sent.push(Buffer.from(frame));
      return true;
    },
  });
  const { reservation } = dungeonMatches.reserve({ session, mapNodeId: MAP_NODE, group: "" });
  const joined = matchExecutor.join(session, reservation, { mapNodeId: MAP_NODE }, {
    onPlayerReady: () => session.send(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE)),
  });
  const player = await waitFor(
    () => sent.find((frame) =>
      frame.readUInt16LE(2) === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP &&
      frame.readUInt16LE(4) === CLID.PlayerGameObject),
    "the owner player"
  );
  const playerDoid = player.readUInt32LE(6);
  const signal = (fieldId) =>
    new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(playerDoid).u16(fieldId).frame().subarray(2);
  matchExecutor.forward(session, signal(185));
  matchExecutor.forward(session, signal(184));
  await joined;

  const exitAt = await waitFor(
    () => {
      const index = sent.findIndex((frame) => fieldOf(frame)?.field === FLID.ClientExitComplete);
      return index >= 0 ? index + 1 : 0;
    },
    "ClientExitComplete"
  ) - 1;
  const marked = sent.findIndex((frame) => fieldOf(frame)?.field === 167 && fieldOf(frame).value === 1);
  assert.ok(marked >= 0 && marked < exitAt, "the Zzz marker came first");
  const disables = sent
    .slice(marked, exitAt)
    .filter((frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP);
  assert.ok(disables.length > 0, "and the run was taken down before ExitComplete");

  await transitionsOf(session).idle();
  assert.equal(session.matchRoute, undefined, "the route is gone");
  await waitFor(() => !pool.ownerOf(1000001101), "the account handed back");
  assert.equal(dungeonMatches.matchByAccount.get(1000001101), undefined);
});

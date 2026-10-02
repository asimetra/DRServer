import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * Closing the dungeons while the server runs, and telling the players.
 *
 * A restart ends every run in progress. What an operator wants before one is
 * to stop new runs starting, say so, and let the ones under way finish — and
 * the only switch there was is read at startup. So the door can be closed and
 * opened again through the internal API. Whoever is in a dungeon keeps
 * playing, and goes on through its doors; a request to start one, or to join
 * somebody's, gets the client's own "game not enterable".
 *
 * And a line can be said to everybody. The client has chat only on a dungeon
 * floor — town has no log to write to — so it reaches the players who are on
 * one, as the server.
 */

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-maintenance-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { endMaintenance, maintenanceState } = await import("../src/maintenance.js");
const { enterPresence, leavePresence } = await import("../src/socket/presence.js");

const server = start();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  endMaintenance();
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT"]) {
    delete process.env[name];
  }
  await rm(dataDir, { recursive: true, force: true });
});

/** The admin these calls are made by (see test/admin-api.test.js); set once one is registered. */
let ADMIN = null;

const call = (method, route, body) =>
  fetch(`${base}${route}`, {
    method,
    headers: {
      "X-Internal-Token": process.env.ODS_INTERNAL_TOKEN,
      ...(ADMIN === null ? {} : { "X-Acting-Account": String(ADMIN) }),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

{
  const { config } = await import("../src/config.js");
  const registered = await (await call("POST", "/internal/v1/accounts", {})).json();
  ADMIN = registered.accountId;
  config.adminAccounts = [ADMIN];
}

/** A player standing on a floor, as presence holds one; `heard` collects the lines sent to them. */
const onFloor = (accountId, { floor = true } = {}) => {
  let doid = 5000 + accountId * 10;
  const heard = [];
  const session = {
    id: accountId,
    accountId,
    playerDoid: floor ? accountId : 0,
    floorDoid: floor ? 77 : 0,
    objects: new Map(),
    allocateDoid: () => ++doid,
    broadcast: () => {},
    send: () => {},
    sendDirect: (frame) => heard.push(Buffer.from(frame).toString("utf8")),
    close: () => {},
  };
  return { session, heard, said: (text) => heard.some((frame) => frame.includes(text)) };
};

const withPresence = async (players, body) => {
  for (const { session } of players) enterPresence(session);
  try {
    return await body();
  } finally {
    for (const { session } of players) leavePresence(session);
  }
};

test("the dungeons are closed, read back, and opened again", async () => {
  assert.equal((await (await call("GET", "/internal/v1/maintenance")).json()).maintenance, null);

  const closed = await call("PUT", "/internal/v1/maintenance", {});
  assert.equal(closed.status, 200);
  const state = (await closed.json()).maintenance;
  assert.equal(state.by, ADMIN, "closed in the name of the admin who made the call");
  assert.ok(state.since, "when it began");
  assert.deepEqual((await (await call("GET", "/internal/v1/maintenance")).json()).maintenance, state);
  assert.ok(maintenanceState());

  const opened = await call("DELETE", "/internal/v1/maintenance");
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).maintenance, null);
  assert.equal(maintenanceState(), null);
});

test("a request to enter a dungeon is refused while they are closed", async () => {
  const { ENTRY_ERROR, FLID, handleField } = await import("../src/socket/matchmaker.js");
  const { transitionsOf } = await import("../src/socket/session-transitions.js");
  const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");
  const { OP } = await import("../src/socket/opcodes.js");
  const sent = [];
  const session = { id: 72, accountId: 1000000005, matchMakerDoid: 9002, send: (frame) => sent.push(frame) };
  const request = new PacketWriter().utf("{}").u32(0).u32(50082).u32(0).u32(0).u8(0).utf("").body();

  await call("PUT", "/internal/v1/maintenance", {});
  try {
    assert.equal(handleField(session, FLID.ClientRequestEntry, new PacketReader(request)), true);
  } finally {
    await call("DELETE", "/internal/v1/maintenance");
  }

  assert.equal(transitionsOf(session).current, null, "nothing was started");
  const response = new PacketReader(sent[0].subarray(2));
  assert.equal(response.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(response.u32(), session.matchMakerDoid);
  assert.equal(response.u16(), FLID.ClientRequestEntryResponce);
  assert.equal(response.u16(), ENTRY_ERROR.GAME_NOT_ENTERABLE);
});

test("an announcement reaches everybody on a floor, and nobody in town", async () => {
  const fighting = onFloor(11);
  const alsoFighting = onFloor(12);
  const inTown = onFloor(13, { floor: false });

  await withPresence([fighting, alsoFighting, inTown], async () => {
    const response = await call("POST", "/internal/v1/announcements", { text: "Restarting in five minutes" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).heard, 2);
  });

  assert.ok(fighting.said("Restarting in five minutes"));
  assert.ok(alsoFighting.said("Restarting in five minutes"));
  assert.equal(inTown.heard.length, 0, "town has no chat log to write to");
});

test("closing with a message says it to everybody on a floor", async () => {
  const fighting = onFloor(21);
  await withPresence([fighting], async () => {
    const response = await call("PUT", "/internal/v1/maintenance", { message: "Finish your run, we restart at 15:00" });
    const answer = await response.json();
    assert.equal(answer.maintenance.message, "Finish your run, we restart at 15:00");
    assert.equal(answer.heard, 1);
    await call("DELETE", "/internal/v1/maintenance");
  });
  assert.ok(fighting.said("Finish your run, we restart at 15:00"));
});

/** The same bound a player's own line has: the client's chat log was not made for essays. */
test("an announcement has to be something, and short enough to be a chat line", async () => {
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 7 }, { text: "x".repeat(301) }]) {
    assert.equal((await call("POST", "/internal/v1/announcements", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("PUT", "/internal/v1/maintenance", { message: "x".repeat(301) })).status, 400);
  assert.equal(maintenanceState(), null, "and a refused close closes nothing");
});

test("with match workers, every worker is asked to say it", async () => {
  const { MatchWorkerPool } = await import("../src/socket/match-worker-pool.js");
  const asked = [];
  const worker = (heard) => ({ alive: true, channel: { call: async (op, args) => (asked.push([op, args]), heard) } });
  const pool = { workers: [worker(2), worker(3), { alive: false, channel: { call: async () => 99 } }] };

  const heard = await MatchWorkerPool.prototype.announceEverywhere.call(pool, "Restarting soon");
  assert.equal(heard, 5);
  assert.deepEqual(asked, [["announce", { text: "Restarting soon" }], ["announce", { text: "Restarting soon" }]]);
});

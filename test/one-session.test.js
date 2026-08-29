import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

/**
 * Two clients on one account.
 *
 * Both copies of the client on this machine carried `AccountId: 1000000005`,
 * so both logged in as the same player and drove one character from two
 * places — measured across three runs, every one of them account 1000000005.
 * Nothing refused it, and nothing told either of them.
 *
 * Its own data directory, and set before the first import that reads config.
 * Logging in loads and saves accounts, so without this a test run writes to
 * whatever the server itself is using — which it did, putting a friendship into
 * a real account.
 */
process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-one-session-"));

const { onConnection } = await import("../src/socket/index.js");
const { clearPresence, isOnline, sessionHolding } = await import("../src/socket/presence.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { OP } = await import("../src/socket/opcodes.js");

const fakeSocket = () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.remoteAddress = "test";
  socket.written = [];
  socket.ended = false;
  socket.write = (frame) => {
    socket.written.push(frame);
    return true;
  };
  socket.pause = () => {};
  socket.resume = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  // The real thing sends what is queued and then the FIN; here the difference
  // that matters is only that it is recorded as the graceful one.
  socket.end = () => {
    socket.ended = true;
    socket.destroy();
  };
  return socket;
};

const settle = async () => {
  for (let index = 0; index < 40; index++) await new Promise((resolve) => setImmediate(resolve));
};

const login = (accountId) =>
  new PacketWriter(OP.CLIENT_LOGIN_DUNGEONBUSTER)
    .utf("token")
    .utf("1.0.0")
    .u32(0)
    .u32(4)
    .u32(accountId)
    .u32(3)
    .u32(0)
    .frame();

const connect = async (accountId) => {
  const socket = fakeSocket();
  const session = onConnection(socket);
  socket.emit("data", login(accountId));
  await settle();
  return { socket, session };
};

/** Opcode 140: i16 code, utf text. Code 60 is the one the client acts on. */
const logoutFrames = (socket) =>
  socket.written
    .map((frame) => frame.subarray(2))
    .filter((body) => body.length >= 4 && body.readUInt16LE(0) === OP.CLIENT_LOGOUT_RESP)
    .map((body) => ({
      code: body.readInt16LE(2),
      text: body.toString("utf8", 6, 6 + body.readUInt16LE(4)),
    }));

test("a second login on one account puts the first one off it", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const first = await connect(1000000005);
  assert.equal(sessionHolding(1000000005), first.session, "the account is his");

  const second = await connect(1000000005);

  assert.ok(first.socket.destroyed, "the one that was there is gone");
  assert.ok(first.socket.ended, "closed gracefully, so the reason reaches him");
  assert.equal(first.session.closed, true);

  const told = logoutFrames(first.socket);
  assert.equal(told.length, 1, "and told exactly once");
  assert.equal(told[0].code, 60, "code 60: the branch that enters the socket error state");
  assert.match(told[0].text, /somewhere else/i, "with a reason he can read");

  assert.ok(!second.socket.destroyed, "the newcomer keeps the account");
  assert.equal(sessionHolding(1000000005), second.session);
  assert.ok(isOnline(1000000005), "and is still online: one player, one session");
});

test("a displaced session releases its dungeon before a graceful socket close completes", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const first = await connect(1000000005);
  const opened = dungeonMatches.resolve({
    session: first.session,
    mapNodeId: 50082,
  });
  assert.equal(opened.match.members.has(first.session), true);

  // Model a slow peer: Node accepted the FIN request, but no close event has
  // arrived yet. Match cleanup must not depend on that event.
  first.socket.end = () => {
    first.socket.ended = true;
  };
  await connect(1000000005);

  assert.equal(first.session.closed, true);
  assert.equal(first.socket.ended, true);
  assert.equal(first.socket.destroyed, false, "the close event is deliberately still pending");
  assert.equal(opened.match.state, "closed");
  assert.equal(dungeonMatches.matches.has(opened.match.id), false);
  assert.equal(dungeonMatches.matchByAccount.has(1000000005), false);
  assert.equal(first.session.dungeonMatch, undefined);

  first.socket.destroy();
});

test("displacing does not take the account offline for everybody else", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const watcher = await connect(1000000001);
  const list = new PacketWriter().u32(1000000005).body();
  watcher.socket.emit(
    "data",
    new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
      .u32(watcher.session.presenceDoid)
      .u16(189)
      .u16(list.length)
      .raw(list)
      .frame()
  );
  await settle();

  await connect(1000000005);
  watcher.socket.written.length = 0;

  // The reconnect: his old socket leaves presence and his new one joins it. The
  // friends panel must not be told he went offline in between, because he did
  // not — that flicker is what a friend list showing people blinking looks like.
  await connect(1000000005);

  const updates = watcher.socket.written
    .map((frame) => frame.subarray(2))
    .filter((body) => body.length >= 17 && body.readUInt16LE(0) === OP.CLIENT_OBJECT_UPDATE_FIELD)
    .filter((body) => body.readUInt16LE(6) === 188)
    .map((body) => ({ online: body.readUInt8(8) !== 0, account: body.readUInt32LE(9) }));

  assert.ok(
    updates.every((update) => update.online),
    `nobody is told he left: ${JSON.stringify(updates)}`
  );
  assert.ok(isOnline(1000000005), "and he is on the roll at the end");
});

test("friends are told about without being asked", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const { loadAccount, saveAccount } = await import("../src/accounts.js");
  const me = await loadAccount(1000000005);
  const them = await loadAccount(1000000006);
  me.ingame_friends = JSON.stringify([1000000006]);
  them.ingame_friends = JSON.stringify([1000000005]);
  await saveAccount(me);
  await saveAccount(them);

  /**
   * Nothing here sends field 189. The client barely does either — 46 of 61
   * official recordings carry the server's 188 and two carry the client's 189 —
   * and a session of our own sent neither, which is why every friend read as
   * offline.
   */
  const first = await connect(1000000005);
  first.socket.written.length = 0;

  const second = await connect(1000000006);
  await settle();

  const seen = (socket) =>
    socket.written
      .map((frame) => frame.subarray(2))
      .filter((body) => body.length >= 17 && body.readUInt16LE(0) === OP.CLIENT_OBJECT_UPDATE_FIELD)
      .filter((body) => body.readUInt16LE(6) === 188)
      .map((body) => ({ online: body.readUInt8(8) !== 0, account: body.readUInt32LE(9) }));

  assert.deepEqual(
    seen(second.socket),
    [{ online: true, account: 1000000005 }],
    "the one arriving is told who is already here"
  );
  assert.deepEqual(
    seen(first.socket),
    [{ online: true, account: 1000000006 }],
    "and the one already here is told about the arrival"
  );
});

test("presence says itself again on the tick, dungeon and all", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const { loadAccount, saveAccount } = await import("../src/accounts.js");
  const { setPresenceLocation, reassertPresenceNow } = await import("../src/socket/presence.js");
  for (const [id, friend] of [
    [1000000005, 1000000006],
    [1000000006, 1000000005],
  ]) {
    const account = await loadAccount(id);
    account.ingame_friends = JSON.stringify([friend]);
    await saveAccount(account);
  }

  const watcher = await connect(1000000005);
  const friend = await connect(1000000006);
  setPresenceLocation(friend.session, 50042);
  await settle();
  watcher.socket.written.length = 0;

  // Nothing has changed since. A purely change-driven server says nothing here,
  // and a panel that missed the last one stays wrong until he moves again.
  reassertPresenceNow();

  const seen = watcher.socket.written
    .map((frame) => frame.subarray(2))
    .filter((body) => body.length >= 17 && body.readUInt16LE(0) === OP.CLIENT_OBJECT_UPDATE_FIELD)
    .filter((body) => body.readUInt16LE(6) === 188)
    .map((body) => ({
      online: body.readUInt8(8) !== 0,
      account: body.readUInt32LE(9),
      mapNode: body.readUInt32LE(13),
    }));

  assert.deepEqual(seen, [{ online: true, account: 1000000006, mapNode: 50042 }]);
});

test("a second login on a different account displaces nobody", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const one = await connect(1000000005);
  const two = await connect(1000000006);

  assert.ok(!one.socket.destroyed, "two accounts are two players");
  assert.ok(!two.socket.destroyed);
  assert.equal(logoutFrames(one.socket).length, 0, "and neither is told to go");
  assert.equal(sessionHolding(1000000005), one.session);
  assert.equal(sessionHolding(1000000006), two.session);
});

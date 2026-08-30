import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { config } from "../src/config.js";
import { issueToken } from "../src/auth.js";

// Logging in here is a real login: the packet carries a token this server
// signed. Set on the config rather than the environment because static
// imports are evaluated before any of this file's own statements run.
config.tokenSecret ||= "presence-test-secret";

import { onConnection } from "../src/socket/index.js";
import {
  clearPresence,
  dungeonOf,
  setPresenceLocation,
} from "../src/socket/presence.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { PacketWriter } from "../src/socket/packet.js";
import { CLID, OP } from "../src/socket/opcodes.js";

const fakeSocket = () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.remoteAddress = "test";
  socket.written = [];
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
  socket.end = socket.destroy;
  return socket;
};

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
};

const login = (accountId) =>
  new PacketWriter(OP.CLIENT_LOGIN_DUNGEONBUSTER)
    .utf(issueToken(accountId))
    .utf("1.0.0")
    .u32(0)
    .u32(4)
    .u32(accountId)
    .u32(3)
    .u32(0)
    .frame();

/** Field 188: u8 online, u32 account, u32 map node — read back off the wire. */
const presenceUpdates = (socket) => {
  const seen = [];
  for (const frame of socket.written) {
    const body = frame.subarray(2);
    if (body.length < 17 || body.readUInt16LE(0) !== OP.CLIENT_OBJECT_UPDATE_FIELD) continue;
    if (body.readUInt16LE(6) !== 188) continue;
    seen.push({
      online: body.readUInt8(8) !== 0,
      account: body.readUInt32LE(9),
      mapNode: body.readUInt32LE(13),
    });
  }
  return seen;
};

const connect = async (accountId) => {
  const socket = fakeSocket();
  const session = onConnection(socket);
  socket.emit("data", login(accountId));
  await settle();
  return { socket, session };
};

/** The client asks about a set, and it replaces whatever it asked about before. */
const watch = async (socket, session, ids) => {
  const list = new PacketWriter();
  for (const id of ids) list.u32(id);
  const blob = list.body();
  socket.emit(
    "data",
    new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
      .u32(session.presenceDoid)
      .u16(189)
      .u16(blob.length)
      .raw(blob)
      .frame()
  );
  await settle();
};

test("a friend's panel is told who is online and where", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const me = await connect(1000000001);
  assert.ok(me.session.presenceDoid, "the object the panel reads is generated at login");
  const generated = me.socket.written.some((frame) => {
    const body = frame.subarray(2);
    return (
      body.length >= 16 &&
      body.readUInt16LE(0) === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP &&
      body.readUInt16LE(10) === CLID.PresenceManager
    );
  });
  assert.ok(generated, "and sent");

  // Asking about somebody who is not here answers, rather than staying silent:
  // the panel is open now and needs a row either way.
  await watch(me.socket, me.session, [1000000002]);
  let updates = presenceUpdates(me.socket);
  assert.equal(updates.length, 1, "the question is answered at once");
  assert.deepEqual(updates[0], { online: false, account: 1000000002, mapNode: 0 });

  // He arrives.
  me.socket.written.length = 0;
  const friend = await connect(1000000002);
  updates = presenceUpdates(me.socket);
  assert.deepEqual(updates.at(-1), { online: true, account: 1000000002, mapNode: 0 }, "online, in town");

  // And walks into a dungeon.
  me.socket.written.length = 0;
  // The first match member enters through a MatchWorld context proxy. Presence
  // must resolve that proxy back to the raw connected session, or it silently
  // leaves the host in town while the dungeon is already running.
  const world = createMatchWorld(
    { id: 1, members: new Set([friend.session]) },
    friend.session
  );
  const dungeonContext = world.contextFor(friend.session);
  setPresenceLocation(dungeonContext, 50002);
  updates = presenceUpdates(me.socket);
  assert.deepEqual(updates.at(-1), { online: true, account: 1000000002, mapNode: 50002 }, "and into one");
  assert.equal(dungeonOf(1000000002), 50002, "the JSON presence source agrees");

  // Back to town is zero rather than absent, which is how the client tells
  // "online but not in a dungeon" from "not here".
  me.socket.written.length = 0;
  setPresenceLocation(dungeonContext, 0);
  assert.deepEqual(presenceUpdates(me.socket).at(-1), {
    online: true,
    account: 1000000002,
    mapNode: 0,
  });
  world.destroy();

  // He leaves.
  me.socket.written.length = 0;
  friend.socket.destroy();
  await settle();
  assert.deepEqual(presenceUpdates(me.socket).at(-1), {
    online: false,
    account: 1000000002,
    mapNode: 0,
  });
});

/** Nobody hears about somebody they never asked about. */
test("presence is only sent to whoever asked for it", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const watcher = await connect(1000000010);
  const stranger = await connect(1000000011);
  await watch(watcher.socket, watcher.session, [1000000099]);

  watcher.socket.written.length = 0;
  setPresenceLocation(stranger.session, 50002);
  assert.deepEqual(presenceUpdates(watcher.socket), [], "an unwatched account says nothing");
});

/**
 * Two connections on one account is a reconnect racing its own close, and the
 * roll is keyed by the person rather than by the socket so it does not read as
 * having gone offline and come back.
 */
test("a second socket on one account does not report a departure", async (t) => {
  clearPresence();
  t.after(clearPresence);

  const watcher = await connect(1000000020);
  await watch(watcher.socket, watcher.session, [1000000021]);

  const first = await connect(1000000021);
  const second = await connect(1000000021);

  watcher.socket.written.length = 0;
  first.socket.destroy();
  await settle();

  const updates = presenceUpdates(watcher.socket);
  assert.ok(
    updates.every((update) => update.online),
    "the account is still held up by the other socket"
  );
  void second;
});

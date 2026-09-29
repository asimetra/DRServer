import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { config } from "../src/config.js";
import { onConnection } from "../src/socket/index.js";

const fakeSocket = (remoteAddress) => {
  const socket = new EventEmitter();
  socket.remoteAddress = remoteAddress;
  socket.destroyed = false;
  socket.write = () => true;
  socket.pause = () => {};
  socket.resume = () => {};
  socket.end = () => socket.destroy();
  socket.destroy = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    socket.emit("close");
  };
  return socket;
};

test("per-address connection admission is released when a socket closes", () => {
  const previousGlobal = config.maxSocketConnections;
  const previousPerIp = config.maxSocketConnectionsPerIp;
  config.maxSocketConnections = 10;
  config.maxSocketConnectionsPerIp = 1;
  try {
    const firstSocket = fakeSocket("192.0.2.10");
    const first = onConnection(firstSocket);
    assert.ok(first);

    const refusedSocket = fakeSocket("192.0.2.10");
    assert.equal(onConnection(refusedSocket), null);
    assert.equal(refusedSocket.destroyed, true);

    firstSocket.destroy();
    const replacementSocket = fakeSocket("192.0.2.10");
    const replacement = onConnection(replacementSocket);
    assert.ok(replacement, "closing the first socket returns its admission slot");
    replacementSocket.destroy();
  } finally {
    config.maxSocketConnections = previousGlobal;
    config.maxSocketConnectionsPerIp = previousPerIp;
  }
});

test("a connection counts against the limits before its protocol is known", async () => {
  /**
   * A browser's connection used to reach `onConnection` only once its upgrade
   * was answered, so a socket parked halfway through a handshake counted
   * against nothing and one address could hold as many as the process allows.
   */
  const { admitSocket } = await import("../src/socket/index.js");
  const previousGlobal = config.maxSocketConnections;
  const previousPerIp = config.maxSocketConnectionsPerIp;
  config.maxSocketConnections = 10;
  config.maxSocketConnectionsPerIp = 1;
  try {
    const pending = fakeSocket("192.0.2.20");
    assert.equal(admitSocket(pending), true);
    const second = fakeSocket("192.0.2.20");
    assert.equal(admitSocket(second), false, "a second connection from the address is refused");
    assert.equal(second.destroyed, true);

    // Its session, once it has one, is not counted a second time.
    assert.ok(onConnection(pending), "the admitted socket goes on to a session");
    pending.destroy();
    const after = fakeSocket("192.0.2.20");
    assert.equal(admitSocket(after), true, "closing it frees the slot");
    after.destroy();
  } finally {
    config.maxSocketConnections = previousGlobal;
    config.maxSocketConnectionsPerIp = previousPerIp;
  }
});

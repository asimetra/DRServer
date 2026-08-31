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

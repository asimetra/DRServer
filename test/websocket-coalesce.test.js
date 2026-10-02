import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";

import { acceptGameSocket, WebSocketStream } from "../src/socket/websocket.js";

/**
 * Entering a dungeon is a burst: the snapshot replays every object on the floor
 * as its own `session.send()`. On the desktop client those land in one TCP
 * stream and coalesce; on the browser each `WebSocketStream.write()` was its own
 * WebSocket message, so a floor of a few hundred objects arrived as a few
 * hundred `SOCKET_DATA` events, each one a separate trip through the client's
 * read loop. That is the stutter.
 *
 * The server already batches these — `flushOutputBatch` corks the member socket
 * around the burst — but the cork did nothing for a browser, because
 * `WebSocketStream` had no `cork`/`uncork` and the guard that uses them
 * (`typeof socket?.cork === "function"`) simply skipped it.
 *
 * The client reads a stream, not messages: `DcSocket` appends whatever arrived
 * to a persistent buffer and parses packets off it by their two-byte length
 * prefix, rewinding when one is incomplete. So N packets in N frames and the
 * same N packets concatenated in ONE frame reassemble to the identical bytes.
 * These tests pin that a corked burst becomes one frame carrying exactly that
 * concatenation, and that nothing changes when the socket is not corked.
 */

class StubSocket extends EventEmitter {
  constructor() {
    super();
    this.remoteAddress = "127.0.0.1";
    this.destroyed = false;
    this.writableLength = 0;
    this.writeResult = true;
    this.writes = [];
  }

  write(bytes) {
    this.writes.push(Buffer.from(bytes));
    return this.writeResult;
  }

  end() {}
  destroy() { this.destroyed = true; }
  destroySoon() { this.destroyed = true; }
  setTimeout() {}
  pause() {}
  resume() {}
}

/** A game packet as the wire carries it: a two-byte length and that many bytes. */
const packet = (seed, length) => {
  const body = Buffer.alloc(length, seed);
  const framed = Buffer.alloc(2 + length);
  framed.writeUInt16LE(length, 0);
  body.copy(framed, 2);
  return framed;
};

/**
 * The payloads of the binary frames the stub received.
 *
 * These are server frames: unmasked, FIN set. `decodeFrames` is the server's
 * decoder for masked client frames, so the payload is read out by hand — byte 0
 * carries the opcode, byte 1 the length (0x82 is FIN|binary), with a two- or
 * eight-byte extended length above 125.
 */
const binaryPayloads = (socket) => {
  const payloads = [];
  for (const write of socket.writes) {
    if ((write[0] & 0x0f) !== 0x2) continue; // binary opcode only
    let length = write[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      length = write.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      length = Number(write.readBigUInt64BE(2));
      offset = 10;
    }
    payloads.push(write.subarray(offset, offset + length));
  }
  return payloads;
};

test("a corked burst leaves the wire as one binary frame", () => {
  const socket = new StubSocket();
  const stream = new WebSocketStream(socket);
  const packets = [packet(1, 20), packet(2, 300), packet(3, 12)];

  stream.cork();
  for (const p of packets) stream.write(p);
  // Nothing goes out until the cork lifts: that is the whole point.
  assert.equal(socket.writes.length, 0, "corked writes are held, not sent");
  stream.uncork();

  assert.equal(socket.writes.length, 1, "the burst left as a single TCP write");
  const payloads = binaryPayloads(socket);
  assert.equal(payloads.length, 1, "and a single WebSocket binary frame");
  assert.deepEqual(
    payloads[0],
    Buffer.concat(packets),
    "carrying exactly the packets, concatenated, which is what the client reassembles"
  );
});

test("the one frame decodes to the same bytes the client would have reassembled", () => {
  const corked = new StubSocket();
  const loose = new StubSocket();
  const packets = [packet(7, 64), packet(8, 1), packet(9, 500), packet(10, 3)];

  // Corked: one frame.
  const a = new WebSocketStream(corked);
  a.cork();
  for (const p of packets) a.write(p);
  a.uncork();

  // Not corked: a frame each, the old behaviour.
  const b = new WebSocketStream(loose);
  for (const p of packets) b.write(p);

  // What the client's input buffer ends up holding is the concatenation of
  // every binary payload, however it was framed. The two must be identical.
  assert.deepEqual(
    Buffer.concat(binaryPayloads(corked)),
    Buffer.concat(binaryPayloads(loose)),
    "framing is invisible to a stream reader"
  );
  assert.equal(loose.writes.length, packets.length, "uncorked is still one frame per write");
});

test("without a cork, each write is its own frame (unchanged)", () => {
  const socket = new StubSocket();
  const stream = new WebSocketStream(socket);

  stream.write(packet(1, 10));
  stream.write(packet(2, 10));

  assert.equal(socket.writes.length, 2, "two writes, two frames");
});

test("writableLength counts what a cork is holding, so the saturation guard still sees it", () => {
  const socket = new StubSocket();
  socket.writableLength = 100;
  const stream = new WebSocketStream(socket);

  assert.equal(stream.writableLength, 100);
  stream.cork();
  stream.write(packet(1, 40)); // 42 bytes on the wire, length prefix included
  assert.equal(
    stream.writableLength,
    142,
    "pending corked bytes are added to the socket's own backlog"
  );
  stream.uncork();
  // Back to just the socket's figure once the buffer is flushed.
  assert.equal(stream.writableLength, 100);
});

test("nested corks flush only when the last one lifts", () => {
  const socket = new StubSocket();
  const stream = new WebSocketStream(socket);

  stream.cork();
  stream.cork();
  stream.write(packet(1, 8));
  stream.uncork();
  assert.equal(socket.writes.length, 0, "still corked by the outer one");
  stream.uncork();
  assert.equal(socket.writes.length, 1, "flushed when the last cork lifts");
});

test("an uncork with nothing held writes nothing", () => {
  const socket = new StubSocket();
  const stream = new WebSocketStream(socket);

  stream.cork();
  stream.uncork();

  assert.equal(socket.writes.length, 0, "no empty frame");
});

test("a burst still held when the socket dies is dropped, not written", () => {
  const socket = new StubSocket();
  const stream = new WebSocketStream(socket);

  stream.cork();
  stream.write(packet(1, 16));
  socket.destroyed = true;
  stream.uncork();

  assert.equal(socket.writes.length, 0, "nothing is written to a dead socket");
});

/**
 * End to end over a real WebSocket, which is the thing the unit tests stand in
 * for: a real browser client counts `onmessage` events, and the whole point of
 * the fix is that a corked burst is one of them, not two hundred.
 */
test("a real browser receives a corked burst as a single message", async (t) => {
  const PACKETS = 200;
  const server = net.createServer((socket) =>
    acceptGameSocket(socket, (conn) => {
      conn.on("error", () => {});
      conn.on("data", () => {
        // The client's first (and only) packet is its cue to send the burst.
        conn.cork();
        for (let i = 0; i < PACKETS; i += 1) conn.write(packet(i & 0xff, 10));
        conn.uncork();
      });
    })
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let messages = 0;
  let bytes = 0;
  const settled = new Promise((resolve) => {
    socket.onmessage = (event) => {
      messages += 1;
      bytes += event.data.byteLength;
      // Give any further messages a moment to arrive before judging.
      clearTimeout(settled.timer);
      settled.timer = setTimeout(resolve, 100);
    };
  });
  socket.send(new Uint8Array([0x76, 0x00, 0x45, 0x00])); // a valid-looking opener
  await settled;
  socket.close();

  assert.equal(messages, 1, `the 200-packet burst arrived as ${messages} message(s), want 1`);
  assert.equal(bytes, PACKETS * 12, "carrying every packet (10 bytes + 2-byte prefix each)");
});

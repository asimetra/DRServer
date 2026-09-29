import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  acceptGameSocket,
  decodeFrames,
  encodeFrame,
  MAX_CONTROL_FRAMES_PER_WINDOW,
  MAX_FRAME_BYTES,
  WebSocketStream,
} from "../src/socket/websocket.js";
import { serveWebClient } from "../src/web-client.js";

/** A client frame: masked, as RFC 6455 requires of browsers. */
const clientFrame = (opcode, payload, { fin = true, mask = [1, 2, 3, 4] } = {}) => {
  const server = encodeFrame(opcode, payload);
  const headerLength = server.length - payload.length;
  const header = Buffer.from(server.subarray(0, headerLength));
  if (!fin) header[0] &= 0x7f;
  header[1] |= 0x80;
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]));
  return Buffer.concat([header, Buffer.from(mask), masked]);
};

class StubSocket extends EventEmitter {
  constructor() {
    super();
    this.remoteAddress = "127.0.0.1";
    this.destroyed = false;
    this.writableLength = 0;
    this.writeResult = true;
    this.writes = [];
    this.paused = false;
    this.ended = false;
  }

  write(bytes) {
    this.writes.push(bytes);
    return this.writeResult;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  isPaused() {
    return this.paused;
  }

  end() {
    this.ended = true;
  }

  destroy(error) {
    this.destroyed = true;
    this.error = error;
  }

  destroySoon() {
    this.destroyed = true;
  }

  setTimeout() {}
}

test("frames are unmasked, and a stream cut anywhere waits for the rest", () => {
  const one = clientFrame(0x2, Buffer.from([7, 0, 118, 0, 1, 2, 3]));
  const long = clientFrame(0x2, Buffer.alloc(300, 9));
  const both = Buffer.concat([one, long]);
  for (let cut = 0; cut <= both.length; cut += 1) {
    const first = decodeFrames(both.subarray(0, cut));
    const second = decodeFrames(Buffer.concat([first.rest, both.subarray(cut)]));
    const payloads = [...first.frames, ...second.frames].map((frame) => frame.payload);
    assert.deepEqual(payloads, [Buffer.from([7, 0, 118, 0, 1, 2, 3]), Buffer.alloc(300, 9)]);
  }
});

test("an unmasked or oversized client frame ends the connection", () => {
  assert.equal(decodeFrames(encodeFrame(0x2, Buffer.from([1]))).error, 1002);
  const huge = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0]);
  assert.equal(decodeFrames(huge).error, 1009);
  assert.ok(MAX_FRAME_BYTES < 0x200000);
});

test("an incomplete maximum-size frame is copied only when its payload is complete", (t) => {
  const payload = Buffer.alloc(MAX_FRAME_BYTES, 9);
  const frame = clientFrame(0x2, payload);
  const originalConcat = Buffer.concat;
  let concatInputBytes = 0;
  t.mock.method(Buffer, "concat", (chunks, length) => {
    concatInputBytes += chunks.reduce((total, chunk) => total + chunk.length, 0);
    return originalConcat(chunks, length);
  });

  const socket = new StubSocket();
  const stream = new WebSocketStream(socket);
  const received = [];
  stream.on("data", (chunk) => received.push(chunk));
  for (let at = 0; at < frame.length; at += 1024) stream.receive(frame.subarray(at, at + 1024));

  assert.deepEqual(received, [payload]);
  assert.equal(concatInputBytes, 0, "partial prefixes were not repeatedly concatenated");
});

test("a bytewise frame is retained in bounded slabs rather than one Buffer per byte", () => {
  const payload = Buffer.alloc(200_000, 9);
  const frame = clientFrame(0x2, payload);
  const socket = new StubSocket();
  const stream = new WebSocketStream(socket);
  const received = [];
  stream.on("data", (chunk) => received.push(chunk));

  for (let at = 0; at < frame.length - 1; at += 1) {
    stream.receive(frame.subarray(at, at + 1));
  }
  assert.ok(stream.decoder.chunks.length < 64, `${stream.decoder.chunks.length} retained chunks`);

  stream.receive(frame.subarray(-1));
  assert.deepEqual(received, [payload]);
});

test("pong output stops at backpressure and resumes only after drain", () => {
  const socket = new StubSocket();
  socket.writeResult = false;
  const stream = new WebSocketStream(socket);
  const ping = clientFrame(0x9, Buffer.from("ping"));
  stream.receive(Buffer.concat([ping, ping]));

  assert.equal(socket.writes.length, 1, "the second pong was left queued in the decoder");
  assert.equal(socket.paused, true);

  socket.writeResult = true;
  socket.emit("drain");
  assert.equal(socket.writes.length, 2);
  assert.equal(socket.paused, false);
});

test("control drain does not bypass an external session pause", () => {
  const socket = new StubSocket();
  socket.writeResult = false;
  const stream = new WebSocketStream(socket);
  const received = [];
  stream.on("data", (chunk) => received.push(chunk));
  const ping = clientFrame(0x9, Buffer.from("ping"));
  const binary = clientFrame(0x2, Buffer.from("must-wait"));

  stream.receive(Buffer.concat([ping, binary]));
  stream.pause();
  socket.writeResult = true;
  socket.emit("drain");
  assert.deepEqual(received, [], "decoded application bytes stay queued while externally paused");
  assert.equal(socket.paused, true);

  stream.resume();
  assert.deepEqual(received, [Buffer.from("must-wait")]);
  assert.equal(socket.paused, false);
});

test("control frames are rate-limited without treating application backlog as a pong flood", () => {
  const flooding = new StubSocket();
  const stream = new WebSocketStream(flooding);
  const ping = clientFrame(0x9, Buffer.alloc(0));
  stream.receive(Buffer.concat(Array.from({ length: MAX_CONTROL_FRAMES_PER_WINDOW + 1 }, () => ping)));

  const opcodes = flooding.writes.map((frame) => frame[0] & 0x0f);
  assert.equal(opcodes.filter((opcode) => opcode === 0xa).length, MAX_CONTROL_FRAMES_PER_WINDOW);
  assert.equal(opcodes.at(-1), 0x8, "the flood ends with a policy close");
  assert.equal(flooding.ended, true);

  const applicationBacklog = new StubSocket();
  applicationBacklog.writableLength = 4 * 1024 * 1024;
  new WebSocketStream(applicationBacklog).receive(ping);
  assert.deepEqual(applicationBacklog.writes.map((frame) => frame[0] & 0x0f), [0xa]);
  assert.equal(applicationBacklog.ended, false, "a valid ping does not close an otherwise valid connection");
});

const echoServer = async () => {
  const seen = [];
  const server = net.createServer((socket) =>
    acceptGameSocket(socket, (conn) => {
      seen.push(conn);
      conn.on("data", (chunk) => conn.write(Buffer.concat([Buffer.from("echo:"), chunk])));
      conn.on("error", () => {});
    })
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen };
};

test("a desktop client's bytes reach the session untouched", async (t) => {
  const { server, port, seen } = await echoServer();
  t.after(() => server.close());
  const client = net.connect(port, "127.0.0.1");
  const reply = await new Promise((resolve, reject) => {
    client.on("error", reject);
    client.once("data", resolve);
    client.write(Buffer.from([0x76, 0x00, 0x45, 0x00]));
  });
  client.destroy();
  assert.deepEqual(reply, Buffer.concat([Buffer.from("echo:"), Buffer.from([0x76, 0x00, 0x45, 0x00])]));
  assert.ok(seen[0] instanceof net.Socket, "the raw socket itself, not a wrapper");
});

test("a browser's WebSocket reaches the same session, binary both ways", async (t) => {
  const { server, port, seen } = await echoServer();
  t.after(() => server.close());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const reply = await new Promise((resolve) => {
    socket.onmessage = (event) => resolve(Buffer.from(event.data));
    socket.send(new Uint8Array([0x76, 0x00, 0x45, 0x00]));
  });
  assert.deepEqual(reply, Buffer.concat([Buffer.from("echo:"), Buffer.from([0x76, 0x00, 0x45, 0x00])]));
  assert.equal(seen[0].remoteAddress, "127.0.0.1");

  // Text is not the game's protocol: refused with 1003 rather than read.
  const closed = new Promise((resolve) => (socket.onclose = (event) => resolve(event.code)));
  socket.send("hello");
  assert.equal(await closed, 1003);
});

test("the browser client is served from its folder and nothing outside it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-client-"));
  const root = path.join(dir, "bin");
  const linkedRoot = path.join(dir, "current");
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<html>game</html>");
  fs.writeFileSync(path.join(root, "lib", "a.zip"), "PK");
  fs.writeFileSync(path.join(root, "safe.zip"), "SAFE");
  fs.writeFileSync(path.join(dir, "secret.zip"), "NOPE");
  fs.symlinkSync(path.join(root, "safe.zip"), path.join(root, "race.zip"));
  fs.writeFileSync(path.join(dir, "secret.txt"), "no");
  fs.symlinkSync(root, linkedRoot, "dir");
  fs.symlinkSync(path.join(dir, "secret.txt"), path.join(root, "leak.txt"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const server = http.createServer((req, res) =>
    serveWebClient(req, res, new URL(req.url, "http://x").pathname, linkedRoot)
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const redirect = await fetch(`${base}/play`, { redirect: "manual" });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("location"), "/play/");

  const page = await fetch(`${base}/play/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(await page.text(), "<html>game</html>");

  const bundle = await fetch(`${base}/play/lib/a.zip`);
  assert.equal(bundle.headers.get("content-type"), "application/zip");
  assert.equal(await bundle.text(), "PK");

  const head = await fetch(`${base}/play/lib/a.zip`, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "2");

  for (const escape of ["/play/..%2fsecret.txt", "/play/%2e%2e/secret.txt", "/play/lib/..%2f..%2fsecret.txt"]) {
    assert.equal((await fetch(`${base}${escape}`)).status, 404, escape);
  }
  assert.equal((await fetch(`${base}/play/leak.txt`)).status, 404, "an inner symlink cannot escape the root");
  assert.equal((await fetch(`${base}/play/missing.js`)).status, 404);

  const realpath = fs.promises.realpath.bind(fs.promises);
  let swapped = false;
  t.mock.method(fs.promises, "realpath", async (target) => {
    const resolved = await realpath(target);
    if (target === path.join(root, "race.zip") && !swapped) {
      swapped = true;
      fs.unlinkSync(target);
      fs.symlinkSync(path.join(dir, "secret.zip"), target);
    }
    return resolved;
  });
  const raced = await fetch(`${base}/play/race.zip`);
  assert.equal(raced.status, 200);
  assert.equal(await raced.text(), "SAFE", "a symlink swap cannot change the already-validated target");
});

test("the browser client is revalidated rather than downloaded again, and text goes compressed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-client-cache-"));
  const script = "var game = 1;\n".repeat(20000);
  fs.writeFileSync(path.join(dir, "game.js"), script);
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "b.zip"), Buffer.alloc(4096, 7));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const server = http.createServer((req, res) =>
    serveWebClient(req, res, new URL(req.url, "http://x").pathname, dir)
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // fetch() would decompress on its own; http.get shows what went over the wire.
  const get = (route, headers = {}) =>
    new Promise((resolve, reject) =>
      http.get(`${base}${route}`, { headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on("error", reject)
    );

  const first = await get("/play/game.js", { "accept-encoding": "gzip" });
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-encoding"], "gzip");
  assert.ok(first.body.length < script.length / 10, "a script shrinks a great deal");
  assert.equal(zlib.gunzipSync(first.body).toString(), script);
  assert.ok(first.headers.etag, "and carries a validator");

  const again = await get("/play/game.js", { "accept-encoding": "gzip", "if-none-match": first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);

  const plain = await get("/play/game.js");
  assert.equal(plain.headers["content-encoding"], undefined, "not compressed for a client that did not ask");
  assert.equal(plain.body.toString(), script);

  const bundle = await get("/play/lib/b.zip", { "accept-encoding": "gzip" });
  assert.equal(bundle.headers["content-encoding"], undefined, "bundles are images already");
  assert.equal((await get("/play/lib/b.zip", { "if-none-match": bundle.headers.etag })).status, 304);

  fs.writeFileSync(path.join(dir, "game.js"), script + "var changed = 2;\n");
  const changed = await get("/play/game.js", { "if-none-match": first.headers.etag });
  assert.equal(changed.status, 200, "a rebuilt file is sent again");
});

test("players asking for a rebuilt script together share one compression of it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-client-once-"));
  const script = "var shared = 1;\n".repeat(20000);
  const file = path.join(dir, "game.js");
  fs.writeFileSync(file, script);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const readFile = fs.promises.readFile;
  let reads = 0;
  let failNext = true;
  t.mock.method(fs.promises, "readFile", async (target, ...rest) => {
    if (target === file || Number.isInteger(target?.fd)) {
      reads += 1;
      if (failNext) {
        failNext = false;
        throw new Error("read failed");
      }
    }
    return readFile(target, ...rest);
  });

  const server = http.createServer((req, res) =>
    serveWebClient(req, res, new URL(req.url, "http://x").pathname, dir)
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = () =>
    new Promise((resolve, reject) =>
      http.get(`${base}/play/game.js`, { headers: { "accept-encoding": "gzip" }, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }).on("error", reject)
    );

  assert.equal((await get()).status, 404, "a failed compression is not kept");
  reads = 0;
  const answers = await Promise.all(Array.from({ length: 12 }, get));
  assert.equal(reads, 1, "one read and one gzip for all twelve");
  for (const answer of answers) {
    assert.equal(answer.status, 200);
    assert.equal(zlib.gunzipSync(answer.body).toString(), script);
  }
});

/** A handshake written by hand, so it can be cut wherever TCP might cut it. */
const handshake =
  "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

test("a handshake whose first packet is shorter than GET is still a browser", async (t) => {
  /**
   * TCP keeps no write boundaries. The first packet decided the protocol, and
   * "GE" is not "GET ", so a browser whose request arrived in two pieces was
   * read as a desktop client and failed its login.
   */
  for (const cut of [1, 2, 3]) {
    const { server, port, seen } = await echoServer();
    t.after(() => server.close());
    const client = net.connect(port, "127.0.0.1");
    client.setNoDelay(true);
    await new Promise((resolve) => client.once("connect", resolve));
    const reply = new Promise((resolve) => client.once("data", resolve));
    client.write(handshake.slice(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.write(handshake.slice(cut));
    const answer = (await reply).toString("latin1");
    client.destroy();
    assert.match(answer, /^HTTP\/1\.1 101 /, `cut after ${cut} byte(s)`);
    assert.ok(!(seen[0] instanceof net.Socket), "handed over as a WebSocket");
  }
});

test("an upgrade that never finishes is closed at the deadline", async (t) => {
  const server = net.createServer((socket) => acceptGameSocket(socket, () => {}, { timeoutMs: 150 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = net.connect(server.address().port, "127.0.0.1");
  client.on("error", () => {});
  await new Promise((resolve) => client.once("connect", resolve));
  const closed = new Promise((resolve) => client.once("close", resolve));
  client.write("GET / HTTP/1.1\r\n");
  const started = Date.now();
  await closed;
  assert.ok(Date.now() - started < 2000, "the server let go of it");
});

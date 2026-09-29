/**
 * The game socket, for a browser.
 *
 * The browser build of the client is OpenFL's html5 target, whose
 * `flash.net.Socket` is a WebSocket underneath: it opens
 * `ws://<gameSocketAddress>:<gameSocketPort>/` and sends the same DcSocket
 * bytes the desktop client writes to TCP, cut into binary frames wherever it
 * likes. So the browser needs no port or protocol of its own, only this: the
 * game port recognising an HTTP upgrade and unwrapping the frames.
 *
 * Told apart by the first bytes. A desktop client's first packet is its login,
 * a little-endian length and opcode, and can never begin "GET "; a browser's is
 * always its upgrade request. A connection that says nothing is closed after
 * `SNIFF_TIMEOUT_MS`, as the login deadline would have closed it.
 *
 * What the rest of the server gets is `WebSocketStream`, which answers to the
 * part of `net.Socket` that `onConnection` uses: `write` (one binary frame per
 * call, backpressure passed through), `end`, `destroy`, `pause`/`resume`,
 * `setTimeout`, `setKeepAlive`, `writableLength`, `remoteAddress` and the
 * `data`, `drain`, `error`, `timeout` and `close` events. Nothing above it can
 * tell a browser from a desktop client.
 *
 * RFC 6455, server side: client frames must be masked; text frames are refused
 * (the game never sends text); pings are answered; a close is answered and the
 * connection ended. There is no subprotocol and no extension (compression is
 * not offered, so none is negotiated). Origin is not checked: nothing here is
 * authorised by a cookie a hostile page could borrow — the login packet carries
 * the account's token, as it does over TCP.
 */
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { warn } from "../log.js";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const SNIFF_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 8192;
/** Far above anything the game sends (a login is ~110 bytes); a bound on what one frame can make us hold. */
export const MAX_FRAME_BYTES = 1 << 20;
export const MAX_CONTROL_FRAMES_PER_WINDOW = 64;
export const CONTROL_FRAME_WINDOW_MS = 10_000;
/** Small reads are copied once into slabs instead of retained as one Buffer object each. */
const DECODER_SLAB_BYTES = 4 * 1024;

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
const CLOSE = { normal: 1000, protocolError: 1002, unsupportedData: 1003, policyViolation: 1008, tooBig: 1009 };

export const looksLikeHttpUpgrade = (chunk) =>
  chunk.length >= 4 && chunk.toString("latin1", 0, 4) === "GET ";

export const acceptKeyFor = (key) =>
  crypto.createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");

/** One unmasked server frame, FIN set. */
export const encodeFrame = (opcode, payload = Buffer.alloc(0)) => {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
};

const closePayload = (code) => {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
};

/**
 * An offset queue for TCP chunks. Incomplete frames stay as their original
 * chunks; only a completed payload is copied, once, so a frame arriving in
 * many small reads remains O(n) rather than repeatedly copying its prefix.
 */
class FrameDecoder {
  constructor() {
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.length = 0;
  }

  push(chunk) {
    if (!chunk.length) return;
    this.length += chunk.length;
    if (chunk.length >= DECODER_SLAB_BYTES) {
      this.chunks.push({ buffer: chunk, length: chunk.length, owned: false });
      return;
    }

    let sourceOffset = 0;
    while (sourceOffset < chunk.length) {
      let tail = this.chunks.at(-1);
      if (!tail?.owned || tail.length === tail.buffer.length) {
        tail = { buffer: Buffer.allocUnsafe(DECODER_SLAB_BYTES), length: 0, owned: true };
        this.chunks.push(tail);
      }
      const take = Math.min(chunk.length - sourceOffset, tail.buffer.length - tail.length);
      chunk.copy(tail.buffer, tail.length, sourceOffset, sourceOffset + take);
      tail.length += take;
      sourceOffset += take;
    }
  }

  peek(length) {
    if (this.length < length) return null;
    const first = this.chunks[this.head];
    if (first.length - this.offset >= length) {
      return first.buffer.subarray(this.offset, this.offset + length);
    }
    const result = Buffer.allocUnsafe(length);
    let chunkIndex = this.head;
    let chunkOffset = this.offset;
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[chunkIndex];
      const take = Math.min(length - written, chunk.length - chunkOffset);
      chunk.buffer.copy(result, written, chunkOffset, chunkOffset + take);
      written += take;
      chunkIndex += 1;
      chunkOffset = 0;
    }
    return result;
  }

  read(length) {
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.head];
      const take = Math.min(length - written, chunk.length - this.offset);
      chunk.buffer.copy(result, written, this.offset, this.offset + take);
      written += take;
      this.offset += take;
      this.length -= take;
      if (this.offset === chunk.length) {
        this.head += 1;
        this.offset = 0;
      }
    }
    this.compact();
    return result;
  }

  discard(length) {
    let left = length;
    while (left > 0) {
      const chunk = this.chunks[this.head];
      const take = Math.min(left, chunk.length - this.offset);
      left -= take;
      this.offset += take;
      this.length -= take;
      if (this.offset === chunk.length) {
        this.head += 1;
        this.offset = 0;
      }
    }
    this.compact();
  }

  compact() {
    if (this.head === this.chunks.length) {
      this.chunks = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  remaining() {
    if (this.length === 0) return Buffer.alloc(0);
    const result = Buffer.allocUnsafe(this.length);
    let written = 0;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      const from = index === this.head ? this.offset : 0;
      chunk.buffer.copy(result, written, from, chunk.length);
      written += chunk.length - from;
    }
    return result;
  }

  next() {
    const start = this.peek(2);
    if (!start) return null;
    const first = start[0];
    const second = start[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if ((first & 0x70) !== 0 || !masked) return { error: CLOSE.protocolError };

    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      const header = this.peek(4);
      if (!header) return null;
      length = header.readUInt16BE(2);
      headerLength = 4;
    } else if (length === 127) {
      const header = this.peek(10);
      if (!header) return null;
      const long = header.readBigUInt64BE(2);
      if (long > BigInt(MAX_FRAME_BYTES)) return { error: CLOSE.tooBig };
      length = Number(long);
      headerLength = 10;
    }
    if (length > MAX_FRAME_BYTES) return { error: CLOSE.tooBig };
    if (opcode >= 0x8 && (!fin || length > 125)) return { error: CLOSE.protocolError };
    if (this.length < headerLength + 4 + length) return null;

    this.discard(headerLength);
    const mask = this.read(4);
    const payload = this.read(length);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    return { frame: { fin, opcode, payload } };
  }
}

/**
 * Reads whole frames off the front of `buffer`.
 * Returns `{ frames, rest }`, or `{ error: closeCode }` for a stream that
 * cannot be read further.
 */
export const decodeFrames = (buffer) => {
  const decoder = new FrameDecoder();
  const frames = [];
  decoder.push(buffer);
  while (true) {
    const decoded = decoder.next();
    if (!decoded) return { frames, rest: decoder.remaining() };
    if (decoded.error) return { error: decoded.error };
    frames.push(decoded.frame);
  }
};

/** A browser's connection, shaped like the `net.Socket` the session code expects. */
export class WebSocketStream extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.remoteAddress = socket.remoteAddress;
    this.decoder = new FrameDecoder();
    this.closing = false;
    this.messageIsBinary = false;
    this.controlBackpressured = false;
    this.externallyPaused = false;
    this.controlWindowStartedAt = Date.now();
    this.controlFrames = 0;
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("drain", () => {
      this.emit("drain");
      if (!this.controlBackpressured || this.closing) return;
      this.controlBackpressured = false;
      if (this.externallyPaused) return;
      this.drainFrames();
      if (!this.controlBackpressured && !this.externallyPaused && !this.socket.destroyed) this.socket.resume();
    });
    socket.on("error", (err) => this.emit("error", err));
    socket.on("timeout", () => this.emit("timeout"));
    socket.on("close", () => this.emit("close"));
  }

  get destroyed() {
    return this.socket.destroyed;
  }

  get writableLength() {
    return this.socket.writableLength;
  }

  receive(chunk) {
    if (this.closing || this.socket.destroyed) return;
    this.decoder.push(chunk);
    this.drainFrames();
  }

  drainFrames() {
    while (
      !this.controlBackpressured &&
      !this.externallyPaused &&
      !this.closing &&
      !this.socket.destroyed
    ) {
      const decoded = this.decoder.next();
      if (!decoded) return;
      if (decoded.error) {
        this.fail(decoded.error);
        return;
      }
      const { opcode, payload } = decoded.frame;
      switch (opcode) {
        case OP.binary:
          this.messageIsBinary = true;
          if (payload.length) this.emit("data", payload);
          break;
        case OP.continuation:
          if (!this.messageIsBinary) {
            this.fail(CLOSE.protocolError);
            return;
          }
          if (payload.length) this.emit("data", payload);
          break;
        case OP.text:
          this.fail(CLOSE.unsupportedData);
          return;
        case OP.ping:
          if (!this.allowControlFrame()) return;
          if (!this.writePong(payload)) return;
          break;
        case OP.pong:
          if (!this.allowControlFrame()) return;
          break;
        case OP.close:
          this.end();
          return;
        default:
          this.fail(CLOSE.protocolError);
          return;
      }
    }
  }

  allowControlFrame(now = Date.now()) {
    if (now - this.controlWindowStartedAt >= CONTROL_FRAME_WINDOW_MS) {
      this.controlWindowStartedAt = now;
      this.controlFrames = 0;
    }
    this.controlFrames += 1;
    if (this.controlFrames <= MAX_CONTROL_FRAMES_PER_WINDOW) return true;
    this.fail(CLOSE.policyViolation);
    return false;
  }

  writePong(payload) {
    const pong = encodeFrame(OP.pong, payload);
    if (!this.socket.write(pong)) {
      this.controlBackpressured = true;
      this.socket.pause();
      return false;
    }
    return true;
  }

  fail(code) {
    warn(`websocket from ${this.remoteAddress} closed: ${code}`);
    this.sendClose(code);
    this.socket.end();
    this.socket.destroySoon?.();
  }

  sendClose(code) {
    if (this.closing || this.socket.destroyed) return;
    this.closing = true;
    this.socket.write(encodeFrame(OP.close, closePayload(code)));
  }

  write(bytes, callback) {
    if (this.closing || this.socket.destroyed) return false;
    return this.socket.write(encodeFrame(OP.binary, bytes), callback);
  }

  end() {
    this.sendClose(CLOSE.normal);
    this.socket.end();
    return this;
  }

  destroy(error) {
    this.socket.destroy(error);
    return this;
  }

  pause() {
    this.externallyPaused = true;
    this.socket.pause();
    return this;
  }

  resume() {
    this.externallyPaused = false;
    if (!this.controlBackpressured) {
      this.drainFrames();
      if (!this.controlBackpressured && !this.closing && !this.socket.destroyed) {
        this.socket.resume();
      }
    }
    return this;
  }

  isPaused() {
    return this.socket.isPaused();
  }

  setTimeout(ms) {
    this.socket.setTimeout(ms);
    return this;
  }

  setKeepAlive(enable, delay) {
    this.socket.setKeepAlive?.(enable, delay);
    return this;
  }
}

/** The request line and headers of an upgrade, or null if it is not one we answer. */
const parseUpgrade = (head) => {
  const [requestLine, ...lines] = head.split("\r\n");
  if (!/^GET \S+ HTTP\/1\.1$/.test(requestLine)) return null;
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const upgrade = /\bwebsocket\b/i.test(headers.upgrade ?? "");
  const connection = /\bupgrade\b/i.test(headers.connection ?? "");
  const key = headers["sec-websocket-key"];
  if (!upgrade || !connection || !key || headers["sec-websocket-version"] !== "13") return null;
  return { key };
};

const upgrade = (socket, first, onConnection) => {
  let head = first;
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    tryHandshake();
  };
  const tryHandshake = () => {
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > MAX_HANDSHAKE_BYTES) socket.destroy();
      else if (head === first) socket.on("data", onData);
      return;
    }
    socket.removeListener("data", onData);
    const request = parseUpgrade(head.toString("latin1", 0, end));
    if (!request) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKeyFor(request.key)}\r\n\r\n`
    );
    const stream = new WebSocketStream(socket);
    onConnection(stream);
    const early = head.subarray(end + 4);
    if (early.length && !socket.destroyed) stream.receive(early);
  };
  tryHandshake();
};

/**
 * Hands a new connection on: to `onConnection` as it is, or wrapped as a
 * `WebSocketStream` once a browser's upgrade has been answered.
 *
 * Two things a connection could do to it, both measured in review. It could
 * send its first bytes in pieces: TCP keeps no write boundaries, and deciding on
 * the first packet read a browser whose request arrived as "GE" then the rest as
 * a desktop client. So bytes that could still be the start of "GET " are held
 * until they cannot. And it could stop halfway through an upgrade: the deadline
 * used to be lifted as soon as the request began, and a handshake that never
 * finished held its socket for good. So the deadline stands until the upgrade is
 * answered or the bytes are handed to a session.
 */
export const acceptGameSocket = (socket, onConnection, { timeoutMs = SNIFF_TIMEOUT_MS } = {}) => {
  // Nobody else is listening yet, and an unheard "error" takes the process down.
  const early = (err) => warn(`game socket from ${socket.remoteAddress} before login: ${err.message}`);
  socket.on("error", early);
  const silent = () => socket.destroy();
  socket.setTimeout(timeoutMs);
  socket.once("timeout", silent);
  const decided = () => {
    socket.removeListener("timeout", silent);
    socket.setTimeout(0);
    socket.removeListener("error", early);
  };

  let head = Buffer.alloc(0);
  const onFirst = (chunk) => {
    head = head.length ? Buffer.concat([head, chunk]) : chunk;
    // "G", "GE" and "GET" are not a decision yet.
    if (head.length < 4 && "GET ".startsWith(head.toString("latin1"))) return;
    socket.removeListener("data", onFirst);

    if (looksLikeHttpUpgrade(head)) {
      upgrade(socket, head, (stream) => {
        decided();
        onConnection(stream);
      });
      return;
    }
    decided();
    // Put back and handed over paused, so the session's own reader sees it first.
    socket.pause();
    socket.unshift(head);
    onConnection(socket);
    if (!socket.destroyed) socket.resume();
  };
  socket.on("data", onFirst);
};

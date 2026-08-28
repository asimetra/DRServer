/**
 * Wire primitives for the DcSocket protocol.
 *
 * Everything is little-endian (DcSocket sets `endian = "littleEndian"`), and
 * strings are OpenFL `writeUTF`: a little-endian u16 byte count followed by
 * UTF-8 bytes. Packets are framed as a u16 length — excluding the prefix
 * itself — followed by that many bytes, the first two of which are the opcode.
 */

export class PacketWriter {
  constructor(opcode) {
    this.chunks = [];
    if (opcode !== undefined) this.u16(opcode);
  }

  u16(value) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value >>> 0, 0);
    this.chunks.push(buf);
    return this;
  }

  i16(value) {
    const buf = Buffer.alloc(2);
    buf.writeInt16LE(value, 0);
    this.chunks.push(buf);
    return this;
  }

  u8(value) {
    this.chunks.push(Buffer.from([value & 0xff]));
    return this;
  }

  u32(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0, 0);
    this.chunks.push(buf);
    return this;
  }

  i32(value) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(value, 0);
    this.chunks.push(buf);
    return this;
  }

  f32(value) {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(value, 0);
    this.chunks.push(buf);
    return this;
  }

  utf(text) {
    const bytes = Buffer.from(String(text), "utf8");
    if (bytes.length > 65535) throw new RangeError("UTF string too long");
    this.u16(bytes.length);
    this.chunks.push(bytes);
    return this;
  }

  raw(buffer) {
    this.chunks.push(buffer);
    return this;
  }

  /** Body without the length prefix. */
  body() {
    return Buffer.concat(this.chunks);
  }

  /** Length-prefixed frame, ready to write to the socket. */
  frame() {
    const body = this.body();
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16LE(body.length, 0);
    return Buffer.concat([prefix, body]);
  }
}

/**
 * A read that ran off the end of the packet.
 *
 * Its own type, because the caller must be able to tell it apart from a bug in
 * a handler. A frame that is well formed at the length prefix but does not
 * carry the payload its opcode requires is a deterministic protocol fault —
 * there is nothing to interpret and nothing to log per occurrence. Anything
 * else that throws is ours.
 */
export class MalformedPacketError extends Error {
  constructor(needed, remaining) {
    super(`read ${needed} bytes with ${remaining} left`);
    this.name = "MalformedPacketError";
  }
}

export class PacketReader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  /** Every read goes through this, so no read can run off the end silently. */
  take(bytes) {
    if (this.remaining < bytes) throw new MalformedPacketError(bytes, this.remaining);
    const at = this.pos;
    this.pos += bytes;
    return at;
  }

  get remaining() {
    return this.buf.length - this.pos;
  }

  eof() {
    return this.pos >= this.buf.length;
  }

  u8() {
    return this.buf.readUInt8(this.take(1));
  }

  u16() {
    return this.buf.readUInt16LE(this.take(2));
  }

  u32() {
    return this.buf.readUInt32LE(this.take(4));
  }

  f32() {
    return this.buf.readFloatLE(this.take(4));
  }

  i32() {
    return this.buf.readInt32LE(this.take(4));
  }

  utf() {
    const length = this.u16();
    const at = this.take(length);
    return this.buf.toString("utf8", at, at + length);
  }

  rest() {
    return this.buf.subarray(this.pos);
  }
}

/**
 * Pulls complete frames out of an accumulating buffer.
 * Returns the packet bodies found and whatever bytes are left over.
 */
/**
 * A frame carries at least an opcode, so a declared length below two bytes is
 * not a short frame — it is a length this stream cannot contain.
 *
 * Reading past one is guesswork: there is no way to tell where the next real
 * frame begins, so everything after it is invented. Sixty-four kilobytes of
 * zeroes drained as 32768 frames of nothing, each of which reached the packet
 * handler, threw on an empty read, and wrote a caught error with a stack.
 */
const MIN_FRAME_BYTES = 2;

/**
 * And at most this many out of one read.
 *
 * Rejecting zero-length frames closed the 32768-frames-of-nothing case, but a
 * valid two-byte body carrying only an opcode is the same work by another
 * route: 64 KiB of them drains as 16384 packets, all materialised before
 * anything looks at how many there are.
 *
 * Whatever is left stays in the buffer for the next turn of the loop, which is
 * what the caller's pause and queue ceiling are for. Honest play peaks at 144
 * packets in a whole second, so this is never reached by a real client.
 */
const MAX_FRAMES_PER_DRAIN = 512;

export const drainFrames = (buffer) => {
  const packets = [];
  let offset = 0;
  let malformed = false;

  while (buffer.length - offset >= 2 && packets.length < MAX_FRAMES_PER_DRAIN) {
    const length = buffer.readUInt16LE(offset);
    if (length < MIN_FRAME_BYTES) {
      malformed = true;
      break;
    }
    if (buffer.length - offset - 2 < length) break;
    packets.push(buffer.subarray(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }

  return { packets, rest: buffer.subarray(offset), malformed };
};

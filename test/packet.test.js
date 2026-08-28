import assert from "node:assert/strict";
import test from "node:test";

import { PacketReader, PacketWriter, drainFrames } from "../src/socket/packet.js";

test("packet primitives round-trip in little-endian order", () => {
  const body = new PacketWriter(0x1234)
    .u8(0xfe)
    .u16(0xabcd)
    .i16(-123)
    .u32(0x89abcdef)
    .i32(-456789)
    .f32(12.5)
    .utf("Dungeon ✓")
    .body();

  const reader = new PacketReader(body);
  assert.equal(reader.u16(), 0x1234);
  assert.equal(reader.u8(), 0xfe);
  assert.equal(reader.u16(), 0xabcd);
  assert.equal(reader.buf.readInt16LE(reader.pos), -123);
  reader.pos += 2;
  assert.equal(reader.u32(), 0x89abcdef);
  assert.equal(reader.buf.readInt32LE(reader.pos), -456789);
  reader.pos += 4;
  assert.equal(reader.f32(), 12.5);
  assert.equal(reader.utf(), "Dungeon ✓");
  assert.equal(reader.eof(), true);
});

test("drainFrames keeps a partial frame for the next socket chunk", () => {
  const firstFrame = new PacketWriter(52).utf("heartbeat").frame();
  const secondFrame = new PacketWriter(118).u32(42).frame();
  const splitAt = 4;

  const firstDrain = drainFrames(
    Buffer.concat([firstFrame, secondFrame.subarray(0, splitAt)])
  );
  assert.equal(firstDrain.packets.length, 1);
  assert.deepEqual(firstDrain.packets[0], firstFrame.subarray(2));
  assert.deepEqual(firstDrain.rest, secondFrame.subarray(0, splitAt));

  const secondDrain = drainFrames(
    Buffer.concat([firstDrain.rest, secondFrame.subarray(splitAt)])
  );
  assert.equal(secondDrain.packets.length, 1);
  assert.deepEqual(secondDrain.packets[0], secondFrame.subarray(2));
  assert.equal(secondDrain.rest.length, 0);
});

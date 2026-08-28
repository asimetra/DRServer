import assert from "node:assert/strict";
import test from "node:test";

import { decode, kindOf, mapNodeOf } from "../tools/capture-lib.js";
import { buildEntryResponse } from "../src/socket/matchmaker.js";
import { playerGenerate, playerOwnerGenerate } from "../src/socket/objects.js";
import { PacketWriter } from "../src/socket/packet.js";
import { OP } from "../src/socket/opcodes.js";

const rowFor = (frame, metadata = {}) => ({
  ts: "2026-08-22T00:00:00.000",
  dir: "in",
  len: frame.length - 2,
  hex: frame.subarray(2).toString("hex"),
  ...metadata,
});

test("capture decoding preserves owner and remote player perspectives", () => {
  const owner = decode(rowFor(playerOwnerGenerate({
    doid: 1001,
    zone: 10,
    screenName: "Owner",
    basicCurrency: 5,
  }), { session: 7, account: 42, match: 9, seq: 3, elapsed_ms: 12 }));
  const remote = decode(rowFor(playerGenerate({
    doid: 1002,
    parent: 500,
    zone: 10,
    screenName: "Remote",
  })));

  assert.equal(owner.clidName, "PlayerGameObjectOwner");
  assert.equal(remote.clidName, "PlayerGameObject");
  assert.notEqual(kindOf(owner), kindOf(remote));
  assert.deepEqual(
    [owner.session, owner.account, owner.match, owner.seq, owner.elapsedMs],
    [7, 42, 9, 3, 12]
  );
});

test("friend joins learn their map node from successful response field 297", () => {
  const response = decode(rowFor(buildEntryResponse(900, 0, 50082)));
  assert.equal(mapNodeOf(response), 50082);

  const refused = decode(rowFor(buildEntryResponse(900, 500, 0)));
  assert.equal(mapNodeOf(refused), null);

  const request = new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(900)
    .u16(296)
    .utf("{}")
    .u32(0)
    .u32(50047)
    .body();
  assert.equal(mapNodeOf(decode({ dir: "out", len: request.length, hex: request.toString("hex") })), 50047);
});

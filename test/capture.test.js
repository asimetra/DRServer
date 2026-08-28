import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCaptureRecorder, withoutCredentials } from "../src/socket/capture.js";
import { PacketWriter } from "../src/socket/packet.js";
import { OP } from "../src/socket/opcodes.js";

/**
 * A capture is a debugging artefact — copied into scratch directories, attached
 * to reports, read by whoever is chasing a bug. The login packet puts a session
 * token into it as plainly readable text: it is the first line of every
 * official recording, sitting next to the account id.
 *
 * The length is kept and the bytes are not, so every offset after it still
 * lines up and the decoder reads the frame exactly as it did.
 */
test("a capture keeps the login packet's shape and not its credential", () => {
  const token = "1786742092:aefe553a77ffda00f9ff6dddadfff90e";
  const login = new PacketWriter(OP.CLIENT_LOGIN_DUNGEONBUSTER)
    .utf(token)
    .utf("1.0.0")
    .u32(1351928210)
    .body();

  const safe = withoutCredentials(login);
  assert.equal(safe.length, login.length, "every offset after it still lines up");
  assert.ok(!safe.toString("latin1").includes(token), "the token is gone");
  assert.equal(safe.readUInt16LE(0), OP.CLIENT_LOGIN_DUNGEONBUSTER, "it is still a login");
  assert.equal(safe.readUInt16LE(2), token.length, "and still claims its own length");
  // What follows the credential is untouched, so a decoder reads the rest.
  assert.equal(
    safe.readUInt32LE(4 + token.length + 2 + 5),
    1351928210,
    "the dc hash after it survives"
  );

  // Nothing else carries one, so nothing else is touched.
  const other = new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(7).u16(147).body();
  assert.deepEqual(withoutCredentials(other), other, "only the login is masked");
});

test("multiplayer capture keeps one official-shaped file per client perspective", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dr-capture-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const at = new Date("2026-08-22T12:34:56.789Z");
  const recorder = createCaptureRecorder({ directory, clock: () => at, monotonic: () => 500 });
  const host = { id: 7, accountId: 1001, dungeonMatch: { id: 42 } };
  const joiner = { id: 8, accountId: 1002, dungeonMatch: { id: 42 } };
  const frame = new PacketWriter(OP.CLIENT_HEART_BEAT).utf("1").frame();

  recorder.recordSent(host, frame);
  recorder.recordSent(joiner, frame);
  const files = await Promise.all([recorder.close(host), recorder.close(joiner)]);

  assert.equal(new Set(files).size, 2, "owner and remote perspectives never interleave");
  const rows = await Promise.all(
    files.map(async (file) => JSON.parse((await fs.readFile(file, "utf8")).trim()))
  );
  assert.deepEqual(rows.map(({ session }) => session).sort(), [7, 8]);
  assert.deepEqual(rows.map(({ account }) => account).sort(), [1001, 1002]);
  assert.deepEqual(rows.map(({ match }) => match), [42, 42]);
  assert.deepEqual(rows.map(({ seq }) => seq), [1, 1]);
  assert.deepEqual(rows.map(({ elapsed_ms }) => elapsed_ms), [0, 0]);
  assert.ok(rows.every(({ dir, op, len, hex }) =>
    dir === "in" && op === OP.CLIENT_HEART_BEAT && len > 0 && hex.startsWith("3400")
  ));
  const manifest = (await fs.readFile(recorder.manifestFile, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(manifest.length, 2);
  assert.deepEqual(manifest.map(({ session }) => session).sort(), [7, 8]);
  assert.ok(manifest.every(({ matches, packets }) => matches[0] === 42 && packets === 1));
});

import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { truncate } from "../src/log.js";

const limit = config.logBodyLimit;

/**
 * The bug this file exists for.
 *
 * `truncate` bounded strings and handed everything else to `String()`, which
 * is the one case where bounding matters most: `/content/*` answers with a
 * Buffer, and the game-master table is four megabytes of it. Every client asks
 * for that file on login, so every login pushed four megabytes of JSON through
 * the terminal — the server looked like it had lost its mind and then, when the
 * response ended, went back to normal.
 */
test("a Buffer body is bounded like a string one", () => {
  const body = Buffer.from("x".repeat(limit * 10));
  const shown = truncate(body);

  assert.ok(shown.length < limit * 2, `bounded, got ${shown.length} characters`);
  assert.match(shown, /… \(6000 bytes\)$/, "and says how much was left out");
});

test("a short Buffer is shown whole", () => {
  assert.equal(truncate(Buffer.from("hello")), "hello");
});

/**
 * Content responses can be gzipped, and printing compressed bytes as text puts
 * control characters into somebody's terminal. Size is the only useful thing to
 * say about them.
 */
test("a binary body is described rather than printed", () => {
  const gzipMagic = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(truncate(gzipMagic), "<8 bytes>");
});

test("strings are still bounded as before", () => {
  assert.equal(truncate("short"), "short");
  const long = "y".repeat(limit + 50);
  assert.ok(truncate(long).length < long.length);
  assert.match(truncate(long), /… \(\d+ bytes\)$/);
});

test("a non-string, non-Buffer value still logs something", () => {
  assert.equal(truncate(404), "404");
  assert.equal(truncate(null), "null");
});

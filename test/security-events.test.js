import test from "node:test";
import assert from "node:assert/strict";

import { RULE, flushViolations, noteViolation } from "../src/socket/security-events.js";

/**
 * Every check writes a line per occurrence, and the occurrences are not paced
 * by anything this server controls: a refused proposal vector can carry eight
 * results, and a client that has decided to keep sending them does so as fast
 * as its socket allows.
 *
 * So the log — the one place an operator would look to decide whether a flag is
 * safe to turn on — was the first thing a determined client could drown, and
 * the loudest rule would bury the rest.
 */
test("a rule says the first at once, then counts", () => {
  const lines = [];
  const session = { id: 1, violations: undefined };
  const at = 5_000_000;

  // The first of a kind is the interesting one and is said immediately.
  assert.equal(noteViolation(session, RULE.noCast, "AXE_COMBO_1", at), true, "the first speaks");

  // A thousand more inside the window say nothing at all.
  for (let i = 0; i < 1000; i++) {
    assert.equal(noteViolation(session, RULE.noCast, "AXE_COMBO_1", at + i), false);
  }
  assert.equal(session.violations.get(RULE.noCast).count, 1001, "but every one is counted");

  // The next one after the window closes reports the batch and starts again.
  assert.equal(noteViolation(session, RULE.noCast, "AXE_COMBO_1", at + 20_000), true, "then it sums up");
  assert.equal(session.violations.get(RULE.noCast).count, 0, "and starts counting afresh");

  // Rules do not share a bucket, so a loud one cannot hide a quiet one.
  assert.equal(
    noteViolation(session, RULE.forgedAttacker, "doid 600", at + 20_000),
    true,
    "a different rule is heard on its own"
  );

  void lines;
});

/** A session that ends mid-window would otherwise take its tail with it. */
test("what a rule was still counting goes out with the session", () => {
  const session = { id: 2 };
  const at = 6_000_000;

  noteViolation(session, RULE.outOfReach, "first", at);
  for (let i = 0; i < 40; i++) noteViolation(session, RULE.outOfReach, "more", at + i);
  assert.equal(session.violations.get(RULE.outOfReach).count, 41);

  flushViolations(session, at + 3000);
  assert.equal(session.violations.size, 0, "nothing is left counting");
});

/**
 * A ten-second window rather than a one-second one, for the same reason the
 * speed rule uses one: a connection that stalls delivers its backlog in a
 * burst, and a one-second view cannot tell that from abuse.
 *
 * Honest play peaks at 144 packets a second measured over one second, 101 over
 * five and 78 over ten. The bound is three times the last of those, so a real
 * burst passes and a client that keeps it up does not.
 */

test("sustained traffic is reported and a burst is not", async () => {
  const { noteTraffic } = await import("../src/socket/security-events.js");
  const at = 7_000_000;

  // The worst honest second on record, then quiet: 144 in one second is well
  // under 240 a second averaged over the window.
  const bursty = { id: 3 };
  noteTraffic(bursty, 144, at);
  assert.equal(noteTraffic(bursty, 10, at + 10_000), false, "a burst inside a quiet window passes");

  // Three thousand over ten seconds is 300 a second, sustained.
  const flooding = { id: 4 };
  noteTraffic(flooding, 3000, at);
  assert.equal(noteTraffic(flooding, 1, at + 10_000), true, "keeping it up is reported");

  // And the window starts again, so one bad stretch is not permanent.
  assert.equal(noteTraffic(flooding, 10, at + 20_000), false, "then it is judged afresh");
});

/**
 * A frame carries at least an opcode, so a declared length below two bytes is
 * not a short frame — it is a length this stream cannot contain, and there is
 * no way to tell where the next real one begins.
 *
 * Sixty-four kilobytes of zeroes drained as 32768 frames of nothing, each of
 * which reached the packet handler, threw on an empty read, and wrote a caught
 * error with a stack.
 */
test("a length that cannot be a frame stops the stream", async () => {
  const { drainFrames } = await import("../src/socket/packet.js");
  const { PacketWriter } = await import("../src/socket/packet.js");
  const { OP } = await import("../src/socket/opcodes.js");

  const flood = drainFrames(Buffer.alloc(65536));
  assert.equal(flood.packets.length, 0, "no frames are invented from zeroes");
  assert.equal(flood.malformed, true, "and the stream is reported unreadable");

  // A real frame still drains, and a good one before a bad one is kept.
  const good = new PacketWriter(OP.CLIENT_HEART_BEAT).utf("1").frame();
  const mixed = drainFrames(Buffer.concat([good, Buffer.alloc(8)]));
  assert.equal(mixed.packets.length, 1, "what was readable is read");
  assert.equal(mixed.malformed, true, "and then it stops");

  // An incomplete tail is not malformed, it is simply not here yet.
  const partial = drainFrames(good.subarray(0, good.length - 2));
  assert.equal(partial.malformed, false, "a half-arrived frame waits");
  assert.ok(partial.rest.length > 0, "and is kept for the next chunk");
});

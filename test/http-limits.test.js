import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MAX_BODY_BYTES, readBody, withinRate, resetRates } from "../src/http.js";

/**
 * What one client actually asks for, so a limit can be set against it rather
 * than guessed at.
 *
 * Measured over 1872 recorded requests: the median body is 154 bytes and the
 * largest any of them ever sent is 775 — `getAllMapnodeScores`. The 75KB
 * payloads in the same recordings are this server's own answers, which these
 * limits have nothing to do with. The busiest second held 20 requests and the
 * busiest ten seconds held 64.
 *
 * The body mattered more than the rate: it was read before routing, so before
 * anything asked who was calling, and nothing bounded it. One unauthenticated
 * client could hold as much of this server's memory as it cared to send.
 */

const chunked = (...chunks) => {
  const request = new EventEmitter();
  request.destroy = () => request.emit("aborted");
  queueMicrotask(() => {
    for (const chunk of chunks) request.emit("data", Buffer.from(chunk));
    request.emit("end");
  });
  return request;
};

test("a body the size the client really sends is read", async () => {
  const body = "x".repeat(775);
  assert.equal(await readBody(chunked(body)), body);
});

test("a body past the limit is refused rather than collected", async () => {
  const oversized = chunked("x".repeat(MAX_BODY_BYTES), "x".repeat(1024));
  await assert.rejects(() => readBody(oversized), /too large/i);
});

test("an aborted upload releases its partial body without waiting for end", async () => {
  const request = new EventEmitter();
  const reading = readBody(request);
  request.emit("data", Buffer.from("partial secret-bearing request"));
  request.emit("aborted");
  await assert.rejects(reading, /aborted/i);
});

test("the limit leaves room the recordings never needed", () => {
  assert.ok(MAX_BODY_BYTES >= 775 * 20, "generous against the largest real request");
  assert.ok(MAX_BODY_BYTES <= 1024 * 1024, "and still a bound worth having");
});

test("a normal playing rate is never limited", () => {
  resetRates();
  // Twenty in a second was the busiest the recordings ever got.
  for (let i = 0; i < 20; i++) {
    assert.equal(withinRate("10.0.0.1"), true, `request ${i + 1} of a busy second`);
  }
});

test("several players behind one address still play", () => {
  resetRates();
  // Five clients at the busiest ten seconds each recorded: 5 × 64.
  for (let i = 0; i < 320; i++) {
    assert.equal(withinRate("10.0.0.2"), true, `request ${i + 1} from a shared address`);
  }
});

test("a flood from one address is cut off", () => {
  resetRates();
  let allowed = 0;
  for (let i = 0; i < 5000; i++) if (withinRate("10.0.0.3")) allowed += 1;
  assert.ok(allowed < 5000, "not everything is served");
  assert.ok(allowed >= 320, "but not before a real client would have finished");
});

test("one address flooding does not lock out another", () => {
  resetRates();
  for (let i = 0; i < 5000; i++) withinRate("10.0.0.4");
  assert.equal(withinRate("10.0.0.5"), true, "somebody else is unaffected");
});

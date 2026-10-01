import assert from "node:assert/strict";
import test from "node:test";

import { diskWarning, tokenWarning, workerWarning, loopWarning } from "../src/health-warnings.js";

const GB = 1024 ** 3;

test("a disk is worth mentioning when little of it is left, by share or by size", () => {
  const disk = (freeBytes, totalBytes) => diskWarning("/srv/data", { freeBytes, totalBytes });
  assert.equal(disk(200 * GB, 500 * GB), null);
  assert.match(disk(10 * GB, 500 * GB), /2% free \(10\.0 GB\) on \/srv\/data/);
  assert.match(disk(0.1 * GB, 1 * GB), /10% free \(0\.1 GB\)/, "a small disk can be nearly full at ten per cent");
  assert.equal(disk(2 * GB, 8 * GB), null);
});

/**
 * A token lasts a year and nothing says when it is about to run out; the first
 * the player hears is an error popup. The server sees the expiry every time
 * the token is presented, so it can say so while the player is still online.
 */
test("a token about to run out is mentioned while its holder is still playing", () => {
  const now = 1_800_000_000;
  const expiring = (days) => ({ accountId: 100 + days, tokenExpiry: now + days * 86400 });
  assert.equal(tokenWarning([expiring(200), expiring(30)], now), null);
  assert.equal(
    tokenWarning([expiring(200), expiring(5), expiring(12)], now),
    "2 online players' tokens expire within 14 days: account 105 in 5 days, account 112 in 12 days"
  );
  assert.match(tokenWarning([{ accountId: 7, tokenExpiry: now + 20 * 3600 }], now), /account 7 in under a day$/);
  // A browser session's token is good for six hours by design: not a warning.
  assert.equal(tokenWarning([{ accountId: 9, tokenExpiry: now + 3 * 3600 }], now), null);
  assert.equal(tokenWarning([{ accountId: 9 }], now), null, "no token, as with auth off");
});

test("a worker that is down while others carry on is a warning, not an outage", () => {
  const slot = (index, alive) => ({ index, alive });
  assert.equal(workerWarning(null), null, "workers are off");
  assert.equal(workerWarning([slot(0, true), slot(1, true)]), null);
  assert.equal(workerWarning([slot(0, true), slot(1, false), slot(2, false)]), "match workers 1, 2 are down");
  assert.equal(workerWarning([slot(0, false)]), null, "none left is the failing check's to say");
});

test("an event loop running late is lag, and is said in milliseconds", () => {
  assert.equal(loopWarning(40), null);
  assert.equal(loopWarning(480), "timers are firing 480 ms late (p99 over the last minute): players will feel this as lag");
});

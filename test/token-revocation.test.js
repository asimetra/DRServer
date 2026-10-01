import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ods-revocation-"));
process.env.ODS_DATA_DIR = dataDir;

const { issueToken, revokeAccountTokens, tokenProblem } = await import("../src/auth.js");

test.after(() => {
  delete process.env.ODS_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const secret = "s".repeat(64);
const generations = path.join(dataDir, "token-generations.json");
const check = (accountId, token) => tokenProblem(accountId, token, { secret });

/**
 * A revocation has to stay a revocation while its record is unreadable.
 *
 * The record is re-read at most every five seconds. The moment of the last
 * attempt was noted before the read, so a read that failed still counted as
 * fresh — and for the rest of the window every check went ahead on whatever
 * was in memory, which for a server that had just started was nothing at all.
 * One refusal, then five seconds of every revoked token being accepted.
 */
test("a revocation record that cannot be read refuses every check, not just the first", () => {
  const revoked = issueToken(41, { secret });
  revokeAccountTokens(41);
  assert.match(check(41, revoked), /signature does not match/);

  const sound = fs.readFileSync(generations, "utf8");
  fs.writeFileSync(generations, sound.slice(0, -3));
  // Past the five-second window, so the next check looks at the disk again.
  const realNow = Date.now;
  const later = realNow() + 6000;
  Date.now = () => later;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(check(41, revoked), "token revocation state is unavailable", `check ${attempt}`);
      assert.equal(
        check(42, issueToken(42, { secret, generation: 0 })),
        "token revocation state is unavailable",
        "nobody is waved through on a guess"
      );
    }
  } finally {
    Date.now = realNow;
    fs.writeFileSync(generations, sound);
  }
});

/**
 * The record going missing un-revoked everything: no file read as no
 * revocations. Within a running server that much is known to be wrong, and
 * what it already loaded stands.
 */
test("a revocation record deleted under a running server does not forgive anybody", () => {
  // A write re-reads the record first, which is what ends the test above's failure.
  revokeAccountTokens(40);
  const revoked = issueToken(43, { secret });
  revokeAccountTokens(43);
  const current = issueToken(43, { secret });
  assert.equal(check(43, current), null);

  fs.rmSync(generations);
  // Well past the five-second window, so the next check looks at the disk again.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    assert.match(check(43, revoked), /signature does not match/);
    assert.equal(check(43, current), null, "and the replacement still works");
  } finally {
    Date.now = realNow;
  }
});

test("a revocation is on disk, whole, before it is reported done", () => {
  revokeAccountTokens(44);
  const stored = JSON.parse(fs.readFileSync(generations, "utf8"));
  assert.equal(stored["44"], 1);
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp")),
    [],
    "no half-written copy is left beside it"
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(generations).mode & 0o777, 0o600);
  }
});

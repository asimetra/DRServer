import test from "node:test";
import assert from "node:assert/strict";
import { issueToken, verifyToken, TOKEN_TTL_SECONDS } from "../src/auth.js";

/**
 * A token says which account it is for, and cannot be written by anyone
 * without the secret.
 *
 * The shape is the one the captures carry: a number, a colon, and a
 * SHA-256-sized hex string. The account id is not in the text — the client
 * sends it alongside, in `X-Account-Id` and in the socket login — but it is
 * signed, or a token issued for one account would open another.
 */

const SECRET = "test-secret";

test("a token verifies for the account it was issued to and no other", () => {
  const token = issueToken(1000, { secret: SECRET });

  assert.match(token, /^\d+:[0-9a-f]{64}$/, "the shape the client already carries");
  assert.equal(verifyToken(1000, token, { secret: SECRET }), true);
  assert.equal(verifyToken(1001, token, { secret: SECRET }), false, "not another account");
});

test("a token does not verify under a different secret", () => {
  const token = issueToken(1000, { secret: SECRET });
  assert.equal(verifyToken(1000, token, { secret: "other" }), false);
});

test("a tampered signature or expiry is refused", () => {
  const token = issueToken(1000, { secret: SECRET });
  const [expiry, signature] = token.split(":");

  const flipped = signature.replace(/^./, (c) => (c === "a" ? "b" : "a"));
  assert.equal(verifyToken(1000, `${expiry}:${flipped}`, { secret: SECRET }), false);
  // Moving the expiry out is the obvious forgery: the signature covers it.
  assert.equal(
    verifyToken(1000, `${Number(expiry) + 86400}:${signature}`, { secret: SECRET }),
    false
  );
});

test("an expired token is refused", () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const token = issueToken(1000, { secret: SECRET, expiry: past });
  assert.equal(verifyToken(1000, token, { secret: SECRET }), false);

  const fresh = issueToken(1000, { secret: SECRET });
  const [expiry] = fresh.split(":");
  assert.ok(
    Number(expiry) > Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS - 60,
    "a fresh one lasts its full term"
  );
});

/**
 * The token in the configuration file has to outlive not playing for a while.
 *
 * `DBFacade` reads `API_ValidationToken` once at startup and never writes the
 * refreshed one back, so every launch presents the same one the operator
 * handed over. A term measured in days would lock out anybody who took a week
 * off and make the operator reissue tokens as a chore.
 *
 * What the client refreshes hourly is a different thing: it lives in memory
 * for one session, so it can be short.
 */
test("the token a player keeps outlives the one a session uses", () => {
  const [bootstrap] = issueToken(1000, { secret: SECRET }).split(":");
  const [session] = issueToken(1000, { secret: SECRET, term: "session" }).split(":");
  const now = Math.floor(Date.now() / 1000);

  assert.ok(Number(bootstrap) - now > 300 * 86400, "the kept one lasts most of a year");
  assert.ok(Number(session) - now < 86400, "the session one lasts hours");
  assert.ok(
    Number(session) - now > 2 * 3600,
    "and comfortably longer than the client's hourly refresh"
  );
});

test("garbage is refused rather than thrown at", () => {
  for (const bad of [undefined, null, "", "nonsense", "1:2", ":", "abc:def", 12345]) {
    assert.equal(verifyToken(1000, bad, { secret: SECRET }), false, `refused ${String(bad)}`);
  }
});

/**
 * Without a secret there is nothing to verify against, and answering "yes"
 * would be worse than answering "no" — the whole point is that a token cannot
 * be written by someone who does not hold the key.
 */
test("no secret means no verification", () => {
  assert.equal(verifyToken(1000, issueToken(1000, { secret: SECRET }), { secret: "" }), false);
  assert.throws(() => issueToken(1000, { secret: "" }), /secret/i);
});

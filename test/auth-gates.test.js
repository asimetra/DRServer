import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * The two places a caller announces who it is.
 *
 * `JSONRPCService` puts `X-Account-Id` and `X-Validation-Token` on every POST
 * it makes, set once for all of them — which matters, because the token's
 * position inside `params` is not fixed: the client passes it second on most
 * calls, third on a chest open, sixth on a gift, and first on a skin change.
 * Reading the header is therefore the only uniform check, and the socket login
 * carries the same pair in its first two fields.
 */

process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-auth-"));
process.env.ODS_TOKEN_SECRET = "gate-test-secret";

const { authorise } = await import("../src/routes.js");
const { issueToken } = await import("../src/auth.js");

const ACCOUNT = 1000000005;
const request = (headers) => ({ headers });

test("a request carrying a token issued for its account is let through", () => {
  const token = issueToken(ACCOUNT);
  assert.equal(
    authorise(request({ "x-account-id": String(ACCOUNT), "x-validation-token": token })),
    null,
    "null is the way through"
  );
});

test("a request for another account with a valid token is refused", () => {
  const token = issueToken(ACCOUNT);
  const refusal = authorise(
    request({ "x-account-id": String(ACCOUNT + 1), "x-validation-token": token })
  );
  assert.ok(refusal, "somebody else's token opens nothing");
  assert.equal(refusal.status, 401);
});

test("a missing, empty or invented token is refused", () => {
  for (const headers of [
    { "x-account-id": String(ACCOUNT) },
    { "x-account-id": String(ACCOUNT), "x-validation-token": "" },
    { "x-account-id": String(ACCOUNT), "x-validation-token": "made-up" },
    { "x-validation-token": issueToken(ACCOUNT) },
  ]) {
    assert.equal(authorise(request(headers))?.status, 401, JSON.stringify(headers));
  }
});

/**
 * Turning the check off is a real choice for a machine nobody else can reach,
 * and it has to keep working or every configuration written before this
 * existed would stop at the login screen.
 */
test("with the check off, anything is let through", async () => {
  const { config } = await import("../src/config.js");
  const was = config.authEnabled;
  config.authEnabled = false;
  try {
    assert.equal(authorise(request({ "x-account-id": "1", "x-validation-token": "junk" })), null);
  } finally {
    config.authEnabled = was;
  }
});

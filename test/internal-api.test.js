import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-internal-api-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
// Port 0: the OS picks one, so the suite cannot collide with a running server.
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { verifyToken } = await import("../src/auth.js");
const { listAccountIds } = await import("../src/accounts.js");

const server = start();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT"]) {
    delete process.env[name];
  }
  await rm(dataDir, { recursive: true, force: true });
});

const call = (method, route, { token = process.env.ODS_INTERNAL_TOKEN, body } = {}) =>
  fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token === null ? {} : { "X-Internal-Token": token }),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/**
 * The credential answers for every account at once, which is exactly why it is
 * checked before anything else a request carries is looked at.
 */
test("a call without the internal token is refused", async () => {
  const response = await call("POST", "/internal/v1/accounts", { token: null });
  assert.equal(response.status, 401);
});

test("a call with the wrong internal token is refused", async () => {
  const response = await call("POST", "/internal/v1/accounts", { token: "not it" });
  assert.equal(response.status, 401);
});

/**
 * Registering, which is the whole reason this API exists: the website has the
 * email and the password, and none of the three things a game account needs —
 * a free id, the starting inventory, and a signature only this process can
 * make.
 */
test("registering returns an account and a token that verifies for it", async () => {
  const response = await call("POST", "/internal/v1/accounts", { body: { name: "Yeni" } });
  assert.equal(response.status, 201);

  const { accountId, name, token } = await response.json();
  assert.equal(name, "Yeni");
  assert.ok(Number.isSafeInteger(accountId) && accountId > 0);
  assert.ok(verifyToken(accountId, token), "the issued token must verify for its account");
  assert.ok(!verifyToken(accountId + 1, token), "and must not verify for anybody else");
});

test("two registrations do not collide on an id", async () => {
  const [first, second] = await Promise.all([
    call("POST", "/internal/v1/accounts").then((r) => r.json()),
    call("POST", "/internal/v1/accounts").then((r) => r.json()),
  ]);
  assert.notEqual(first.accountId, second.accountId);
});

/**
 * `loadAccount` creates an account it has never seen, which is right for a
 * client presenting an id an operator handed it and wrong here — a typo in a
 * front-end call would otherwise conjure an account and hand back a working
 * token for it.
 */
test("asking about an unknown account is a 404 and does not create it", async () => {
  const unknown = 4_000_000_001;
  const response = await call("POST", `/internal/v1/accounts/${unknown}/token`);
  assert.equal(response.status, 404);
  assert.ok(!(await listAccountIds()).includes(unknown));
});

test("a malformed account id is refused before anything is loaded", async () => {
  const response = await call("GET", "/internal/v1/accounts/not-a-number");
  assert.equal(response.status, 400);
});

/**
 * Signing out everywhere. Tokens are signed rather than stored, so there is no
 * list to delete from: the generation the signature covers moves on and every
 * token issued under the old one stops verifying.
 */
test("revoking invalidates the tokens already issued for that account", async () => {
  const { accountId, token } = await call("POST", "/internal/v1/accounts").then((r) => r.json());
  assert.ok(verifyToken(accountId, token));

  const revoked = await call("DELETE", `/internal/v1/accounts/${accountId}/token`);
  assert.equal(revoked.status, 200);

  assert.ok(!verifyToken(accountId, token), "the old token must stop verifying");

  const replacement = await call("POST", `/internal/v1/accounts/${accountId}/token`);
  const { token: fresh } = await replacement.json();
  assert.ok(verifyToken(accountId, fresh), "and a fresh one must work");
});

test("an account reads back as the payload the client would receive", async () => {
  const { accountId } = await call("POST", "/internal/v1/accounts").then((r) => r.json());
  const account = await call("GET", `/internal/v1/accounts/${accountId}`).then((r) => r.json());

  assert.equal(account.id, accountId);
  assert.ok(Array.isArray(account.account_avatars));
  assert.ok(Array.isArray(account.account_items));
});

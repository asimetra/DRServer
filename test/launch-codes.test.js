import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Opening the browser client signed in, from the website.
 *
 * The link used to carry a session token after "#". Never sent to a server,
 * but it sat in the browser's history and in whatever copied it, and opened
 * the account for six hours from there. Now the link carries a one-time code:
 * the website asks the internal API for one, the page that loads the client
 * trades it here for a session token, and the code is spent by that — and
 * lapses after a minute if nobody trades it.
 */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ods-launch-codes-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { createLaunchCode, redeemLaunchCode, LAUNCH_CODE_TTL_MS } = await import("../src/launch-codes.js");
const { start } = await import("../src/internal.js");
const { routes } = await import("../src/routes.js");
const { tokenProblem } = await import("../src/auth.js");

const server = start();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const internal = (method, route, body) =>
  fetch(`${base}${route}`, {
    method,
    headers: { "X-Internal-Token": process.env.ODS_INTERNAL_TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const launch = routes.find((route) => route.method === "POST" && route.pattern === "/launch").handler;
const trade = async (code) => {
  const answer = await launch({ json: { code }, headers: {} }, []);
  return { status: answer.status, body: JSON.parse(answer.body), headers: answer.headers };
};

test("a code is good once, for its own account", () => {
  const { code } = createLaunchCode(1_000_000_005);
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.equal(redeemLaunchCode(code), 1_000_000_005);
  assert.equal(redeemLaunchCode(code), null, "spent");
});

test("a code nobody trades lapses", () => {
  const now = Date.now();
  const { code } = createLaunchCode(1_000_000_005, now);
  assert.equal(redeemLaunchCode(code, now + LAUNCH_CODE_TTL_MS + 1), null);
  assert.ok(LAUNCH_CODE_TTL_MS <= 120_000, "a minute or two, not hours");
});

test("anything that is not a code is refused without a lookup", () => {
  for (const offered of [undefined, null, "", "abc", 42, "g".repeat(64), {}]) {
    assert.equal(redeemLaunchCode(offered), null, String(offered));
  }
});

test("the website gets a code for an account that exists, and the page trades it for a session token", async () => {
  const account = (await (await internal("POST", "/internal/v1/accounts", {})).json()).accountId;
  const issued = await internal("POST", `/internal/v1/accounts/${account}/launch-code`);
  assert.equal(issued.status, 200);
  const { code, expires } = await issued.json();
  assert.ok(Date.parse(expires) > Date.now());

  const traded = await trade(code);
  assert.equal(traded.status, 200);
  assert.equal(traded.body.accountId, account);
  assert.equal(tokenProblem(account, traded.body.token), null, "a token that works");
  const hours = (Date.parse(traded.body.expires) - Date.now()) / 3_600_000;
  assert.ok(hours > 0 && hours <= 6, "the short session term, not the kept one");
  assert.equal(traded.headers["Cache-Control"], "no-store");

  const again = await trade(code);
  assert.equal(again.status, 400, "and only once");
  assert.equal("token" in again.body, false);
});

test("no code for an account that does not exist, or without the internal token", async () => {
  assert.equal((await internal("POST", "/internal/v1/accounts/4000000000/launch-code")).status, 404);
  const anonymous = await fetch(`${base}/internal/v1/accounts/1000000001/launch-code`, { method: "POST" });
  assert.equal(anonymous.status, 401);
});

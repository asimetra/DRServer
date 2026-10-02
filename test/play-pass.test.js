import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The browser client's files, for people signed in on the website only.
 *
 * Behind an operator's gate (ODS_WEB_CLIENT_GATE), /play/ answers its entry
 * page to anybody — it is what trades the website's one-time code — and every
 * other file only to a browser holding a play pass: a signed cookie that the
 * trade at POST /launch hands out. The pass opens the files and nothing else;
 * it is not a game credential, so a stolen one opens no account.
 */

process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.DR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dr-play-pass-"));
test.after(() => fs.rmSync(process.env.DR_DATA_DIR, { recursive: true, force: true }));

const { issuePlayPass, checkPlayPass, playPassFrom, PLAY_PASS_TTL_SECONDS } = await import("../src/play-pass.js");
const { serveWebClient } = await import("../src/web-client.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dr-play-root-"));
fs.writeFileSync(path.join(root, "index.html"), "<html>entry</html>");
fs.writeFileSync(path.join(root, "favicon.png"), "PNG");
fs.writeFileSync(path.join(root, "game.js"), "game()");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const serve = async (gated) => {
  const server = http.createServer((req, res) =>
    serveWebClient(req, res, new URL(req.url, "http://x").pathname, root, { gated })
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

test("a pass is good for its term, and a forged or altered one is not", () => {
  const now = Date.now();
  const pass = issuePlayPass(1_000_000_005, now);
  assert.equal(checkPlayPass(pass, now)?.accountId, 1_000_000_005);
  assert.equal(checkPlayPass(pass, now + (PLAY_PASS_TTL_SECONDS + 1) * 1000), null, "lapsed");
  const [account, expiry, signature] = pass.split(".");
  assert.equal(checkPlayPass(`${Number(account) + 1}.${expiry}.${signature}`, now), null, "another account");
  assert.equal(checkPlayPass(`${account}.${Number(expiry) + 999}.${signature}`, now), null, "a longer term");
  for (const junk of [undefined, "", "a.b.c", "1.2", `${account}.${expiry}.${"0".repeat(64)}`]) {
    assert.equal(checkPlayPass(junk, now), null, String(junk));
  }
});

test("the pass is read out of a cookie header among others", () => {
  assert.equal(playPassFrom("theme=dark; dr_play=1.2.abc; other=x"), "1.2.abc");
  assert.equal(playPassFrom(undefined), null);
  assert.equal(playPassFrom("dr_playx=1"), null);
});

test("gated, the entry page and icon are open and everything else needs a pass", async (t) => {
  const { server, base } = await serve(true);
  t.after(() => server.close());

  assert.equal((await fetch(`${base}/play/`)).status, 200, "the page that trades the code");
  assert.equal((await fetch(`${base}/play/index.html`)).status, 200);
  assert.equal((await fetch(`${base}/play/favicon.png`)).status, 200);
  const refused = await fetch(`${base}/play/game.js`);
  assert.equal(refused.status, 401);
  assert.equal(await refused.text().then((body) => body.includes("game()")), false);

  const pass = issuePlayPass(1_000_000_005);
  const allowed = await fetch(`${base}/play/game.js`, { headers: { cookie: `dr_play=${pass}` } });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "game()");

  const forged = await fetch(`${base}/play/game.js`, { headers: { cookie: "dr_play=1000000005.9999999999.deadbeef" } });
  assert.equal(forged.status, 401);
});

test("a pass near the end of its term is renewed on the next file", async (t) => {
  const { server, base } = await serve(true);
  t.after(() => server.close());
  const old = issuePlayPass(1_000_000_005, Date.now() - (PLAY_PASS_TTL_SECONDS - 600) * 1000);
  const answer = await fetch(`${base}/play/game.js`, { headers: { cookie: `dr_play=${old}` } });
  assert.equal(answer.status, 200);
  const renewed = answer.headers.get("set-cookie") ?? "";
  assert.match(renewed, /^dr_play=1000000005\./);
  assert.match(renewed, /HttpOnly/);
  assert.match(renewed, /Path=\/play/);

  const fresh = issuePlayPass(1_000_000_005);
  const quiet = await fetch(`${base}/play/game.js`, { headers: { cookie: `dr_play=${fresh}` } });
  assert.equal(quiet.headers.get("set-cookie"), null, "a fresh one is left alone");
});

test("ungated, the files are open as before", async (t) => {
  const { server, base } = await serve(false);
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/play/game.js`)).status, 200);
});

test("trading a launch code hands out the pass with the token", async () => {
  const { createLaunchCode } = await import("../src/launch-codes.js");
  const { routes } = await import("../src/routes.js");
  const { loadAccount } = await import("../src/accounts.js");
  await loadAccount(1_000_000_005);
  const launch = routes.find((route) => route.method === "POST" && route.pattern === "/launch").handler;
  const answer = await launch({ json: { code: createLaunchCode(1_000_000_005).code }, headers: {} });
  assert.equal(answer.status, 200);
  const cookie = answer.headers["Set-Cookie"];
  assert.match(cookie, /^dr_play=1000000005\./);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(checkPlayPass(playPassFrom(cookie.split(";")[0]))?.accountId, 1_000_000_005);
});

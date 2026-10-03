import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
 * Signing out of the website ends the browser game for that account.
 *
 * The Play link's session token lived six hours and was renewed every hour
 * while the game ran, and the play pass that loads the client's files lived
 * twelve and renewed itself too: somebody who signed out of the website could
 * keep playing on that account, or reload the tab and be straight back in. The
 * desktop client's token is the long, kept kind an operator hands over, and is
 * not the website's to end.
 */
process.env.ODS_TOKEN_SECRET = "1".repeat(64);
process.env.DR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dr-browser-signout-"));
test.after(() => fs.rmSync(process.env.DR_DATA_DIR, { recursive: true, force: true }));

const { issueToken, tokenProblem, SESSION_TTL_SECONDS } = await import("../src/auth.js");
const { issuePlayPass, checkPlayPass } = await import("../src/play-pass.js");
const { endBrowserSessions } = await import("../src/browser-sessions.js");

const ACCOUNT = 1000000901;

test("a browser session from before signing out is refused, and the desktop token is not", () => {
  const session = issueToken(ACCOUNT, { term: "session" });
  const kept = issueToken(ACCOUNT);
  assert.equal(tokenProblem(ACCOUNT, session), null);

  endBrowserSessions(ACCOUNT, Date.now() + 1000);

  assert.match(tokenProblem(ACCOUNT, session), /signed out/);
  assert.equal(tokenProblem(ACCOUNT, kept), null, "the desktop client keeps playing");
});

test("a browser session from after signing in again is good", () => {
  const ended = Date.now();
  endBrowserSessions(ACCOUNT + 1, ended);
  const later = Math.floor(ended / 1000) + SESSION_TTL_SECONDS + 5;
  const fresh = issueToken(ACCOUNT + 1, { term: "session", expiry: later });
  assert.equal(tokenProblem(ACCOUNT + 1, fresh), null);
});

test("signing out takes the play pass with it, and only that account's", () => {
  const pass = issuePlayPass(ACCOUNT + 2);
  const other = issuePlayPass(ACCOUNT + 3);
  assert.ok(checkPlayPass(pass));

  endBrowserSessions(ACCOUNT + 2, Date.now() + 1000);

  assert.equal(checkPlayPass(pass), null);
  assert.ok(checkPlayPass(other), "somebody else's pass is untouched");
  const after = issuePlayPass(ACCOUNT + 2, Date.now() + 5000);
  assert.ok(checkPlayPass(after, Date.now() + 5000), "a pass from a new Play link works");
});

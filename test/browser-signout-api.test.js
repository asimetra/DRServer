import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/*
 * POST /internal/v1/accounts/:id/browser-signout — what the website calls when
 * its player signs out: the account's browser game ends, at once, and its
 * desktop client plays on.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "ods-browser-signout-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "2".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { issueToken, tokenProblem } = await import("../src/auth.js");
const { enterPresence, leavePresence } = await import("../src/socket/presence.js");
const { WebSocketStream } = await import("../src/socket/websocket.js");

const server = start();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

const call = (method, route, { body, actor } = {}) =>
  fetch(`${base}${route}`, {
    method,
    headers: {
      "X-Internal-Token": process.env.ODS_INTERNAL_TOKEN,
      ...(actor === undefined ? {} : { "X-Acting-Account": String(actor) }),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

let player;
let stranger;
before(async () => {
  player = (await (await call("POST", "/internal/v1/accounts", { body: {} })).json()).accountId;
  stranger = (await (await call("POST", "/internal/v1/accounts", { body: {} })).json()).accountId;
});

after(async () => {
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT"]) {
    delete process.env[name];
  }
  await rm(dataDir, { recursive: true, force: true });
});

/** A connected player, through a browser's WebSocket or the desktop client's socket. */
const connected = (accountId, { browser }) => {
  const closed = [];
  const session = {
    id: Math.floor(Math.random() * 1e9),
    accountId,
    authenticated: true,
    connectedAt: Date.now(),
    remoteAddress: "198.51.100.7",
    socket: browser ? Object.create(WebSocketStream.prototype) : { destroyed: false },
    send: () => {},
    close: (why) => closed.push(why),
  };
  return { session, closed };
};

test("signing out ends the browser game at once and leaves the desktop one playing", async () => {
  const token = issueToken(player, { term: "session" });
  const kept = issueToken(player);
  const browser = connected(player, { browser: true });
  const desktop = connected(player, { browser: false });
  enterPresence(browser.session);
  enterPresence(desktop.session);
  try {
    const response = await call("POST", `/internal/v1/accounts/${player}/browser-signout`, { body: {}, actor: player });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).disconnected, 1);
    assert.equal(browser.closed.length, 1, "the open browser game is closed");
    assert.equal(desktop.closed.length, 0, "the desktop client is not");
    assert.match(tokenProblem(player, token), /signed out/);
    assert.equal(tokenProblem(player, kept), null);
  } finally {
    leavePresence(browser.session);
    leavePresence(desktop.session);
  }
});

test("nobody signs anybody else out", async () => {
  const response = await call("POST", `/internal/v1/accounts/${player}/browser-signout`, { body: {}, actor: stranger });
  assert.equal(response.status, 403);
});

test("signing out with no game open is still an answer, not an error", async () => {
  const response = await call("POST", `/internal/v1/accounts/${stranger}/browser-signout`, { body: {}, actor: stranger });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).disconnected, 0);
});

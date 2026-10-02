import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * The internal API's administrative half, and who is using it.
 *
 * The internal token proves the caller is the website, not which person on it
 * pressed the button. Restricting an account, closing the dungeons, throwing
 * somebody off: these name the admin doing it, in `X-Acting-Account`, and the
 * server checks that account is an admin by the same rule its chat commands
 * use — `ODS_ADMIN_ACCOUNTS`, or the rank stored on the account. A page on the
 * website that forgot to check would otherwise hand every signed-in player the
 * same powers. Every such action is written down: who, what, to whom, when.
 */

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-admin-api-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { config } = await import("../src/config.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { endMaintenance } = await import("../src/maintenance.js");
const { enterPresence, leavePresence } = await import("../src/socket/presence.js");
const { ROLE, withRole } = await import("../src/socket/roles.js");

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

const register = async () => (await (await call("POST", "/internal/v1/accounts", { body: {} })).json()).accountId;

let admin;
let player;
const usualAdmins = config.adminAccounts;

before(async () => {
  admin = await register();
  player = await register();
  config.adminAccounts = [admin];
});

after(async () => {
  config.adminAccounts = usualAdmins;
  endMaintenance();
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT"]) {
    delete process.env[name];
  }
  await rm(dataDir, { recursive: true, force: true });
});

/** A player online, as presence holds one. */
const online = (accountId, { mapNode = 0 } = {}) => {
  const closed = [];
  const session = {
    id: accountId,
    accountId,
    authenticated: true,
    connectedAt: Date.now() - 65_000,
    remoteAddress: "198.51.100.4",
    tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
    send: () => {},
    close: (why) => closed.push(why),
  };
  return { session, closed };
};

const ADMIN_ROUTES = [
  ["PUT", () => `/internal/v1/accounts/${player}/restriction`, { reason: "r" }],
  ["DELETE", () => `/internal/v1/accounts/${player}/restriction`],
  ["PUT", () => "/internal/v1/maintenance", {}],
  ["DELETE", () => "/internal/v1/maintenance"],
  ["POST", () => "/internal/v1/announcements", { text: "hi" }],
  ["POST", () => `/internal/v1/accounts/${player}/disconnect`, {}],
  ["GET", () => "/internal/v1/online"],
  ["GET", () => "/internal/v1/restrictions"],
  ["GET", () => "/internal/v1/admin-actions"],
];

test("an administrative call names the admin making it, or is refused", async () => {
  for (const [method, route, body] of ADMIN_ROUTES) {
    const without = await call(method, route(), { body });
    assert.equal(without.status, 400, `${method} ${route()} without X-Acting-Account`);
    assert.match((await without.json()).error, /X-Acting-Account/);

    const notAdmin = await call(method, route(), { body, actor: player });
    assert.equal(notAdmin.status, 403, `${method} ${route()} by a player`);

    const nobody = await call(method, route(), { body, actor: 4_000_000_000 });
    assert.equal(nobody.status, 403, `${method} ${route()} by an account that does not exist`);

    const garbage = await call(method, route(), { body, actor: "me" });
    assert.equal(garbage.status, 400, `${method} ${route()} by something that is not an account`);
  }
  endMaintenance();
});

test("an admin by stored rank counts, as one named in the environment does", async () => {
  const ranked = await register();
  const account = await loadAccount(ranked);
  account.admin_flags = Number(withRole(account.admin_flags, ROLE.ADMIN));
  await saveAccount(account);

  assert.equal((await call("GET", "/internal/v1/online", { actor: ranked })).status, 200);
  assert.equal((await call("GET", "/internal/v1/online", { actor: admin })).status, 200);
});

test("what an admin does is done in their name, and written down", async () => {
  const restricted = await call("PUT", `/internal/v1/accounts/${player}/restriction`, {
    body: { reason: "speed hack" },
    actor: admin,
  });
  assert.equal(restricted.status, 200);
  assert.equal((await restricted.json()).restriction.by, admin, "by is the admin who did it, not a claim");

  await call("PUT", "/internal/v1/maintenance", { body: { message: "restart soon" }, actor: admin });
  await call("DELETE", "/internal/v1/maintenance", { actor: admin });
  await call("DELETE", `/internal/v1/accounts/${player}/restriction`, { actor: admin });

  const log = await (await call("GET", "/internal/v1/admin-actions?limit=4", { actor: admin })).json();
  assert.deepEqual(
    log.actions.map((entry) => entry.action),
    ["restriction.lift", "maintenance.open", "maintenance.close", "restriction.set"],
    "newest first"
  );
  for (const entry of log.actions) {
    assert.equal(entry.actor, admin);
    assert.ok(entry.at);
  }
  const set = log.actions.at(-1);
  assert.equal(set.target, player);
  assert.equal(set.detail.reason, "speed hack");

  const aboutPlayer = await (await call("GET", `/internal/v1/admin-actions?account=${player}`, { actor: admin })).json();
  assert.ok(aboutPlayer.actions.length >= 2);
  assert.ok(aboutPlayer.actions.every((entry) => entry.target === player), "filtered to the account acted on");
});

test("a refused call is not written down as done", async () => {
  const before = (await (await call("GET", "/internal/v1/admin-actions?limit=200", { actor: admin })).json()).actions.length;
  await call("PUT", `/internal/v1/accounts/${player}/restriction`, { body: { reason: "x" }, actor: player });
  await call("PUT", `/internal/v1/accounts/${player}/restriction`, { body: {}, actor: admin });
  const now = (await (await call("GET", "/internal/v1/admin-actions?limit=200", { actor: admin })).json()).actions.length;
  assert.equal(now, before);
});

test("who is online, where, and from where", async () => {
  const inTown = online(player);
  const another = await register();
  const inDungeon = online(another);
  enterPresence(inTown.session);
  enterPresence(inDungeon.session);
  const { setPresenceLocation } = await import("../src/socket/presence.js");
  setPresenceLocation(inDungeon.session, 50004);
  try {
    const answer = await (await call("GET", "/internal/v1/online", { actor: admin })).json();
    const byId = new Map(answer.players.map((row) => [row.account_id, row]));
    const town = byId.get(player);
    assert.ok(town, "the player in town is listed");
    assert.equal(town.address, "198.51.100.4");
    assert.ok(town.connected_seconds >= 60);
    assert.equal(town.in_dungeon, false);
    assert.equal(byId.get(another).in_dungeon, true);
    assert.equal(byId.get(another).map_node, 50004);
    assert.ok("name" in town);
    assert.equal(answer.count, answer.players.length);
  } finally {
    leavePresence(inTown.session);
    leavePresence(inDungeon.session);
  }
});

test("a player is thrown off, and the action kept", async () => {
  const { session, closed } = online(player);
  enterPresence(session);
  try {
    const response = await call("POST", `/internal/v1/accounts/${player}/disconnect`, {
      body: { reason: "being rude" },
      actor: admin,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).disconnected, 1);
    assert.equal(closed.length, 1);
  } finally {
    leavePresence(session);
  }
  const [latest] = (await (await call("GET", "/internal/v1/admin-actions?limit=1", { actor: admin })).json()).actions;
  assert.equal(latest.action, "account.disconnect");
  assert.equal(latest.target, player);
  assert.equal(latest.detail.reason, "being rude");

  const offline = await call("POST", `/internal/v1/accounts/${player}/disconnect`, { body: {}, actor: admin });
  assert.equal(offline.status, 404, "nobody to throw off");
});

test("the restricted accounts, with why and until when", async () => {
  const first = await register();
  const second = await register();
  const over = await register();
  const until = new Date(Date.now() + 86_400_000).toISOString();
  await call("PUT", `/internal/v1/accounts/${first}/restriction`, { body: { reason: "a", until }, actor: admin });
  await call("PUT", `/internal/v1/accounts/${second}/restriction`, { body: { reason: "b" }, actor: admin });
  // One that has run out by itself is not restricted any more.
  const expired = await loadAccount(over);
  expired.restriction = { until: new Date(Date.now() - 1000).toISOString(), reason: "c", by: admin, at: new Date().toISOString() };
  await saveAccount(expired);

  const answer = await (await call("GET", "/internal/v1/restrictions", { actor: admin })).json();
  const ids = answer.restrictions.map((row) => row.account_id);
  assert.ok(ids.includes(first) && ids.includes(second));
  assert.equal(ids.includes(over), false);
  const row = answer.restrictions.find((entry) => entry.account_id === first);
  assert.equal(row.restriction.reason, "a");
  assert.equal(row.restriction.until, until);
  assert.ok("name" in row);
});

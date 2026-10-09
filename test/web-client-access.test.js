import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, afterEach, before } from "node:test";

/**
 * Who may open the browser client, when the host asks that somebody decide.
 *
 * With ODS_WEB_CLIENT_APPROVAL on, a Play link is given only to an account a
 * helper or an admin has said yes to. The player asks through the website; a
 * helper sees who is waiting and answers; a no ends a browser game already
 * under way. A helper is let through for this and for nothing else an admin
 * may do.
 */

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-web-client-access-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { config } = await import("../src/config.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { ROLE, withRole } = await import("../src/socket/roles.js");
const { redeemLaunchCode } = await import("../src/launch-codes.js");
const { issuedBeforeSignOut } = await import("../src/browser-sessions.js");
const { forTheClient } = await import("../src/server-only-fields.js");

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
const launch = (id) => call("POST", `/internal/v1/accounts/${id}/launch-code`);
const summary = async (id) => (await call("GET", `/internal/v1/accounts/${id}/summary`)).json();
const ask = (id) => call("POST", `/internal/v1/accounts/${id}/web-client/request`);
const answer = (id, state, actor) => call("PUT", `/internal/v1/accounts/${id}/web-client`, { body: { state }, actor });
const waiting = (actor, state = "pending") => call("GET", `/internal/v1/web-client?state=${state}`, { actor });

let admin;
let helper;
const usualAdmins = config.adminAccounts;
const usualApproval = config.webClientApproval;

before(async () => {
  admin = await register();
  helper = await register();
  const account = await loadAccount(helper);
  account.admin_flags = Number(withRole(account.admin_flags, ROLE.HELPER));
  await saveAccount(account);
  config.adminAccounts = [admin];
});

afterEach(() => {
  config.webClientApproval = usualApproval;
});

after(async () => {
  config.adminAccounts = usualAdmins;
  config.webClientApproval = usualApproval;
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT"]) {
    delete process.env[name];
  }
  await rm(dataDir, { recursive: true, force: true });
});

test("with approval off, anybody is given a Play link, as before", async () => {
  config.webClientApproval = false;
  const player = await register();

  assert.equal((await launch(player)).status, 200);
  assert.deepEqual((await summary(player)).web_client, { may_play: true, state: null });
});

test("with approval on, an account nobody has answered is refused a Play link, and says why", async () => {
  config.webClientApproval = true;
  const player = await register();

  const refused = await launch(player);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).reason, "not_approved");
  assert.deepEqual((await summary(player)).web_client, { may_play: false, state: null });
});

test("a player asks once; asking again changes nothing", async () => {
  config.webClientApproval = true;
  const player = await register();

  assert.equal((await (await ask(player)).json()).state, "pending");
  const first = (await loadAccount(player)).web_client.requested_at;
  assert.equal((await (await ask(player)).json()).state, "pending");
  assert.equal((await loadAccount(player)).web_client.requested_at, first);
  assert.deepEqual((await summary(player)).web_client, { may_play: false, state: "pending" });
});

test("a helper sees who is waiting, the longest waiting first; a player may not look", async () => {
  config.webClientApproval = true;
  const earlier = await register();
  const later = await register();
  await ask(earlier);
  await ask(later);

  const listed = await (await waiting(helper)).json();
  const order = listed.accounts.map((entry) => entry.account_id);
  assert.ok(order.indexOf(earlier) < order.indexOf(later));
  assert.equal((await waiting(earlier)).status, 403);
  assert.equal((await waiting(admin)).status, 200);
  assert.equal((await waiting(helper, "everyone")).status, 400);
});

test("a helper's yes opens Play, and is written down in the helper's name", async () => {
  config.webClientApproval = true;
  const player = await register();
  await ask(player);

  const approved = await answer(player, "approved", helper);
  assert.equal(approved.status, 200);
  assert.equal((await launch(player)).status, 200);
  assert.deepEqual((await summary(player)).web_client, { may_play: true, state: "approved" });

  const stored = (await loadAccount(player)).web_client;
  assert.equal(stored.by, helper);
  assert.ok(stored.requested_at);

  const { actions } = await (
    await call("GET", `/internal/v1/admin-actions?account=${player}`, { actor: admin })
  ).json();
  assert.equal(actions[0].action, "web-client.approve");
  assert.equal(actions[0].actor, helper);
});

test("a no ends the browser game under way, and asking again does not undo it", async () => {
  config.webClientApproval = true;
  const player = await register();
  await answer(player, "approved", helper);
  const { code } = await (await launch(player)).json();
  const playingSince = Date.now();

  assert.equal((await answer(player, "denied", helper)).status, 200);
  assert.equal(redeemLaunchCode(code), null, "a code already handed out is spent");
  assert.ok(issuedBeforeSignOut(player, playingSince), "its session and play pass stop working");
  assert.equal((await launch(player)).status, 403);
  assert.equal((await (await ask(player)).json()).state, "denied");
});

test("a helper and an admin are always given a Play link: they are the ones who give it", async () => {
  config.webClientApproval = true;

  assert.equal((await launch(helper)).status, 200);
  assert.equal((await launch(admin)).status, 200);
  assert.equal((await summary(helper)).helper, true);
  assert.equal((await summary(helper)).admin, false);
});

test("a helper may answer browser-client requests and do nothing else an admin does", async () => {
  const player = await register();

  assert.equal((await call("GET", "/internal/v1/restrictions", { actor: helper })).status, 403);
  assert.equal(
    (await call("PUT", `/internal/v1/accounts/${player}/restriction`, { body: { reason: "x" }, actor: helper })).status,
    403
  );
  assert.equal((await answer(player, "approved", player)).status, 403, "nor may a player answer for themselves");
});

test("an answer is yes or no, and nothing else", async () => {
  const player = await register();

  assert.equal((await answer(player, "pending", helper)).status, 400);
  assert.equal((await answer(player, undefined, helper)).status, 400);
  assert.equal((await answer(999_999, "approved", helper)).status, 404);
});

test("the answer is the server's record, never the client's", async () => {
  const player = await register();
  await ask(player);

  assert.equal("web_client" in forTheClient(await loadAccount(player)), false);
});

/* ---------------------------------------------------------------- ranks - */

const giveRole = (id, role, actor) => call("PUT", `/internal/v1/accounts/${id}/role`, { body: { role }, actor });
const lookUp = async (name) => (await call("GET", `/internal/v1/players/${name}/account`, { actor: admin })).json();

test("an admin makes a player a helper, and the helper can answer requests at once", async () => {
  config.webClientApproval = true;
  const moderator = await register();
  const player = await register();
  await ask(player);

  assert.equal((await waiting(moderator)).status, 403);
  const given = await giveRole(moderator, "helper", admin);
  assert.equal(given.status, 200);
  assert.deepEqual(await given.json(), { accountId: moderator, role: "helper", was: "player" });
  assert.equal((await waiting(moderator)).status, 200);
  assert.equal((await answer(player, "approved", moderator)).status, 200);

  const { name } = await loadAccount(moderator);
  const found = await lookUp(name);
  assert.equal(found.role, "helper");
  assert.equal(found.admin_by_config, false);

  const { actions } = await (await call("GET", `/internal/v1/admin-actions?account=${moderator}`, { actor: admin })).json();
  assert.equal(actions[0].action, "role.set");
  assert.deepEqual(actions[0].detail, { role: "helper", was: "player" });

  await giveRole(moderator, "player", admin);
  assert.equal((await waiting(moderator)).status, 403, "and taken back the same way");
});

test("the rank keeps every other bit of the account's flags", async () => {
  const player = await register();
  const account = await loadAccount(player);
  account.admin_flags = 1;
  await saveAccount(account);

  await giveRole(player, "admin", admin);
  assert.equal((await loadAccount(player)).admin_flags, 0x0201);
});

test("ranks are an admin's to give: not a helper's, not one's own, not one the environment fixes", async () => {
  const player = await register();

  assert.equal((await giveRole(player, "helper", helper)).status, 403);
  assert.equal((await giveRole(helper, "player", helper)).status, 403);
  assert.equal((await giveRole(admin, "player", admin)).status, 409, "an admin cannot take their own rank");
  const other = await register();
  config.adminAccounts = [admin, other];
  try {
    assert.equal((await giveRole(other, "player", admin)).status, 409);
  } finally {
    config.adminAccounts = [admin];
  }
  assert.equal((await giveRole(player, "owner", admin)).status, 400);
  assert.equal((await giveRole(player, undefined, admin)).status, 400);
});

test("finding a player says where their browser-client request stands", async () => {
  const player = await register();
  await ask(player);
  const { name } = await loadAccount(player);
  assert.equal((await lookUp(name)).web_client.state, "pending");
});

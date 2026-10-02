import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Deleting an account, when its player asks.
 *
 * A hosted server with a website that keeps e-mail addresses has to be able
 * to. What goes is the account and every row of it, its standings and its run
 * history; a market sale stays — the other side's history is made of it — but
 * no longer names the deleted player. Its tokens are revoked first, and the
 * revocation outlives the account: the server makes an account the first time a
 * valid token arrives for one, so a token left good would bring it back empty.
 * Whoever is online on it is disconnected, and the deletion waits for their
 * dungeon to have written itself, or that write would put the rows back.
 *
 * Asked by the account itself or by an admin, named in X-Acting-Account like
 * every other call that changes somebody's standing.
 */

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-account-deletion-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { config } = await import("../src/config.js");
const { loadExistingAccount, acquireAccount } = await import("../src/accounts.js");
const { releaseAccount } = await import("../src/account-registry.js");
const { issueToken, tokenProblem } = await import("../src/auth.js");
const { enterPresence, leavePresence } = await import("../src/socket/presence.js");
const { recordRuns, waitForRunRecords, boardFor } = await import("../src/leaderboard.js");
const { recordSale, salesFor } = await import("../src/market-history.js");
const { deleteAccount } = await import("../src/account-deletion.js");

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
const remove = (id, actor) => call("DELETE", `/internal/v1/accounts/${id}`, { actor });

let admin;
const usualAdmins = config.adminAccounts;
before(async () => {
  admin = await register();
  config.adminAccounts = [admin];
});
after(async () => {
  config.adminAccounts = usualAdmins;
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT"]) delete process.env[name];
  await rm(dataDir, { recursive: true, force: true });
});

const run = (account_id, name) => ({
  account_id, name, avatar_id: 1, hero_id: 101, map_node_id: 58_888, party_size: 1,
  started_at: "2026-08-31T12:00:00.000Z", finished_at: "2026-08-31T12:02:00.000Z",
  duration_ms: 60_000, success: true, floors: 1, kills: 10, damage: 500, gold: 100, xp: 250,
  trophies: 12, rankable: true,
});
const board = async () =>
  (await boardFor("speedrun", { node: 58_888, hero: 101, party: 1 })).map((entry) => entry.account_id);

test("only the account itself or an admin may delete it", async () => {
  const owner = await register();
  const stranger = await register();
  assert.equal((await remove(owner)).status, 400, "nobody named");
  assert.equal((await remove(owner, stranger)).status, 403, "somebody else");
  assert.ok(await loadExistingAccount(owner), "and it is still there");
  assert.equal((await remove(owner, admin)).status, 200, "an admin may");
  assert.equal((await remove(stranger, stranger)).status, 200, "and so may the account itself");
  assert.equal((await remove(4_000_000_000, admin)).status, 404);
});

test("a deleted account is gone from everywhere it was, and its token stays refused", async () => {
  const doomed = await register();
  const witness = await register();
  const token = issueToken(doomed);
  await recordRuns([run(doomed, "Doomed"), run(witness, "Witness")]);
  await waitForRunRecords();
  await recordSale({
    listing_id: 77, at: new Date().toISOString(), seller_id: doomed, seller_name: "Doomed",
    buyer_id: witness, buyer_name: "Witness", item_id: 11001, rarity: 1, power: 10,
    requiredlevel: 1, price: 100, tax: 10, proceeds: 90, listed_at: new Date().toISOString(),
  });
  assert.deepEqual((await board()).sort(), [doomed, witness].sort());

  const response = await remove(doomed, doomed);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accountId: doomed, deleted: true });

  assert.equal(await loadExistingAccount(doomed), null, "the account");
  assert.equal((await call("GET", `/internal/v1/accounts/${doomed}`)).status, 404);
  assert.deepEqual(await board(), [witness], "its standings");
  const [sale] = await salesFor(witness);
  assert.equal(sale.seller_name, null, "its name, from the other side's history");
  assert.equal(sale.buyer_name, "Witness", "which keeps everything else");
  assert.match(tokenProblem(doomed, token) ?? "", /signature/, "and a token it had no longer works");

  const log = await (await call("GET", `/internal/v1/admin-actions?account=${doomed}`, { actor: admin })).json();
  assert.equal(log.actions[0].action, "account.delete");
  assert.equal(log.actions[0].actor, doomed);
});

test("whoever is online on it is disconnected first", async () => {
  const id = await register();
  const closed = [];
  const session = { id: 5, accountId: id, authenticated: true, send: () => {}, close: (why) => closed.push(why) };
  enterPresence(session);
  try {
    assert.equal((await remove(id, admin)).status, 200);
  } finally {
    leavePresence(session);
  }
  assert.equal(closed.length, 1);
  assert.equal(await loadExistingAccount(id), null);
});

/**
 * An account still held — a dungeon writing itself after its player was
 * disconnected — is waited for: deleting under it would see the rows put back.
 */
test("an account still in play is waited for, and refused if it never comes free", async () => {
  const waited = await register();
  await acquireAccount(waited);
  setTimeout(() => releaseAccount(waited), 300);
  assert.equal(await deleteAccount(waited, { waitMs: 3000, pollMs: 50 }), true, "deleted once it was let go");
  assert.equal(await loadExistingAccount(waited), null);

  const stuck = await register();
  await acquireAccount(stuck);
  try {
    assert.equal(await deleteAccount(stuck, { waitMs: 200, pollMs: 50 }), false, "not while somebody plays it");
    assert.ok(await loadExistingAccount(stuck), "and nothing was removed");
  } finally {
    releaseAccount(stuck);
  }
});

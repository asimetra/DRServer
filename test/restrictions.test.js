import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * A restricted account.
 *
 * The client has no idea of one: nothing in it shows a suspension, a date or a
 * reason, and a refused login is only "error". So the account is not refused.
 * It signs in and keeps what it has, and the server refuses what it may not
 * do: enter a dungeon, buy or sell on the market, speak on the global channel.
 * Its listings are out of sight, and it can still take its own weapons back
 * down. It is off the leaderboards while it lasts. Gifts and trades are left
 * open. Who restricts, until when and why is set through the internal API,
 * which is the website's door, and read back by the website to show the player.
 */

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-restrictions-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_MARKET_LISTING_DELAY_SECONDS = "0";
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { isRestricted, restrictionOf } = await import("../src/restrictions.js");

const server = start();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT", "ODS_MARKET_LISTING_DELAY_SECONDS"]) {
    delete process.env[name];
  }
  await rm(dataDir, { recursive: true, force: true });
});

/** The admin these calls are made by (see test/admin-api.test.js); set once one is registered. */
let ADMIN = null;

const call = (method, route, body) =>
  fetch(`${base}${route}`, {
    method,
    headers: {
      "X-Internal-Token": process.env.ODS_INTERNAL_TOKEN,
      ...(ADMIN === null ? {} : { "X-Acting-Account": String(ADMIN) }),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

{
  const { config } = await import("../src/config.js");
  const registered = await (await call("POST", "/internal/v1/accounts", {})).json();
  ADMIN = registered.accountId;
  config.adminAccounts = [ADMIN];
}

const register = async () => (await (await call("POST", "/internal/v1/accounts", {})).json());

const restrict = (id, body) => call("PUT", `/internal/v1/accounts/${id}/restriction`, body);
const lift = (id) => call("DELETE", `/internal/v1/accounts/${id}/restriction`);

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

let nextWeapon = 1_950_000_001;
/** An account with one weapon in its bag, and that weapon's id. */
const sellerWithWeapon = async () => {
  const { accountId } = await register();
  const account = await loadAccount(accountId);
  const id = nextWeapon++;
  account.account_items = [
    ...(account.account_items ?? []),
    {
      id, account_id: accountId, item_id: 11003, power: 42, rarity: 3, requiredlevel: 8,
      modifier1: 0, modifier2: 0, legendarymodifier: 0, avatar_id: null, avatar_slot: null,
    },
  ];
  await saveAccount(account);
  return { accountId, weapon: id };
};

const rich = async (accountId) => {
  const account = await loadAccount(accountId);
  account.basic_currency = 1_000_000;
  await saveAccount(account);
};

test("a restriction is active until it ends, and one with no end lasts", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const until = (at) => ({ restriction: { until: at, reason: "r", by: "b", at: "2026-10-01T00:00:00Z" } });

  assert.equal(isRestricted({}, now), false);
  assert.equal(isRestricted({ restriction: null }, now), false);
  assert.equal(isRestricted(until("2026-10-03T00:00:00Z"), now), true);
  assert.equal(isRestricted(until("2026-10-02T11:59:59Z"), now), false, "over is over, with nobody lifting it");
  assert.equal(isRestricted(until(null), now), true, "no end is indefinite");
  assert.equal(restrictionOf(until("2026-10-02T11:59:59Z"), now), null);
  assert.equal(restrictionOf(until(null), now).reason, "r");
});

test("restricting needs a reason and an end that has not passed", async () => {
  const { accountId } = await register();

  for (const body of [
    {},
    { reason: "" },
    { reason: "x".repeat(501) },
    { reason: "cheating", until: "yesterday-ish" },
    { reason: "cheating", until: new Date(Date.now() - DAY).toISOString() },
  ]) {
    const response = await restrict(accountId, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await restrict(4_000_000_000, { reason: "cheating" })).status, 404);
  assert.equal(isRestricted(await loadAccount(accountId)), false, "and nothing was set");
});

test("a restriction is set, read back for the website, and lifted", async () => {
  const { accountId } = await register();
  const until = inDays(10);

  const set = await restrict(accountId, { reason: "speed hack", until });
  assert.equal(set.status, 200);
  const answer = await set.json();
  assert.equal(answer.restriction.reason, "speed hack");
  assert.equal(answer.restriction.until, until);
  assert.equal(answer.restriction.by, ADMIN, "set in the name of the admin who made the call");
  assert.ok(answer.restriction.at, "when it was set");

  const summary = await (await call("GET", `/internal/v1/accounts/${accountId}/summary`)).json();
  assert.equal(summary.restriction.reason, "speed hack", "the website can tell the player why and until when");
  assert.equal(summary.restriction.until, until);

  assert.equal((await lift(accountId)).status, 200);
  const after = await (await call("GET", `/internal/v1/accounts/${accountId}/summary`)).json();
  assert.equal(after.restriction, null);
  assert.equal(isRestricted(await loadAccount(accountId)), false);
});

test("with no end given, it lasts until it is lifted", async () => {
  const { accountId } = await register();
  const answer = await (await restrict(accountId, { reason: "chargeback" })).json();
  assert.equal(answer.restriction.until, null);
  assert.equal(isRestricted(await loadAccount(accountId), Date.now() + 3650 * DAY), true);
});

/** The client parses this response with code this server does not change. */
test("the client is never sent the restriction", async () => {
  const { routes } = await import("../src/routes.js");
  const { issueToken } = await import("../src/auth.js");
  const { accountId } = await register();
  await restrict(accountId, { reason: "speed hack" });

  const route = routes.find((entry) => entry.pattern === "/api/dbAccountInfo/accountdetails");
  const result = await route.handler({
    headers: { "x-account-id": String(accountId), "x-validation-token": issueToken(accountId) },
  }, []);
  assert.equal(result.status, 200);
  assert.equal("restriction" in JSON.parse(result.body), false);
});

test("a restricted account cannot enter a dungeon, and the client is told it is not enterable", async () => {
  const { admitEntry } = await import("../src/socket/match-entry.js");
  const { DungeonMatchRegistry } = await import("../src/socket/matches.js");
  const { ENTRY_ERROR, entryErrorCodeFor } = await import("../src/socket/entry-protocol.js");
  const node = { Id: 50002, Constant: "TUTORIAL", NodeType: "BOSS", BitIndex: 0 };
  const gameMaster = { raw: { MapPage: [node] }, mapNodeById: new Map([[node.Id, node]]) };
  const account = { admin_flags: 0, active_avatar: 7, account_avatars: [{ id: 7 }] };
  const enter = () =>
    admitEntry(
      { accountId: 9 },
      { mapNodeId: 50002, friendId: 0, mapId: 0, friendOnly: false, matchMakerGroup: "" },
      { registry: new DungeonMatchRegistry(), loadAccountById: async () => account, loadGameMasterData: async () => gameMaster }
    );

  account.restriction = { until: null, reason: "r", by: "b", at: new Date().toISOString() };
  const refused = await enter();
  assert.equal(refused.match, null);
  assert.equal(refused.error, "restricted");
  assert.equal(entryErrorCodeFor(refused), ENTRY_ERROR.GAME_NOT_ENTERABLE);

  account.restriction.until = new Date(Date.now() - 1000).toISOString();
  assert.ok((await enter()).match, "and once it is over, the door is open again");
});

test("a restricted account can neither list nor buy", async () => {
  const seller = await sellerWithWeapon();
  await restrict(seller.accountId, { reason: "gold selling" });

  const listing = await call("POST", "/internal/v1/market", { sellerId: seller.accountId, itemId: seller.weapon, price: 500 });
  assert.equal(listing.status, 409);
  assert.equal((await listing.json()).reason, "restricted");

  const other = await sellerWithWeapon();
  assert.equal((await call("POST", "/internal/v1/market", { sellerId: other.accountId, itemId: other.weapon, price: 500 })).status, 201);
  await rich(seller.accountId);
  const bought = await call("POST", `/internal/v1/market/${other.weapon}/buy`, { buyerId: seller.accountId });
  assert.equal(bought.status, 409);
  assert.equal((await bought.json()).reason, "restricted");
});

test("a restricted seller's listings are out of sight and out of reach, and can be taken back", async () => {
  const seller = await sellerWithWeapon();
  assert.equal((await call("POST", "/internal/v1/market", { sellerId: seller.accountId, itemId: seller.weapon, price: 640 })).status, 201);
  const visible = async () =>
    (await (await call("GET", "/internal/v1/market?limit=200")).json()).listings.some((row) => row.id === seller.weapon);
  assert.equal(await visible(), true);

  await restrict(seller.accountId, { reason: "gold selling" });
  assert.equal(await visible(), false, "hidden as soon as it is set");

  const { accountId: buyer } = await register();
  await rich(buyer);
  const bought = await call("POST", `/internal/v1/market/${seller.weapon}/buy`, { buyerId: buyer });
  assert.equal(bought.status, 410, "to a buyer it is simply not there");

  const withdrawn = await call("POST", `/internal/v1/market/${seller.weapon}/cancel`, { sellerId: seller.accountId });
  assert.equal(withdrawn.status, 200, "the seller takes their own weapon back");
  assert.ok((await loadAccount(seller.accountId)).account_items.some((item) => Number(item.id) === seller.weapon));
});

test("once lifted, the market is open to them again", async () => {
  const seller = await sellerWithWeapon();
  await restrict(seller.accountId, { reason: "gold selling" });
  await lift(seller.accountId);
  assert.equal((await call("POST", "/internal/v1/market", { sellerId: seller.accountId, itemId: seller.weapon, price: 500 })).status, 201);
});

test("a restricted account is off the leaderboards while it lasts", async () => {
  const { recordRuns, waitForRunRecords } = await import("../src/leaderboard.js");
  const { accountId: fast } = await register();
  const { accountId: slow } = await register();
  // The shape test/leaderboard.test.js records.
  const run = (account_id, duration_ms) => ({
    account_id, name: `p${account_id}`, avatar_id: 1, hero_id: 101, map_node_id: 59_999,
    party_size: 1, started_at: "2026-08-31T12:00:00.000Z", finished_at: "2026-08-31T12:02:00.000Z",
    duration_ms, success: true, floors: 1, kills: 10, damage: 500, gold: 100, xp: 250,
    trophies: 12, rankable: true,
  });
  await recordRuns([run(fast, 60_000), run(slow, 90_000)]);
  await waitForRunRecords();
  const board = async () =>
    (await (await call("GET", "/internal/v1/leaderboards/speedrun?node=59999&hero=101&party=1")).json()).entries
      .map((entry) => entry.account_id);

  assert.deepEqual(await board(), [fast, slow]);
  await restrict(fast, { reason: "speed hack" });
  assert.deepEqual(await board(), [slow], "the fastest is gone, and the next is first");
  await lift(fast);
  assert.deepEqual(await board(), [fast, slow], "and back when it ends: the run was kept");
});

test("a restricted account does not speak on the global channel", async () => {
  const { sayGlobally, forgetGlobalAllowances } = await import("../src/socket/global-chat.js");
  forgetGlobalAllowances();
  const speaker = {
    id: 1,
    accountId: 77,
    dungeonAccount: { id: 77, name: "Muted", restriction: { until: null, reason: "spam", by: "b", at: "x" } },
    send: () => {},
  };
  assert.equal(sayGlobally(speaker, "hello"), null);
});

test("whoever is online when restricted is sent back to the start", async () => {
  const { enterPresence, leavePresence } = await import("../src/socket/presence.js");
  const { accountId } = await register();
  const closed = [];
  const session = { accountId, id: 991, close: (why) => closed.push(why), send: () => {} };
  enterPresence(session);
  try {
    assert.equal((await restrict(accountId, { reason: "speed hack" })).status, 200);
    assert.equal(closed.length, 1, "out of whatever dungeon they were in; they sign in again, restricted");
  } finally {
    leavePresence(session);
  }
});

/**
 * An account in a dungeon on a match worker lives there, and its run writes
 * that live object when it ends. A restriction written here, to storage, would
 * be written over by it. So setting one is handed to the worker holding the
 * account, which sets it on the object the run saves.
 */
test("restricting an account held by a match worker is done on that worker", async (t) => {
  const accounts = await import("../src/accounts.js");
  const { installAccountOperationForwarder } = await import("../src/account-operations.js");
  const { setRestriction } = await import("../src/restrictions.js");
  const { accountId } = await register();

  const previous = accounts.installAccountOwnership({
    lock: (id, work, local) => {
      if (id === accountId) throw new accounts.AccountLeasedError(id, 1);
      return local(id, work);
    },
    beforeSave: (ids) => {
      for (const id of ids) if (id === accountId) throw new accounts.AccountLeasedError(id, 1);
    },
  });
  const forwarded = [];
  const previousForwarder = installAccountOperationForwarder(async (owner, name, args) => {
    forwarded.push({ owner, name, args });
    return args[1];
  });
  t.after(() => {
    accounts.installAccountOwnership(previous);
    installAccountOperationForwarder(previousForwarder);
  });

  const restriction = { until: null, reason: "on a worker", by: null, at: new Date().toISOString() };
  assert.deepEqual(await setRestriction(accountId, restriction), restriction);
  assert.deepEqual(forwarded, [{ owner: 1, name: "account.restrict", args: [accountId, restriction] }]);
  accounts.installAccountOwnership(previous);
  assert.equal(isRestricted(await loadAccount(accountId)), false, "and nothing was written here");
});

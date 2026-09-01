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
  assert.equal(response.headers.get("cache-control"), "no-store");
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

/**
 * What a seller may put up, and what it is called.
 *
 * Both are this server's answers and neither can be worked out on the other
 * side: "equipped" is an `avatar_id` on the row, which is a detail of these
 * tables, and turning 11001 into a name needs the GameMaster — which the
 * website has no copy of and is not meant to.
 */
test("the inventory offers only what nobody is holding, named", async () => {
  const { saveAccount, loadAccount } = await import("../src/accounts.js");
  const registered = await (await call("POST", "/internal/v1/accounts", { body: {} })).json();

  const account = await loadAccount(registered.accountId);
  account.account_items = [
    { id: 90001, account_id: account.id, item_id: 11001, power: 5, rarity: 1, avatar_id: null },
    { id: 90002, account_id: account.id, item_id: 11001, power: 5, rarity: 1, avatar_id: 7 },
  ];
  await saveAccount(account);

  const bag = await (
    await call("GET", `/internal/v1/accounts/${registered.accountId}/inventory`)
  ).json();

  assert.deepEqual(
    bag.items.map((item) => item.id),
    [90001],
    "a weapon somebody is holding is not for sale"
  );
  assert.ok(bag.items[0].name, "and what is offered says what it is");
  assert.deepEqual(bag.items[0].modifiers, [], "with room for the lines it would carry");
});

test("an inventory for an account that does not exist is refused", async () => {
  const response = await call("GET", "/internal/v1/accounts/4000000001/inventory");
  assert.equal(response.status, 404);
});

test("market browsing exposes useful item facts and applies filters before paging", async () => {
  const { saveAccount, loadAccount } = await import("../src/accounts.js");
  const registered = await (await call("POST", "/internal/v1/accounts", { body: {} })).json();
  const account = await loadAccount(registered.accountId);
  account.account_items = [{
    id: 1_900_000_001,
    account_id: account.id,
    item_id: 11003, // Quake/Monster Axe, whose hold attack is Fissure
    power: 42,
    rarity: 3,
    requiredlevel: 8,
    modifier1: 0,
    modifier2: 0,
    legendarymodifier: 0,
    avatar_id: null,
  }];
  await saveAccount(account);

  const listed = await call("POST", "/internal/v1/market", {
    body: { sellerId: account.id, itemId: 1_900_000_001, price: 750 },
  });
  assert.equal(listed.status, 201);

  const response = await call(
    "GET",
    "/internal/v1/market?q=fissure&type=AXE_TYPE&rarity=3&hero=101&maxPrice=800&sort=price_asc&limit=1&offset=0"
  );
  assert.equal(response.status, 200);
  const market = await response.json();
  assert.equal(market.total, 1);
  assert.equal(market.listings.length, 1);
  assert.equal(market.listings[0].id, 1_900_000_001);
  assert.equal(market.listings[0].rarity_name, "rare");
  assert.ok(market.listings[0].vendor_value > 0);
  assert.ok(market.listings[0].usable_by.some((hero) => hero.id === 101));
  assert.equal(market.has_more, false);

  const tooCheap = await call("GET", "/internal/v1/market?maxPrice=100").then((r) => r.json());
  assert.equal(tooCheap.total, 0);
});

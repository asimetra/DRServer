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

/**
 * Every market route, answered.
 *
 * Written because the sales endpoint shipped broken while the whole suite was
 * green: it referenced a helper that a later refactor had removed, and nothing
 * called the route to find out. The module under it was tested and the wiring
 * was not, which is the gap this closes — a handler that throws on its first
 * line still passes every test of the thing it calls.
 */
test("every market route answers rather than throwing", async () => {
  const { accountId } = await (await call("POST", "/internal/v1/accounts", { body: { name: "Stallholder" } })).json();

  for (const route of [
    "/internal/v1/market",
    `/internal/v1/accounts/${accountId}/stall`,
    `/internal/v1/accounts/${accountId}/sales`,
    `/internal/v1/accounts/${accountId}/summary`,
  ]) {
    const response = await call("GET", route);
    assert.equal(response.status, 200, `${route} answered ${response.status}`);
    // A 500 here is JSON too, so the body is checked rather than the status alone.
    const body = await response.json();
    assert.ok(!body.error, `${route} answered with ${body.error}`);
  }
});

test("a sales history is empty rather than missing for somebody who has not traded", async () => {
  const { accountId } = await (await call("POST", "/internal/v1/accounts", { body: { name: "Quiet One" } })).json();
  const body = await (await call("GET", `/internal/v1/accounts/${accountId}/sales`)).json();

  assert.equal(body.account_id, accountId);
  assert.deepEqual(body.sales, []);
});

test("a sales history is refused for an account that does not exist", async () => {
  assert.equal((await call("GET", "/internal/v1/accounts/4000000000/sales")).status, 404);
  assert.equal((await call("GET", "/internal/v1/accounts/nope/sales")).status, 400);
});

/* --------------------------------------------------------------- profile - */

/**
 * Addressed by name, because the account id is the number the client
 * authenticates with and a profile is the one page built to be linked to.
 */
test("a profile is found by name, in any case", async () => {
  await call("POST", "/internal/v1/accounts", { body: { name: "Ayşegül" } });

  for (const spelling of ["Ayşegül", "ayşegül", "AYŞEGÜL"]) {
    const response = await call("GET", `/internal/v1/players/${encodeURIComponent(spelling)}`);
    assert.equal(response.status, 200, spelling);
    assert.equal((await response.json()).name, "Ayşegül");
  }

  assert.equal((await call("GET", "/internal/v1/players/NobodyHere")).status, 404);
});

/**
 * What a player may know about another, and what they may not. The second half
 * is the half worth testing: a profile that leaked the account id would undo
 * the reason it is addressed by name.
 */
test("a profile answers about the player and nothing about their account", async () => {
  await call("POST", "/internal/v1/accounts", { body: { name: "Ivory" } });
  const profile = await (await call("GET", "/internal/v1/players/Ivory")).json();

  for (const field of ["name", "trophies", "title", "clears", "heroes", "sales"]) {
    assert.ok(field in profile, `a profile says ${field}`);
  }
  for (const field of ["account_id", "id", "basic_currency", "premium_currency", "account_items", "email"]) {
    assert.ok(!(field in profile), `a profile does not say ${field}`);
  }
  assert.ok(!JSON.stringify(profile).includes("basic_currency"), "and not anywhere inside it");
});

/**
 * The roster, not the active hero. "How far has this person got" is a question
 * about all of them, and the stats are the game's own answer rather than a
 * website's second opinion.
 */
test("a profile carries every hero, with the stats the game computes", async () => {
  await call("POST", "/internal/v1/accounts", { body: { name: "Pell" } });
  const { heroes } = await (await call("GET", "/internal/v1/players/Pell")).json();

  assert.ok(heroes.length >= 1, "a new account starts with one");
  const [hero] = heroes;
  assert.equal(typeof hero.name, "string");
  assert.ok(hero.level >= 1);
  assert.ok(hero.health > 0, "health is computed, not left null");
  assert.ok(Object.keys(hero.stats).length > 5, "and the stat vector is filled in");
  /* `statTotals` answers with a Map; read it as one. Reading it as a plain
     object turned every value into zero, and a vector of zeroes passes the
     key-count check above — which is exactly how it slipped through. */
  assert.ok(
    Object.values(hero.stats).some((value) => value > 0),
    "the vector carries the game's numbers, not zeroes"
  );
  assert.equal(typeof hero.active, "boolean");
});

/**
 * How a hero was built, which is a different question from what it ended up
 * with.
 *
 * `stats` is the computed vector — the melee attack this hero has, gear and
 * points and all. What it cannot say is what the player *chose*: four slots,
 * seventy-five points each, and a build is which of them they filled. Those
 * live on the avatar as statupgrade1..4 and mean nothing on their own, since
 * the slots belong to the hero — 75 in the second is cooking on a Battle Chef
 * and something else on everybody else, and only this side holds the table
 * that says which.
 */
test("a hero says how its points were spent, not only what it ended up with", async () => {
  const { loadAccount, saveAccount } = await import("../src/accounts.js");
  const registered = await (
    await call("POST", "/internal/v1/accounts", { body: { name: "Builder" } })
  ).json();

  const account = await loadAccount(registered.accountId);
  Object.assign(account.account_avatars[0], {
    statupgrade1: 0,
    statupgrade2: 75,
    statupgrade3: 50,
    statupgrade4: 75,
  });
  await saveAccount(account);

  const { heroes } = await (await call("GET", "/internal/v1/players/Builder")).json();
  const [hero] = heroes;

  assert.equal(hero.spent.placed, 200, "the points actually spent");
  assert.equal(hero.spent.cap, 75, "and what one slot may hold");
  assert.equal(hero.spent.slots.length, 4);

  const [first, second] = hero.spent.slots;
  assert.equal(first.points, 0);
  assert.equal(second.points, 75);
  assert.ok(second.stat, "a slot names the stat it feeds, or its number means nothing");
  assert.ok(Number.isFinite(second.perPoint), "and says what a point in it is worth");
  assert.ok(second.name, "and carries the words a player reads, not only the constant");
  assert.notEqual(second.name, second.stat, "a constant is not a label");
});

test("a hero with nothing spent still says what its slots are", async () => {
  await call("POST", "/internal/v1/accounts", { body: { name: "Fresh" } });
  const { heroes } = await (await call("GET", "/internal/v1/players/Fresh")).json();

  assert.equal(heroes[0].spent.placed, 0);
  assert.equal(heroes[0].spent.slots.length, 4, "the choices are worth showing before any are made");
});

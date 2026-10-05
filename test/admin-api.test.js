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
const { boardFor, recordRuns } = await import("../src/leaderboard.js");

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
  await call("POST", "/internal/v1/accounts", { body: { name: "Lookupable" } });
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
  ["GET", () => "/internal/v1/players/Lookupable/account"],
  ["GET", () => "/internal/v1/match-workers"],
  ["GET", () => "/internal/v1/grants"],
  ["GET", () => `/internal/v1/accounts/${player}/holdings`],
  ["POST", () => `/internal/v1/accounts/${player}/grants`, { gold: 1 }],
  ["PUT", () => `/internal/v1/accounts/${player}/name`, { name: "Renamed" }],
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

/**
 * A profile is addressed by name and leaves the account id out on purpose; an
 * admin acting on a player they only know by name needs the id, and whether
 * they are restricted or online, before doing anything.
 */
test("an admin finds an account by its name", async () => {
  const found = await call("GET", "/internal/v1/players/lookupable/account", { actor: admin });
  assert.equal(found.status, 200);
  const body = await found.json();
  assert.equal(body.name, "Lookupable");
  assert.ok(Number.isSafeInteger(body.account_id));
  assert.equal(body.restriction, null);
  assert.equal(body.online, false);

  assert.equal((await call("GET", "/internal/v1/players/Nobody%20Here/account", { actor: admin })).status, 404);
});

/** The website shows its admin pages to admins; the rule is this server's, so it says. */
test("an account's summary says whether it is an admin", async () => {
  const summary = async (id) => (await (await call("GET", `/internal/v1/accounts/${id}/summary`)).json()).admin;
  assert.equal(await summary(admin), true);
  assert.equal(await summary(player), false);
});

/* ----------------------------------------------------------------- grants - */

test("what may be given: the four weapon chests, the heroes, and the most of each", async () => {
  const response = await call("GET", "/internal/v1/grants", { actor: admin });
  assert.equal(response.status, 200);
  const { chests, rarities, heroes, limits } = await response.json();
  assert.deepEqual(chests.map((chest) => chest.rarity), ["COMMON", "UNCOMMON", "RARE", "LEGENDARY"]);
  assert.deepEqual(rarities, ["COMMON", "UNCOMMON", "RARE", "LEGENDARY"]);
  assert.equal(heroes.length, 6);
  assert.ok(heroes.every((hero) => hero.maxLevel > 1), "each hero says how far it goes");
  assert.ok(limits.gold > 0 && limits.chests > 0);
});

test("an admin gives an account gold, gems, keys, chests, weapons, powerups and a level, and it is written down", async () => {
  const target = await register();
  const before = await loadAccount(target);
  const gold = Number(before.basic_currency ?? 0);
  const gems = Number(before.premium_currency ?? 0);
  const chests = (before.account_chests ?? []).length;
  const items = (before.account_items ?? []).length;

  const response = await call("POST", `/internal/v1/accounts/${target}/grants`, {
    body: { gold: 5000, gems: 100, keys: 3, weapons: 2, powerups: 7, chests: [{ id: 60004, count: 2 }], level: { level: 20 } },
    actor: admin,
  });
  assert.equal(response.status, 200);
  const { given } = await response.json();
  assert.ok(given.some((each) => each.what === "gold" && each.amount === 5000));

  const after = await loadAccount(target);
  assert.equal(Number(after.basic_currency), gold + 5000);
  assert.equal(Number(after.premium_currency), gems + 100);
  assert.equal(Number(after.legendary_keys ?? 0), Number(before.legendary_keys ?? 0) + 3);
  assert.equal(after.account_chests.length, chests + 2);
  assert.equal(after.account_items.length, items + 2);
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const powerups = (await loadGameMaster()).raw.Stackables.filter((row) => row.ItemCategory === "POWERUP");
  for (const row of powerups) {
    const held = after.account_stackables.find((entry) => Number(entry.stack_id) === Number(row.Id));
    assert.ok(Number(held?.count) >= 7, `${row.Name} topped up to 7`);
  }
  assert.ok(after.account_avatars.every((avatar) => Number(avatar.experience) > 0), "every hero levelled");

  const [latest] = (await (await call("GET", "/internal/v1/admin-actions?limit=1", { actor: admin })).json()).actions;
  assert.equal(latest.action, "account.grant");
  assert.equal(latest.target, target);
  assert.deepEqual(latest.detail.given, given);
});

test("keys go by rarity, and weapons can be one rarity for one hero", async () => {
  const target = await register();
  const before = await loadAccount(target);
  const response = await call("POST", `/internal/v1/accounts/${target}/grants`, {
    body: { keys: { LEGENDARY: 2, RARE: 1 }, weapons: { count: 3, rarity: "LEGENDARY", hero: 102 } },
    actor: admin,
  });
  assert.equal(response.status, 200);
  const after = await loadAccount(target);
  assert.equal(Number(after.legendary_keys ?? 0), Number(before.legendary_keys ?? 0) + 2);
  assert.equal(Number(after.rare_keys ?? 0), Number(before.rare_keys ?? 0) + 1);
  assert.equal(Number(after.basic_keys ?? 0), Number(before.basic_keys ?? 0), "no common keys asked for");
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  const legendary = gm.raw.Rarity.find((row) => row.Type === "LEGENDARY");
  const rolled = after.account_items.slice((before.account_items ?? []).length);
  assert.equal(rolled.length, 3);
  assert.ok(rolled.every((item) => Number(item.rarity) === Number(legendary.Id)), "all three legendary");
  const { given } = await response.json();
  assert.ok(given.some((each) => each.what === "legendary weapons for the Ranger" && each.amount === 3), JSON.stringify(given));
});

test("what a player holds, as an admin's page shows it: purse, keys and chests by rarity, heroes, every weapon", async () => {
  const target = await register();
  await call("POST", `/internal/v1/accounts/${target}/grants`, {
    body: { gold: 250, keys: { RARE: 3 }, chests: [{ id: 60003, count: 2 }], powerups: 4 },
    actor: admin,
  });
  const response = await call("GET", `/internal/v1/accounts/${target}/holdings`, { actor: admin });
  assert.equal(response.status, 200);
  const holdings = await response.json();
  const account = await loadAccount(target);
  assert.equal(holdings.gold, Number(account.basic_currency));
  assert.equal(holdings.keys.RARE, Number(account.rare_keys));
  assert.equal(holdings.chests.RARE, 2);
  assert.equal(holdings.chests.LEGENDARY, 0);
  assert.ok(holdings.powerups.length > 0 && holdings.powerups.every((row) => row.count >= 4));
  assert.equal(holdings.heroes.length, account.account_avatars.length);
  assert.ok(holdings.heroes.every((hero) => hero.level >= 1 && hero.maxLevel >= hero.level));
  assert.equal(holdings.items.length, account.account_items.length, "the bag and the hands both");
  const held = holdings.items.find((item) => Number(item.avatar_id ?? 0));
  if (held) assert.ok(held.equipped_by, "a held weapon says whose hand it is in");
  assert.ok(holdings.items.every((item) => "name" in item && "rarity_name" in item), "described as the market describes one");
});

test("one grant sets a level of its own for each of several heroes", async () => {
  const target = await register();
  const heroes = (await loadAccount(target)).account_avatars.map((avatar) => Number(avatar.avatar_id));
  const response = await call("POST", `/internal/v1/accounts/${target}/grants`, {
    body: { level: heroes.map((hero, at) => ({ hero, level: 10 + at })) },
    actor: admin,
  });
  assert.equal(response.status, 200);
  const shown = (await (await call("GET", `/internal/v1/accounts/${target}/holdings`, { actor: admin })).json()).heroes;
  heroes.forEach((hero, at) => assert.equal(shown.find((row) => row.id === hero).level, 10 + at));
});

test("a grant of nothing, too much, or a chest the game has not got is refused, and says why", async () => {
  for (const [body, why] of [
    [{}, "nothing_to_grant"],
    [{ gold: -5 }, "bad_grant"],
    [{ gold: 1e12 }, "bad_grant"],
    [{ gems: 1.5 }, "bad_grant"],
    [{ chests: [{ id: 60007, count: 1 }] }, "bad_grant"],
    [{ level: { level: 10, hero: 999 } }, "bad_grant"],
    [{ keys: { MYTHIC: 1 } }, "bad_grant"],
    [{ weapons: { count: 1, rarity: "MYTHIC" } }, "bad_grant"],
    [{ keys: { LEGENDARY: 0 } }, "nothing_to_grant"],
  ]) {
    const response = await call("POST", `/internal/v1/accounts/${player}/grants`, { body, actor: admin });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).reason, why, JSON.stringify(body));
  }
});

test("a grant or a rename waits for the player to be offline", async () => {
  const { session } = online(player);
  enterPresence(session);
  try {
    const grant = await call("POST", `/internal/v1/accounts/${player}/grants`, { body: { gold: 1 }, actor: admin });
    assert.equal(grant.status, 409);
    assert.equal((await grant.json()).reason, "online");
    const rename = await call("PUT", `/internal/v1/accounts/${player}/name`, { body: { name: "WhileHere" }, actor: admin });
    assert.equal(rename.status, 409);
    assert.equal((await rename.json()).reason, "online");
  } finally {
    leavePresence(session);
  }
});

/* ----------------------------------------------------------------- rename - */

test("an admin renames a player: sign-up's rules, nobody else's name, and the boards follow", async () => {
  const target = await register();
  const named = await call("PUT", `/internal/v1/accounts/${target}/name`, { body: { name: "Firstname" }, actor: admin });
  assert.equal(named.status, 200);
  assert.equal((await loadAccount(target)).name, "Firstname");

  await recordRuns([
    {
      account_id: target, name: "Firstname", avatar_id: 1, hero_id: 101, map_node_id: 50003, party_size: 1,
      started_at: "2026-10-01T12:00:00.000Z", finished_at: "2026-10-01T12:02:00.000Z", duration_ms: 120_000,
      success: true, floors: 1, kills: 1, damage: 1, gold: 1, xp: 1, trophies: 0,
    },
  ]);
  const renamed = await call("PUT", `/internal/v1/accounts/${target}/name`, { body: { name: "Secondname" }, actor: admin });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { accountId: target, name: "Secondname", was: "Firstname" });
  const board = await boardFor("clears", { limit: 100 });
  assert.equal(board.find((entry) => Number(entry.account_id) === target)?.name, "Secondname", "the board shows the new name");

  const cased = await call("PUT", `/internal/v1/accounts/${target}/name`, { body: { name: "secondName" }, actor: admin });
  assert.equal(cased.status, 200, "its own name in other letters is no clash");

  const taken = await call("PUT", `/internal/v1/accounts/${target}/name`, { body: { name: "lookupable" }, actor: admin });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).reason, "name_taken");
  const shaped = await call("PUT", `/internal/v1/accounts/${target}/name`, { body: { name: "no!" }, actor: admin });
  assert.equal(shaped.status, 400, "a malformed name is a bad request, not a clash");
  assert.equal((await shaped.json()).reason, "bad_name");

  const [latest] = (await (await call("GET", "/internal/v1/admin-actions?limit=1", { actor: admin })).json()).actions;
  assert.equal(latest.action, "account.rename");
  assert.deepEqual(latest.detail, { from: "Secondname", to: "secondName" });
});

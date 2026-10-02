import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-accounts-test-"));
process.env.ODS_DATA_DIR = dataDir;

const { createAccount, loadAccount, saveAccount } = await import("../src/accounts.js");

after(async () => {
  delete process.env.ODS_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});


/**
 * These read or damage the account files themselves, or keep a record in a
 * shape only a file can hold, so they have nothing to say about PostgreSQL —
 * test/postgres-save.test.js is where that backend is held to the same things.
 */
const fileOnly = process.env.ODS_STORAGE === "postgres" && "file storage only";

test("a new account survives a save/load round trip", async () => {
  const account = await loadAccount(12345);

  assert.equal(account.id, 12345);
  assert.ok(account.active_avatar >= 1_200_000_000);
  assert.ok(account.active_avatar <= 0x7fffffff);
  assert.equal(account.account_avatars[0].avatar_id, 101);
  assert.equal(account.account_items[0].item_id, 11001);
  assert.deepEqual(
    Object.fromEntries(account.account_attributes.map(({ name, value }) => [name, value])),
    {
      optionsHudStyle: "1",
      optionsGraphicsQuality: "high",
      optionsMusicVolume: "0",
      optionsSFXVolume: "0",
    }
  );
  assert.equal(
    account.account_attributes.every(({ id, account_id }) =>
      Number.isSafeInteger(id) && account_id === account.id
    ),
    true,
    "default preferences are valid rows for both file and Postgres storage"
  );

  account.basic_currency += 250;
  account.account_avatars[0].experience = 99;
  await saveAccount(account);

  const reloaded = await loadAccount(12345);
  assert.equal(reloaded.basic_currency, 1250);
  assert.equal(reloaded.account_avatars[0].experience, 99);
});

test("loading a legacy account restores its map progress to the active avatar", { skip: fileOnly }, async () => {
  const account = await loadAccount(12346);
  account.completed_mapnode_mask = String.fromCharCode(0x80);
  account.account_avatars.forEach((avatar) => {
    avatar.completed_mapnode_mask = "";
  });
  await saveAccount(account);

  const repaired = await loadAccount(12346);
  const active = repaired.account_avatars.find((avatar) => avatar.id === repaired.active_avatar);
  assert.equal(active.completed_mapnode_mask.charCodeAt(0), 0x80);

  const persisted = JSON.parse(await readFile(path.join(dataDir, "12346.json"), "utf8"));
  const savedActive = persisted.account_avatars.find((avatar) => avatar.id === persisted.active_avatar);
  assert.equal(savedActive.completed_mapnode_mask.charCodeAt(0), 0x80);
});

test("loading a legacy account moves avatar ids out of the client-local range", { skip: fileOnly }, async () => {
  const account = await loadAccount(12347);
  account.account_avatars.push({
    id: 1_000_055,
    account_id: account.id,
    avatar_id: 104,
    completed_mapnode_mask: "",
  });
  account.active_avatar = 1_000_055;
  account.account_items.push({
    id: 900,
    account_id: account.id,
    item_id: 15001,
    avatar_id: 1_000_055,
    avatar_slot: 0,
  });
  account.account_pets.push({
    id: 901,
    account_id: account.id,
    npc_id: 3303,
    equipped_hero: 1_000_055,
  });
  await saveAccount(account);

  const repaired = await loadAccount(12347);
  const migratedId = 1_101_000_055;
  assert.equal(repaired.active_avatar, migratedId);
  assert.ok(repaired.account_avatars.some((avatar) => avatar.id === migratedId));
  assert.equal(repaired.account_items.at(-1).avatar_id, migratedId);
  assert.equal(repaired.account_pets[0].equipped_hero, migratedId);

  const persisted = JSON.parse(await readFile(path.join(dataDir, "12347.json"), "utf8"));
  assert.equal(persisted.active_avatar, migratedId, "the repair survives a restart");
});

/**
 * A hero row with no skin. Nothing this server creates is one — the template
 * names a skin and so does buying a hero — but an account written by hand or
 * carried over from somewhere else can be, and such a row is one PostgreSQL
 * will not hold: the column is required, so the account could not be moved
 * across. Every hero has a skin of its own in the game data, and a hero with
 * none wears that.
 */
test("a hero with no skin is given its own on loading", { skip: fileOnly }, async () => {
  const account = await loadAccount(12349);
  account.account_avatars.push({
    id: 1_250_000_901,
    account_id: account.id,
    avatar_id: 104,
    completed_mapnode_mask: "",
  });
  await saveAccount(account);

  const repaired = await loadAccount(12349);
  const chef = repaired.account_avatars.find((avatar) => avatar.avatar_id === 104);
  assert.equal(chef.skin_type, 154, "the Battle Chef's own");
  assert.equal(repaired.account_avatars[0].skin_type, account.account_avatars[0].skin_type, "one that had a skin keeps it");

  const persisted = JSON.parse(await readFile(path.join(dataDir, "12349.json"), "utf8"));
  assert.equal(persisted.account_avatars.find((avatar) => avatar.avatar_id === 104).skin_type, 154);
});

test("new account object ids are allocated outside the client-local range", async () => {
  const { nextObjectId } = await import("../src/accounts.js");
  assert.ok((await nextObjectId()) > 1_099_999);
});

test("account JSON template hydrates allocated ids and timestamps without sharing state", async () => {
  const created = "2026-08-15T00:00:00.000Z";
  const first = await createAccount(42, created);
  const second = await createAccount(43, created);

  assert.equal(first.name, "Player42");
  assert.equal(first.created, created);
  assert.equal(first.account_avatars[0].account_id, 42);
  assert.equal(first.account_items[0].account_id, 42);
  first.account_items[0].power = 999;
  assert.equal(second.account_items[0].power, 5);
  assert.notEqual(first.active_avatar, second.active_avatar);
  assert.notEqual(first.account_items[0].id, second.account_items[0].id);
  assert.equal(first.account_items[0].avatar_id, first.active_avatar);
});

test("starter rows never collide with allocator output or modulo-related accounts", async () => {
  const { nextObjectId } = await import("../src/accounts.js");
  const first = await createAccount(1_000_000_005);
  const allocatedBetween = await nextObjectId(first);
  const second = await createAccount(1_400_000_005);
  const ids = [
    first.active_avatar,
    first.account_items[0].id,
    allocatedBetween,
    second.active_avatar,
    second.account_items[0].id,
  ];

  assert.equal(new Set(ids).size, ids.length, `persistent ID collision: ${ids}`);
});

test("invalid account JSON is preserved and never replaced with a fresh account", { skip: fileOnly }, async () => {
  const id = 12348;
  const account = await loadAccount(id);
  account.basic_currency = 999_999;
  await saveAccount(account);

  const file = path.join(dataDir, `${id}.json`);
  const valid = await readFile(file, "utf8");
  const corrupt = valid.slice(0, -2);
  await writeFile(file, corrupt, "utf8");

  await assert.rejects(() => loadAccount(id), /invalid JSON; refusing to recreate/);

  assert.equal(await readFile(file, "utf8"), corrupt, "the broken source was overwritten");
  const preserved = (await readdir(dataDir)).filter((name) =>
    name.startsWith(`${id}.json.corrupt-`)
  );
  assert.equal(preserved.length, 1, "the corrupt payload was not quarantined exactly once");
  assert.equal(await readFile(path.join(dataDir, preserved[0]), "utf8"), corrupt);

  /* The broken file stays where it is, so it is read again — by the next
     login, by every scan of the population, by each restart. Each of those
     used to write another copy of the same bytes. */
  await assert.rejects(() => loadAccount(id), /invalid JSON; refusing to recreate/);
  await assert.rejects(() => loadAccount(id), (problem) => problem.code === "ACCOUNT_CORRUPT");
  const afterMore = (await readdir(dataDir)).filter((name) =>
    name.startsWith(`${id}.json.corrupt-`)
  );
  assert.deepEqual(afterMore, preserved, "the same bytes were preserved a second time");

  // A different breakage of the same file is different evidence, and is kept.
  await writeFile(file, corrupt.slice(0, -5), "utf8");
  await assert.rejects(() => loadAccount(id), /invalid JSON; refusing to recreate/);
  const afterChange = (await readdir(dataDir)).filter((name) =>
    name.startsWith(`${id}.json.corrupt-`)
  );
  assert.equal(afterChange.length, 2);

  // Out of the way of the tests that follow.
  await rm(file);
  for (const name of afterChange) await rm(path.join(dataDir, name));
});

/**
 * One account an operator edited by hand and left a comma in. Questions asked
 * of the whole population — is this name taken, what is for sale — load every
 * account to answer, and each of them failed for everybody on that one file.
 */
test("questions asked of every account skip one that cannot be read", async () => {
  const { browseAll } = await import("../src/market.js");
  const { createNewAccount, listAccountIds } = await import("../src/accounts.js");
  const { nameTaken } = await import("../src/account-names.js");

  const sound = await createNewAccount({ name: "Readable" });
  const file = path.join(dataDir, "12360.json");
  await writeFile(file, '{"id": 12360, "name": "Edited",}', "utf8");
  try {
    assert.ok(Array.isArray(await browseAll()), "the market still lists what it can read");
    assert.equal(await nameTaken("Readable", { listAccountIds, loadAccount }), true);
    assert.equal(await nameTaken("Nobody Yet", { listAccountIds, loadAccount }), false);
    assert.equal((await createNewAccount({ name: "Newcomer" })).name, "Newcomer");
    assert.ok(sound.id);
  } finally {
    for (const name of await readdir(dataDir)) {
      if (name.startsWith("12360.json")) await rm(path.join(dataDir, name));
    }
  }
});

test("a non-ENOENT account read failure is propagated without writing", { skip: fileOnly }, async () => {
  const id = 12349;
  await loadAccount(id);
  const file = path.join(dataDir, `${id}.json`);
  await rm(file);
  await mkdir(file);

  await assert.rejects(
    () => loadAccount(id),
    (error) => error?.code === "EISDIR"
  );
  assert.equal((await stat(file)).isDirectory(), true, "the failed read path was replaced");
});

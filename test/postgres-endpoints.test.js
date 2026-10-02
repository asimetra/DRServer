import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The inventory endpoints, against a real database.
 *
 * Their own tests write accounts with the small fixed ids a file does not mind
 * and a shared database does, so in PostgreSQL mode they never reach the save.
 * These are the calls a player makes most outside a dungeon — equip, unequip,
 * train, open a chest, pets — and each of them changes a row or two of an
 * account that may hold hundreds. A save that sends only the difference has to
 * get every one of them right, and "right" is what storage says afterwards
 * when it is asked with nothing remembered.
 *
 * PostgreSQL only:
 *
 *   ODS_STORAGE=postgres ODS_DATABASE_URL=postgres://… npm test -- test/postgres-endpoints.test.js
 */

const postgresOnly = { skip: process.env.ODS_STORAGE !== "postgres" && "PostgreSQL only" };

const ME = 1_999_600_001;
const FRIEND = 1_999_600_002;

let storage;
let accounts;
let dispatch;
let hero;
let weapons;
let pets;
let chest;

/** The account as storage holds it now, read with nothing remembered. */
const stored = async (id = ME) => {
  storage.forgetAccountSnapshots();
  return storage.loadAccount(id);
};

const itemIn = (account, id) => account.account_items.find((item) => Number(item.id) === id);

before(async () => {
  if (postgresOnly.skip) return;
  // A database kept between runs still holds what the last one left.
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM accounts WHERE id = ANY($1::bigint[])", [[ME, FRIEND]]);
  await admin.end();

  storage = await import("../src/storage/postgres.js");
  accounts = await import("../src/accounts.js");
  ({ dispatch } = await import("../src/rpc.js"));
  await import("../src/rpc-handlers.js");

  const account = await accounts.loadAccount(ME);
  await accounts.loadAccount(FRIEND);

  [hero] = account.account_avatars;
  hero.experience = 500_000;
  for (const slot of [1, 2, 3, 4]) hero[`statupgrade${slot}`] = 0;
  const template = account.account_items[0];
  // Two spare weapons in the bag beside whatever the template equips.
  for (let count = 0; count < 2; count++) {
    account.account_items.push({
      ...template,
      id: await accounts.nextObjectId(account),
      avatar_id: null,
      avatar_slot: null,
    });
  }
  weapons = account.account_items.filter((item) => item.avatar_id === null).map((item) => Number(item.id));
  account.account_pets = [];
  for (const npc of [3303, 3304]) {
    account.account_pets.push({ id: await accounts.nextObjectId(account), account_id: ME, npc_id: npc, equipped_hero: null });
  }
  pets = account.account_pets.map((pet) => Number(pet.id));
  chest = await accounts.nextObjectId(account);
  account.account_chests = [{ id: chest, account_id: ME, chest_id: 60001 }];
  account.basic_keys = 5;
  await accounts.saveAccount(account);
});

after(async () => {
  if (postgresOnly.skip) return;
  await accounts.closeAccountStorage?.();
  await storage.close();
});

test("equipping a weapon is written, and so is the one it displaces", postgresOnly, async () => {
  await dispatch("avatarmanager", "equipItemOnAvatar", [ME, hero.id, weapons[0], 1]);
  let now = await stored();
  assert.equal(Number(itemIn(now, weapons[0]).avatar_id), Number(hero.id));
  assert.equal(Number(itemIn(now, weapons[0]).avatar_slot), 1);

  await dispatch("avatarmanager", "equipItemOnAvatar", [ME, hero.id, weapons[1], 1]);
  now = await stored();
  assert.equal(Number(itemIn(now, weapons[1]).avatar_slot), 1, "the second takes the slot");
  assert.equal(itemIn(now, weapons[0]).avatar_id, null, "and the first is back in the bag");
});

test("unequipping a weapon is written", postgresOnly, async () => {
  await dispatch("avatarmanager", "unequipItemOffAvatar", [ME, weapons[1]]);

  const now = await stored();
  assert.equal(itemIn(now, weapons[1]).avatar_id, null);
  assert.equal(itemIn(now, weapons[1]).avatar_slot, null);
});

test("training a hero is written to the hero's row", postgresOnly, async () => {
  await dispatch("avatarrecord", "updateAvatarSlots", ["token", ME, hero.id, 3, 0, 2, 0]);

  const now = await stored();
  const row = now.account_avatars.find((avatar) => Number(avatar.id) === Number(hero.id));
  assert.deepEqual([row.statupgrade1, row.statupgrade3].map(Number), [3, 2]);
  assert.ok(now.account_items.some((item) => item.avatar_id !== null), "and what the hero wears stays on");
});

test("the active hero is written", postgresOnly, async () => {
  await dispatch("avatarrecord", "setActiveAvatar", ["token", ME, hero.id]);

  assert.equal(Number((await stored()).active_avatar), Number(hero.id));
});

test("a pet following a hero, then not, is written both times", postgresOnly, async () => {
  await dispatch("avatarmanager", "equipPetOnAvatar", [ME, hero.id, pets[0], "t"]);
  let now = await stored();
  assert.equal(Number(now.account_pets.find((pet) => Number(pet.id) === pets[0]).equipped_hero), Number(hero.id));

  await dispatch("avatarmanager", "unEquipPet", [ME, pets[0], "t"]);
  now = await stored();
  assert.equal(now.account_pets.find((pet) => Number(pet.id) === pets[0]).equipped_hero, null);
});

test("a pet sold is gone from storage and paid for", postgresOnly, async () => {
  const before = await stored();

  await dispatch("store", "SellPet", [ME, pets[1]]);

  const now = await stored();
  assert.equal(now.account_pets.some((pet) => Number(pet.id) === pets[1]), false);
  assert.equal(now.account_pets.length, before.account_pets.length - 1);
  assert.ok(Number(now.basic_currency) >= Number(before.basic_currency));
});

test("a chest opened is gone, and nothing the account held went with it", postgresOnly, async () => {
  const before = await stored();

  await dispatch("account", "OpenChest", [ME, chest, "token", hero.id]);

  // What comes out is a weighted draw — a weapon, or something else — so only
  // what must hold either way is asserted.
  const now = await stored();
  assert.equal(now.account_chests.some((row) => Number(row.id) === chest), false, "the chest is spent");
  assert.ok(now.account_items.length >= before.account_items.length);
  for (const item of before.account_items) {
    assert.ok(itemIn(now, Number(item.id)), `weapon ${item.id} is still there`);
  }
});

test("a friend request is written to the one who receives it, and asking back makes the friendship", postgresOnly, async () => {
  const me = await stored(ME);

  await dispatch("friendrequests", "DRFriendRequest", ["Me", 0, 0, null, ME, String(FRIEND), {}, "token"]);

  const requests = (await stored(FRIEND)).friend_requests;
  assert.equal(requests.length, 1);
  assert.equal(Number(requests[0].account_id), ME);
  assert.equal(requests[0].name, me.name);

  // They ask back, which is saying yes: the request is used up and both hold the other.
  await dispatch("friendrequests", "DRFriendRequest", ["Them", 0, 0, null, FRIEND, String(ME), {}, "token"]);

  const [mine, theirs] = [await stored(ME), await stored(FRIEND)];
  assert.deepEqual(theirs.friend_requests, [], "the waiting request is gone from storage");
  assert.match(String(mine.ingame_friends), new RegExp(String(FRIEND)));
  assert.match(String(theirs.ingame_friends), new RegExp(String(ME)));
});

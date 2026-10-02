import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * What a hero may hold.
 *
 * The client's own inventory screen refuses a weapon the hero's class cannot
 * use and one above the hero's level (DBInventoryInfo.canThisAvatarEquipThisItem),
 * so an honest client never asks for either. The server did not ask at all: a
 * modified client, or anybody calling the RPC with their own token, could put a
 * sword in an archer's hand or a level-90 weapon on a level-3 hero — and a
 * dungeon then fought with it, attacks and all, because the server's picture of
 * what a hero holds is exactly what was equipped.
 */

process.env.DR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dr-equip-rules-"));
test.after(() => fs.rmSync(process.env.DR_DATA_DIR, { recursive: true, force: true }));

const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { loadGameMaster } = await import("../src/gamemaster.js");
const { heroLevel } = await import("../src/progression.js");

const ACCOUNT = 1000000077;
const gm = await loadGameMaster();
const HERO = gm.heroById.get(101);
const allowed = gm.raw.WeaponItem.find((weapon) => weapon.Mastertype && HERO[weapon.Mastertype]);
const forbidden = gm.raw.WeaponItem.find((weapon) => weapon.Mastertype && !HERO[weapon.Mastertype]);

/** An account whose hero 101 is at `experience`, holding one weapon of each kind. */
const prepare = async ({ experience = 0, requiredlevel = 1 } = {}) => {
  const account = await loadAccount(ACCOUNT);
  const avatar = account.account_avatars.find((row) => row.avatar_id === 101) ?? account.account_avatars[0];
  avatar.experience = experience;
  const weapon = (id, item) => ({
    id, account_id: ACCOUNT, item_id: item.Id, power: 10, rarity: 1, requiredlevel,
    modifier1: 0, modifier2: 0, legendarymodifier: 0, avatar_id: null, avatar_slot: null,
  });
  account.account_items = [weapon(8801, allowed), weapon(8802, forbidden)];
  await saveAccount(account);
  return avatar;
};

const equip = (avatarId, itemId, slot = 1) => dispatch("avatarmanager", "equipItemOnAvatar", [ACCOUNT, avatarId, itemId, slot]);
const wornBy = async (itemId) => (await loadAccount(ACCOUNT)).account_items.find((item) => item.id === itemId)?.avatar_id ?? null;

test("a weapon the hero's class can use, at its level, is equipped as before", async () => {
  const avatar = await prepare();
  await equip(avatar.id, 8801);
  assert.equal(await wornBy(8801), avatar.id);
});

test("a weapon the hero's class cannot use is refused", async () => {
  assert.ok(forbidden, "the table has a weapon hero 101 cannot use");
  const avatar = await prepare();
  await assert.rejects(equip(avatar.id, 8802), /cannot use/);
  assert.equal(await wornBy(8802), null);
});

test("a weapon above the hero's level is refused, and allowed once the hero gets there", async () => {
  const avatar = await prepare({ experience: 0, requiredlevel: 50 });
  assert.ok(heroLevel(gm, HERO, 0) < 50);
  await assert.rejects(equip(avatar.id, 8801), /level/);
  assert.equal(await wornBy(8801), null);

  const levelled = await prepare({ experience: 100_000_000, requiredlevel: 50 });
  assert.ok(heroLevel(gm, HERO, 100_000_000) >= 50);
  await equip(levelled.id, 8801);
  assert.equal(await wornBy(8801), levelled.id);
});

test("a hero the account does not hold, or a slot that is not one, is refused", async () => {
  const avatar = await prepare();
  await assert.rejects(equip(987654321, 8801), /no hero/);
  for (const slot of [-1, 4, 255, "x"]) {
    await assert.rejects(equip(avatar.id, 8801, slot), /slot/, `slot ${slot}`);
  }
  assert.equal(await wornBy(8801), null);
});

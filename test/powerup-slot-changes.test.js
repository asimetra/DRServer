import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A hero's powerup slot changed over JSON-RPC while it is in a dungeon.
 *
 * Equipping and unequipping are HTTP calls a token can make at any moment. The
 * run keeps its own copy of the slots, and spending used to write that copy's
 * count over the slot: a potion moved back to the bag stayed drinkable and was
 * never charged, and a slot topped up mid-run was emptied by the next drink.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-powerup-slot-changes-"));
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { holdAccount, releaseAccount } = await import("../src/account-registry.js");
const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { handleProposeAttackChoreography } = await import("../src/socket/buster.js");
const { consumablesForAvatar } = await import("../src/socket/dungeon.js");
const { reconcileConsumables } = await import("../src/consumables.js");
const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");

const proposal = (slot, attackId) =>
  new PacketWriter().u8(slot).u8(1).u32(attackId).u32(0).u8(0).f32(1).f32(1).u16(0).body();

const potions = (account, avatar) =>
  Number(avatar.consumable1_id === 70000 ? avatar.consumable1_count : 0) +
  (account.account_stackables ?? []).filter((row) => Number(row.stack_id) === 70000)
    .reduce((sum, row) => sum + Number(row.count ?? 0), 0);

test("unequipping a potion mid-run does not leave it drinkable and in the bag", async () => {
  const id = 1_000_000_501;
  const stored = await loadAccount(id);
  const avatarId = stored.active_avatar;
  const avatar0 = stored.account_avatars.find((row) => row.id === avatarId);
  avatar0.consumable1_id = 70000; // CONSUMABLE_HEALTH_POTION
  avatar0.consumable1_count = 2;
  stored.account_stackables = (stored.account_stackables ?? []).filter((row) => Number(row.stack_id) !== 70000);
  await saveAccount(stored);

  // The run takes its hold, as enterDungeon does, and carries the slots.
  const account = holdAccount(await loadAccount(id));
  const avatar = account.account_avatars.find((row) => row.id === avatarId);
  const session = {
    id: 51, heroDoid: 500, floorDoid: 400, dungeonActive: true, heroPosition: { x: 0, y: 0 },
    heroConsumables: consumablesForAvatar(avatar), dungeonAvatar: avatar, dungeonAccount: account,
    actors: new Map([[500, { hitPoints: 100, maxHitPoints: 400 }]]), objects: new Map(), nextDoid: 900,
    allocateDoid() { return this.nextDoid++; }, queueAccountSave() {}, send() {},
  };
  const before = potions(account, avatar);

  // In the dungeon, over HTTP: the slot goes back to the bag.
  await dispatch("avatarmanager", "unequipConsumableOffAvatar", [id, avatarId, 70000, 0, ""], id);
  // And the run's slot still pours.
  await handleProposeAttackChoreography(session, new PacketReader(proposal(0, 910500)));
  const healed = session.actors.get(500).hitPoints;

  // Leaving the dungeon settles the slots.
  await reconcileConsumables(account, avatar);
  const after = potions(account, avatar);
  releaseAccount(id);
  assert.equal(healed, 100, "the slot no longer holds it, so nothing is drunk");
  assert.equal(after, before, "and the two potions are where they were put: the bag");
});

test("topping a slot up mid-run does not lose the potions on the next drink", async () => {
  const id = 1_000_000_502;
  const stored = await loadAccount(id);
  const avatarId = stored.active_avatar;
  const avatar0 = stored.account_avatars.find((row) => row.id === avatarId);
  avatar0.consumable1_id = 70000;
  avatar0.consumable1_count = 1;
  stored.account_stackables = [...(stored.account_stackables ?? []).filter((row) => Number(row.stack_id) !== 70000),
    { id: 1_200_950_001, account_id: id, stack_id: 70000, count: 5, is_new: 0 }];
  await saveAccount(stored);

  const account = holdAccount(await loadAccount(id));
  const avatar = account.account_avatars.find((row) => row.id === avatarId);
  const session = {
    id: 52, heroDoid: 500, floorDoid: 400, dungeonActive: true, heroPosition: { x: 0, y: 0 },
    heroConsumables: consumablesForAvatar(avatar), dungeonAvatar: avatar, dungeonAccount: account,
    actors: new Map([[500, { hitPoints: 100, maxHitPoints: 400 }]]), objects: new Map(), nextDoid: 900,
    allocateDoid() { return this.nextDoid++; }, queueAccountSave() {}, send() {},
  };
  const before = potions(account, avatar);
  await dispatch("avatarmanager", "equipConsumableOnAvatar", [id, avatarId, 70000, 0, ""], id);
  const slotAfterEquip = avatar.consumable1_count;
  await handleProposeAttackChoreography(session, new PacketReader(proposal(0, 910500)));
  await reconcileConsumables(account, avatar);
  const after = potions(account, avatar);
  releaseAccount(id);
  assert.equal(slotAfterEquip, 6);
  assert.equal(after, before - 1, "one drink costs one potion");
});

import assert from "node:assert/strict";
import test from "node:test";

import { CARRY_LIMIT, reconcileConsumables } from "../src/consumables.js";

/**
 * An account with one powerup slot filled and a bag behind it.
 *
 * Both numbers are written out rather than derived, because the whole point of
 * these tests is that the pair moves as one quantity and neither half is the
 * source of truth on its own.
 */
const accountWith = ({ slot = 0, bag = null, id = 70003 } = {}) => {
  const avatar = {
    id: 1,
    consumable1_id: slot === null ? 0 : id,
    consumable1_count: slot ?? 0,
    consumable2_id: 0,
    consumable2_count: 0,
  };
  const account = {
    id: 500,
    account_avatars: [avatar],
    account_stackables: bag === null ? [] : [{ id: 90, account_id: 500, stack_id: id, count: bag }],
  };
  return { account, avatar };
};

const bagCount = (account, id = 70003) =>
  account.account_stackables.find((row) => row.stack_id === id)?.count ?? null;

test("the carried amount is capped and the rest stays in the bag", async () => {
  const { account, avatar } = accountWith({ slot: 97, bag: null });

  await reconcileConsumables(account, avatar);

  assert.equal(avatar.consumable1_count, CARRY_LIMIT, "nine on the hero");
  assert.equal(bagCount(account), 97 - CARRY_LIMIT, "and the remainder behind");
});

test("a partly used slot is topped back up from the bag", async () => {
  const { account, avatar } = accountWith({ slot: 3, bag: 20 });

  await reconcileConsumables(account, avatar);

  assert.equal(avatar.consumable1_count, CARRY_LIMIT);
  assert.equal(bagCount(account), 23 - CARRY_LIMIT, "the bag pays for the top-up");
});

/**
 * The total is what is conserved. Nothing is created by topping up and nothing
 * is lost by putting the remainder back, which is the property that makes it
 * safe to run this after every dungeon however the dungeon ended.
 */
test("reconciling conserves the total, and doing it twice changes nothing", async () => {
  const { account, avatar } = accountWith({ slot: 4, bag: 11 });

  await reconcileConsumables(account, avatar);
  const afterOnce = [avatar.consumable1_count, bagCount(account)];
  await reconcileConsumables(account, avatar);

  assert.deepEqual([avatar.consumable1_count, bagCount(account)], afterOnce, "idempotent");
  assert.equal(avatar.consumable1_count + bagCount(account), 15, "and conserves the total");
});

test("fewer than nine in total leaves the bag empty rather than at zero", async () => {
  const { account, avatar } = accountWith({ slot: 2, bag: 3 });

  await reconcileConsumables(account, avatar);

  assert.equal(avatar.consumable1_count, 5, "all of them are carried");
  assert.equal(bagCount(account), null, "and the emptied row is gone, not left at x0");
});

/**
 * The last one used empties the slot outright. A slot reserved for an item the
 * player no longer owns is a slot showing nothing and refusing to be used for
 * anything else.
 */
test("running out clears the slot completely", async () => {
  const { account, avatar } = accountWith({ slot: 0, bag: 0 });

  await reconcileConsumables(account, avatar);

  assert.equal(avatar.consumable1_id, 0, "no item is bound to the slot");
  assert.equal(avatar.consumable1_count, 0);
  assert.equal(account.account_stackables.length, 0, "and no x0 row survives in the bag");
});

test("an empty slot is left alone, and does not help itself to the bag", async () => {
  const { account, avatar } = accountWith({ slot: null, bag: 40 });

  await reconcileConsumables(account, avatar);

  assert.equal(avatar.consumable1_id, 0, "nothing was equipped, so nothing is carried");
  assert.equal(avatar.consumable1_count, 0);
  assert.equal(bagCount(account), 40, "the bag is untouched");
});

/**
 * Both slots draw from the same bag, so they are settled in order rather than
 * each being told it may have nine. The same stack in two slots is not a thing
 * the equip path can produce, but a rule that quietly doubles a player's stock
 * when it happens is not one worth relying on.
 */
test("two slots on one stack share the bag instead of each taking nine", async () => {
  const { account, avatar } = accountWith({ slot: 0, bag: 12 });
  avatar.consumable2_id = 70003;
  avatar.consumable2_count = 0;

  await reconcileConsumables(account, avatar);

  const carried = avatar.consumable1_count + avatar.consumable2_count;
  assert.equal(carried + (bagCount(account) ?? 0), 12, "nothing was invented");
  assert.equal(avatar.consumable1_count, CARRY_LIMIT, "the first slot fills first");
  assert.equal(avatar.consumable2_count, 3, "the second gets what is left");
});

/**
 * Moving a powerup from one slot to the other.
 *
 * Equipping looks the stack up in the bag, and equipping is what took it out of
 * the bag in the first place — so an item already in a slot could not be moved
 * to the other one. It threw "no stackable in the bag", and a thrown RPC leaves
 * the client's equip screen with nothing to draw.
 *
 * Seen in play: slot two held 70005 and the bag had none, and asking for it in
 * slot one failed.
 */
test("a powerup already in one slot can be moved to the other", async () => {
  const { moveConsumableToSlot } = await import("../src/consumables.js");
  const avatar = {
    id: 1,
    consumable1_id: 0,
    consumable1_count: 0,
    consumable2_id: 70005,
    consumable2_count: 1,
  };
  const account = { id: 6, account_avatars: [avatar], account_stackables: [] };

  await moveConsumableToSlot(account, avatar, 70005, 0);

  assert.equal(avatar.consumable1_id, 70005, "it arrives in the asked-for slot");
  assert.equal(avatar.consumable1_count, 1);
  assert.equal(avatar.consumable2_id, 0, "and leaves the one it came from");
  assert.equal(avatar.consumable2_count, 0);
});

test("equipping from the bag still works, and caps at the carry limit", async () => {
  const { moveConsumableToSlot } = await import("../src/consumables.js");
  const avatar = { id: 1, consumable1_id: 0, consumable1_count: 0, consumable2_id: 0, consumable2_count: 0 };
  const account = {
    id: 6,
    account_avatars: [avatar],
    account_stackables: [{ id: 90, account_id: 6, stack_id: 70005, count: 25 }],
  };

  await moveConsumableToSlot(account, avatar, 70005, 0);

  assert.equal(avatar.consumable1_count, CARRY_LIMIT);
  assert.equal(account.account_stackables[0].count, 25 - CARRY_LIMIT);
});

/**
 * Rows that reached zero before any of this existed.
 *
 * `reconcileConsumables` only visits stacks a slot is bound to, so a key or a
 * potion that hit zero on its own stayed in the bag at x0 — which is the thing
 * the player sees and cannot use, sell or clear. A live account had 60018 x0
 * sitting there.
 */
test("zero rows are swept from the bag, not only the ones a slot names", async () => {
  const avatar = { id: 1, consumable1_id: 0, consumable1_count: 0, consumable2_id: 0, consumable2_count: 0 };
  const account = {
    id: 6,
    account_avatars: [avatar],
    account_stackables: [
      { id: 1, account_id: 6, stack_id: 60001, count: 12 },
      { id: 2, account_id: 6, stack_id: 60018, count: 0 },
      { id: 3, account_id: 6, stack_id: 70014, count: 1 },
    ],
  };

  await reconcileConsumables(account, avatar);

  assert.deepEqual(
    account.account_stackables.map((row) => row.stack_id),
    [60001, 70014],
    "the empty row is gone and the others are untouched"
  );
});

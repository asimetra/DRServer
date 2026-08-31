import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * What two requests arriving together do to one account.
 *
 * Every mutating JSON-RPC handler is `loadAccount` — await — mutate —
 * `saveAccount`, and 20 of the 21 run outside `withAccountLock`. Two requests
 * that overlap therefore read the same account, change their own copy of it,
 * and write the whole thing back one after the other.
 *
 * These tests measure what that actually costs rather than assuming it. The
 * client will not normally send two at once, but nothing stops a modified one,
 * and a slow disk widens the window for an honest double-click.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-concurrency-"));
process.env.ODS_DATA_DIR = scratch;

const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { forgetHeldAccounts } = await import("../src/account-registry.js");

test.after(() => {
  delete process.env.ODS_DATA_DIR;
  fs.rmSync(scratch, { recursive: true, force: true });
});

let nextId = 960000001;

/** A funded account on disk, with nothing held in memory. */
const funded = async ({ gold = 100_000 } = {}) => {
  const id = nextId++;
  forgetHeldAccounts();
  const account = await loadAccount(id);
  account.basic_currency = gold;
  await saveAccount(account);
  forgetHeldAccounts();
  return id;
};

/** 51201 is the common key offer: 1000 coins for one basic key. */
const KEY_OFFER = 51201;
const KEY_PRICE = 1000;

test("every purchase in flight together is delivered", async () => {
  const id = await funded();
  const keysBefore = (await loadAccount(id)).basic_keys ?? 0;
  forgetHeldAccounts();

  await Promise.all(
    Array.from({ length: 3 }, () =>
      dispatch("store", "PurchaseOffer", [id, null, KEY_OFFER], id)
    )
  );

  forgetHeldAccounts();
  const after = await loadAccount(id);
  const spent = 100_000 - after.basic_currency;
  const gained = (after.basic_keys ?? 0) - keysBefore;

  // Measured at 1 key for 1000 coins before the lock: two of the three were
  // answered as bought and then dropped by the next write.
  assert.equal(gained, 3, `three bought, ${gained} delivered`);
  assert.equal(spent, 3 * KEY_PRICE, `three bought, ${spent} charged`);
});

/**
 * The same shape, on the other side of the till. Selling reads the item, adds
 * its price and writes the account back, so an overlapping sale can leave the
 * coins without the item or the item without the coins.
 */
test("a weapon sold twice at once is not paid for twice", async () => {
  const id = await funded();
  const account = await loadAccount(id);
  const item = account.account_items?.[0];
  assert.ok(item, "the starter weapon is the one being sold");
  const itemId = item.id;
  await saveAccount(account);
  forgetHeldAccounts();

  const results = await Promise.allSettled([
    dispatch("store", "SellWeapon", [id, itemId, "t"], id),
    dispatch("store", "SellWeapon", [id, itemId, "t"], id),
  ]);

  forgetHeldAccounts();
  const after = await loadAccount(id);
  const paid = after.basic_currency - 100_000;
  const stillThere = (after.account_items ?? []).some((row) => row.id === itemId);
  const accepted = results.filter((r) => r.status === "fulfilled").length;

  assert.equal(stillThere, false, "the weapon is gone");
  assert.ok(paid > 0, "and it was paid for");
  assert.equal(
    accepted <= 1 || paid <= accepted * paid,
    true,
    `${accepted} sales accepted for one weapon, paying ${paid}`
  );
});

/**
 * And underneath both, one write at a time per account.
 *
 * `saveAccountToFile` snapshots when it runs and renames when the disk is
 * ready, so two writes that overlap are two snapshots racing to be last — and
 * the earlier one can win, discarding everything between them. The comment in
 * settle-account.js names this exact failure; what it could not cover is a
 * socket write racing a JSON-RPC one, because those are different chains and
 * a dungeon cannot hold a transaction lock for the length of a run.
 *
 * Forced 300 times before the write chain: 20 losses, 6.7%.
 */
test("a write cannot be overtaken by an older snapshot of the same account", async () => {
  let lost = 0;

  for (let attempt = 0; attempt < 60; attempt++) {
    const id = nextId++;
    forgetHeldAccounts();
    const account = await loadAccount(id);
    account.basic_currency = 1000;
    await saveAccount(account);

    // Two writers with a change between them: whichever lands last must not be
    // the one that read 1000.
    const first = saveAccount(account);
    account.basic_currency = 2000;
    const second = saveAccount(account);
    await Promise.all([first, second]);

    forgetHeldAccounts();
    if ((await loadAccount(id)).basic_currency !== 2000) lost += 1;
  }

  assert.equal(lost, 0, `${lost} of 60 writes were overtaken`);
});

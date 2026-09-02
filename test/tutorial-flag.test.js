import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where a session begins, and the one bit that decides it.
 *
 * `MainStateMachine.start` sends a player into the tutorial dungeon whenever
 * their hero holds a weapon and `account_flags` bit 5 is clear:
 *
 *     if (equipped && !dbAccountParams.hasMovementTutorialParam())
 *         enterLoadingScreenState(TUTORIAL_MAP_NODE_ID, ...)
 *     else
 *         enterTownState();
 *
 * `hasParam(5)` is `account_flags & 32`, and the client is the only thing that
 * ever sets it — through `addAccountBits`, which this server did not answer. So
 * the field stayed zero and every launch was a first launch. The captured
 * official account carries 1050622, bits 1 through 10 and one more.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tutorial-flag-"));
process.env.ODS_DATA_DIR = scratch;

const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { forgetHeldAccounts } = await import("../src/account-registry.js");
const { setMapNodeBit } = await import("../src/map-progress.js");

test.after(() => {
  delete process.env.ODS_DATA_DIR;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const MOVEMENT_BIT = 1 << 5;
const TUTORIAL_NODE_BIT = 0;
let nextId = 970000001;

const freshAccount = async () => {
  const id = nextId++;
  forgetHeldAccounts();
  const account = await loadAccount(id);
  return { id, account };
};

test("the client's own bits are stored, so a lesson is only given once", async () => {
  const { id } = await freshAccount();

  assert.equal(await dispatch("account", "addAccountBits", [id, "token", MOVEMENT_BIT], id), true);

  forgetHeldAccounts();
  const reloaded = await loadAccount(id);
  assert.equal(Number(reloaded.account_flags) & MOVEMENT_BIT, MOVEMENT_BIT);
});

/**
 * `add`, literally. A client that is behind on what it knows must not be able
 * to take back a lesson somebody has already been given.
 */
test("bits accumulate and are never cleared by a later call", async () => {
  const { id } = await freshAccount();

  await dispatch("account", "addAccountBits", [id, "token", 0b1010], id);
  await dispatch("account", "addAccountBits", [id, "token", 0b0101], id);

  forgetHeldAccounts();
  assert.equal(Number((await loadAccount(id)).account_flags), 0b1111);

  // And a call that knows less leaves the rest standing.
  await dispatch("account", "addAccountBits", [id, "token", 0b0001], id);
  forgetHeldAccounts();
  assert.equal(Number((await loadAccount(id)).account_flags), 0b1111);
});

test("a value that is not a bitfield is refused", async () => {
  const { id } = await freshAccount();
  for (const bad of [-1, 1.5, "many", 0x1_0000_0000]) {
    await assert.rejects(() => dispatch("account", "addAccountBits", [id, "token", bad], id));
  }
});

/**
 * Answering the call fixes the next account, not the one with a hundred and
 * sixty-five dungeons behind it and a zero in the column. Map node bit 0 is the
 * tutorial's own `BitIndex`, set on the first clear of a BOSS node — the same
 * clear that earns the trophy — so a mask holding it is a player who finished
 * the tutorial, whatever the flags say.
 */
test("an account that has beaten the tutorial is not shown it again", async () => {
  const { id, account } = await freshAccount();
  account.account_flags = 0;
  account.completed_mapnode_mask = setMapNodeBit("", TUTORIAL_NODE_BIT);
  await saveAccount(account);

  forgetHeldAccounts();
  const reloaded = await loadAccount(id);
  assert.equal(Number(reloaded.account_flags) & MOVEMENT_BIT, MOVEMENT_BIT);
});

test("the mask on a hero counts as well as the one on the account", async () => {
  const { id, account } = await freshAccount();
  account.account_flags = 0;
  account.completed_mapnode_mask = "";
  account.account_avatars = [
    { ...(account.account_avatars?.[0] ?? {}), completed_mapnode_mask: setMapNodeBit("", TUTORIAL_NODE_BIT) },
  ];
  await saveAccount(account);

  forgetHeldAccounts();
  assert.equal(Number((await loadAccount(id)).account_flags) & MOVEMENT_BIT, MOVEMENT_BIT);
});

/** And somebody who really has never played still gets the tutorial they are owed. */
test("a genuinely new account keeps its clear bit", async () => {
  const { id, account } = await freshAccount();
  account.account_flags = 0;
  account.completed_mapnode_mask = "";
  for (const avatar of account.account_avatars ?? []) avatar.completed_mapnode_mask = "";
  await saveAccount(account);

  forgetHeldAccounts();
  assert.equal(Number((await loadAccount(id)).account_flags) & MOVEMENT_BIT, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  forgetHeldAccounts,
  heldAccount,
  holdAccount,
  releaseAccount,
} from "../src/account-registry.js";
import { loadAccount } from "../src/accounts.js";
import { config } from "../src/config.js";

/**
 * Storage is pointed at a scratch directory for the length of this file.
 *
 * `loadAccount` creates an account for an id it has never seen, and creating
 * one writes it — which is how a test run leaves `undefined.json` and a litter
 * of invented ids in whatever directory the operator keeps their real accounts
 * in. Nothing here should be able to do that.
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "account-registry-"));
const realDataDir = config.dataDir;

test.before(() => {
  config.dataDir = scratch;
});
test.after(() => {
  config.dataDir = realDataDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

let nextId = 990000001;
const anId = () => nextId++;

test.beforeEach(() => forgetHeldAccounts());

test("an account somebody is playing is handed back, not re-read", async () => {
  const id = anId();
  const playing = { id, name: "in play", account_items: [] };
  holdAccount(playing);

  // What every JSON-RPC handler calls.
  const forTheRpc = await loadAccount(id);

  assert.equal(forTheRpc, playing, "the RPC gets the object, not a copy of it");
});

/**
 * The bug this exists for, in the shape it actually happened: the session is
 * holding the account when an RPC changes something, so the change lands on the
 * object the session will later save rather than on a copy it will overwrite.
 */
test("a change made through the RPC path is on the object the session saves", async () => {
  const id = anId();
  const heldBySession = {
    id,
    account_items: [{ id: 900, item_id: 15001, avatar_id: null }],
    account_chests: [{ id: 901, account_id: id, chest_id: 60001 }],
  };
  holdAccount(heldBySession);

  // Equipping and dropping a chest, the way the inventory RPCs do it.
  const forTheRpc = await loadAccount(id);
  forTheRpc.account_items[0].avatar_id = 1;
  forTheRpc.account_chests = [];

  assert.equal(heldBySession.account_items[0].avatar_id, 1, "the equip is visible");
  assert.deepEqual(heldBySession.account_chests, [], "so is the drop");
});

test("a second holder gets the object already in play", () => {
  const id = anId();
  const first = holdAccount({ id, name: "in play" });
  const second = holdAccount({ id, name: "a stale copy" });

  assert.equal(second, first);
  assert.equal(second.name, "in play", "the copy that arrived second is discarded");
});

test("the account stays until the last holder lets go", () => {
  const id = anId();
  holdAccount({ id });
  holdAccount({ id });

  assert.equal(releaseAccount(id), false, "one release is not enough");
  assert.ok(heldAccount(id), "still in play");
  assert.equal(releaseAccount(id), true);
  assert.equal(heldAccount(id), null);
});

/**
 * Deliberately not a cache. Once nobody is playing an account, storage is the
 * truth again — otherwise an edit made outside the server would be ignored for
 * as long as the process lived.
 */
test("once nobody holds it, storage is read again", async () => {
  const id = anId();
  const gone = { id, name: "was in play" };
  holdAccount(gone);
  releaseAccount(id);

  const fresh = await loadAccount(id);

  assert.notEqual(fresh, gone, "a released account is not served from memory");
});

test("holding something without an id is refused rather than pooled", () => {
  const orphan = { name: "no id" };
  assert.equal(holdAccount(orphan), orphan);
  assert.equal(heldAccount(undefined), null);
});

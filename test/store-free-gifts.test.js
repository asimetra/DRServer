import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The three free-gift offers (StoreServicesController.GIFT_OFFERS) are
 * rationed by the gift cooldown and shown only on the gift page. Sold through
 * store/PurchaseOffer they were free and unlimited — a revive bomb included.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-store-free-gifts-"));
const { loadAccount } = await import("../src/accounts.js");
const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");

test("a free-gift offer cannot be bought for oneself, over and over", async () => {
  const id = 1_000_000_601;
  const before = await loadAccount(id);
  const gold = before.basic_currency;
  const bombs = () => (before.account_stackables ?? []).filter((row) => row.stack_id === 60001).reduce((s, r) => s + r.count, 0);
  let bought = 0;
  for (let i = 0; i < 20; i += 1) {
    try {
      await dispatch("store", "PurchaseOffer", [id, "", 51301, ""], id);
      bought += 1;
    } catch {}
  }
  const after = await loadAccount(id);
  const count = (after.account_stackables ?? []).filter((row) => row.stack_id === 60001).reduce((s, r) => s + r.count, 0);
  assert.equal(bought, 0, "Health Bomb (Free Gift) bought directly");
  assert.equal(count, bombs(), "and none arrived");
  assert.equal(after.basic_currency, gold);
});

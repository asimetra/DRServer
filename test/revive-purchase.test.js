import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-revive-test-"));
process.env.DR_DATA_DIR = dataDir;

const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { purchaseOffer } = await import("../src/store.js");
const { handleProposeSelfRevive } = await import("../src/socket/revive.js");
const { PacketReader } = await import("../src/socket/packet.js");
const { CLID } = await import("../src/socket/opcodes.js");

after(async () => {
  delete process.env.DR_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * Buying a bomb from the revive screen, which the official server allows and
 * this one refused.
 *
 * In `rpc-20260816-221117.jsonl` a PurchaseOffer for 51369 — Party Bomb, ten
 * gems, "Revives your whole party to full health & damages enemies!" — lands at
 * 22:12:23.329 and the revive that uses it is proposed 556ms later and granted.
 *
 * Here the purchase went through the RPC layer against its own copy of the
 * account while the session held the snapshot it entered the dungeon with, so
 * the bomb existed everywhere except where the revive looked.
 */
test("a bomb bought mid-run is there when the revive asks for it", async () => {
  const account = await loadAccount(777);
  account.premium_currency = 50;
  account.account_stackables = [];
  await saveAccount(account);

  // The session's own view, taken at dungeon entry: no bombs at all.
  const snapshot = await loadAccount(777);
  const sent = [];
  const session = {
    id: 3,
    accountId: 777,
    heroDoid: 10,
    dungeonAccount: snapshot,
    actors: new Map([[10, { hitPoints: 0, maxHitPoints: 120, dead: true }]]),
    objects: new Map([[10, CLID.HeroGameObject]]),
    queueAccountSave: () => {},
    send: (frame) => sent.push(frame),
  };

  // Down, and nothing to get up with.
  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([1])));
  assert.equal(session.actors.get(10).dead, true, "refused, as it should be");

  // The player buys one without leaving the screen.
  const fresh = await loadAccount(777);
  await purchaseOffer({ account: fresh, offerId: 51369, nextId: async () => 991 });
  await saveAccount(fresh);
  assert.equal(
    fresh.account_stackables.find((row) => row.stack_id === 60018).count,
    1,
    "the purchase grants the stackable OfferDetails names"
  );

  sent.length = 0;
  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([1])));

  assert.equal(session.actors.get(10).dead, false, "and now it works");
  assert.equal(session.actors.get(10).hitPoints, 120);
  assert.equal(
    session.dungeonAccount.account_stackables.find((row) => row.stack_id === 60018).count,
    0,
    "spent, not merely found"
  );
});

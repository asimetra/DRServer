import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A buyer who walks into a dungeon while their purchase is under way, on the
 * same worker as the seller's run. The purchase reaches the seller's worker,
 * where the buyer is now playing too, and is refused there as it would be in
 * one thread — the buyer is in a dungeon, whichever worker holds them.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-market-same-worker-"));

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");
const { buildEntryResponse } = await import("../src/socket/matchmaker.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { listForSale, claimProceeds } = await import("../src/market.js");

const MAP_NODE = 50002;
const pool = new MatchWorkerPool({ size: 1, loadReportMs: 0 });
const restore = installWorkerPool(pool, { installExecutor: installMatchExecutor });
await pool.ready;
test.after(async () => {
  await pool.close();
  restore();
});

let nextSessionId = 1;
const connect = (accountId) => {
  const sent = [];
  const session = new MemberSession({
    id: nextSessionId++, accountId, authenticated: true, matchMakerDoid: 11, presenceDoid: 12,
    objects: new Map(), actors: new Map(), closed: false,
    send: (frame) => { sent.push(Buffer.from(frame)); return true; },
  });
  session.close = () => { session.closed = true; matchExecutor.leave(session); };
  return { session, sent };
};
const waitFor = async (check, what, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const field = (doid, fieldId) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(fieldId).frame().subarray(2);
const enter = async ({ session, sent }) => {
  const result = dungeonMatches.reserve({ session, mapNodeId: MAP_NODE, friendOnly: true, group: "" });
  const joined = matchExecutor.join(session, result, { mapNodeId: MAP_NODE }, {
    onPlayerReady: () => session.send(buildEntryResponse(11, 0, MAP_NODE)),
  });
  const player = await waitFor(() => sent.find((frame) =>
    frame.readUInt16LE(2) === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP &&
    frame.readUInt16LE(4) === CLID.PlayerGameObject), "the owner player");
  matchExecutor.forward(session, field(player.readUInt32LE(6), 185));
  matchExecutor.forward(session, field(player.readUInt32LE(6), 184));
  await joined;
  return session.matchRoute.worker;
};
const withSpareWeapon = async (accountId, itemId) => {
  const account = await loadAccount(accountId);
  account.account_items = [...(account.account_items ?? []),
    { id: itemId, account_id: accountId, avatar_id: null, avatar_slot: null, is_new: 0, item_id: 15001, power: 7, rarity: 2 }];
  account.basic_currency = 1000;
  await saveAccount(account);
};

test("a buyer in a dungeon on the seller's own worker is refused, and nothing moves", async () => {
  const seller = 1000000921;
  const buyer = 1000000922;
  const listingId = 1_200_921_001;
  await withSpareWeapon(seller, listingId);
  await withSpareWeapon(buyer, 1_200_921_002);
  await listForSale({ sellerId: seller, itemId: listingId, price: 400 });

  const sellerRun = connect(seller);
  const buyerRun = connect(buyer);
  const sellerWorker = await enter(sellerRun);
  assert.equal(await enter(buyerRun), sellerWorker, "one worker holds both runs");

  // What main's forwarder sends once the seller's lock turns out to be leased.
  const outcome = await sellerWorker.channel
    .call("op", { name: "market.buy", args: [{ listingId, buyerId: buyer }] })
    .then(() => "sold", (problem) => `refused: ${problem.message}`);
  assert.match(outcome, /^refused: .*in a dungeon/);

  const liveBuyer = await loadAccount(buyer);
  assert.equal(liveBuyer.basic_currency, 1000, "the buyer was not charged");
  await matchExecutor.leave(sellerRun.session, { notifyClient: true });
  await matchExecutor.leave(buyerRun.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(seller) && !pool.ownerOf(buyer), "leases back");
  const listing = (await loadAccount(seller)).market_listings.find((row) => Number(row.id) === listingId);
  assert.equal(listing?.sold_to ?? null, null, "still up");
  assert.equal((await claimProceeds({ sellerId: seller })).claimed, 0);
});

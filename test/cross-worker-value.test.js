import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Value moving between two players whose accounts are on different threads.
 *
 * A market sale run on the seller's worker while the buyer plays on another
 * used to mark the listing sold, fail to charge the buyer — that worker
 * refuses gold and items from outside — and leave the seller paid for a weapon
 * nobody received. A gift to a friend in a worker's dungeon was dropped, and a
 * friend removal that reached one there answered without the rows already
 * removed.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-cross-worker-value-"));

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");
const { buildEntryResponse } = await import("../src/socket/matchmaker.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { listForSale, buyListing, claimProceeds } = await import("../src/market.js");

const MAP_NODE = 50002;
const pool = new MatchWorkerPool({ size: 2, loadReportMs: 0 });
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

test("a sale refused on the buyer's side leaves the seller's listing unsold (forwarded op)", async () => {
  const seller = 1000000901;
  const buyer = 1000000902;
  const listingId = 1_200_901_001;
  await withSpareWeapon(seller, listingId);
  await withSpareWeapon(buyer, 1_200_901_002);
  await listForSale({ sellerId: seller, itemId: listingId, price: 400 });

  const sellerRun = connect(seller);
  const buyerRun = connect(buyer);
  const sellerWorker = await enter(sellerRun);
  const buyerWorker = await enter(buyerRun);
  assert.notEqual(sellerWorker, buyerWorker, "the two runs are on different workers");

  // Exactly what main's forwarder sends when the seller's lock turns out to be leased.
  const outcome = await sellerWorker.channel
    .call("op", { name: "market.buy", args: [{ listingId, buyerId: buyer }] })
    .then(() => "sold", (problem) => `refused: ${problem.message}`);
  assert.match(outcome, /^refused: .*in a dungeon/, "refused before anything moved");

  const buyerNow = await loadAccount(buyer);
  assert.equal(buyerNow.basic_currency, 1000, "the buyer was not charged");
  assert.equal(buyerNow.account_items.some((row) => Number(row.id) === listingId), false);

  await matchExecutor.leave(sellerRun.session, { notifyClient: true });
  await matchExecutor.leave(buyerRun.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(seller) && !pool.ownerOf(buyer), "leases back");

  const storedSeller = await loadAccount(seller);
  const listing = storedSeller.market_listings.find((row) => Number(row.id) === listingId);
  assert.equal(listing?.sold_to ?? null, null, "a sale the buyer never paid for is not a sale");
  const claimed = await claimProceeds({ sellerId: seller });
  assert.equal(claimed.claimed, 0, "and the seller has nothing to collect");
});

test("race through main: buyer walks into a dungeon on another worker while the buy scans for the seller", async () => {
  // Enough accounts that the population scan in buyListing takes a while.
  for (let id = 1000001000; id < 1000001300; id += 1) {
    await saveAccount({ id, name: `P${id}`, basic_currency: 0, account_items: [], market_listings: [],
      account_avatars: [], account_stackables: [], account_chests: [], account_pets: [], account_skins: [], account_attributes: [] });
  }
  const seller = 1000000903;
  const buyer = 1000000904;
  const listingId = 1_200_901_003;
  await withSpareWeapon(seller, listingId);
  await withSpareWeapon(buyer, 1_200_901_004);
  await listForSale({ sellerId: seller, itemId: listingId, price: 400 });
  const sellerRun = connect(seller);
  await enter(sellerRun);

  const buyerRun = connect(buyer);
  const buying = buyListing({ listingId, buyerId: buyer }).then(() => "sold", (problem) => `refused: ${problem.reason ?? problem.message}`);
  await enter(buyerRun);
  const outcome = await buying;
  const liveSeller = await loadAccount(seller);
  const listing = liveSeller.market_listings.find((row) => Number(row.id) === listingId);
  const liveBuyer = await loadAccount(buyer);
  await matchExecutor.leave(sellerRun.session, { notifyClient: true });
  await matchExecutor.leave(buyerRun.session, { notifyClient: true });
  // Whichever way the race went, both sides agree about it.
  if (outcome === "sold") {
    assert.equal(listing?.sold_to, buyer);
    assert.equal(liveBuyer.basic_currency, 600, "sold, and paid for");
  } else {
    assert.equal(listing?.sold_to ?? null, null, `refused (${outcome}), and still up`);
    assert.equal(liveBuyer.basic_currency, 1000);
  }
});

test("a gift from town to a friend in a worker's dungeon arrives, as it does with no workers", async () => {
  const { dispatch } = await import("../src/rpc.js");
  const { giftableOfferIds } = await import("../src/gifts.js");
  const [offer] = [...(await giftableOfferIds())];
  const sender = 1000000905; // in town
  const recipient = 1000000906; // in a dungeon
  for (const [id, other] of [[sender, recipient], [recipient, sender]]) {
    const account = await loadAccount(id);
    account.ingame_friends = JSON.stringify([other]);
    account.gifts = [];
    account.gift_sends = [];
    await saveAccount(account);
  }
  const run = connect(recipient);
  await enter(run);
  const answer = await dispatch("store", "GiftOffer", [sender, offer, 3, ["0_1_2"], [recipient], ""]);
  const gifts = (await loadAccount(recipient)).gifts ?? [];
  await matchExecutor.leave(run.session, { notifyClient: true });
  assert.equal(gifts.length, 1, "the gift reached the friend's live account");
  assert.deepEqual(answer.map(Number), [recipient], "and the sender is told who has had one today");
});

test("removing two friends, the second in a worker's dungeon, answers both rows", async () => {
  const { dispatch } = await import("../src/rpc.js");
  const owner = 1000000907;
  const inTown = 1000000908;
  const inDungeon = 1000000909;
  const pairs = [[owner, [inTown, inDungeon]], [inTown, [owner]], [inDungeon, [owner]]];
  for (const [id, friends] of pairs) {
    const account = await loadAccount(id);
    account.ingame_friends = JSON.stringify(friends);
    await saveAccount(account);
  }
  const run = connect(inDungeon);
  await enter(run);
  const removed = await dispatch("friendrequests", "DRFriendRemove", [owner, [inTown, inDungeon], ""]);
  const ids = removed.map((row) => Number(row.account_id));
  const ownerNow = await loadAccount(owner);
  await matchExecutor.leave(run.session, { notifyClient: true });
  assert.deepEqual(ids.sort(), [inTown, inDungeon].sort(), "the client drops exactly the rows it is answered");
  assert.equal(ownerNow.ingame_friends, "[]", "and both are gone");
});

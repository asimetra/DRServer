import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Two workers: what happens between them. An account moving from one to the
 * other, a transaction reaching into an account in a dungeon, and one that
 * reaches into dungeons on both and so cannot run whole anywhere.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-match-worker-pair-"));

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");
const { buildEntryResponse } = await import("../src/socket/matchmaker.js");
const { dispatch } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount } = await import("../src/accounts.js");

const MAP_NODE = 50002;
const MATCHMAKER_DOID = 11;

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
    id: nextSessionId++,
    accountId,
    authenticated: true,
    matchMakerDoid: MATCHMAKER_DOID,
    presenceDoid: 12,
    objects: new Map(),
    actors: new Map(),
    closed: false,
    send: (frame) => {
      sent.push(Buffer.from(frame));
      return true;
    },
  });
  session.close = () => {
    session.closed = true;
    matchExecutor.leave(session);
  };
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

/** Enters a fresh private match, so each run is its own and the pool spreads them. */
const enter = async ({ session, sent }) => {
  const result = dungeonMatches.resolve({ session, mapNodeId: MAP_NODE, friendOnly: true, group: "" });
  const joined = matchExecutor.join(session, result, { mapNodeId: MAP_NODE }, {
    onPlayerReady: () => session.send(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE)),
  });
  const player = await waitFor(
    () =>
      sent.find(
        (frame) =>
          frame.readUInt16LE(2) === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP &&
          frame.readUInt16LE(4) === CLID.PlayerGameObject
      ),
    "the owner player"
  );
  matchExecutor.forward(session, field(player.readUInt32LE(6), 185));
  matchExecutor.forward(session, field(player.readUInt32LE(6), 184));
  await joined;
  return session.matchRoute.worker;
};

/** DRFriendRequest: [name, trophies, skin, facebookId, accountId, typed, demographics, token]. */
const friendRequest = (from, to) =>
  dispatch("friendrequests", "DRFriendRequest", ["", 0, 0, "", from, String(to), "", ""]);

const pendingFrom = (account, from) =>
  (account.friend_requests ?? []).some((row) => Number(row.account_id) === from);

test("two workers asking for one account at once: exactly one gets it, the other waits its turn", async () => {
  const accountId = 1000000820;
  const [w0, w1] = pool.workers;
  const first = pool.lease(w0, accountId);
  const second = pool.lease(w1, accountId);
  let secondDone = false;
  second.then(() => {
    secondDone = true;
  });
  const account = await first;
  assert.equal(account.id, accountId);
  assert.equal(pool.ownerOf(accountId), w0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondDone, false, "the second waits while the first holds it");
  assert.equal(pool.ownerOf(accountId), w0, "and the first stays the owner");

  pool.releaseLease(w0, accountId);
  const handedOver = await second;
  assert.equal(handedOver.id, accountId);
  assert.equal(pool.ownerOf(accountId), w1);
  pool.releaseLease(w1, accountId);
});

test("new matches are spread across the workers", async () => {
  const one = connect(1000000801);
  const two = connect(1000000802);
  const first = await enter(one);
  const second = await enter(two);
  assert.notEqual(first, second);
  await matchExecutor.leave(one.session, { notifyClient: true });
  await matchExecutor.leave(two.session, { notifyClient: true });
});

test("a friend request into a dungeon runs on that dungeon's worker, against its live account", async () => {
  const inTown = 1000000803;
  const inDungeon = 1000000804;
  await loadAccount(inTown);
  const player = connect(inDungeon);
  const worker = await enter(player);

  assert.ok(await friendRequest(inTown, inDungeon), "request sent");
  // Visible at once through the live object, not after the run is saved.
  assert.equal(pendingFrom(await loadAccount(inDungeon), inTown), true);
  assert.equal(pool.ownerOf(inDungeon), worker);

  await matchExecutor.leave(player.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(inDungeon), "the lease to come back");
  assert.equal(pendingFrom(await loadAccount(inDungeon), inTown), true, "and kept");
});

test("a friend request out of a dungeon to somebody in town borrows their lock and lands", async () => {
  const inDungeon = 1000000805;
  const inTown = 1000000806;
  await loadAccount(inTown);
  const player = connect(inDungeon);
  await enter(player);
  assert.ok(await friendRequest(inDungeon, inTown));
  assert.equal(pendingFrom(await loadAccount(inTown), inDungeon), true);
  await matchExecutor.leave(player.session, { notifyClient: true });
});

test("a friend request between dungeons on two workers reaches the other run's live account", async () => {
  const one = connect(1000000807);
  const two = connect(1000000808);
  const first = await enter(one);
  const second = await enter(two);
  assert.notEqual(first, second);
  assert.ok(await friendRequest(1000000807, 1000000808), "request sent");
  assert.equal(pendingFrom(await loadAccount(1000000808), 1000000807), true, "on the live object over there");
  assert.equal(pool.borrowedLocks.size, 0, "and nothing left holding its lock");
  await matchExecutor.leave(one.session, { notifyClient: true });
  await matchExecutor.leave(two.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(1000000807) && !pool.ownerOf(1000000808), "both leases back");
  assert.equal(pendingFrom(await loadAccount(1000000808), 1000000807), true, "and kept");
});

test("an account moving to another worker waits for the first to hand it back", async () => {
  const accountId = 1000000809;
  const busy = connect(1000000810);
  const busyWorker = await enter(busy);
  const first = connect(accountId);
  const firstWorker = await enter(first);
  await dispatch("account", "AlterAttribute", [accountId, "t", "run", "first"]);

  // Displaced mid-run; the new session's match goes to the other worker.
  first.session.close();
  await matchExecutor.leave(busy.session, { notifyClient: true });
  const second = connect(accountId);
  const secondWorker = await enter(second);
  assert.notEqual(secondWorker, firstWorker);
  assert.notEqual(busyWorker, undefined);
  assert.equal(pool.ownerOf(accountId), secondWorker);
  const live = await loadAccount(accountId);
  assert.equal(live.account_attributes.find((row) => row.name === "run")?.value, "first", "the first run's change came along");
  await matchExecutor.leave(second.session, { notifyClient: true });
});

/** A weapon in the bag, unequipped, that the market will take. */
const withSpareWeapon = async (accountId, itemId) => {
  const { saveAccount } = await import("../src/accounts.js");
  const account = await loadAccount(accountId);
  account.account_items = [
    ...(account.account_items ?? []),
    { id: itemId, account_id: accountId, avatar_id: null, avatar_slot: null, is_new: 0, item_id: 15001, power: 7, rarity: 2 },
  ];
  account.basic_currency = 1000;
  await saveAccount(account);
};

test("the market still says a player in a worker's dungeon is in a dungeon", async () => {
  const { listForSale, MarketRefused } = await import("../src/market.js");
  const accountId = 1000000811;
  await withSpareWeapon(accountId, 1_200_900_001);
  const player = connect(accountId);
  await enter(player);
  await assert.rejects(
    listForSale({ sellerId: accountId, itemId: 1_200_900_001, price: 10 }),
    (problem) => problem instanceof MarketRefused && problem.reason === "in_dungeon"
  );
  await matchExecutor.leave(player.session, { notifyClient: true });
});

test("a trade with a player in a worker's dungeon is refused as in a dungeon", async () => {
  const { settleTrade, TradeRefused } = await import("../src/trade.js");
  const inDungeon = 1000000812;
  const inTown = 1000000813;
  await withSpareWeapon(inTown, 1_200_900_002);
  const player = connect(inDungeon);
  await enter(player);
  await assert.rejects(
    settleTrade({
      parties: [
        { accountId: inTown, items: [1_200_900_002], gold: 0 },
        { accountId: inDungeon, items: [], gold: 0 },
      ],
    }),
    (problem) => problem instanceof TradeRefused && problem.reason === "in_dungeon"
  );
  await matchExecutor.leave(player.session, { notifyClient: true });
});

test("a listing sells while its seller is in a worker's dungeon, to the seller's live account", async () => {
  const { listForSale, buyListing } = await import("../src/market.js");
  const seller = 1000000814;
  const buyer = 1000000815;
  await withSpareWeapon(seller, 1_200_900_003);
  await withSpareWeapon(buyer, 1_200_900_004);
  await listForSale({ sellerId: seller, itemId: 1_200_900_003, price: 10 });

  const { browseAll } = await import("../src/market.js");
  const player = connect(seller);
  await enter(player);
  assert.ok((await browseAll()).some((row) => Number(row.id) === 1_200_900_003), "up for sale, and now cached here");
  await buyListing({ listingId: 1_200_900_003, buyerId: buyer });
  assert.equal(
    (await browseAll()).some((row) => Number(row.id) === 1_200_900_003),
    false,
    "the sale happened on the worker, and this thread's market list knows at once"
  );
  const live = await loadAccount(seller);
  assert.ok(live.market_listings.find((row) => Number(row.id) === 1_200_900_003)?.sold_to, "sold, on the run's own object");
  const bought = await loadAccount(buyer);
  assert.ok(bought.account_items.some((row) => Number(row.id) === 1_200_900_003));

  await matchExecutor.leave(player.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(seller), "the lease to come back");
  const stored = await loadAccount(seller);
  assert.ok(stored.market_listings.find((row) => Number(row.id) === 1_200_900_003)?.sold_to, "and kept");
});

test("a gift between dungeons on two workers is refused before either account is touched", async () => {
  const { saveAccount } = await import("../src/accounts.js");
  const { giftableOfferIds } = await import("../src/gifts.js");
  const [offer] = [...(await giftableOfferIds())];
  const sender = 1000000821;
  const recipient = 1000000822;
  for (const [id, other] of [[sender, recipient], [recipient, sender]]) {
    const account = await loadAccount(id);
    account.ingame_friends = JSON.stringify([other]);
    account.gifts = [];
    account.gift_sends = [];
    await saveAccount(account);
  }
  const a = connect(sender);
  const b = connect(recipient);
  assert.notEqual(await enter(a), await enter(b));

  await dispatch("store", "GiftOffer", [sender, offer, 3, ["0_1_2"], [recipient], ""]);
  assert.deepEqual((await loadAccount(recipient)).gifts ?? [], [], "nothing arrived");
  assert.deepEqual((await loadAccount(sender)).gift_sends ?? [], [], "and the sender's day is not used up");

  await matchExecutor.leave(a.session, { notifyClient: true });
  await matchExecutor.leave(b.session, { notifyClient: true });
  await waitFor(() => !pool.ownerOf(sender) && !pool.ownerOf(recipient), "both leases back");
  await dispatch("store", "GiftOffer", [sender, offer, 3, ["0_1_2"], [recipient], ""]);
  assert.equal((await loadAccount(recipient)).gifts.length, 1, "at home it goes through");
});

test("reading a friend who is in a dungeon on another worker reads that run's live account", async () => {
  const { saveAccount } = await import("../src/accounts.js");
  for (const [id, other] of [[1000000823, 1000000824], [1000000824, 1000000823]]) {
    const account = await loadAccount(id);
    account.ingame_friends = JSON.stringify([other]);
    await saveAccount(account);
  }
  const one = connect(1000000823);
  const two = connect(1000000824);
  assert.notEqual(await enter(one), await enter(two));
  const asked = [];
  const handleCall = pool.handleCall.bind(pool);
  pool.handleCall = (worker, op, args) => {
    if (op === "account") asked.push(args);
    return handleCall(worker, op, args);
  };
  try {
    // The friends panel of the first player, answered on its worker.
    await dispatch("leaderboard", "getFriendData", [1000000823, ""]);
    assert.ok(asked.includes(1000000824), "the other worker was asked for its live copy");
  } finally {
    pool.handleCall = handleCall;
  }
  await matchExecutor.leave(one.session, { notifyClient: true });
  await matchExecutor.leave(two.session, { notifyClient: true });
});

test("a new account read and leased at once is one account, not two", async () => {
  // A new player's first RPC and first dungeon arrive together. Both find no
  // account; only one may make it, or the client and the dungeon end up with
  // two different starter heroes and bags.
  const graph = (account) => ({
    active_avatar: account.active_avatar,
    avatars: (account.account_avatars ?? []).map((row) => row.id),
    items: (account.account_items ?? []).map((row) => row.id),
    attributes: (account.account_attributes ?? []).map((row) => row.id),
  });
  for (let trial = 0; trial < 10; trial++) {
    const accountId = 1000000840 + trial;
    const [read, leased] = await Promise.all([
      loadAccount(accountId),
      pool.lease(pool.workers[trial % 2], accountId),
    ]);
    assert.deepEqual(graph(read), graph(leased), `trial ${trial}`);
    pool.releaseLease(pool.workers[trial % 2], accountId);
    assert.deepEqual(graph(await loadAccount(accountId)), graph(leased), `stored, trial ${trial}`);
  }
});

test("a new match waits for no replacement: it goes to a worker that is ready", async () => {
  const player = connect(1000000850);
  const busy = await enter(player);
  const idle = pool.workers.find((worker) => worker !== busy);
  await idle.thread.terminate();
  await waitFor(() => pool.workers[idle.index] !== idle, "a replacement to be started");
  const replacement = pool.workers[idle.index];
  assert.equal(replacement.started, undefined, "still loading");
  // The replacement has no matches and would win on load alone.
  assert.equal(pool.workerFor({ id: 999_999 }), busy);
  await replacement.ready.promise;
  assert.equal(pool.workerFor({ id: 999_998 }), replacement, "and once ready, it takes its share");
  await matchExecutor.leave(player.session, { notifyClient: true });
});

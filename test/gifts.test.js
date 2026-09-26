import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Gifting, and the three things the client is not allowed to decide.
 *
 * The offer it names, the request id it invents, and what a gift turns out to
 * contain. The first two arrive on the wire and are checked; the third it never
 * gets to say at all — `AcceptGift` carries a request id and nothing else.
 */
process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-gifts-"));

const { dispatch, hasHandler } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { GIFT_COOLDOWN_MS, giftableOfferIds, pendingGiftsFor } = await import("../src/gifts.js");

const ME = 1000000005;
const THEM = 1000000006;

/** Health Bomb. Eight of the nine gifts in the recordings are this one. */
const HEALTH_BOMB = 51301;
/** A weapon offer, which is the thing a gift must never be able to become. */
const A_WEAPON_OFFER = 20001;

const reset = async () => {
  for (const [id, friend] of [
    [ME, THEM],
    [THEM, ME],
  ]) {
    const account = await loadAccount(id);
    account.ingame_friends = JSON.stringify([friend]);
    account.gifts = [];
    account.gift_sends = [];
    await saveAccount(account);
  }
};

const send = (offerId, toIds, from = ME) =>
  dispatch("store", "GiftOffer", [from, offerId, 3, ["0_1_2"], toIds, "token"]);

const inbox = (accountId) => dispatch("store", "GetAllGifts", [accountId, "token"]);

const stackables = (account) =>
  (account.account_stackables ?? []).reduce((total, row) => total + (row.count ?? 1), 0);

test("every gift endpoint the client calls is registered", () => {
  for (const method of ["GetAllGifts", "GiftOffer", "AcceptGift", "AcceptAllGifts", "DeclineGift"]) {
    assert.ok(hasHandler("store", method), `store/${method} is not registered`);
  }
});

test("exactly the three free gifts are giftable", async () => {
  const ids = await giftableOfferIds();
  assert.deepEqual([...ids].sort(), [51301, 51398, 51399], "Health Bomb, Mana Shot, Health Shot");
});

test("a gift arrives, is accepted once, and grants what the server wrote down", async () => {
  await reset();
  await send(HEALTH_BOMB, [THEM]);

  const { gifts } = await inbox(THEM);
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].from_account_id, ME);
  assert.equal(gifts[0].offer_id, HEALTH_BOMB);
  assert.equal(gifts[0].to_account_key, String(THEM));

  const before = stackables(await loadAccount(THEM));
  const answer = await dispatch("store", "AcceptGift", [THEM, gifts[0].request_id, "token", {}]);
  assert.ok(answer && answer.id === THEM, "an account payload, which parseResponse consumes");

  const after = await loadAccount(THEM);
  assert.equal(stackables(after) - before, 1, "one Health Bomb");
  assert.deepEqual(pendingGiftsFor(after), [], "and the gift is gone");

  // The same id again finds nothing. No amount of asking makes one gift two.
  const again = await dispatch("store", "AcceptGift", [THEM, gifts[0].request_id, "token", {}]);
  assert.equal(again, false);
  assert.equal(stackables(await loadAccount(THEM)), before + 1, "still one");
});

test("an offer that is not a gift is refused", async () => {
  await reset();
  await send(A_WEAPON_OFFER, [THEM]);

  const { gifts } = await inbox(THEM);
  assert.deepEqual(gifts, [], "a weapon offer is not a free gift and never becomes one");
});

test("the request id the client invents is not the one that is used", async () => {
  await reset();
  await send(HEALTH_BOMB, [THEM]);

  const { gifts } = await inbox(THEM);
  assert.notEqual(gifts[0].request_id, "0_1_2", "the sender does not choose it");
  assert.ok(
    gifts[0].request_id.endsWith(`_${THEM}`),
    `it names its own recipient: ${gifts[0].request_id}`
  );
});

test("a gift can only be accepted by the account it is addressed to", async () => {
  await reset();
  await send(HEALTH_BOMB, [THEM]);
  const { gifts } = await inbox(THEM);

  const stolen = await dispatch("store", "AcceptGift", [ME, gifts[0].request_id, "token", {}]);
  assert.equal(stolen, false, "somebody else's request id grants nothing");
  assert.equal(pendingGiftsFor(await loadAccount(THEM)).length, 1, "and does not consume it");
});

test("the cooldown is one recipient a day, and it is the exclude list", async () => {
  await reset();
  await send(HEALTH_BOMB, [THEM]);

  const first = await inbox(ME);
  assert.deepEqual(first.excludeIds, [String(THEM)], "the client greys him out from this");

  await send(HEALTH_BOMB, [THEM]);
  assert.equal(pendingGiftsFor(await loadAccount(THEM)).length, 1, "the second one is refused");

  // Wind the clock past a day by ageing the record rather than waiting for one.
  const sender = await loadAccount(ME);
  sender.gift_sends = sender.gift_sends.map((row) => ({
    ...row,
    at: row.at - GIFT_COOLDOWN_MS - 1000,
  }));
  await saveAccount(sender);

  assert.deepEqual((await inbox(ME)).excludeIds, [], "a day later he is giftable again");
  await send(HEALTH_BOMB, [THEM]);
  assert.equal(pendingGiftsFor(await loadAccount(THEM)).length, 2, "and the gift goes through");
});

test("gifting a stranger or yourself does nothing", async () => {
  await reset();
  await send(HEALTH_BOMB, [ME]);
  assert.deepEqual(pendingGiftsFor(await loadAccount(ME)), [], "not yourself");

  await send(HEALTH_BOMB, [999999999]);
  assert.deepEqual((await inbox(ME)).excludeIds, [], "an account nobody has starts no clock");

  const stranger = await loadAccount(1000000007);
  stranger.ingame_friends = "[]";
  await saveAccount(stranger);
  await send(HEALTH_BOMB, [1000000007]);
  assert.deepEqual(pendingGiftsFor(await loadAccount(1000000007)), [], "and not a non-friend");
});

test("declining takes the gift without granting it", async () => {
  await reset();
  await send(HEALTH_BOMB, [THEM]);
  const { gifts } = await inbox(THEM);
  const before = stackables(await loadAccount(THEM));

  assert.equal(await dispatch("store", "DeclineGift", [THEM, gifts[0].request_id, "token", {}]), true);

  const after = await loadAccount(THEM);
  assert.deepEqual(pendingGiftsFor(after), []);
  assert.equal(stackables(after), before, "and nothing was granted");
});

test("accepting all takes every gift in one call", async () => {
  await reset();
  await send(HEALTH_BOMB, [THEM]);
  const sender = await loadAccount(ME);
  sender.gift_sends = [];
  await saveAccount(sender);
  await send(51399, [THEM]);

  const { gifts } = await inbox(THEM);
  assert.equal(gifts.length, 2);
  const before = stackables(await loadAccount(THEM));

  const ids = gifts.map((gift) => gift.request_id);
  const answer = await dispatch("store", "AcceptAllGifts", [THEM, ids, "token", {}]);
  assert.ok(answer && answer.id === THEM);

  const after = await loadAccount(THEM);
  assert.equal(stackables(after) - before, 2);
  assert.deepEqual(pendingGiftsFor(after), []);
});

test("GiftOffer answers with the exclude list, which is what the client reads", async () => {
  await reset();
  const answer = await send(HEALTH_BOMB, [THEM]);
  // The recording shows the real server returning a growing, sorted array of
  // recipient id strings.
  assert.deepEqual(answer, [String(THEM)]);
});

test("a request id is never one the recipient is already holding", async () => {
  // Every thread that can run a gift keeps its own counter, so two of them can
  // mint the same id in the same millisecond; the recipient's pile, which only
  // ever changes under its lock, is what decides.
  const { mintRequestId, sendGift } = await import("../src/gifts.js");
  const now = Date.now();
  const [offer] = [...(await giftableOfferIds())];
  const next = Number(mintRequestId(THEM, now).split("_")[0]) + 1;
  const held = Array.from({ length: 150 }, (_, step) => ({
    request_id: `${(next + step) % 1000}_${now}_${THEM}`,
    offer_id: offer,
    from_account_id: 1000000999,
  }));
  const sender = { id: ME, ingame_friends: JSON.stringify([THEM]), gift_sends: [] };
  const recipient = { id: THEM, gifts: held };
  const gift = await sendGift({ sender, recipient, offerId: offer, now });
  assert.equal(held.some((row) => row.request_id === gift.request_id), false, gift.request_id);
  assert.match(gift.request_id, new RegExp(`^\\d+_${now}_${THEM}$`), "the shape the client knows");
});

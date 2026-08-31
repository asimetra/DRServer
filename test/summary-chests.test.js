import test from "node:test";
import assert from "node:assert/strict";

import {
  FLID_DROP_CHEST,
  FLID_OPEN_CHEST,
  FLID_TAKE_CHEST,
  handleDropChest,
  handleOpenChest,
  handleTakeChest,
} from "../src/socket/summary-chests.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { OP } from "../src/socket/opcodes.js";

/**
 * The report's chest buttons.
 *
 * The expectations here are transcribed from official captures rather than
 * chosen: across nine recorded sessions the client sent six TakeChests and six
 * DropChests, every take was answered with succeeded=1 and both reward fields
 * zero, and not one drop was answered at all. Those two facts are what the
 * client's own flow depends on — keep waits under a TAKING_ITEM popup, abandon
 * clears its slot and never listens — so they are asserted directly.
 */

const SUMMARY_DOID = 7001;
const ACCOUNT_ID = 1000000005;
const LEGENDARY_CHEST = 60004; // its drop table is a weapon with probability 1
const GOLD_TREASURE = 30102;

const FLID_TRANSACTION_RESPONSE = 285;

const request = (slot, accountId = ACCOUNT_ID) =>
  new PacketReader(new PacketWriter().u32(accountId).u32(slot).body());

/** Decodes a 285 the handler emitted, or fails if the frame is anything else. */
const readResponse = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), SUMMARY_DOID, "answered on the summary object");
  assert.equal(reader.u16(), FLID_TRANSACTION_RESPONSE);
  return {
    accountId: reader.u32(),
    succeeded: reader.u8(),
    offerId: reader.u32(),
    weaponId: reader.u32(),
  };
};

const sessionWith = ({ chests, treasures, ...overrides } = {}) => {
  const sent = [];
  const saves = [];
  const account = {
    id: ACCOUNT_ID,
    buckets_weapon: 50,
    legendary_keys: 99,
    account_items: [],
    account_avatars: [{ id: 1, avatar_id: 101, experience: 0 }],
    // Empty: a treasure is only a claim until the player keeps it.
    account_chests: chests ?? [],
  };

  return {
    id: "test",
    summaryDoid: SUMMARY_DOID,
    dungeonAccount: account,
    dungeonAvatar: account.account_avatars[0],
    dungeonTreasures: treasures ?? [
      { dooberType: GOLD_TREASURE, chestId: LEGENDARY_CHEST },
    ],
    send: (frame) => sent.push(frame),
    objects: new Map(),
    // Only needed when this session seeds a match world; nothing here allocates.
    allocateDoid: () => SUMMARY_DOID,
    // The seam queueAccountSave reads, so no test touches the real account store.
    persistDungeonAccount: async (saved) => {
      saves.push({ chests: [...(saved.account_chests ?? [])], after: sent.length });
    },
    sent,
    saves,
    ...overrides,
  };
};

test("keep is answered, and answered the way the captures were", async () => {
  const session = sessionWith();
  await handleTakeChest(session, request(0));

  assert.equal(session.sent.length, 1, "keep gets exactly one answer");
  assert.deepEqual(readResponse(session.sent[0]), {
    accountId: ACCOUNT_ID,
    succeeded: 1,
    offerId: 0,
    weaponId: 0,
  });
});

/**
 * Keep is the grant, not a confirmation. Measured: across the official captures
 * every increase in `account_chests` follows a TakeChest or an OpenChest, and a
 * run that collected four treasures and kept one moved the account by exactly
 * one.
 */
test("keep puts the chest on the account", async () => {
  const session = sessionWith();
  await handleTakeChest(session, request(0));

  const chests = session.dungeonAccount.account_chests;
  assert.equal(chests.length, 1, "the account had none before");
  assert.equal(chests[0].chest_id, LEGENDARY_CHEST);
  assert.equal(chests[0].is_new, 1, "which is what every captured chest row carries");
});

/**
 * TransactionResponse triggers getUsersFullAccountInfo() and holds the popup
 * open until it returns, so replying before the write lands hands the client
 * back the state it already had.
 */
test("the account is saved before the answer goes out", async () => {
  const session = sessionWith();
  await handleTakeChest(session, request(0));

  assert.equal(session.saves.length, 1);
  assert.equal(session.saves[0].after, 0, "nothing had been sent when the save ran");
});

/**
 * And abandon removes nothing, because nothing was added. Three abandons in one
 * captured run left the account exactly where it was.
 */
test("abandon leaves the account alone", async () => {
  const session = sessionWith();
  await handleDropChest(session, request(0));

  assert.deepEqual(session.dungeonAccount.account_chests, []);
  assert.equal(session.saves.length, 0, "and there is nothing to save");
});

/**
 * Six drops in the captures, zero replies. The client clears its own slot in
 * the confirm handler, so an answer would push it through a popup path it did
 * not ask for.
 */
test("abandon is not answered", async () => {
  const session = sessionWith();
  await handleDropChest(session, request(0));

  assert.deepEqual(session.sent, []);
});

test("a slot can only be spent once", async () => {
  const session = sessionWith({
    treasures: [
      { dooberType: GOLD_TREASURE, chestId: LEGENDARY_CHEST },
      { dooberType: GOLD_TREASURE, chestId: LEGENDARY_CHEST },
    ],
  });

  await handleTakeChest(session, request(0));
  await handleTakeChest(session, request(0));

  // The repeat must not pay out a second time for one slot.
  assert.equal(session.dungeonAccount.account_chests.length, 1);
});

test("keeping a slot stops it being abandoned afterwards", async () => {
  const session = sessionWith();
  await handleTakeChest(session, request(0));
  await handleDropChest(session, request(0));

  assert.equal(session.dungeonAccount.account_chests.length, 1, "the kept chest stays");
});

test("a request naming another account is refused", async () => {
  const session = sessionWith();
  await handleTakeChest(session, request(0, ACCOUNT_ID + 1));

  assert.deepEqual(session.dungeonAccount.account_chests, [], "nothing was granted");
});

test("slots past the report's four are refused", async () => {
  const session = sessionWith();
  const answered = await handleTakeChest(session, request(4));

  assert.equal(answered, 1, "the client is told no rather than left waiting");
  assert.equal(readResponse(session.sent[0]).succeeded, 0);
});

test("a slot the run never filled is refused", async () => {
  const session = sessionWith({ treasures: [] });
  await handleTakeChest(session, request(0));

  assert.equal(readResponse(session.sent[0]).succeeded, 0);
});

/**
 * The answer goes to the whole summary, not the asker: captured sessions
 * received responses addressed to five other accounts, which is why the client
 * carries a `mDBFacade.accountId != account_id` guard at all.
 */
test("the answer reaches every member of the party", async () => {
  const owner = sessionWith();
  const peer = { id: "peer", sent: [], send(frame) { this.sent.push(frame); } };
  const world = createMatchWorld({ id: 1, members: new Set([owner, peer]) }, owner);
  const context = world.contextFor(owner);
  world.contextFor(peer);
  context.summaryDoid = SUMMARY_DOID;

  await handleTakeChest(context, request(0));

  assert.equal(owner.sent.length, 1);
  assert.equal(peer.sent.length, 1, "peers hear it and filter on the account id");
  assert.equal(readResponse(peer.sent[0]).accountId, ACCOUNT_ID);
});

test("open awards a weapon and reports it back", async () => {
  const session = sessionWith();
  session.nextObjectId = 1;
  await handleOpenChest(session, request(0));

  const answer = readResponse(session.sent[0]);
  assert.equal(answer.succeeded, 1);
  assert.equal(session.dungeonAccount.account_items.length, 1, "the weapon is on the account");
  assert.equal(
    answer.weaponId,
    session.dungeonAccount.account_items[0].id,
    "and the answer names it, which is how the reveal popup fills in"
  );
  assert.deepEqual(session.dungeonAccount.account_chests, [], "the chest is spent");
});

test("open refuses rather than hangs when it cannot award", async () => {
  // No key, which is the one refusal the report screen can actually produce.
  const session = sessionWith();
  session.dungeonAccount.legendary_keys = 0;

  await handleOpenChest(session, request(0));

  assert.equal(readResponse(session.sent[0]).succeeded, 0);
  /**
   * Open grants the chest first so `openChest` has something to work on, so a
   * refusal has to take it back off — otherwise the player would be left
   * holding a chest the report has already cleared from its slot.
   */
  assert.deepEqual(
    session.dungeonAccount.account_chests,
    [],
    "and the failed open leaves the account exactly where it started"
  );
});

test("the field ids are the ones the client sends", () => {
  assert.equal(FLID_OPEN_CHEST, 282);
  assert.equal(FLID_TAKE_CHEST, 283);
  assert.equal(FLID_DROP_CHEST, 284);
});

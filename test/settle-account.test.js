import assert from "node:assert/strict";
import test from "node:test";

import { sendDungeonSummary } from "../src/socket/summary.js";
import { leaveDungeon } from "../src/socket/dungeon.js";
import { settleDungeonAccount } from "../src/socket/settle-account.js";

/**
 * When the run gets written down.
 *
 * These come from one captured session rather than from reasoning. The player
 * opened a chest on the report screen, was dropped into the inventory by the
 * reveal popup — still inside the dungeon — equipped the weapon and dropped a
 * spare chest, both over JSON-RPC against a freshly read account. Sixteen
 * seconds later they left the report, and the teardown wrote the account the
 * session had loaded at dungeon *entry*, undoing both.
 *
 * The account file's last write was that teardown, to the second, and nothing
 * touched it for the remaining 73 seconds of the session.
 */

const sessionWith = (overrides = {}) => {
  const avatar = {
    id: 1,
    consumable1_id: 0,
    consumable1_count: 0,
    consumable2_id: 0,
    consumable2_count: 0,
  };
  const account = {
    id: 500,
    account_avatars: [avatar],
    account_stackables: [],
    account_items: [{ id: 900, item_id: 15001, avatar_id: null, avatar_slot: null }],
    account_chests: [{ id: 901, account_id: 500, chest_id: 60001 }],
  };

  const objects = new Map();
  const saved = [];
  return {
    account,
    avatar,
    saved,
    session: {
      id: 42,
      dungeonActive: true,
      areaDoid: 4001,
      dungeonZone: 10,
      mapNodeId: 50002,
      actors: new Map(),
      objects,
      allocateDoid: (clid) => {
        objects.set(5001, clid);
        return 5001;
      },
      send: () => {},
      dungeonAccount: account,
      dungeonAvatar: avatar,
      persistDungeonAccount: async (value) => {
        saved.push(structuredClone(value));
      },
      ...overrides,
    },
  };
};

const settled = (session) => session.rewardSavePromise ?? Promise.resolve();

test("the report screen writes the run down", async () => {
  const { session, saved } = sessionWith();

  sendDungeonSummary(session, true);
  await settled(session);

  assert.equal(saved.length, 1, "the summary is where the run reaches storage");
});

test("leaving does not write the run down a second time", async () => {
  const { session, saved } = sessionWith();

  sendDungeonSummary(session, true);
  await settled(session);
  await leaveDungeon(session);

  assert.equal(saved.length, 1, "the teardown adds no second write");
});

/**
 * The observed failure, in the order it happened.
 *
 * `disk` stands in for the account store the JSON-RPC layer reads and writes:
 * equipping and dropping a chest both load their own fresh copy, so a change
 * they make is invisible to `session.dungeonAccount`. Nothing merges the two —
 * the only protection is that the session must not write after them.
 */
test("an equip made while the report is up survives leaving", async () => {
  let disk = null;
  const { session } = sessionWith({
    persistDungeonAccount: async (value) => {
      disk = structuredClone(value);
    },
  });

  sendDungeonSummary(session, true);
  await settled(session);

  // The reveal popup sends the player into the inventory; the RPC layer equips
  // the weapon and drops the spare chest on its own copy of the account.
  disk.account_items[0].avatar_id = 1;
  disk.account_items[0].avatar_slot = 0;
  disk.account_chests = [];

  await leaveDungeon(session);

  assert.equal(disk.account_items[0].avatar_id, 1, "the weapon is still equipped");
  assert.deepEqual(disk.account_chests, [], "and the dropped chest stayed dropped");
});

/**
 * Quitting mid-floor, wiping and dropping the connection all reach
 * `leaveDungeon` without ever generating a report, and the powerup carry rule
 * has to run for those too. Removing the teardown write outright would have
 * put the "x0" slot back.
 */
test("a run that never reached a report is still settled on the way out", async () => {
  const { session, saved } = sessionWith();

  await leaveDungeon(session);

  assert.equal(saved.length, 1, "no summary means leaving is the only chance");
});

test("settling twice is refused rather than repeated", async () => {
  const { session, saved } = sessionWith();

  await settleDungeonAccount(session);
  await settleDungeonAccount(session);

  assert.equal(saved.length, 1);
});

/**
 * The two halves of a run, and they do not survive the same way.
 *
 * Reported from play and confirmed against the captures: gold picked up off the
 * floor is banked as it is picked up, so quitting mid-run keeps it. A treasure
 * is only a claim on a chest until the report screen, so quitting mid-run
 * loses it — every increase in `account_chests` across the official recordings
 * follows a TakeChest or an OpenChest.
 *
 * That asymmetry is the point rather than an accident: finishing a run is what
 * the chest is for.
 */
test("a mid-run quit keeps the gold and loses the chests", async () => {
  const { applyProgressReward, awardTreasureChest } = await import("../src/socket/rewards.js");

  let disk = null;
  const { session, account } = (() => {
    const { session } = sessionWith({
      persistDungeonAccount: async (value) => {
        disk = structuredClone(value);
      },
    });
    session.dungeonAccount.basic_currency = 500;
    session.dungeonAccount.account_chests = [];
    return { session, account: session.dungeonAccount };
  })();

  applyProgressReward(session, { gold: 120 });
  await awardTreasureChest(session, 30100);

  // No report: the player walked out, or the socket died.
  await leaveDungeon(session);
  await settled(session);

  assert.equal(account.basic_currency, 620, "the gold went in as it was collected");
  assert.equal(disk.basic_currency, 620, "and it reached storage");
  assert.deepEqual(disk.account_chests, [], "the chest never became one");
  assert.equal(session.dungeonTreasures, undefined, "and the claim went with the run");
});

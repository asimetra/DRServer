import assert from "node:assert/strict";
import test from "node:test";

import { loadServerConfig } from "../src/config.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { CLID } from "../src/socket/opcodes.js";
import {
  applyProgressReward,
  queueAccountSave,
  saveChangedAccounts,
  startRunCheckpoints,
} from "../src/socket/rewards.js";

/**
 * A run is written down when something ends, not for every coin.
 *
 * Every coin and every star used to queue a save of the account, one after
 * another: a third of a save a second for each player on their own recordings,
 * four a second in a fight. Nothing about a coin needs storage that instant —
 * the client is told the new total from the account in memory, and the account
 * in memory is what every later save writes.
 *
 * So picking something up only marks the account as changed. It is written
 * when the floor ends, when the run ends, when the player leaves or is
 * dropped — all of which already saved — and, for the endings nothing can
 * announce, on a clock: a match worker that dies takes its memory with it, and
 * so does a process that is killed. The clock is what bounds those to half a
 * minute of gold and experience.
 */

const member = (id, heroDoid) => {
  const saved = [];
  const session = {
    id,
    accountId: id,
    playerDoid: id,
    heroDoid,
    dungeonAccount: { id, basic_currency: 100 },
    dungeonAvatar: { id: 9, experience: 1000 },
    objects: new Map([[heroDoid, CLID.HeroGameObject]]),
    actors: new Map([[heroDoid, { hitPoints: 100, maxHitPoints: 100 }]]),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid: () => 100,
    persistDungeonAccount: async (account) => {
      saved.push({ gold: account.basic_currency });
    },
  };
  return { session, saved };
};

test("a coin picked up changes the account and saves nothing", async () => {
  const { session, saved } = member(41, 501);

  applyProgressReward(session, { gold: 10, xp: 5 });
  applyProgressReward(session, { gold: 10 });
  await session.rewardSavePromise;

  assert.equal(session.dungeonAccount.basic_currency, 120, "the account in memory has it");
  assert.equal(session.dungeonAvatar.experience, 1005);
  assert.deepEqual(saved, [], "and storage has not been asked for anything");
});

test("a checkpoint writes an account that changed, once", async () => {
  const { session, saved } = member(41, 501);
  applyProgressReward(session, { gold: 10 });
  applyProgressReward(session, { gold: 10 });

  saveChangedAccounts(session);
  await session.rewardSavePromise;
  assert.deepEqual(saved, [{ gold: 120 }], "two coins, one save");

  saveChangedAccounts(session);
  await session.rewardSavePromise;
  assert.equal(saved.length, 1, "and nothing more until something changes again");
});

test("a checkpoint writes every member that changed, and only those", async () => {
  const host = member(41, 501);
  const guest = member(42, 502);
  const world = createMatchWorld({ id: 1, members: new Set([host.session, guest.session]) }, host.session);
  world.contextFor(guest.session);

  applyProgressReward(world.contextFor(guest.session), { gold: 7 });
  saveChangedAccounts(world.contextFor(host.session));
  await Promise.all([host.session.rewardSavePromise, guest.session.rewardSavePromise]);

  assert.deepEqual(guest.saved, [{ gold: 107 }]);
  assert.deepEqual(host.saved, []);
});

test("any other save of the account carries the coins with it", async () => {
  const { session, saved } = member(41, 501);
  applyProgressReward(session, { gold: 10 });

  // A chest, a floor reward, leaving: whatever saves, saves the whole account.
  await queueAccountSave(session);
  saveChangedAccounts(session);
  await session.rewardSavePromise;

  assert.deepEqual(saved, [{ gold: 110 }], "and the checkpoint has nothing left to write");
});

test("the clock runs for the length of the run and writes what changed", async () => {
  const { session, saved } = member(41, 501);
  const timers = [];
  session.runScope = { interval: (callback, delay) => timers.push({ callback, delay }) };

  startRunCheckpoints(session, 30_000);
  startRunCheckpoints(session, 30_000);
  assert.equal(timers.length, 1, "one clock a run, however many members ask");
  assert.equal(timers[0].delay, 30_000);

  applyProgressReward(session, { gold: 10 });
  timers[0].callback();
  await session.rewardSavePromise;
  assert.deepEqual(saved, [{ gold: 110 }]);
});

test("a run with no checkpoint interval has no clock", () => {
  const { session } = member(41, 501);
  const timers = [];
  session.runScope = { interval: (callback, delay) => timers.push({ callback, delay }) };

  startRunCheckpoints(session, 0);
  assert.equal(timers.length, 0);
});

test("the interval is thirty seconds unless it is set, and zero turns it off", () => {
  assert.equal(loadServerConfig({}).runCheckpointMs, 30_000);
  assert.equal(loadServerConfig({ ODS_RUN_CHECKPOINT_SECONDS: "5" }).runCheckpointMs, 5000);
  assert.equal(loadServerConfig({ ODS_RUN_CHECKPOINT_SECONDS: "0" }).runCheckpointMs, 0);
});

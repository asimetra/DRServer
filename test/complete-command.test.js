import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_PREFIX, resetCommands, runCommand } from "../src/socket/commands.js";
import { registerBuiltinCommands } from "../src/socket/command-set.js";
import { completeFloor } from "../src/socket/floorstate.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { awardInfiniteFloor, noteInfiniteFloorReached } from "../src/socket/rewards.js";
import { runRecordFor } from "../src/socket/summary.js";
import { CLID } from "../src/socket/opcodes.js";
import { ROLE, withRole } from "../src/socket/roles.js";

/**
 * `/complete` ends the floor its caller is standing on, the way the floor
 * would have ended itself.
 *
 * It is for whoever is checking a later floor and does not want to fight
 * through the earlier ones to reach it. It goes through `completeFloor` — the
 * one place that decides what a finished floor means — so a floor ended this
 * way hands over to the next exactly as a cleared one does, and the last one
 * wins the run with its report and its reward.
 */

const HERO = 500;

const onFloor = (rank, overrides = {}) => {
  const session = {
    id: 7,
    accountId: 900,
    dungeonAccount: { id: 900, name: "Simetra", admin_flags: String(withRole(0, rank)) },
    heroDoid: HERO,
    floorDoid: 400,
    areaDoid: 300,
    dungeonActive: true,
    floorIndex: 0,
    floorCount: 3,
    floorSettled: true,
    floorCleared: false,
    floorFinished: false,
    floorExits: [{ x: 0, y: 0 }],
    heroPosition: { x: 10, y: 10 },
    objects: new Map([[HERO, CLID.HeroGameObject]]),
    actors: new Map([
      [HERO, { hitPoints: 100, maxHitPoints: 100 }],
      [20, { constant: "SKELETON_GRUNT", isEnemy: true, hitPoints: 40, maxHitPoints: 40 }],
    ]),
    advanced: 0,
    sent: [],
    summaries: [],
    completeFloor,
    ...overrides,
  };
  session.send = (frame) => session.sent.push(frame);
  session.advanceFloor = () => {
    session.advanced += 1;
  };
  session.scheduleDungeonSummary = (_session, won) => session.summaries.push(won);
  return session;
};

let said = [];
const run = async (session, line = "complete") => {
  said = [];
  const reply = (message) => said.push(message);
  reply.warn = (message) => said.push(message);
  await runCommand(session, `${COMMAND_PREFIX}${line}`, reply);
  return said.join("\n");
};

test.beforeEach(() => {
  resetCommands();
  registerBuiltinCommands();
});

test("complete is an admin's, and a player's attempt ends nothing", async () => {
  const session = onFloor(ROLE.PLAYER);

  assert.match(await run(session), /needs admin/);
  assert.equal(session.floorFinished, false);
  assert.equal(session.advanced, 0);

  const helper = onFloor(ROLE.HELPER);
  assert.match(await run(helper), /needs admin/);
  assert.equal(helper.advanced, 0);
});

test("complete hands a floor over to the next one, monsters standing or not", async () => {
  const session = onFloor(ROLE.ADMIN);

  const text = await run(session);

  assert.equal(session.advanced, 1, "the run moves on");
  assert.equal(session.floorCleared, true, "and the floor counts as cleared, so nothing can fail it now");
  assert.equal(session.floorFinished, true);
  assert.equal(session.actors.get(20).dead ?? false, false, "nothing is killed for it");
  assert.match(text, /floor 1 of 3 completed — on to floor 2/);
});

test("complete on the last floor wins the run, after the floor's own delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = onFloor(ROLE.ADMIN, { floorIndex: 2, floorExits: [] });

  const text = await run(session);

  assert.equal(session.advanced, 0, "there is no next floor to go to");
  assert.match(text, /last floor completed — the run ends in 7s/);
  assert.deepEqual(session.summaries, [], "not before the delay");

  t.mock.timers.tick(7000);
  assert.deepEqual(session.summaries, [true], "and then it is a win, with its report");
});

test("complete does not end a floor twice, or one that is not standing yet", async () => {
  const session = onFloor(ROLE.ADMIN);
  await run(session);
  assert.match(await run(session), /already finishing/);
  assert.equal(session.advanced, 1);

  const building = onFloor(ROLE.ADMIN, { floorSettled: false });
  assert.match(await run(building), /still being built/);
  assert.equal(building.advanced, 0);

  assert.match(await run({ id: 7, dungeonAccount: { id: 900, admin_flags: String(withRole(0, ROLE.ADMIN)) } }), /not on a floor/);
});

/** A hero that is down has started the defeat countdown; ending the floor stops it. */
test("complete calls off a defeat that was counting down", async () => {
  const session = onFloor(ROLE.ADMIN, { floorFailingTimer: setTimeout(() => {}, 60_000) });

  await run(session);

  assert.equal(session.floorFailingTimer ?? null, null);
  assert.equal(session.advanced, 1);
});

// --- a run that was helped along does not count -----------------------------------

/**
 * A floor ended by command was not played, and neither is anything it led to.
 *
 * The boards rank a node by how fast it was cleared, and a run walked through
 * with `/complete` would take first place on every one of them in a few
 * seconds. The Infinite dungeons keep their own measure — the depth reached,
 * with coins and treasure for each floor — and it is reached the same way. So
 * the run is marked, for the whole party and for the rest of its length: it is
 * still written to the history, it is kept off the boards, and it neither pays
 * an Infinite floor nor raises anybody's depth.
 */
test("a run that used complete is kept off the boards", async () => {
  const startedAt = Date.now() - 60_000;
  const played = onFloor(ROLE.ADMIN, {
    dungeonAvatar: { id: 1, avatar_id: 101, experience: 0 },
    dungeonStart: { at: startedAt },
    mapPage: { NodeType: "DUNGEON" },
  });
  assert.equal(runRecordFor(played, true).rankable, true, "an ordinary run ranks");

  await run(played);

  assert.equal(played.runAssisted, true);
  const record = runRecordFor(played, true);
  assert.equal(record.rankable, false, "one that was completed by command does not");
  assert.equal(record.success, true, "though it is still written down as what it was");
});

test("a run that used complete pays no Infinite floor and raises no depth", async () => {
  const gm = await loadGameMaster();
  const account = { id: 900, basic_currency: 1000, premium_currency: 0, trophies: 0, infinite_progress: {} };
  const session = onFloor(ROLE.ADMIN, {
    playerDoid: 50,
    mapNodeId: 50150,
    dungeonAvatar: { id: 1200 },
    infiniteEpoch: 2957,
    infiniteDefinition: gm.raw.InfiniteDungeons[0],
    dungeonRewards: { gold: 0, gems: 0, xp: 0 },
    dungeonTreasures: [],
    persistDungeonAccount: async () => {},
    floorCount: 55,
  });
  session.dungeonAccount = { ...session.dungeonAccount, ...account };

  // Floor one, reached and cleared honestly.
  assert.equal(noteInfiniteFloorReached(session), 1);
  assert.equal(awardInfiniteFloor(session).gold, 600);
  const gold = session.dungeonAccount.basic_currency;

  // Floor two, walked into and then skipped.
  session.floorIndex = 1;
  assert.equal(noteInfiniteFloorReached(session), 2);
  session.completeFloor = (target) => completeFloor(target);
  await run(session);

  assert.equal(session.dungeonAccount.basic_currency, gold, "the skipped floor pays nothing");
  session.floorIndex = 2;
  assert.equal(noteInfiniteFloorReached(session), null, "and the floor it led to is not a depth reached");
  assert.equal(awardInfiniteFloor(session), null, "nor is anything after it paid");
  assert.equal(session.dungeonAccount.infinite_progress["50150"]["1200"].score, 2, "what was earned before stays");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  beginFloorFailing,
  buildDungeonEnding,
  cancelFloorFailing,
  cancelVictory,
  checkFloorCleared,
  clearFloorFailing,
  completeFloor,
  refreshFloorFailing,
  reportFloorFailed,
} from "../src/socket/floorstate.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { dungeonMatches } from "../src/socket/matches.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

const FLID_DUNGEON_ENDING = 216;

const fieldId = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  reader.u32();
  return reader.u16();
};

test("victory is emitted once after the last enemy dies", async () => {
  const sent = [];
  const summaries = [];
  const session = {
    id: 1,
    areaDoid: 1000,
    actors: new Map([
      [1, { isEnemy: true, dead: true }],
      [2, { isEnemy: true, dead: false }],
      [3, { isEnemy: false, dead: false }],
    ]),
    send: (frame) => sent.push(frame),
    dungeonActive: true,
    // The real victory waits out the loot countdown; tests do not.
    victoryDelayMs: 0,
    scheduleDungeonSummary: (_session, success) => summaries.push(success),
  };

  assert.equal(checkFloorCleared(session), false);
  session.actors.get(2).dead = true;
  assert.equal(checkFloorCleared(session), true);
  assert.equal(checkFloorCleared(session), false);
  // The victory is announced on a timer, so let it land.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent.map(fieldId), [FLID_DUNGEON_ENDING]);
  assert.deepEqual(summaries, [true]);
});

test("defeat is emitted once", async () => {
  const sent = [];
  const summaries = [];
  const session = {
    id: 2,
    areaDoid: 2000,
    send: (frame) => sent.push(frame),
    dungeonActive: true,
    // The real victory waits out the loot countdown; tests do not.
    victoryDelayMs: 0,
    scheduleDungeonSummary: (_session, success) => summaries.push(success),
  };

  reportFloorFailed(session);
  reportFloorFailed(session);
  assert.deepEqual(sent.map(fieldId), [FLID_DUNGEON_ENDING]);
  assert.deepEqual(summaries, [false]);
});

test("a shared-world victory awards every remaining member once", async () => {
  const awarded = [];
  const make = (id) => ({
    id,
    accountId: id,
    heroDoid: 100 + id,
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid: () => 900 + id,
    awardDungeonCompletion: async () => awarded.push(id),
  });
  const host = make(10);
  const peer = make(11);
  const world = createMatchWorld({ id: 1, members: new Set([host, peer]) }, host);
  world.contextFor(peer);
  world.areaDoid = 500;
  world.floorIndex = 0;
  world.floorCount = 1;
  world.dungeonActive = true;
  world.victoryDelayMs = 0;
  host.scheduleDungeonSummary = () => {};

  assert.equal(completeFloor(world.contextFor(host)), true);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(awarded.sort((a, b) => a - b), [10, 11]);
  world.destroy();
});

test("final-floor completion closes matchmaking before the victory delay", () => {
  let nextDoid = 70_000;
  const host = {
    id: 70,
    accountId: 70,
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid(clid) {
      const doid = nextDoid++;
      if (clid !== undefined) this.objects.set(doid, clid);
      return doid;
    },
  };
  const opened = dungeonMatches.resolve({ session: host, mapNodeId: 50082 });
  const world = createMatchWorld(opened.match, host);
  world.areaDoid = 700;
  world.floorIndex = 0;
  world.floorCount = 1;
  world.dungeonActive = true;
  world.victoryDelayMs = 60_000;
  const context = world.contextFor(host);

  assert.equal(completeFloor(context), true);
  assert.equal(opened.match.state, "finished");
  const refused = dungeonMatches.resolve({
    session: { accountId: 71 },
    friendId: host.accountId,
    eligibleForExplicitJoin: true,
  });
  assert.equal(refused.match, null);
  assert.equal(refused.error, "run_finished");

  cancelVictory(context);
  dungeonMatches.remove(host);
});

test("an unopened generator prevents premature victory", async () => {
  const sent = [];
  const generator = { completed: false };
  const session = {
    id: 3,
    areaDoid: 3000,
    actors: new Map([[1, { isEnemy: true, dead: true }]]),
    generators: new Map([["cage", generator]]),
    send: (frame) => sent.push(frame),
    dungeonActive: true,
    // The real victory waits out the loot countdown; tests do not.
    victoryDelayMs: 0,
    scheduleDungeonSummary: (_session, success) => assert.equal(success, true),
  };

  assert.equal(checkFloorCleared(session), false);
  assert.equal(sent.length, 0);

  generator.completed = true;
  assert.equal(checkFloorCleared(session), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent.map(fieldId), [FLID_DUNGEON_ENDING]);
});

test("dungeon ending matches the production transition payload", async () => {
  const reader = new PacketReader(buildDungeonEnding(4000, true).subarray(2));

  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), 4000);
  assert.equal(reader.u16(), FLID_DUNGEON_ENDING);
  assert.equal(reader.u16(), 5);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.eof(), true);
});

/**
 * A dungeon is a sequence of floors. Clearing one of them is not finishing the
 * run: it only opens the gate in front of the exit, and reaching the exit
 * behind it is what advances. Only the last floor — the one with no exit —
 * ends the dungeon.
 */
test("clearing a floor with an exit does not end the dungeon", async () => {
  const { floorPlanForMapNode, floorCountOf, loadFloorAt, exitsOf } = await import(
    "../src/socket/floors.js"
  );

  const plan = await floorPlanForMapNode(50002);
  const count = floorCountOf(plan);
  assert.equal(count, 2, "the tutorial runs two floors");

  const first = await loadFloorAt(plan, 0);
  const last = await loadFloorAt(plan, count - 1);
  assert.ok(exitsOf(first).length, "every floor but the last has somewhere to go");
  assert.equal(exitsOf(last).length, 0, "the last floor has no exit, so clearing it wins");
});

/**
 * The opposite was asserted for one commit: that reaching the exit proves
 * nothing and only `checkFloorCleared` may end a floor. It reads well and it
 * shut every run down, because clearing here demands that every generator on
 * the floor report itself complete, and a laid-out floor is full of cages
 * nobody is obliged to open. Twenty-five floors across five libraries, every
 * enemy dead: not one cleared.
 */
test("reaching the exit is what advances a floor", async () => {
  const { checkFloorExit } = await import("../src/socket/dungeon.js");
  const session = {
    id: 1,
    floorCleared: false,
    floorTransition: false,
    floorExits: [{ x: 100, y: 200, radius: 50 }],
    advanceFloor: () => {},
  };

  assert.equal(checkFloorExit(session, { x: 100, y: 200 }), true, "the hero walked out");
  assert.equal(session.floorTransition, true, "and the floor is handing over");
});

/**
 * A kill gate waits for its generator to report itself clear. Generators learned
 * to switch off when their input goes low, and clearing still demanded the full
 * quota of spawns had been attempted — so one switched off part way through
 * could never report, and its gate never opened however many monsters died.
 */
test("a generator switched off early still clears once its spawns are dead", async () => {
  const { completeGenerator } = await import("../src/socket/dungeon.js");
  const signals = [];
  const session = {
    id: 1,
    send: () => {},
    actors: new Map(),
    generators: new Map(),
    signalValues: new Map(),
    signalTargets: new Map(),
  };

  const runtime = {
    placement: { id: "gen", clearsOnAllDead: true },
    maxSpawns: 10,
    attemptedSpawns: 2,
    alive: 1,
    completed: false,
    spawnedDoids: new Set(),
    stopped: false,
    onSignal: (value) => signals.push(value),
  };

  completeGenerator(session, runtime);
  assert.equal(runtime.completed, false, "not while it is still owed spawns and one lives");

  runtime.stopped = true;
  completeGenerator(session, runtime);
  assert.equal(runtime.completed, false, "nor while one of them is alive");

  runtime.alive = 0;
  completeGenerator(session, runtime);
  assert.equal(runtime.completed, true, "but yes once switched off and empty");
});

/**
 * When the hero comes off the floor, which is the ending and not the party.
 *
 * Four captured endings, separated cleanly by node type:
 *
 *   50078, 50081, 50025  DUNGEON  hero disabled 1ms before dungeonEnding
 *   50026                BOSS     heroes disabled 52ms after the summary
 *
 * A boss floor ends with treasure on the ground and five seconds to walk to it.
 * Taking the hero away at the announcement took the loot with it.
 */
test("a boss victory leaves the hero on the floor for the treasure", async () => {
  const { completeFloor } = await import("../src/socket/floorstate.js");
  const { sendDungeonSummary } = await import("../src/socket/summary.js");

  const sent = [];
  const session = {
    id: 1,
    areaDoid: 1000,
    heroDoid: 2574,
    floorIndex: 0,
    floorCount: 1,
    dungeonActive: true,
    victoryDelayMs: 0,
    allocateDoid: () => 9001,
    actors: new Map(),
    // The hero is still a live object on the client until the report takes it.
    objects: new Map([[2574, CLID.HeroGameObject]]),
    send: (frame) => sent.push(frame),
    awardDungeonCompletion: async () => ({}),
    scheduleDungeonSummary: () => {},
  };

  completeFloor(session);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const disables = sent.filter(
    (frame) => new PacketReader(frame.subarray(2)).u16() === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP
  );
  assert.equal(disables.length, 0, "the win is announced around a hero still standing");

  sendDungeonSummary(session, true);
  assert.equal(
    sent.filter(
      (frame) => new PacketReader(frame.subarray(2)).u16() === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP
    ).length,
    1,
    "and the report is what takes it away"
  );
});

test("the hero is only taken off the floor once", async () => {
  const { removeHeroFromFloor } = await import("../src/socket/summary.js");

  const sent = [];
  const session = {
    heroDoid: 7,
    objects: new Map([[7, CLID.HeroGameObject]]),
    send: (frame) => sent.push(frame),
  };

  assert.equal(removeHeroFromFloor(session), true);
  assert.equal(removeHeroFromFloor(session), false, "walking out already did it");
  assert.equal(sent.length, 1);
  assert.equal(session.objects.has(7), false, "the object table is what remembers");
});

/**
 * The defeat countdown, from `socket-20260816-191126.jsonl`: the hero drops and
 * the area is told 10, a bomb brings him back 3.5 seconds later and it is told
 * 0. The one captured ordinary dungeon was told 60 instead.
 */
const FLID_FLOOR_FAILING = 217;

const failingPayload = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  reader.u16();
  reader.u32();
  assert.equal(reader.u16(), FLID_FLOOR_FAILING);
  return reader.u16();
};

const downedSession = (overrides = {}) => ({
  id: 9,
  areaDoid: 4000,
  heroDoid: 77,
  actors: new Map([[77, { dead: true }]]),
  send: () => {},
  dungeonActive: true,
  ...overrides,
});

test("the defeat countdown is the map node's, and an ordinary dungeon gets sixty", () => {
  const sent = [];
  const session = downedSession({ send: (frame) => sent.push(frame) });

  beginFloorFailing(session);
  assert.deepEqual(sent.map(failingPayload), [60]);

  clearFloorFailing(session);
});

test("an infinite node gets ten", () => {
  const sent = [];
  const session = downedSession({
    send: (frame) => sent.push(frame),
    mapPage: { NodeType: "INFINITE" },
  });

  beginFloorFailing(session);
  assert.deepEqual(sent.map(failingPayload), [10]);

  clearFloorFailing(session);
});

test("a hero still standing keeps the countdown away", () => {
  const sent = [];
  const session = downedSession({ send: (frame) => sent.push(frame) });
  session.actors.get(77).dead = false;

  beginFloorFailing(session);
  assert.deepEqual(sent, [], "somebody is up, so nothing is failing");
});

test("the countdown does not restart while it runs", () => {
  const sent = [];
  const session = downedSession({ send: (frame) => sent.push(frame) });

  beginFloorFailing(session);
  beginFloorFailing(session);
  assert.deepEqual(sent.map(failingPayload), [60], "a party would be immortal otherwise");

  clearFloorFailing(session);
});

test("reviving in time cancels it, and the run is not lost", async () => {
  const sent = [];
  const failures = [];
  const session = downedSession({
    send: (frame) => sent.push(frame),
    mapPage: { NodeType: "INFINITE" },
    reportFloorFailed: (s) => failures.push(s.id),
  });

  beginFloorFailing(session);
  cancelFloorFailing(session);
  assert.deepEqual(sent.map(failingPayload), [10, 0]);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(failures, [], "the counter was stopped, so nothing fires later");
});

test("letting it run out is what loses the run", (t) => {
  // Ten real seconds is the authored wait; the clock is faked rather than the
  // countdown shortened, so the timer under test is the one that ships.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const failures = [];
  const session = downedSession({
    mapPage: { NodeType: "INFINITE" },
    reportFloorFailed: (s) => failures.push(s.id),
  });

  beginFloorFailing(session);

  /**
   * Ten on the wire is thirteen on the clock: FloorEndingGui tweens a start
   * clip away for two seconds before its first tick, and decrements before it
   * renders, so it needs eleven ticks to pass zero. The official server waited
   * 62.986s on a captured countdown of 60, which is the same arithmetic.
   */
  t.mock.timers.tick(12_999);
  assert.deepEqual(failures, [], "ending on the bare ten leaves three still showing");

  t.mock.timers.tick(1);
  assert.deepEqual(failures, [9], "it ends when the number on screen runs out");
});

/**
 * Somebody arriving is somebody standing.
 *
 * The countdown means "nobody is up", and it is cancelled when a hero is
 * revived — but a late joiner is the same fact by a different route. They enter
 * on full health, so the party is no longer wiped, and the run should not end
 * underneath them. Nothing re-asked the question on join, so the timer ran to
 * the end and failed a floor that had a live player standing on it.
 */
test("a late joiner stops a running defeat countdown", () => {
  const sent = [];
  const session = {
    id: 9,
    areaDoid: 2000,
    send: (frame) => sent.push(frame),
    actors: new Map([[500, { hitPoints: 0, dead: true }]]),
    playerActors: new Set([500]),
  };

  beginFloorFailing(session);
  assert.ok(session.floorFailingTimer, "the wipe starts the countdown");
  const afterStart = sent.length;

  // A second player arrives, alive, exactly as the join path registers them.
  session.actors.set(600, { hitPoints: 205, maxHitPoints: 205 });
  session.playerActors.add(600);

  refreshFloorFailing(session);

  assert.equal(session.floorFailingTimer, null, "the countdown is dropped");
  assert.equal(sent.length, afterStart + 1, "and the client is told it stopped");
});

/**
 * The guard that makes the re-check safe to call anywhere.
 *
 * This is not a join story — a joiner arrives standing, which is the test
 * above. It is the property that lets `refreshFloorFailing` be called on any
 * membership change without having to know which change it was: asking again
 * while the party is still down must leave a correct countdown running, and
 * must not send the client a second, contradictory number.
 */
test("re-checking while everybody is still down leaves the countdown alone", () => {
  const sent = [];
  const session = {
    id: 10,
    areaDoid: 2000,
    send: (frame) => sent.push(frame),
    actors: new Map([[500, { dead: true }]]),
    playerActors: new Set([500]),
  };

  beginFloorFailing(session);
  const timer = session.floorFailingTimer;
  const afterStart = sent.length;

  session.actors.set(600, { dead: true });
  session.playerActors.add(600);
  refreshFloorFailing(session);

  assert.equal(session.floorFailingTimer, timer, "the same countdown keeps running");
  assert.equal(sent.length, afterStart, "and the client is told nothing new");
});

/**
 * The rule, stated once: the countdown runs exactly while nobody is up.
 *
 * Cancelling on revive and on join was two answers to one question, and it
 * missed the third way the answer changes — somebody leaving. The last player
 * standing walking out leaves a floor of corpses, which is a wipe arrived at
 * by a different route, and nothing started the countdown for it. The run hung
 * with nobody able to finish it and no ending on the way.
 *
 * So the re-check restores the rule in both directions rather than only
 * stopping what is already running.
 */
test("the last player standing leaving starts the countdown", () => {
  const sent = [];
  const session = {
    id: 11,
    areaDoid: 2000,
    send: (frame) => sent.push(frame),
    actors: new Map([
      [500, { dead: true }],
      [600, { hitPoints: 205, maxHitPoints: 205 }],
    ]),
    playerActors: new Set([500, 600]),
  };

  refreshFloorFailing(session);
  assert.equal(session.floorFailingTimer, undefined, "somebody is up, so nothing runs");

  // The one on their feet leaves, the way leaveDungeonSession removes them.
  session.playerActors.delete(600);
  session.actors.delete(600);
  refreshFloorFailing(session);

  assert.ok(session.floorFailingTimer, "the corpses left behind are a wipe");
  clearFloorFailing(session);
});

test("a downed player leaving does not start a countdown while others stand", () => {
  const session = {
    id: 12,
    areaDoid: 2000,
    send: () => {},
    actors: new Map([
      [500, { dead: true }],
      [600, { hitPoints: 205, maxHitPoints: 205 }],
    ]),
    playerActors: new Set([500, 600]),
  };

  session.playerActors.delete(500);
  session.actors.delete(500);
  refreshFloorFailing(session);

  assert.equal(session.floorFailingTimer, undefined, "the survivor is still playing");
});

/**
 * An empty floor is not a wipe.
 *
 * `everyPlayerDown` answers true for a party of nobody, which is correct for
 * the question it is asked but wrong as a reason to start a countdown: the last
 * member leaving tears the world down, and a timer started on the way out would
 * fire into it.
 */
test("the last member leaving starts no countdown at all", () => {
  const session = {
    id: 13,
    areaDoid: 2000,
    send: () => {},
    actors: new Map(),
    playerActors: new Set(),
  };

  refreshFloorFailing(session);
  assert.equal(session.floorFailingTimer, undefined, "nobody left to fail");
});

const FLID_SHOW_TEXT = 201;

/** The text a show_text frame carries, for asserting on the line and not the bytes. */
const textOf = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  reader.u16();
  reader.u32();
  assert.equal(reader.u16(), FLID_SHOW_TEXT);
  return reader.utf();
};


/**
 * The lines are on their own timers, so cancelling only the victory left a
 * floor nobody was on still being told to collect its treasure.
 */
test("leaving takes the countdown with it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const session = {
    id: 41,
    areaDoid: 4100,
    floorDoid: 4101,
    dungeonActive: true,
    send: (frame) => sent.push(frame),
    scheduleDungeonSummary: () => {},
    awardDungeonCompletion: async () => {},
  };

  completeFloor(session);
  cancelVictory(session);
  t.mock.timers.tick(10_000);

  assert.deepEqual(sent, [], "no treasure to collect, and no victory");
});

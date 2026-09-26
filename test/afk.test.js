import test from "node:test";
import assert from "node:assert/strict";

import { checkIdle, noteActivity, startAfkWatch } from "../src/socket/afk.js";
import { installMatchHost, matchHost } from "../src/socket/match-host.js";
import { PacketReader } from "../src/socket/packet.js";
import { OP } from "../src/socket/opcodes.js";
import { config } from "../src/config.js";

/**
 * Standing still in a dungeon, measured the way the official server did it:
 * thirty seconds without the hero moving, turning or attacking puts "Zzz..."
 * over its name for the whole party (HeroGameObject field 167). Here the
 * player is also told, and a minute sends them back to town.
 */
const WARN = config.afkWarnMs;
const KICK = config.afkKickMs;

const hero = () => {
  const told = [];
  const broadcast = [];
  const session = {
    id: 3,
    heroDoid: 4100,
    playerDoid: 4000,
    dungeonActive: true,
    actors: new Map([[4100, { dead: false }]]),
    mapPage: { Id: 50010, NodeType: "DUNGEON" },
    broadcast: (frame) => broadcast.push(frame),
    sendDirect: (frame) => told.push(frame),
    send: () => {},
  };
  return { session, told, broadcast };
};

/** The field-167 updates among what was broadcast. */
const afkFlags = (frames) =>
  frames
    .map((frame) => {
      const reader = new PacketReader(frame.subarray(2));
      assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
      return { doid: reader.u32(), field: reader.u16(), afk: reader.u8() };
    })
    .filter((row) => row.field === 167);

/** A watch whose clock and ticks the test turns by hand. */
const watch = (session, start = 1_000_000) => {
  let tick = null;
  const stop = startAfkWatch(session, {
    now: () => start,
    schedule: (fn) => {
      tick = fn;
      return 1;
    },
    cancel: () => {
      tick = null;
    },
  });
  return { at: (ms) => checkIdle(session, start + ms), stop, ticking: () => tick !== null };
};

const sentHome = (t) => {
  const sent = [];
  const previous = matchHost();
  installMatchHost({ ...previous, sendHome: async (session) => sent.push(session.id) });
  t.after(() => installMatchHost(previous));
  return sent;
};

test("the defaults are the thirty seconds the official server used, and a minute to go home", () => {
  assert.equal(WARN, 30_000);
  assert.equal(KICK, 60_000);
});

test("thirty seconds without playing marks the hero for the party and tells the player, once", (t) => {
  sentHome(t);
  const { session, told, broadcast } = hero();
  const clock = watch(session);

  clock.at(WARN - 1);
  assert.deepEqual(broadcast, [], "not yet");
  clock.at(WARN);
  clock.at(WARN + 5_000);
  assert.deepEqual(afkFlags(broadcast), [{ doid: 4100, field: 167, afk: 1 }], "Zzz, to everybody, once");
  assert.equal(told.length, 1, "and one warning line to the player");
});

test("moving, turning or attacking clears it at once", (t) => {
  sentHome(t);
  const { session, broadcast } = hero();
  const clock = watch(session);
  clock.at(WARN);
  noteActivity(session, 1_000_000 + WARN + 100);
  assert.deepEqual(afkFlags(broadcast).map((row) => row.afk), [1, 0]);

  // And the clock starts again from that moment.
  clock.at(WARN + 100 + WARN - 1);
  assert.equal(broadcast.length, 2);
});

test("a minute idle sends the player home, and asks only once", (t) => {
  const home = sentHome(t);
  const { session } = hero();
  const clock = watch(session);
  clock.at(KICK - 1);
  assert.deepEqual(home, []);
  clock.at(KICK);
  clock.at(KICK + 5_000);
  assert.deepEqual(home, [3]);
});

test("waiting to be revived, a finished run and the report are not idling", (t) => {
  const home = sentHome(t);
  for (const excuse of [
    (session) => session.actors.get(4100).dead = true,
    (session) => session.floorFinished = true,
    (session) => session.summaryDoid = 9000,
    // Lost: the defeat banner is up and the report is on its way.
    (session) => session.summaryTimer = {},
  ]) {
    const { session, broadcast } = hero();
    excuse(session);
    const clock = watch(session);
    clock.at(KICK * 3);
    assert.deepEqual(broadcast, []);
  }
  assert.deepEqual(home, []);

  // Excused time does not count once it ends: revived, the clock starts over.
  const { session, broadcast } = hero();
  session.actors.get(4100).dead = true;
  const clock = watch(session);
  clock.at(KICK * 3);
  session.actors.get(4100).dead = false;
  clock.at(KICK * 3 + WARN - 1);
  assert.deepEqual(broadcast, []);
});

test("a hub shows the marker but neither warns nor sends anybody home", (t) => {
  const home = sentHome(t);
  const { session, told, broadcast } = hero();
  session.mapPage = { Id: 1, NodeType: "HUB" };
  const clock = watch(session);
  clock.at(KICK * 2);
  assert.deepEqual(afkFlags(broadcast).map((row) => row.afk), [1]);
  assert.deepEqual(told, []);
  assert.deepEqual(home, []);
});

test("stopping the watch ends its ticks and forgets the player", (t) => {
  sentHome(t);
  const { session } = hero();
  const clock = watch(session);
  assert.equal(clock.ticking(), true);
  clock.stop();
  assert.equal(clock.ticking(), false);
  assert.equal(session.idleState, null);
  noteActivity(session);
});

test("the hero's own play counts; chat does not", async (t) => {
  sentHome(t);
  const { handleGameplayField } = await import("../src/socket/gameplay-fields.js");
  const { FLID_PLAYER_TYPING } = await import("../src/socket/chat.js");
  const { PacketWriter } = await import("../src/socket/packet.js");
  const { session, broadcast } = hero();
  const clock = watch(session);
  clock.at(WARN);
  assert.equal(afkFlags(broadcast).length, 1);

  const payload = (write) => new PacketReader(write(new PacketWriter()).body());
  // Typing is the player object's, and does not wake the hero.
  await handleGameplayField(session, 4000, FLID_PLAYER_TYPING, payload((w) => w.u8(1)));
  assert.equal(afkFlags(broadcast).length, 1);
  await handleGameplayField(session, 4100, 148, payload((w) => w.f32(1.5)));
  assert.equal(afkFlags(broadcast).at(-1).afk, 0, "turning the hero does");
});

test("on this thread, sending home is the player's own exit, started for them", async (t) => {
  const { installMatchExecutor } = await import("../src/socket/match-runtime.js");
  const { transitionsOf } = await import("../src/socket/session-transitions.js");
  const { FLID } = await import("../src/socket/entry-protocol.js");
  const left = [];
  const previous = installMatchExecutor({
    join: async () => {},
    leave: async (session, options = {}) => left.push(options.notifyClient === true),
  });
  t.after(() => installMatchExecutor(previous));
  const sent = [];
  const connection = { id: 12, matchMakerDoid: 9, send: (frame) => sent.push(frame) };

  assert.equal(await matchHost().sendHome({ member: connection }), true);
  await transitionsOf(connection).idle();
  assert.deepEqual(left, [true], "the run taken down, the client told");
  const reader = new PacketReader(sent.at(-1).subarray(2));
  reader.u16();
  reader.u32();
  assert.equal(reader.u16(), FLID.ClientExitComplete);
});

test("on this thread, a player who has left the floor since is not sent anywhere", async (t) => {
  const { installMatchExecutor } = await import("../src/socket/match-runtime.js");
  const { transitionsOf } = await import("../src/socket/session-transitions.js");
  const previous = installMatchExecutor({
    join: async () => {},
    leave: async () => assert.fail("a player already gone was sent home"),
  });
  t.after(() => installMatchExecutor(previous));
  const sent = [];
  const connection = { id: 13, matchMakerDoid: 9, send: (frame) => sent.push(frame), world: null };
  // The floor context the tick read, whose world the player has since left.
  const context = { member: connection, world: { id: "old floor" } };

  assert.equal(await matchHost().sendHome(context), false);
  await transitionsOf(connection).idle();
  assert.deepEqual(sent, []);
});

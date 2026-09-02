import assert from "node:assert/strict";
import test from "node:test";

import { attackForConstant, loadGameMaster } from "../src/gamemaster.js";
import { scheduleTimelineDoobers } from "../src/socket/powerups.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

/**
 * What the reward chest leaves behind.
 *
 * `REWARD_CHEST_A` dies into `LOOT_SPAWN_A1`, and nothing here played it: the
 * death-attack path is the damage half and refuses an attack with no colliders,
 * which this one has none of — its `DamageMod` is zero and everything it
 * authors is `spawndoober`. So the chest broke and dropped nothing.
 *
 * The timeline is the animation. Forty-seven actions between frames 10 and 145
 * at 24 fps is a shower starting 0.42s after the break and running 5.63s, and
 * six recorded runs agree to within a tenth: 47 pickups, 5.66–5.78 seconds.
 */

const FLID_DOOBER_SPAWN_FROM = 290;
const CHEST_AT = { x: 5898, y: 2262 };

const harness = () => {
  const frames = [];
  let doid = 900000;
  return {
    frames,
    session: {
      id: 7,
      dungeonActive: true,
      floorDoid: 400,
      dungeonZone: 10,
      heroDoid: 500,
      actors: new Map(),
      objects: new Map(),
      doobers: new Map(),
      allocateDoid: () => ++doid,
      send: (frame) => frames.push(frame),
      random: Math.random,
    },
  };
};

const readField = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  const op = reader.u16();
  const target = reader.u32();
  return { op, doid: target, field: op === OP.CLIENT_OBJECT_UPDATE_FIELD ? reader.u16() : null, reader };
};

test("a chest's death timeline drops what it authors, on its own frames", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await loadGameMaster();
  const attack = await attackForConstant("LOOT_SPAWN_A1");
  const { session, frames } = harness();

  await scheduleTimelineDoobers(session, attack, { origin: CHEST_AT, heading: 0 });
  assert.deepEqual(frames, [], "nothing lands the instant the chest breaks");

  // The first authored frame is 10, which at 24fps is 417ms.
  t.mock.timers.tick(416);
  for (let flush = 0; flush < 5; flush++) await Promise.resolve();
  assert.equal(frames.length, 0, "and not a frame early");

  t.mock.timers.tick(1);
  for (let flush = 0; flush < 5; flush++) await Promise.resolve();
  assert.ok(frames.length > 0, "the shower starts on frame 10");

  // Frame 145 is the last, at 6042ms.
  t.mock.timers.tick(6000);
  for (let flush = 0; flush < 40; flush++) await Promise.resolve();

  const spawned = frames.filter((frame) => readField(frame).op === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(spawned.length, 47, "forty-seven pickups, as the captures count them");
});

/**
 * `spawnFrom` is the fly-out. Without it the client draws each pickup where it
 * landed and the chest appears to have items sitting on top of it rather than
 * throwing them.
 */
test("every pickup is told to fly out of the chest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await loadGameMaster();
  const attack = await attackForConstant("LOOT_SPAWN_A1");
  const { session, frames } = harness();

  await scheduleTimelineDoobers(session, attack, { origin: CHEST_AT, heading: 0 });
  t.mock.timers.tick(7000);
  for (let flush = 0; flush < 60; flush++) await Promise.resolve();

  const origins = [];
  for (const frame of frames) {
    const { op, field, reader } = readField(frame);
    if (op !== OP.CLIENT_OBJECT_UPDATE_FIELD || field !== FLID_DOOBER_SPAWN_FROM) continue;
    origins.push({ x: Math.round(reader.f32()), y: Math.round(reader.f32()) });
  }

  assert.equal(origins.length, 47, "one for every pickup");
  for (const origin of origins) {
    assert.deepEqual(origin, CHEST_AT, "and all of them from the chest, not from where they fell");
  }
});

/** A run that ends before the shower does must not keep dropping into it. */
test("the shower stops when the floor does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await loadGameMaster();
  const attack = await attackForConstant("LOOT_SPAWN_A1");
  const { session, frames } = harness();

  await scheduleTimelineDoobers(session, attack, { origin: CHEST_AT, heading: 0 });
  t.mock.timers.tick(1000);
  for (let flush = 0; flush < 10; flush++) await Promise.resolve();
  const partway = frames.length;
  assert.ok(partway > 0, "some of it has landed");

  session.dungeonActive = false;
  t.mock.timers.tick(6000);
  for (let flush = 0; flush < 40; flush++) await Promise.resolve();

  assert.equal(frames.length, partway, "and the rest is not dropped into an ended run");
});

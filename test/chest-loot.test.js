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

/**
 * The animation the chest plays while it empties itself.
 *
 * `playDeathAttack` is the damage half of a death timeline and it used to
 * refuse the whole job when an attack had no colliders. `LOOT_SPAWN_A1` has
 * none — its `DamageMod` is zero and everything on its timeline is
 * `spawndoober` — so the choreography was never sent and the client kept a
 * closed chest on screen while six seconds of coins came out of it.
 *
 * Against the recorded run, on the chest's own object:
 *
 *   theirs  CREATE, heading, position, choreography 910999, hitPoints,
 *           choreography 950144, result, result, state "dead"
 *   ours    CREATE,                                hitPoints,
 *                              result,             state "dead"
 *
 * 950144 is `LOOT_SPAWN_A1` and is the one this pins.
 */
test("a chest is told to play the animation it empties itself with", async () => {
  const { attackForConstant, npcForConstant, attackColliders } = await import(
    "../src/gamemaster.js"
  );
  const { playDeathAttack } = await import("../src/socket/hazards.js");

  const npc = await npcForConstant("REWARD_CHEST_A");
  assert.equal(npc.DeathAttack, "LOOT_SPAWN_A1", "the chest dies into its loot spawn");
  const attack = await attackForConstant(npc.DeathAttack);
  assert.equal(
    (await attackColliders(attack.AttackTimeline)).length,
    0,
    "and that attack hurts nobody, which is why it was skipped"
  );

  const frames = [];
  const session = {
    id: 29,
    dungeonActive: true,
    objects: new Map(),
    actors: new Map(),
    send: (frame) => frames.push(frame),
  };

  // No colliders, exactly as the floor computes them for this attack.
  assert.equal(await playDeathAttack(session, 1433, attack, { x: 0, y: 0 }, []), true);

  assert.equal(frames.length, 1, "the choreography still goes out");
  const { op, doid, field, reader } = ((frame) => {
    const r = new PacketReader(frame.subarray(2));
    const o = r.u16();
    const d = r.u32();
    return { op: o, doid: d, field: r.u16(), reader: r };
  })(frames[0]);

  assert.equal(op, OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(doid, 1433, "on the chest");
  assert.equal(field, 143, "ReceiveAttackChoreography");
  reader.u8(); // weaponSlot
  reader.u8(); // isConsumableWeapon
  assert.equal(reader.u32(), attack.Id, "naming LOOT_SPAWN_A1, as the capture does");
});

/** A barrel still bangs: the damage half is gated on colliders, not the animation. */
test("an attack that does hurt somebody still schedules its damage", async () => {
  const { attackForConstant, npcForConstant, attackColliders } = await import(
    "../src/gamemaster.js"
  );
  const { worldColliders } = await import("../src/socket/heading.js");
  const { playDeathAttack } = await import("../src/socket/hazards.js");

  const npc = await npcForConstant("CASTLE_ARENA_EXPLODING_BARREL");
  const attack = await attackForConstant(npc.DeathAttack);
  const colliders = await attackColliders(attack.AttackTimeline);
  assert.ok(colliders.length, "the barrel's blast has one");

  const frames = [];
  const session = { id: 30, dungeonActive: true, objects: new Map(), actors: new Map(), send: (f) => frames.push(f) };
  const at = { x: 2000, y: 2000 };

  assert.equal(
    await playDeathAttack(session, 9500, attack, at, worldColliders(at, 0, colliders)),
    true
  );
  assert.equal(frames.length, 1, "announced once, and the bang is still on a timer");
});

/**
 * The animation the chest arrives with.
 *
 * `REWARD_CHEST_A` authors `Attack1: LOOT_INTRO_A1`, three frames of `visible`,
 * `attackEffect` and `sound` and nothing else, and the recorded runs play it
 * once at 0.16 and 0.18s after the create — including on a chest left standing
 * 8.78 seconds with an `AttackTimer` of 1, which sent exactly one. An entrance,
 * not a cycle, and this server sent neither.
 */
test("an attack that only plays is an arrival, and only the chest has one", async () => {
  const { isArrivalAnimation, npcForConstant, loadGameMaster } = await import(
    "../src/gamemaster.js"
  );
  const gm = await loadGameMaster();

  assert.equal(await isArrivalAnimation(await npcForConstant("REWARD_CHEST_A")), true);

  // The near misses. Both look empty until what they spawn is counted.
  for (const constant of ["SHAMAN_IMP", "RIVAL_VAMPIRE_HUNTER_MASTER_TRAPPER"]) {
    assert.equal(
      await isArrivalAnimation(await npcForConstant(constant)),
      false,
      `${constant} spawns something, so its Attack1 is an attack`
    );
  }
  // And a statue that aims, a knight that swings, a tile that stabs.
  for (const constant of ["NORDIC_TEMPLE_TRAP_STATUE_LOKI", "KNIGHT", "CASTLE_PRISON_TRAP_SPIKE"]) {
    assert.equal(await isArrivalAnimation(await npcForConstant(constant)), false, constant);
  }

  /**
   * And nothing else in the game, which is what makes the rule safe: it can
   * only ever reach an attack that does nothing.
   */
  let matches = 0;
  for (const npc of gm.raw.Npc) if (await isArrivalAnimation(npc)) matches += 1;
  assert.equal(matches, 1, "one NPC in the whole table");
});

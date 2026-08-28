import test from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config.js";
import { handleProposeCreateNPC, notePlacementPermit } from "../src/socket/placeables.js";
import { attackForConstant, npcForConstant } from "../src/gamemaster.js";
import { PacketWriter, PacketReader } from "../src/socket/packet.js";

/**
 * `ProposeCreateNPC` took any known NPC id at any coordinate from any slot: the
 * client said "a mine appeared here" and this server made one. Every trap and
 * placeable in the game, anywhere on the floor, for nothing.
 *
 * The authored data says exactly what a placement can be, so it is closed with
 * a permit rather than a guess. Exactly three projectiles name an `OnDeathNPC`
 * — `PROJ_GARLIC`, `PROJ_MINES`, `PROJ_FIREBOMB` — so those three placeables
 * are the whole of what this field can honestly ask for.
 *
 * An earlier version of this comment credited the official recordings with 32
 * such placements. They contain none: across all 66 captures there is not one
 * outbound field 177 and not one of those three ever generated. What the
 * behaviour is measured against instead is a session played against this server
 * with the same unmodified client, which placed five — three garlics, a mine
 * and a firebomb.
 */
test("a placeable lands only where a throw of it was allowed", async () => {
  const mine = await npcForConstant("STICKY_MINE_PLACEABLE");
  const throwMine = await attackForConstant("THROW_MINE");
  assert.equal(throwMine.Projectile, "PROJ_MINES", "the throw this permit comes from");

  const world = () => ({
    id: 98,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroHeading: 0,
    heroWeapons: [{ power: 1 }, { power: 1 }, { power: 1 }],
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => 8888,
    send: () => {},
  });
  const landIt = () =>
    new PacketReader(new PacketWriter().u32(mine.Id).u32(2).f32(300).f32(300).body());

  config.castMode = "enforce";
  config.placementMode = "enforce";
  try {
    const forged = world();
    await handleProposeCreateNPC(forged, landIt());
    assert.equal(forged.objects.size, 0, "nothing lands with no throw behind it");

    const honest = world();
    await notePlacementPermit(honest, throwMine, 2);
    await handleProposeCreateNPC(honest, landIt());
    assert.ok(honest.objects.size > 0, "and it lands when the throw was accepted");

    // One throw, one mine.
    const landed = honest.objects.size;
    await handleProposeCreateNPC(honest, landIt());
    assert.equal(honest.objects.size, landed, "the same permit does not pay twice");

    // The slot is part of it: 32 of 32 official placements matched their cast's.
    const wrongSlot = world();
    await notePlacementPermit(wrongSlot, throwMine, 0);
    await handleProposeCreateNPC(wrongSlot, landIt());
    assert.equal(wrongSlot.objects.size, 0, "a permit from another slot is not this one");
  } finally {
    config.castMode = "off";
    config.placementMode = "off";
  }
});

/**
 * A permit proves what was thrown and from which slot. It says nothing about
 * where the thing landed, and nothing read the coordinate — so one honest
 * throw could put a mine at NaN, Infinity, and this server built it there.
 *
 * The hero's own position has been refused on this rule since it was measured:
 * 34850 official coordinates, none non-finite, none past a million. The same
 * claim on a different field gets the same answer.
 */
test("a placeable needs a coordinate that is one", async () => {
  const mine = await npcForConstant("STICKY_MINE_PLACEABLE");
  const throwMine = await attackForConstant("THROW_MINE");

  const world = () => ({
    id: 97,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroHeading: 0,
    heroWeapons: [{ power: 1 }, { power: 1 }, { power: 1 }],
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => 8888,
    send: () => {},
  });
  const landAt = (x, y) =>
    new PacketReader(new PacketWriter().u32(mine.Id).u32(2).f32(x).f32(y).body());

  for (const [x, y, what] of [
    [NaN, 300, "NaN"],
    [300, Infinity, "Infinity"],
    [-Infinity, -Infinity, "negative infinity"],
    [2e6, 2e6, "past the coordinate limit"],
  ]) {
    const session = world();
    await notePlacementPermit(session, throwMine, 2);
    await handleProposeCreateNPC(session, landAt(x, y));
    assert.equal(session.objects.size, 0, `nothing lands at ${what}`);
  }

  // A real coordinate still does, so the rule is about the number and not the throw.
  const honest = world();
  await notePlacementPermit(honest, throwMine, 2);
  await handleProposeCreateNPC(honest, landAt(300, 300));
  assert.ok(honest.objects.size > 0, "and an ordinary place still works");

  /**
   * This rule is about the number and the next one is about the throw, so a
   * finite coordinate far from the hero passes here — with enforcement off, as
   * this test runs it, everything passes anyway. What refuses it is the range
   * bound below, under `DR_REQUIRE_CAST`.
   */
  const far = world();
  await notePlacementPermit(far, throwMine, 2);
  await handleProposeCreateNPC(far, landAt(900000, 900000));
  assert.ok(far.objects.size > 0, "a finite coordinate is not this rule's business");
});

/**
 * The permit proved what was thrown and out of which slot, and said nothing
 * about where it landed — so one honest throw could put a mine anywhere finite.
 *
 * The projectile's authored `Range` answers it, and the origin is fixed when
 * the cast is accepted rather than read at landing: the thing flies from where
 * the hero stood, so walking away afterwards does not move it.
 *
 * The bound is generous against what a throw does. Five placements in a session
 * played against this server landed 17, 179, 179, 182 and 209 units out, all
 * three projectiles authoring a `Range` of 350.
 */
test("a placeable lands within the throw that permitted it", async () => {
  const mine = await npcForConstant("STICKY_MINE_PLACEABLE");
  const throwMine = await attackForConstant("THROW_MINE");

  const world = () => ({
    id: 93,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    heroWeapons: [{ power: 1 }, { power: 1 }, { power: 1 }],
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => 8888,
    send: () => {},
  });
  const landAt = (x, y) =>
    new PacketReader(new PacketWriter().u32(mine.Id).u32(2).f32(x).f32(y).body());

  config.castMode = "enforce";
  config.placementMode = "enforce";
  try {
    // 209 units out is the furthest a real throw was seen to go.
    const near = world();
    await notePlacementPermit(near, throwMine, 2);
    await handleProposeCreateNPC(near, landAt(1209, 1000));
    assert.ok(near.objects.size > 0, "an ordinary throw lands");

    // Finite, under the coordinate limit, and nowhere near the throw.
    const far = world();
    await notePlacementPermit(far, throwMine, 2);
    await handleProposeCreateNPC(far, landAt(900_000, 900_000));
    assert.equal(far.objects.size, 0, "and one across the map does not");

    /**
     * The hero walking off does not drag the mine with him: the origin is where
     * the throw was made, not where he is now.
     */
    const moved = world();
    await notePlacementPermit(moved, throwMine, 2);
    moved.heroPosition = { x: 50_000, y: 50_000 };
    await handleProposeCreateNPC(moved, landAt(1209, 1000));
    assert.ok(moved.objects.size > 0, "the throw is measured from where it was thrown");
  } finally {
    config.castMode = "off";
    config.placementMode = "off";
  }
});

/**
 * There used to be two searches here: one for the origin the wall sweep
 * measured from, another for the record to consume, matched on different
 * criteria. With two live throws of the same thing from the same slot they
 * could land on different records — the mine placed against the near permit
 * while the sweep reported the far one crossing a wall.
 *
 * That is both a false positive and a false negative in the very telemetry
 * meant to decide whether the sweep can be enforced, so it is worth a test
 * before the count is trusted.
 */
test("two live permits audit and consume the same one", async () => {
  const mine = await npcForConstant("STICKY_MINE_PLACEABLE");
  const throwMine = await attackForConstant("THROW_MINE");

  const session = {
    id: 92,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 50_000, y: 50_000 },
    heroHeading: 0,
    heroWeapons: [{ power: 1 }, { power: 1 }, { power: 1 }],
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => 8888,
    send: () => {},
  };

  // One throw from far away, then one from where the mine actually lands.
  await notePlacementPermit(session, throwMine, 2);
  session.heroPosition = { x: 1000, y: 1000 };
  await notePlacementPermit(session, throwMine, 2);
  assert.equal(session.placementPermits.length, 2, "both throws are live");

  config.castMode = "enforce";
  config.placementMode = "enforce";
  try {
    await handleProposeCreateNPC(
      session,
      new PacketReader(new PacketWriter().u32(mine.Id).u32(2).f32(1000).f32(1000).body())
    );
  } finally {
    config.castMode = "off";
    config.placementMode = "off";
  }

  assert.ok(session.objects.size > 0, "the mine lands on the throw that reaches it");
  assert.equal(session.placementPermits.length, 1, "and that is the throw that is spent");
  assert.equal(
    session.placementPermits[0].origin.x,
    50_000,
    "the far one is untouched, not consumed in its place"
  );
});

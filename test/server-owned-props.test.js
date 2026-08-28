import test from "node:test";
import assert from "node:assert/strict";
import { buildFloor } from "../src/socket/floors.js";
import { npcForConstant, propForConstant } from "../src/gamemaster.js";

const CAVES = "Resources/Levels/nordic/caves/tiles.json";

/**
 * The scenery nobody was drawing.
 *
 * `TileFactory.buildProp` validates an `LEProp` against the *Prop* table and
 * nothing else: a constant that is not there logs `invalid prop constant` and
 * the object never appears. Almost every LEProp does have a Prop row — 30 927
 * of them across the libraries — but 198 do not, and those live in the Npc
 * table instead. The official generates every one as a distributed object.
 *
 * Reading them as client-owned left the caves missing their ice stalagmites,
 * ground spikes and towers, which is what "the maps feel like something is
 * missing" was. Replaying forty of the official's own floors, they went from
 * 147 objects the official placed and we did not, to three.
 *
 * They hid because the same constants are *also* authored as LENPC in the same
 * libraries — ICESTALAGMITE_A 46 times as one and 35 as the other — so the
 * floors that happened to use the LENPC spelling looked correct.
 */

test("an LEProp the client cannot draw is placed by the server", async () => {
  const floor = await buildFloor(CAVES, { tier: 1, tileCount: 14, seed: 7 });
  const placed = new Set((floor.placements.npc ?? []).map((npc) => npc.constant));

  const owed = [...placed].filter(
    (constant) => /GROUND_SPIKES|ICESTALAGMITE|SMASH_SKULLPILE/.test(constant)
  );
  assert.ok(owed.length > 0, "the caves lay ground scenery the client has no Prop row for");

  // And each one really is in that position: an Npc row, and no Prop row.
  for (const constant of owed) {
    assert.ok(await npcForConstant(constant), `${constant} should have an Npc row`);
    assert.equal(await propForConstant(constant), null, `${constant} should have no Prop row`);
  }
});

test("an LEProp the client can draw is still left to it", async () => {
  /**
   * The other 30 927. Generating those as well would put two of everything on
   * the floor — the client's own copy from the tile library and ours over it.
   */
  const floor = await buildFloor(CAVES, { tier: 1, tileCount: 14, seed: 7 });

  for (const npc of floor.placements.npc ?? []) {
    const prop = await propForConstant(npc.constant);
    assert.equal(
      prop,
      null,
      `${npc.constant} has a Prop row, so the client draws it and we must not`
    );
  }
});

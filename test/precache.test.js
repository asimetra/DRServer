import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { preloadFor } from "../src/socket/precache.js";
import { dungeonAreaGenerate } from "../src/socket/objects.js";
import { CLID } from "../src/socket/opcodes.js";

const TEMPLE = "Resources/Levels/nordic/temple/tiles.json";
const CAVES = "Resources/Levels/nordic/caves/tiles.json";
const FX = "Resources/Art2D/FX/db_fx_library.swf";

/** The three lists back out of an area generate, as the client reads them. */
const readArea = (frame) => {
  const body = frame.subarray(2);
  let at = 16;
  const u16 = () => { const value = body.readUInt16LE(at); at += 2; return value; };
  const u32 = () => { const value = body.readUInt32LE(at); at += 4; return value; };
  const utf = () => { const n = u16(); const s = body.toString("utf8", at, at + n); at += n; return s; };
  const strings = () => { const end = at + u16() + 0; const out = []; while (at < end) out.push(utf()); return out; };
  const ids = () => { const end = at + u16() + 0; const out = []; while (at < end) out.push(u32()); return out; };
  return {
    clid: body.readUInt16LE(10),
    tileLibrary: strings(),
    cacheNpc: ids(),
    cacheSWC: strings(),
    trailing: body.length - at,
  };
};

/**
 * A trap that damages you while drawing nothing.
 *
 * `BURNING_FIRE_PLACEABLE_ALL` and `MINE_PLACEABLE_ALL` keep their art in
 * `db_fx_library.swf`, and Flash resolves a class against the applicationDomain
 * of the SWF it came from — so a library the client was never told to load has
 * nowhere to find the clip. It says `rootType=null` once and carries on, which
 * is why this survived every field-by-field diff: the generates were right.
 */
test("a floor that authors fx placeables preloads the library holding their art", async () => {
  const gm = await loadGameMaster();

  const temple = await preloadFor([TEMPLE], { gm, tierConstant: "NORDIC_TEMPLE" });
  assert.ok(temple.cacheSwfs.includes(FX), "the temple authors mines and fire, so it needs the fx library");

  /**
   * And it is not simply appended to everything. The official declares it on
   * nordic/temple (9 recordings of 12), castle/prison (8 of 9) and jungle/dino
   * (2 of 3), and on none of the 35 nordic/caves areas, 25 castle/arena or 8
   * castle/catacombs — the themes whose libraries author no placeable.
   */
  const caves = await preloadFor([CAVES], { gm, tierConstant: "ICE_CAVES" });
  assert.ok(!caves.cacheSwfs.includes(FX), "the caves author none, and the official does not send it either");
});

test("the environment art a theme draws with is preloaded from the Prop table", async () => {
  /**
   * The paths are looked up rather than composed. Every one of these was read
   * out of an area generate the official sent for a nordic/caves run.
   */
  const gm = await loadGameMaster();
  const { cacheSwfs } = await preloadFor([CAVES], { gm, tierConstant: "ICE_CAVES" });

  for (const expected of [
    "Resources/Art2D/Environments/nordic/ground_nordic_caves/db_grd_nordic_caves_library.swf",
    "Resources/Art2D/Environments/nordic/prop_nordic_caves/db_prop_nordic_caves_library.swf",
    "Resources/Art2D/Environments/shared/props/db_prop_shared_library.swf",
  ]) {
    assert.ok(cacheSwfs.includes(expected), `missing ${expected}`);
  }
});

test("the area generate carries all three lists, and nothing after them", async () => {
  /**
   * The fields are byte-length-prefixed, so a miscounted list does not fail —
   * it slides the reader into the middle of the next one. Reading the frame
   * back and landing exactly on its end is what says the framing is right.
   */
  const gm = await loadGameMaster();
  const { cacheNpcs, cacheSwfs } = await preloadFor([TEMPLE], { gm, tierConstant: "NORDIC_TEMPLE" });
  assert.ok(cacheNpcs.length > 0 && cacheSwfs.length > 0, "the temple fills both lists");

  const area = readArea(
    dungeonAreaGenerate({ doid: 500, parent: 1, tileLibraries: [TEMPLE], cacheNpcs, cacheSwfs })
  );

  assert.equal(area.clid, CLID.DistributedDungionArea);
  assert.deepEqual(area.tileLibrary, [TEMPLE]);
  assert.deepEqual(area.cacheNpc, cacheNpcs);
  assert.deepEqual(area.cacheSWC, cacheSwfs);
  assert.equal(area.trailing, 0, "the three lists account for the whole body");
});

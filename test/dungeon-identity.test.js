import assert from "node:assert/strict";
import test from "node:test";

import { heroDoidForAvatar } from "../src/socket/dungeon.js";
import { heroOwnerGenerate } from "../src/socket/objects.js";
import { decodeGenerate } from "../tools/wire.js";

test("the owner hero doid is the active avatar instance id", () => {
  /**
   * Infinite revive and exit UI does this lookup directly:
   *
   *   getReferenceFromId(dbAccountInfo.activeAvatarInfo.id)
   *
   * The official server therefore generates HeroGameObjectOwner with that same
   * id. Allocating an unrelated doid leaves the lookup null and the native
   * client segfaults when it dereferences `distributedDungeonFloor`.
   */
  assert.equal(heroDoidForAvatar({ id: 1_101_000_055 }), 1_101_000_055);
  assert.equal(heroDoidForAvatar({ id: 1_100_334_245 }), 1_100_334_245);
});

test("an invalid avatar id is refused before a malformed owner generate", () => {
  for (const id of [
    undefined,
    null,
    0,
    -1,
    1.5,
    1_000_055,
    0x1_0000_0000,
    0x8000_0000,
    Number.NaN,
  ]) {
    assert.throws(() => heroDoidForAvatar({ id }), /client-safe instance id/);
  }
});

test("the owner hero generate uses the production dungeon zone", () => {
  const generated = decodeGenerate(
    heroOwnerGenerate({
      doid: 1_101_000_055,
      parent: 1234,
      heroType: 104,
      skinType: 154,
      playerId: 1_000_000_005,
      screenName: "Player1000000005",
    }).subarray(2)
  );

  assert.equal(generated.error, undefined, generated.error);
  assert.equal(generated.class, "HeroGameObjectOwner");
  assert.equal(generated.doid, 1_101_000_055);
  assert.equal(generated.parent, 1234);
  assert.equal(generated.zone, 10);
});

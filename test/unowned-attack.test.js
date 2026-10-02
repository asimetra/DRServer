import assert from "node:assert/strict";
import test from "node:test";

import { weaponWith } from "./helpers/weapons.js";

/**
 * A hit from an attack the weapon in its slot does not have.
 *
 * The slot names a weapon this server equipped, so what it can swing is the
 * server's table. A modified client — one that edited the weapon it shows, or
 * just writes results — could otherwise land any attack in the game with the
 * weapon it holds, and since reach is measured against the attack named, a
 * sword claiming a long-range spell hit from across the floor. Of 6616 hits by
 * the player's hero in 84 official recordings none is refused by this, once
 * Dungeon Busters, Berserk's RAMPAGE and the two revive bombs are allowed for.
 */

const { handleProposeCombatResults } = await import("../src/socket/combat.js");
const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");
const { CLID } = await import("../src/socket/opcodes.js");
const { attackForConstant, loadGameMaster } = await import("../src/gamemaster.js");
// Before anything asks what a weapon grants: a pack's variants are part of it.
const { readyContentPacks } = await import("../src/content-packs.js");
await readyContentPacks({ quiet: true });

const hitWith = async (weapon, constant) => {
  const attack = await attackForConstant(constant);
  const session = {
    id: 96,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 0, y: 0 },
    heroPositionAt: Date.now(),
    heroWeapons: [weapon],
    objects: new Map([[500, CLID.HeroGameObject], [700, CLID.DistributedNPCGameObject]]),
    actors: new Map([
      [700, { hitPoints: 99999, maxHitPoints: 99999, constant: "KNIGHT_TUTORIAL", position: { x: 40, y: 0 }, isEnemy: true }],
    ]),
    allocateDoid: () => 9999,
    send: () => {},
  };
  const result = new PacketWriter()
    .u32(500).u32(700).i32(0).u8(0).u8(0).u32(Number(attack.Id)).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  await handleProposeCombatResults(session, new PacketReader(new PacketWriter().u16(result.length).raw(result).body()));
  return { session, landed: session.actors.get(700).hitPoints < 99999 };
};

test("a hit with an attack the slot's weapon has lands", async () => {
  const { landed } = await hitWith(await weaponWith("AXE_COMBO_1", { power: 100 }), "AXE_COMBO_1");
  assert.equal(landed, true);
});

test("a hit with an attack the slot's weapon does not have is dropped, and only that", async () => {
  const axe = await weaponWith("AXE_COMBO_1", { power: 100 });
  const { session, landed } = await hitWith(axe, "THUNDERSTORM");
  assert.equal(landed, false, "a storm from an axe lands nothing");
  assert.equal(session.terminationRequested ?? null, null, "and the session goes on: it is refused, not punished");
  assert.ok(session.violations?.has("cast.not_granted"), "and it is reported");
});

test("a revive bomb is not a weapon's and is not refused for it", async () => {
  const axe = await weaponWith("AXE_COMBO_1", { power: 100 });
  const { session } = await hitWith(axe, "HEALTH_BOMB_ATTACK");
  assert.equal(session.violations?.has("cast.not_granted") ?? false, false);
});

/**
 * A content pack's weapon names its own variants of the attacks it swings, and
 * a hit is read as the base attack before it is checked. Found in 11 sessions
 * with the pack's katana: every special and every fifth combo was refused.
 */
test("a pack weapon's variant attacks land, as the base attacks they stand in for", async (t) => {
  const { raw } = await loadGameMaster();
  const katana = raw.WeaponItem.find((row) => row.Constant === "HERO_LIGHT_KATANA__THE_KNIGHT");
  if (!katana) return t.skip("this checkout has no content pack with the knight's katana");
  const weapon = { type: katana.Id, power: 100 };
  for (const constant of [katana.ChargeAttack, katana.Attack4]) {
    const { landed } = await hitWith(weapon, constant);
    assert.equal(landed, true, constant);
  }
});


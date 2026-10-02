import test from "node:test";
import { weaponWith } from "./helpers/weapons.js";
import assert from "node:assert/strict";

import { loadGameMaster } from "../src/gamemaster.js";
import { handleProposeCombatResults } from "../src/socket/combat.js";
import { CLID } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

/**
 * Which hits a weapon's crit modifier reaches, against the official corpus.
 *
 * The health and party bombs are proposed as slot 0 and not consumable — 461 of
 * 461 of the official's — and priced from that slot's weapon, so a crit
 * modifier on it reached them: a katana's CRIT_DAMAGE_4 turned a health bomb
 * into 8946. The official's 628 SUPPORT hits carry no crit; its melee,
 * shooting and magic hits do.
 */

const HERO = 500;
const VICTIM = 700;

const hit = async (attackConstant) => {
  const gm = await loadGameMaster();
  const crit = [...gm.modifiersById.values()].find((row) => row.Constant === "CRIT_DAMAGE_4");
  const attack = gm.raw.Attack.find((row) => row.Constant === attackConstant);
  const sent = [];
  const session = {
    id: 95,
    heroDoid: HERO,
    floorDoid: 400,
    dungeonActive: true,
    // A hand axe, which has AXE_COMBO_1; the bomb is the slot's whatever it holds.
    heroWeapons: [await weaponWith("AXE_COMBO_1", { power: 100, modifier1: crit.Id })],
    random: () => 0,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [VICTIM, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [VICTIM, { hitPoints: 60_000, maxHitPoints: 60_000, constant: "BRUTE", isEnemy: true }],
    ]),
    allocateDoid: () => 900,
    send: (frame) => sent.push(frame),
  };
  const result = new PacketWriter()
    .u32(HERO).u32(VICTIM).i32(0).u8(0).u8(0).u32(attack.Id).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  await handleProposeCombatResults(
    session,
    new PacketReader(new PacketWriter().u16(result.length).raw(result).body())
  );
  const echo = sent.find((frame) => frame.readUInt32LE(4) === VICTIM && frame.readUInt16LE(8) === 144);
  return { damage: 0 - echo.readInt32LE(18), critical: echo.readUInt8(36) };
};

test("a health bomb never crits, whatever the weapon in slot 0 carries", async () => {
  const bomb = await hit("HEALTH_BOMB_ATTACK");
  assert.equal(bomb.critical, 0);
  assert.equal(bomb.damage, 150, "slot 0's power times the bomb's 1.5, as the official's 116 × 1.5 = 174");
});

test("the same weapon's swing still crits", async () => {
  const swing = await hit("AXE_COMBO_1");
  assert.equal(swing.critical, 1);
});

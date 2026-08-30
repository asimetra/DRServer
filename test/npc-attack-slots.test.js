import assert from "node:assert/strict";
import test from "node:test";

import { attackForConstant, npcForConstant, weaponForConstant } from "../src/gamemaster.js";
import { npcAttackChoices } from "../src/socket/dungeon.js";

test("NPC charge attacks in later slots are included in the attack list", async () => {
  const npc = await npcForConstant("RIVAL_BERSERKER");
  assert.ok(npc, "the rival berserker exists");
  const weapon = npc.Weapon1 ? await weaponForConstant(npc.Weapon1) : null;

  const attacks = await npcAttackChoices(npc, weapon);
  const attackIds = new Set(attacks.map((attack) => attack.attackType));

  const fissure = await attackForConstant("FISSURE");
  const berserk = await attackForConstant("EN_DBUSTER_BERSERK");
  assert.ok(fissure, "the charge attack exists");
  assert.ok(berserk, "the later-slot special exists");

  assert.ok(attackIds.has(fissure.Id), "Attack4/FISSURE is included");
  assert.ok(attackIds.has(berserk.Id), "Attack5/EN_DBUSTER_BERSERK is included");
  assert.equal(attacks.length, 5, "all authored attack slots are exposed");
});

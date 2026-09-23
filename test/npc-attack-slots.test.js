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

test("NPC attack choices retain the authored animation speed", async () => {
  const npc = await npcForConstant("SAVAGE_BOW");
  assert.ok(npc, "the poison archer exists");
  const weapon = npc.Weapon1 ? await weaponForConstant(npc.Weapon1) : null;

  const attacks = await npcAttackChoices(npc, weapon);
  const poisonArrow = await attackForConstant("EN_POISON_ARROW");
  const choice = attacks.find((attack) => attack.attackType === poisonArrow?.Id);

  assert.ok(choice, "the poison arrow is available to the archer");
  assert.equal(poisonArrow.AttackSpd, 0.25, "the fixture still authors quarter speed");
  assert.equal(choice.attackSpeed, 0.25, "runtime preserves that authored speed");
  assert.equal(choice.speedStat, "SHOOT_SPD", "shooting buffs use the shooting speed column");
});

test("NPC attack choices retain the last authored damage frame as movement lock", async () => {
  const npc = await npcForConstant("KNIGHT_TUTORIAL");
  const weapon = npc.Weapon1 ? await weaponForConstant(npc.Weapon1) : null;
  const attacks = await npcAttackChoices(npc, weapon);
  const slash = await attackForConstant("EN_SWORD_SLASH");
  const choice = attacks.find((attack) => attack.attackType === slash?.Id);

  assert.ok(choice);
  assert.equal(choice.impactFrame, 11);
  assert.equal(choice.attackLockFrame, 11);
});

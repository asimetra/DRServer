import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster } from "../src/gamemaster.js";
import { chooseNpcAttack } from "../src/socket/ai.js";
import { npcAttackChoices } from "../src/socket/npc-attacks.js";

const gm = await loadGameMaster();

const choicesFor = async (constant) => {
  const npc = gm.npcByConstant.get(constant);
  const weapon = npc.Weapon1 ? gm.weaponsByConstant.get(npc.Weapon1) : null;
  const attacks = await npcAttackChoices(npc, weapon);
  return {
    ai: { attacks },
    named: (choice) => gm.attacksById.get(choice.attackType)?.Constant,
  };
};

const availableAt = (ai, named, distance, now = 0) => {
  const found = new Set();
  for (const roll of [0, 0.24, 0.49, 0.74, 0.999999]) {
    const choice = chooseNpcAttack(ai, distance, 60, now, () => roll);
    if (choice) found.add(named(choice));
  }
  return [...found].sort();
};

test("Freeze Imp selection follows its three authored distance bands", async () => {
  const { ai, named } = await choicesFor("FREEZE_IMP");

  assert.deepEqual(availableAt(ai, named, 100), ["EN_FREEZE_IMP_ATTACK"]);
  assert.deepEqual(
    availableAt(ai, named, 300),
    ["EN_FREEZE_IMP_ATTACK", "EN_ICE_IMP_ATTACK_SHOWOFF"]
  );
  assert.deepEqual(
    availableAt(ai, named, 500),
    ["EN_ICE_IMP_ATTACK", "EN_ICE_IMP_ATTACK_SHOWOFF"]
  );
});

test("Lion selection opens roar, tackle, and claw at their authored ranges", async () => {
  const { ai, named } = await choicesFor("LION");

  assert.deepEqual(availableAt(ai, named, 300), ["EN_LION_ROAR"]);
  assert.deepEqual(availableAt(ai, named, 90), ["EN_LION_ROAR", "EN_LION_TACKLE"]);
  assert.deepEqual(
    availableAt(ai, named, 60),
    ["EN_LION_ROAR", "EN_LION_TACKLE", "EN_MONSTER_CLAW"]
  );
});

test("Mini Boss Imp exposes the right move set at close, middle, and far range", async () => {
  const { ai, named } = await choicesFor("MINI_BOSS_IMP");

  assert.deepEqual(
    availableAt(ai, named, 100),
    ["EN_AREA_PULL_PULSE_ATTACK", "EN_ICE_IMP_ATTACK_BACKOFF"]
  );
  assert.deepEqual(
    availableAt(ai, named, 300),
    ["EN_AREA_PULL_PULSE_ATTACK", "EN_ICE_IMP_ATTACK_BACKOFF", "EN_ICE_IMP_ATTACK_SHOWOFF"]
  );
  assert.deepEqual(
    availableAt(ai, named, 600),
    ["EN_ICE_IMP_ATTACK", "EN_ICE_IMP_ATTACK_SHOWOFF"]
  );
});

test("per-attack recharge removes only the move whose own clock is running", async () => {
  const { ai, named } = await choicesFor("LION");
  const roar = ai.attacks.find((choice) => named(choice) === "EN_LION_ROAR");
  roar.readyAt = 10_000;

  assert.deepEqual(
    availableAt(ai, named, 60, 1000),
    ["EN_LION_TACKLE", "EN_MONSTER_CLAW"]
  );
  assert.deepEqual(
    availableAt(ai, named, 60, 10_000),
    ["EN_LION_ROAR", "EN_LION_TACKLE", "EN_MONSTER_CLAW"]
  );
});

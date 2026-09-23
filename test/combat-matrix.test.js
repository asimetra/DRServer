import assert from "node:assert/strict";
import test from "node:test";

import { buildCombatMatrix } from "../tools/combat-matrix-lib.js";

test("every authored mover attack passes the generated combat matrix", async () => {
  const matrix = await buildCombatMatrix({ muteLogs: true });

  assert.ok(matrix.summary.npcRows > 100, "the matrix silently lost the mover catalogue");
  assert.ok(matrix.summary.weaponRows > 100, "the matrix silently lost the weapon catalogue");
  assert.equal(
    matrix.summary.runtimeNpcCases,
    matrix.summary.npcAttackReferences,
    "an authored NPC attack was inventoried but never executed"
  );
  assert.equal(
    matrix.summary.projectileNpcCases +
      matrix.summary.colliderNpcCases +
      matrix.summary.noImpactNpcCases,
    matrix.summary.runtimeNpcCases,
    "a runtime attack has no declared resolution path"
  );
  assert.equal(matrix.weaponCases.length, matrix.summary.weaponAttackReferences);
  assert.ok(matrix.summary.runtimeWeaponCases > 250, "weapon result coverage collapsed");
  for (const constant of [
    "EN_ICE_IMP_ATTACK_SHOWOFF",
    "EN_ICE_IMP_ATTACK_BACKOFF",
    "EN_SHAMAN_IMP_SPAWN",
    "EN_YETI_SPAWN_BABIES",
  ]) {
    const cases = matrix.npcCases.filter((testCase) => testCase.attack === constant);
    assert.ok(cases.length > 0, `${constant} disappeared from the matrix`);
    assert.ok(
      cases.every(
        (testCase) => testCase.resolution === "no-impact" && testCase.observed.damage === 0
      ),
      `${constant} regained a geometry-free fallback hit`
    );
  }
  assert.deepEqual(matrix.failures, []);
});

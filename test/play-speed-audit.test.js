import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { loadGameMaster } from "../src/gamemaster.js";
import {
  auditHeroPlaySpeed,
  expectedHeroPlaySpeedRange,
} from "../src/socket/buster.js";
import { RULE } from "../src/socket/security-events.js";

test("playSpeed audit derives ordinary, holding, and repeater bounds from authored data", async (t) => {
  const previous = config.castMode;
  config.castMode = "audit";
  t.after(() => { config.castMode = previous; });

  const gm = await loadGameMaster();
  const sword = gm.weaponById.get(10001);
  const session = {
    id: "speed-audit",
    heroDoid: 500,
    heroStats: new Map([["MELEE_SPD", 1], ["SHOOT_SPD", 1], ["MAGIC_SPD", 1]]),
    heroWeapons: [{ type: sword.Id, modifier1: 0, modifier2: 0 }],
  };

  const ordinary = gm.attacksByConstant.get(sword.Attack1);
  assert.deepEqual(await expectedHeroPlaySpeedRange(session, ordinary, 0), {
    min: Number(sword.Speed),
    max: Number(sword.Speed),
  });

  const holding = gm.attacksByConstant.get(sword.HoldingAttack);
  const holdingRange = await expectedHeroPlaySpeedRange(session, holding, 0);
  assert.ok(Math.abs(holdingRange.min - Number(sword.Speed) * 8) < 0.0001);
  assert.equal(holdingRange.max, holdingRange.min);

  assert.equal(await auditHeroPlaySpeed(session, ordinary, 0, ordinary.AttackSpd * sword.Speed), false);
  assert.equal(await auditHeroPlaySpeed(session, ordinary, 0, 32), true);
  assert.equal(session.violations.get(RULE.playSpeedMismatch)?.count, 1);

  const repeater = gm.raw.WeaponItem.find((row) => row.WeaponController === "REPEATER");
  const repeaterAttack = gm.attacksByConstant.get(repeater.Attack1);
  session.heroWeapons[0] = { type: repeater.Id, modifier1: 0, modifier2: 0 };
  const repeaterRange = await expectedHeroPlaySpeedRange(session, repeaterAttack, 0);
  assert.ok(repeaterRange.max > repeaterRange.min, "repeater acceleration collapsed to one value");
  assert.equal(
    await auditHeroPlaySpeed(session, repeaterAttack, 0, repeaterRange.max),
    false
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { attackTimelineFrames, loadGameMaster } from "../src/gamemaster.js";
import { auditCombatResultWhen } from "../src/socket/combat.js";
import { RULE } from "../src/socket/security-events.js";

test("CombatResult.when audit measures standalone timing and ignores embedded sentinel 255", async (t) => {
  const previous = config.castMode;
  config.castMode = "audit";
  t.after(() => { config.castMode = previous; });

  const gm = await loadGameMaster();
  const attack = gm.attacksByConstant.get("SWORD_COMBO_1");
  const totalFrames = await attackTimelineFrames(attack.AttackTimeline);
  const now = 10_000;

  const pastTimeline = { id: "past", violations: new Map() };
  assert.equal(
    await auditCombatResultWhen(
      pastTimeline,
      { when: totalFrames + 1 },
      attack,
      { at: now },
      now
    ),
    true
  );
  assert.equal(pastTimeline.violations.get(RULE.whenPastTimeline)?.count, 1);

  const late = { id: "late", violations: new Map() };
  assert.equal(
    await auditCombatResultWhen(late, { when: 0 }, attack, { at: now - 1000 }, now),
    true
  );
  assert.equal(late.violations.get(RULE.whenLate)?.count, 1);

  const embedded = { id: "embedded", violations: new Map() };
  assert.equal(
    await auditCombatResultWhen(embedded, { when: 255 }, attack, { at: 0 }, now),
    false
  );
  assert.equal(embedded.violations.size, 0);
});

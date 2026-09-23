import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster } from "../src/gamemaster.js";
import { npcAwarenessProfile } from "../src/socket/dungeon.js";

test("every moving combatant keeps its authored awareness and leash", async () => {
  const gm = await loadGameMaster();
  const moving = gm.raw.Npc.filter(
    (npc) => npc.IsMover && ["ENEMY", "BEAST", "PET"].includes(npc.CharType)
  );

  assert.equal(moving.length, 107, "the audited moving-combatant roster changed");
  for (const npc of moving) {
    const ownedPet = npc.CharType === "PET";
    const profile = npcAwarenessProfile(npc, { fallbackAggroRadius: 1800, ownedPet });
    const authoredAggro = Math.max(0, Number(npc.AggroRadius));
    const authoredDisengage = Number(npc.DisengageDist);

    assert.equal(
      profile.aggroRadius,
      authoredAggro,
      `${npc.Constant} replaced its authored AggroRadius with the fallback`
    );
    assert.equal(
      profile.disengageDistance,
      ownedPet || npc.CharType === "BEAST"
        ? Math.max(authoredAggro, authoredDisengage)
        : Math.max(authoredDisengage, authoredAggro + 400),
      `${npc.Constant} did not retain its authored leash policy`
    );
  }
});

test("an authored zero radius is passive rather than replaced by the fallback", async () => {
  const gm = await loadGameMaster();
  const passive = gm.npcByConstant.get("WARTHOG_WHITE_FAT");

  assert.equal(passive.AggroRadius, 0);
  assert.deepEqual(
    npcAwarenessProfile(passive, { fallbackAggroRadius: 1800 }),
    { aggroRadius: 0, disengageDistance: 1600 }
  );
});

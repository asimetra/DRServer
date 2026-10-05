import assert from "node:assert/strict";
import test from "node:test";

import { installRankedHooks } from "../src/ranked/hooks.js";
import { installModeHooks } from "../src/modes/hooks.js";
import { RANKED_RUN_RULES } from "../src/ranked/stock-client/adapter.js";
import { STOCK_RUN_RULES, rulesOfMode, runRules, runRulesOf } from "../src/socket/run-rules.js";
import { applyProgressReward, awardDungeonCompletion, awardTreasureChest } from "../src/socket/rewards.js";

/**
 * What a run pays and counts for is one object (socket/run-rules.js), and
 * every pay point reads it: a mode that pays less says so once.
 */
const everything = (rules) =>
  Object.values(rules.pays).every(Boolean) && rules.unlockCheck && rules.mapCredit && rules.rankable && rules.joinable;

test("the game's own run pays and counts for everything; a mode's rules sit on top of that", () => {
  assert.ok(everything(STOCK_RUN_RULES));
  assert.equal(runRulesOf({ accountId: 1 }), STOCK_RUN_RULES, "with no mode installed");
  const quiet = runRules({ mode: "quiet", pays: { experience: false } });
  assert.equal(quiet.mode, "quiet");
  assert.equal(quiet.pays.experience, false);
  assert.equal(quiet.pays.gold, true, "unsaid, the stock answer");
  assert.equal(quiet.mapCredit, true);
  assert.ok(Object.isFrozen(quiet) && Object.isFrozen(quiet.pays));
});

test("a ranked race keeps gold and loot, and pays no experience, chests, keys, trophy or gems", () => {
  assert.equal(RANKED_RUN_RULES.mode, "ranked");
  assert.deepEqual(RANKED_RUN_RULES.pays, { experience: false, gold: true, chests: false, keys: false, trophies: false, gems: false });
  assert.deepEqual(
    [RANKED_RUN_RULES.unlockCheck, RANKED_RUN_RULES.mapCredit, RANKED_RUN_RULES.rankable, RANKED_RUN_RULES.joinable],
    [false, false, false, false]
  );
});

test("a match's mode decides who may join it, by the mode's rules", (t) => {
  // A mode is asked for its own rules by name, so "closed" installs under that name.
  const uninstall = installModeHooks("closed", { modeRules: (mode) => runRules({ mode, joinable: false }) });
  t.after(uninstall);
  assert.equal(rulesOfMode("closed").joinable, false);
  assert.equal(rulesOfMode("open"), STOCK_RUN_RULES, "a mode nobody installed plays by the game's rules");
  assert.equal(rulesOfMode(null), STOCK_RUN_RULES);
});

const underRules = (t, rules) => {
  const uninstall = installRankedHooks({ runRules: () => rules });
  t.after(uninstall);
};

const session = () => ({
  id: 1,
  heroDoid: 11,
  playerDoid: 12,
  dungeonAccount: { basic_currency: 100, basic_keys: 0, trophies: 0, premium_currency: 0, completed_dungeons: 0, completed_mapnode_mask: "" },
  dungeonAvatar: { experience: 500, completed_mapnode_mask: "" },
  mapPage: { Id: 50005, Name: "A boss", NodeType: "BOSS", BitIndex: 0, CompletionXPBonus: 50, BasicKeys: 1 },
  persistDungeonAccount: async () => {},
  send: () => {},
});

test("under rules that pay no experience, a star picked up pays its gold and nothing else", (t) => {
  underRules(t, runRules({ pays: { experience: false } }));
  const target = session();
  applyProgressReward(target, { gold: 30, xp: 9 });
  assert.equal(target.dungeonAccount.basic_currency, 130);
  assert.equal(target.dungeonAvatar.experience, 500);
  assert.equal(target.dungeonRewards.xp, 0);
});

test("under a ranked race's rules, completion marks nothing and pays nothing a first clear would", async (t) => {
  underRules(t, RANKED_RUN_RULES);
  const target = session();
  const paid = await awardDungeonCompletion(target);
  assert.deepEqual(
    { experience: paid.experience, basicKeys: paid.basicKeys, trophies: paid.trophies, gems: paid.gems, firstClear: paid.firstClear },
    { experience: 0, basicKeys: 0, trophies: 0, gems: 0, firstClear: false }
  );
  assert.equal(target.dungeonAvatar.experience, 500);
  assert.equal(target.dungeonAccount.completed_dungeons, 0);
  assert.equal(target.dungeonAccount.completed_mapnode_mask, "", "the node is not marked done");
  assert.equal(await awardTreasureChest(target, 30100), null, "and a treasure owes no chest");
  assert.equal(target.dungeonTreasures, undefined);
});

test("the game's own run is untouched by any of this", async () => {
  const target = session();
  const paid = await awardDungeonCompletion(target);
  assert.equal(paid.experience, 50);
  assert.equal(paid.basicKeys, 1);
  assert.equal(paid.trophies, 1);
  assert.equal(paid.firstClear, true);
  assert.equal(target.dungeonAccount.completed_dungeons, 1);
  assert.equal(await awardTreasureChest(target, 30100), 60001);
});

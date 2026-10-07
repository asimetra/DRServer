import assert from "node:assert/strict";
import test from "node:test";

import { installModeHooks } from "../src/modes/hooks.js";
import { runRules } from "../src/socket/run-rules.js";
import { awardTreasureChest } from "../src/socket/rewards.js";
import { noteFloorEnemy, stealLife } from "../src/socket/life-steal.js";
import { beginFloorFailing, clearFloorFailing } from "../src/socket/floorstate.js";
import { CLID } from "../src/socket/opcodes.js";
import { plannedTreasure } from "../src/socket/floors.js";
import { spawnBossReward } from "../src/socket/drops.js";
import { runControls } from "../src/modes/runtime.js";
import { giftsFor, grantGift, returnGift } from "../src/gifts.js";
import { loadGameMaster } from "../src/gamemaster.js";

/** A run under `rules`, its floor plan saying `floor`. */
const runUnder = (t, rules, floor = {}) => {
  const uninstall = installModeHooks("rules-test", { runRules: (session) => (session.modeEntry === "rules-test" ? runRules({ mode: "rules-test", ...rules }) : null) });
  t.after(uninstall);
  return {
    id: "s",
    modeEntry: "rules-test",
    floorIndex: 0,
    floorPlan: { floors: [{ authored: "a.json", ...floor }] },
    dungeonAccount: { id: 7, account_chests: [] },
    dungeonTreasures: [],
    sent: [],
    send(frame) {
      this.sent.push(frame);
    },
  };
};

test("a floor's chestMost holds a better chest down to it; item boxes are not a rarity", async (t) => {
  const run = runUnder(t, {}, { chestMost: 2 });
  assert.equal(await awardTreasureChest(run, 30103), 60002, "a legendary held to uncommon");
  assert.equal(await awardTreasureChest(run, 30100), 60001, "a common stays common");
  assert.equal(await awardTreasureChest(run, 30104), 60005, "an item box stays an item box");
  assert.deepEqual(run.dungeonTreasures.map((t) => t.chestId), [60002, 60001, 60005], "owed on the report, as the game keeps them");
});

test("chestsKept pickup: the chest is on the account as it is picked up, owing nothing on the report", async (t) => {
  const run = runUnder(t, { chestsKept: "pickup" });
  assert.equal(await awardTreasureChest(run, 30101), 60002);
  assert.deepEqual(run.dungeonAccount.account_chests.map((c) => c.chest_id), [60002]);
  assert.deepEqual(run.dungeonTreasures, [], "nothing left for the report to offer again");
});

test("a floor plan's treasure stands in for the node's, a boss's chest included; only the treasure doobers", (t) => {
  assert.equal(plannedTreasure(runUnder(t, {}, { treasure: 30104 })), 30104);
  assert.equal(plannedTreasure(runUnder(t, {}, { treasure: 30099 })), null, "not a treasure: the node's as ever");
  assert.equal(plannedTreasure(runUnder(t, {}, {})), null);
  const run = { ...runUnder(t, {}, { treasure: 30105 }), dungeonZone: 1, allocateDoid: () => 900, send: () => {} };
  const doid = spawnBossReward(run, { floorDoid: 8, origin: { x: 0, y: 0 }, node: { Id: 50002, BossRewardTreasureId: 30103, TotalEnemyCoin: 10 }, random: () => 0 });
  assert.equal(run.doobers.get(doid).treasure, 30105, "a royal item box where the legendary chest was");
});

test("runControls.weapon: a weapon gift of the rarity at the mode's level, shown by the shop's offer for it", async (t) => {
  const run = runUnder(t, {});
  run.dungeonAccount = { id: 7, buckets_weapon: 1, account_items: [], gifts: [] };
  run.dungeonAvatar = { id: 70, avatar_id: 101 };
  run.member = run;
  run.random = () => 0.5;
  const saved = [];
  run.persistDungeonAccount = async (account) => saved.push(account.id);
  assert.equal(await runControls.weapon(run, { rarity: "RARE", level: 40 }), null, "a gift says who it is from");
  const gift = await runControls.weapon(run, { rarity: "RARE", level: 40, from: 0 });
  assert.equal(gift.weapon.rarity, 3);
  assert.equal(gift.weapon.requiredlevel, 40);
  assert.equal(gift.weapon.id, undefined, "no instance until it is accepted");
  const gm = await loadGameMaster();
  const face = gm.raw.OfferDetails.find((d) => d.OfferId === gift.offer_id);
  assert.equal(face.WeaponId, gift.weapon.item_id, "the face is the shop's offer for the same weapon");
  assert.deepEqual(run.dungeonAccount.account_items, [], "waiting in town, not in storage");
  await run.rewardSavePromise;
  assert.deepEqual(saved, [7], "written at once, not at a far-off report");
  assert.equal(giftsFor(run.dungeonAccount).gifts[0].weapon, undefined, "the client is not told the weapon");
  assert.ok((await runControls.weapon(run, { rarity: "LEGENDARY", level: 500, from: 0 })).weapon.requiredlevel <= 100, "no higher than a hero reaches");
  assert.equal(await runControls.weapon(run, { rarity: "CONSUMABLE_SMALL", level: 5, from: 0 }), null, "not a weapon rarity");

  // Accepted: that weapon, a new instance; a second with storage full stays on the pile.
  const account = run.dungeonAccount;
  let next = 500;
  const [first, second] = account.gifts;
  account.gifts = account.gifts.filter((row) => row !== first);
  await grantGift({ account, gift: first, nextId: async () => next++ });
  assert.deepEqual(account.account_items.map((item) => [item.id, item.item_id, item.requiredlevel]), [[500, first.weapon.item_id, 40]]);
  account.gifts = account.gifts.filter((row) => row !== second);
  await assert.rejects(grantGift({ account, gift: second, nextId: async () => next++ }), /storage is full/);
  returnGift(account, second);
  returnGift(account, second);
  assert.deepEqual(account.gifts, [second], "back on the pile, once");
});

test("the floor's toughest heal a share of what they deal to a hero; the rest do not", (t) => {
  const run = { npcLifeSteal: 0.25, objects: new Map([[50, CLID.DistributedNPCGameObject], [51, CLID.DistributedNPCGameObject]]), actors: new Map(), sent: [], send(f) { this.sent.push(f); } };
  run.actors.set(50, { hitPoints: 500, maxHitPoints: 1000, isEnemy: true });
  run.actors.set(51, { hitPoints: 50, maxHitPoints: 100, isEnemy: true });
  noteFloorEnemy(run, 1000);
  noteFloorEnemy(run, 100);
  assert.equal(stealLife(run, 50, 40), 10, "the boss heals a quarter of the 40 it dealt");
  assert.equal(run.actors.get(50).hitPoints, 510);
  assert.equal(stealLife(run, 51, 40), 0, "an add is not the floor's toughest");
  run.actors.get(50).hitPoints = 999;
  assert.equal(stealLife(run, 50, 400), 1, "never past its most");
  run.npcLifeSteal = 0;
  assert.equal(stealLife(run, 50, 40), 0, "a floor that does not steal heals nobody");
});

test("defeatCountdownSeconds: the client counts down from the mode's number", (t) => {
  const run = runUnder(t, { defeatCountdownSeconds: 12 });
  Object.assign(run, { areaDoid: 9, heroDoid: 20, actors: new Map([[20, { dead: true, hitPoints: 0 }]]), playerActors: new Set([20]) });
  beginFloorFailing(run);
  t.after(() => clearFloorFailing(run));
  const frame = run.sent.at(-1);
  assert.ok(frame, "the countdown was sent");
  assert.equal(frame.readUInt16LE(frame.length - 2), 12);
});

test("a boss's hit through the server's own AI — where most monster hits land — steals too", async () => {
  const { attackForConstant } = await import("../src/gamemaster.js");
  const { performNpcAttack } = await import("../src/socket/combat.js");
  const { TEAM } = await import("../src/socket/opcodes.js");
  const skill = await attackForConstant("EN_SWORD_SLASH");
  const boss = { constant: "KNIGHT", level: 40, partySize: 1, team: TEAM.ENEMIES, isEnemy: true, hitPoints: 500, maxHitPoints: 1000, position: { x: 0, y: 0 } };
  const hero = { constant: "BERSERKER", level: 1, partySize: 1, team: TEAM.PLAYERS, hitPoints: 5000, maxHitPoints: 5000, position: { x: 40, y: 0 } };
  const session = {
    id: 902,
    heroDoid: 30,
    npcLifeSteal: 0.5,
    floorToughestHitPoints: 1000,
    objects: new Map([[20, CLID.DistributedNPCGameObject], [30, CLID.HeroGameObject]]),
    actors: new Map([[20, boss], [30, hero]]),
    playerActors: new Set([30]),
    send: () => {},
  };
  assert.ok(skill, "a test attack in the game data");
  await performNpcAttack(session, 20, {
    attackType: skill.Id,
    attackSpeed: skill.AttackSpd,
    weaponPower: 1,
    attackColliders: [{ type: "circleCollider", radius: 1000, xOffset: 0, frame: 0 }],
    impactFrame: 0,
  }, 30);
  const dealt = 5000 - hero.hitPoints;
  assert.ok(dealt > 0, "the hit landed");
  assert.equal(boss.hitPoints, 500 + Math.max(1, Math.round(dealt * 0.5)), "and the boss drank half of it");
});

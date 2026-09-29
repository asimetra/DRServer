import test from "node:test";
import assert from "node:assert/strict";

import { generateWeapon } from "../src/chests.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { weaponPowerAt } from "../src/weapon-power.js";

/**
 * A weapon's power is the game's own curve:
 * `Power × BasePowerScale × (1 + level^ScalingFactor / 10) + BasePowerConstant`.
 *
 * Chests used to roll `Power × level × BasePowerScale + BasePowerConstant`,
 * which meets it only at level 100 for a 1.5 weapon: a level-10 roll came out
 * 2.4 times the official's, a scroll nine times.
 */

const weaponNamed = (gm, constant) => gm.raw.WeaponItem.find((row) => row.Constant === constant);
const rarityOf = (gm, id) => gm.raw.Rarity.find((row) => row.Id === id);
const powerOf = (gm, constant, level, rarity) =>
  weaponPowerAt(weaponNamed(gm, constant), rarityOf(gm, rarity), level);

test("the curve gives the official accounts' own weapons", async () => {
  const gm = await loadGameMaster();
  // Straight off official account rows: a scroll (ScalingFactor 1), a starter
  // band sword and a top-level bow (1.5).
  assert.equal(powerOf(gm, "HERO_SCROLL_HEAL", 98, 4), 271);
  assert.equal(powerOf(gm, "HERO_REGULAR_SWORD", 4, 1), 12);
  assert.equal(powerOf(gm, "HERO_REGULAR_BOW", 100, 4), 1631);
  // And within the official's own spread of a percent or two.
  const bow = powerOf(gm, "HERO_SHORT_BOW", 99, 4);
  assert.ok(Math.abs(1157 / bow - 1) < 0.02, `official 1157 against ${bow}`);
  const sword = powerOf(gm, "HERO_SHORT_SWORD", 99, 3);
  assert.ok(Math.abs(739 / sword - 1) < 0.02, `the captured chest award, 739 against ${sword}`);
});

/** Every shop weapon at its own level, rarity and power, as a bag row. */
const shopRows = (gm) =>
  gm.raw.OfferDetails.flatMap((detail) => {
    const weapon = gm.weaponById.get(Number(detail.WeaponId));
    const rarity = gm.raw.Rarity.find((row) => row.Type === detail.Rarity);
    if (!weapon || !(Number(weapon.Power) > 0) || !rarity) return [];
    return [{
      item_id: weapon.Id,
      power: Number(detail.WeaponPower),
      requiredlevel: Number(detail.Level),
      rarity: rarity.Id,
    }];
  });

test("the shop sells along the curve", async () => {
  const gm = await loadGameMaster();
  const rows = shopRows(gm);
  const close = rows.filter((row) => {
    const expected = weaponPowerAt(gm.weaponById.get(row.item_id), rarityOf(gm, row.rarity), row.requiredlevel);
    return Math.abs(row.power / expected - 1) <= 0.02;
  });
  assert.ok(rows.length > 2500, `${rows.length} weapon offers`);
  assert.ok(close.length / rows.length > 0.75, `${close.length} of ${rows.length} within 2%`);
});

test("a chest's weapon is priced at the level it carries", async () => {
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(101);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  for (const rarityId of [1, 2, 3, 4]) {
    for (const level of [1, 5, 20, 50, 99]) {
      const item = generateWeapon({ gm, hero, rarity: rarityOf(gm, rarityId), level, accountId: 1, id: 1, random });
      const weapon = gm.weaponById.get(item.item_id);
      assert.equal(item.power, weaponPowerAt(weapon, rarityOf(gm, rarityId), item.requiredlevel));
    }
  }
});

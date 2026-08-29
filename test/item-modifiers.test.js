import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { repairItemModifiers } from "../src/accounts.js";

/**
 * A modifier is stored as the number the client looks it up by.
 *
 * `OfferDetails` names them instead: 3840 modifier columns across the 3080
 * weapon-granting offers, every one a constant like `CRIT_DAMAGE_4`, and every
 * one resolvable against `Modifiers` or `LegendaryModifiers`. Writing the name
 * through to the account row is silent everywhere it is then read —
 * `ItemInfo.parseJson` guards with `toNumberField(row, "modifier1") > 0`, and
 * NaN is not greater than zero, so the modifier is dropped without a word. The
 * same value reaches the wire encoder as a `u32`, which is why a bought weapon
 * showed its modifiers in neither storage, the dungeon, nor the summary.
 */

test("a shop weapon stores its modifiers as ids, not as names", async () => {
  const { grantWeaponForTest } = await import("../src/store.js");
  const gm = await loadGameMaster();
  let next = 900;
  const item = await grantWeaponForTest(
    { id: 1 },
    {
      WeaponId: 16003,
      WeaponPower: 1177,
      Level: 63,
      Rarity: 3,
      Modifier1: "CRIT_DAMAGE_4",
      Modifier2: "CRIT_CHANCE_2",
    },
    async () => next++,
    gm
  );

  assert.equal(item.modifier1, 70124, "CRIT_DAMAGE_4 is the number the client knows");
  assert.equal(
    item.modifier2,
    gm.raw.Modifiers.find((row) => row.Constant === "CRIT_CHANCE_2").Id
  );
  assert.equal(item.legendarymodifier, 0, "and an unnamed one stays zero");
});

test("a legendary column resolves against its own table", async () => {
  const { grantWeaponForTest } = await import("../src/store.js");
  const gm = await loadGameMaster();
  const legendary = gm.raw.LegendaryModifiers[0];
  const item = await grantWeaponForTest(
    { id: 1 },
    { WeaponId: 16003, Rarity: 4, Modifier3: legendary.Constant },
    async () => 901,
    gm
  );

  assert.equal(item.legendarymodifier, legendary.Id);
});

/**
 * The rows already written this way are repaired on load rather than left for
 * the player to notice, because nothing about them says they are broken: the
 * item is in the bag, at the right rarity, with a modifier the UI cannot see.
 */
test("weapons already stored under a name are repaired on load", async () => {
  const account = {
    id: 5,
    account_items: [
      { id: 1, item_id: 11501, rarity: 2, modifier1: "DAMAGE_1", modifier2: 0 },
      { id: 2, item_id: 11002, rarity: 3, modifier1: "CRIT_CHANCE_2", modifier2: 70001 },
      { id: 3, item_id: 11003, rarity: 1, modifier1: 0, modifier2: 0 },
    ],
  };

  const repaired = await repairItemModifiers(account);

  assert.equal(repaired, 2, "two names became numbers");
  assert.equal(account.account_items[0].modifier1, 70001);
  assert.equal(account.account_items[1].modifier1, 70112);
  assert.equal(account.account_items[1].modifier2, 70001, "an id already right is left alone");
  assert.equal(account.account_items[2].modifier1, 0, "and so is an empty one");

  assert.equal(await repairItemModifiers(account), 0, "a second load finds nothing to do");
});

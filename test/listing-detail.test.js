import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { describeListings, filterMarketListings } from "../src/internal.js";

/**
 * A listing leaves here saying what it is, not which numbers it is.
 *
 * The row stores `modifier1: 70211`, which is all an account row ever holds,
 * and a market page has to show "Chargey — Charge attacks charge 10% faster!".
 * Resolving it here is the same decision already taken for the weapon's name:
 * a Map lookup on a table this process has open, rather than four megabytes of
 * GameMaster sent to every browser that opens the market.
 *
 * The website could not do it in any case. It has no game data and is not
 * meant to — that is the whole arrangement the repository is built on.
 */

test("a listing carries its weapon's name and type", async () => {
  const gm = await loadGameMaster();
  const weapon = gm.raw.WeaponItem.find((row) => row.Mastertype);

  const [listing] = describeListings([{ item_id: weapon.Id, price: 10, rarity: 1 }], gm);

  assert.equal(listing.name, weapon.Name);
  assert.equal(listing.mastertype, weapon.Mastertype);
  assert.equal(listing.price, 10, "and keeps what it already had");
  assert.ok(listing.rarity_name, "the numeric rarity is named for filters and accessibility");
  assert.ok(listing.vendor_value >= 0, "the shop baseline is available beside the asking price");
  assert.ok(listing.usable_by.length > 0, "a buyer can tell which heroes may equip it");
});

/**
 * What the weapon itself is, before anything was rolled onto it.
 *
 * A listing showed a name and a power and stopped, which is the least
 * interesting half: the row carries how fast it swings, what its tap combo is
 * called and does, and what its charged attack costs in mana. Somebody
 * deciding whether to spend gold is reading those, and none of them can be
 * worked out from an id on the other side.
 */
test("a listing carries the weapon's own stat block", async () => {
  const gm = await loadGameMaster();
  const axe = gm.raw.WeaponItem.find((row) => row.Constant === "HERO_HAND_AXE");

  const [listing] = describeListings([{ item_id: axe.Id }], gm);

  assert.equal(listing.weapon.classType, axe.ClassType);
  assert.equal(listing.weapon.speed, axe.SpeedDisplay);
  assert.equal(listing.weapon.tap.title, axe.TapTitle);
  assert.equal(listing.weapon.tap.description, axe.TapDescription);
  assert.equal(listing.weapon.hold.title, axe.HoldTitle);
  assert.equal(listing.weapon.hold.manaCost, axe.HoldManaCost);
});

test("a weapon nothing is known about carries no block rather than an empty one", async () => {
  const gm = await loadGameMaster();
  const [listing] = describeListings([{ item_id: 999999 }], gm);

  assert.equal(listing.name, null);
  assert.equal(listing.weapon, null);
});

test("and its modifiers by name, with what they do", async () => {
  const gm = await loadGameMaster();
  const first = gm.raw.Modifiers[0];
  const second = gm.raw.Modifiers[1];

  const [listing] = describeListings(
    [{ item_id: 15001, modifier1: first.Id, modifier2: second.Id }],
    gm
  );

  assert.deepEqual(
    listing.modifiers.map(({ name, description }) => ({ name, description })),
    [
      { name: first.Name, description: first.Description },
      { name: second.Name, description: second.Description },
    ]
  );
});

/**
 * And its picture's name, for the same reason as the weapon's: the other side
 * has the files but no table to look one up in, so an id would leave it holding
 * a picture it cannot match to a line. Twenty-two icons cover a hundred and
 * twenty modifiers — the row names which, and this passes the name along.
 */
test("a modifier says which picture it wears", async () => {
  const gm = await loadGameMaster();
  const named = gm.raw.Modifiers.find((row) => row.IconName);

  const [listing] = describeListings([{ item_id: 15001, modifier1: named.Id }], gm);

  assert.equal(listing.modifiers[0].icon, named.IconName);
});

/**
 * The top rarity carries a third from a table of its own, and it is worth
 * telling apart: the game shows it differently and a page that lumps it in
 * would lose the one line a legendary is bought for.
 */
test("a legendary modifier is named as one", async () => {
  const gm = await loadGameMaster();
  const legendary = gm.raw.LegendaryModifiers[0];

  const [listing] = describeListings([{ item_id: 15001, legendarymodifier: legendary.Id }], gm);

  assert.equal(listing.legendary?.name, legendary.Name);
  assert.equal(listing.legendary?.description, legendary.Description);
  assert.equal(listing.legendary?.icon, legendary.IconName, "and wears its own picture");
  assert.deepEqual(listing.modifiers, [], "and is not counted among the ordinary ones");
});

test("an item with no modifiers says so with an empty list, not with nulls", async () => {
  const gm = await loadGameMaster();

  const [listing] = describeListings(
    [{ item_id: 15001, modifier1: 0, modifier2: 0, legendarymodifier: 0 }],
    gm
  );

  assert.deepEqual(listing.modifiers, []);
  assert.equal(listing.legendary, null);
});

/**
 * A modifier this server cannot name is dropped rather than rendered as a
 * blank row. An id that resolves to nothing is a data mismatch between the
 * player's copy and this one, and an empty line on a market page explains
 * none of it.
 */
test("a modifier that resolves to nothing is left out", async () => {
  const gm = await loadGameMaster();

  const [listing] = describeListings([{ item_id: 15001, modifier1: 999999 }], gm);

  assert.deepEqual(listing.modifiers, []);
});

test("market search covers names, sellers, attacks, modifiers and compatible heroes", () => {
  const rows = [
    {
      id: 1,
      name: "Quake Axe",
      seller_name: "Sable",
      mastertype: "AXE_TYPE",
      rarity: 3,
      rarity_name: "rare",
      price: 800,
      power: 40,
      requiredlevel: 8,
      listed_at: "2026-09-01T02:00:00Z",
      weapon: { classType: "MELEE", hold: { title: "Fissure", description: "Crack the ground" } },
      modifiers: [{ name: "Chargey", description: "Charge faster" }],
      legendary: null,
      usable_by: [{ id: 101, name: "Berserker" }],
    },
    {
      id: 2,
      name: "Hunter Crossbow",
      seller_name: "Mira",
      mastertype: "CROSSBOW_TYPE",
      rarity: 2,
      rarity_name: "uncommon",
      price: 300,
      power: 25,
      requiredlevel: 3,
      listed_at: "2026-09-01T03:00:00Z",
      weapon: { classType: "SHOOTING", tap: { title: "Bolt", description: "Quick shot" } },
      modifiers: [],
      legendary: null,
      usable_by: [{ id: 105, name: "Vampire Hunter" }],
    },
  ];

  for (const q of ["quake", "sable", "fissure", "chargey", "berserker"]) {
    assert.deepEqual(filterMarketListings(rows, { q }).map((row) => row.id), [1], q);
  }
  assert.deepEqual(filterMarketListings(rows, { type: "CROSSBOW_TYPE" }).map((row) => row.id), [2]);
  assert.deepEqual(filterMarketListings(rows, { rarity: 3 }).map((row) => row.id), [1]);
  assert.deepEqual(filterMarketListings(rows, { hero: 105 }).map((row) => row.id), [2]);
  assert.deepEqual(filterMarketListings(rows, { maxPrice: 500 }).map((row) => row.id), [2]);
  assert.deepEqual(filterMarketListings(rows, { sort: "price_asc" }).map((row) => row.id), [2, 1]);
  assert.deepEqual(
    filterMarketListings([{ ...rows[0], seller_name: "IŞIK" }], { q: "ışık" }).map((row) => row.id),
    [1],
    "seller-name search uses the same Turkish-I folding as account names"
  );
});

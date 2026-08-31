import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { describeListings } from "../src/internal.js";

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

  const [listing] = describeListings([{ item_id: weapon.Id, price: 10 }], gm);

  assert.equal(listing.name, weapon.Name);
  assert.equal(listing.mastertype, weapon.Mastertype);
  assert.equal(listing.price, 10, "and keeps what it already had");
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

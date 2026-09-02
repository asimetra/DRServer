import test from "node:test";
import assert from "node:assert/strict";
import { loadGameMaster } from "../src/gamemaster.js";
import { modifierIdFor } from "../src/store.js";
import {
  dayInProgress,
  openingTimes,
  rotationDay,
  rotationDays,
  searchSchedule,
  stockOn,
} from "../src/store-rotation.js";

/**
 * The store rotates and the schedule is already written down.
 *
 * Nothing in this module decides what is on sale. `Offers` carries a StartDate
 * and an EndDate on every weapon row and the client reads the same two columns
 * to fill the same shelf — so the thing worth testing is not that the answers
 * are sensible but that they are the table's, and that the one piece of arithmetic
 * here, the boundary between one day's stock and the next, lands where the
 * table says it does.
 */

test("the day turns over at nine, not at midnight", () => {
  assert.equal(rotationDay("2026-09-02T08:59:59Z"), "2026-09-01", "before nine is still yesterday's shop");
  assert.equal(rotationDay("2026-09-02T09:00:00Z"), "2026-09-02");
  assert.equal(rotationDay("2026-09-02T23:59:59Z"), "2026-09-02");
});

test("a day's window is the one the offers themselves carry", async () => {
  const gm = await loadGameMaster();
  const day = rotationDays(gm)[1];
  const [offer] = stockOn(gm, day);
  const window = openingTimes(day);

  assert.equal(Date.parse(window.opens_at), Date.parse(offer.opens_at));
  assert.equal(
    Date.parse(window.closes_at) - Date.parse(window.opens_at),
    86_400_000,
    "a day's stock is up for exactly a day"
  );
});

test("every day the tables reach carries a full shelf, best first", async () => {
  const gm = await loadGameMaster();
  const days = rotationDays(gm);
  assert.ok(days.length > 30, "the schedule runs months out, not days");

  for (const day of days) {
    const stock = stockOn(gm, day);
    assert.equal(stock.length, 22, `${day} should have a full shelf`);
    for (let at = 1; at < stock.length; at += 1) {
      assert.ok(
        stock[at - 1].rarity >= stock[at].rarity,
        `${day} should be ordered best first`
      );
    }
  }
});

/**
 * The half of an offer that matters is the weapon it hands over, and it is
 * built here in the shape an account row holds one — the same fields
 * `grantWeapon` fills when the purchase actually happens. A disagreement
 * between the two would be the site advertising a weapon the shop does not sell.
 */
test("an offer carries the weapon a purchase would grant", async () => {
  const gm = await loadGameMaster();
  const day = dayInProgress(gm) ?? rotationDays(gm)[0];
  const rolled = stockOn(gm, day).find((row) => row.modifier1);
  const offer = gm.raw.Offers.find((row) => row.Id === rolled.offer_id);
  const detail = gm.raw.OfferDetails.find((row) => row.OfferId === rolled.offer_id);

  assert.equal(rolled.item_id, detail.WeaponId);
  assert.equal(rolled.power, detail.WeaponPower);
  assert.equal(rolled.requiredlevel, detail.Level);
  assert.equal(rolled.price, offer.Price);
  assert.equal(
    rolled.modifier1,
    modifierIdFor(gm, detail.Modifier1),
    "the constant on the offer is resolved to the number an account row holds"
  );
});

/**
 * The offer says "LEGENDARY"; an account row says 4, and so does every card
 * already drawn from one. Resolving it here is what lets the shop and the
 * market be the same picture.
 */
test("the rarity an offer names in words arrives as the number", async () => {
  const gm = await loadGameMaster();
  const legendary = gm.raw.Rarity.find((row) => row.Type === "LEGENDARY");
  const day = rotationDays(gm)[0];
  const best = stockOn(gm, day)[0];

  assert.equal(best.rarity, legendary.Id);
  assert.equal(
    gm.raw.OfferDetails.find((row) => row.OfferId === best.offer_id).Rarity,
    "LEGENDARY"
  );
});

test("the schedule only ever looks forwards", async () => {
  const gm = await loadGameMaster();
  const days = rotationDays(gm);
  const from = days[Math.floor(days.length / 2)];

  const found = searchSchedule(gm, { from, limit: 100 });
  assert.ok(found.total > 0);
  for (const row of found.rows) assert.ok(row.day >= from, `${row.day} is behind ${from}`);
});

/**
 * The question a rotating shop cannot answer by showing today: three hundred
 * weapons share the shelf, so anything somebody wants is coming back and what
 * they need is the date.
 */
test("a weapon can be found by name, on every day it is coming", async () => {
  const gm = await loadGameMaster();
  const days = rotationDays(gm);
  const [first] = stockOn(gm, days[0]);
  const named = gm.weaponById.get(first.item_id);

  const found = searchSchedule(gm, { q: named.Name, from: days[0], limit: 100 });

  assert.ok(found.rows.some((row) => row.offer_id === first.offer_id), "including today's");
  assert.ok(found.total > 1, `${named.Name} is on the shelf more than once in four months`);
  for (const row of found.rows) assert.equal(row.item_id, first.item_id);
});

test("and by what its modifiers do, which is the other way anybody hunts one", async () => {
  const gm = await loadGameMaster();
  const days = rotationDays(gm);
  const rolled = stockOn(gm, days[0]).find((row) => row.modifier1);
  const modifier = gm.modifiersById.get(rolled.modifier1);

  const found = searchSchedule(gm, { q: modifier.Name, from: days[0], limit: 100 });

  assert.ok(found.total >= 1, `nothing found for ${modifier.Name}`);
  assert.ok(found.rows.some((row) => row.offer_id === rolled.offer_id));
});

/**
 * Counted before the filter they belong to. Counted after it, every count but
 * the chosen one is zero and the control goes dead in the hand at exactly the
 * moment somebody is using it.
 */
test("the rarity counts say what choosing one would find", async () => {
  const gm = await loadGameMaster();
  const days = rotationDays(gm);

  const all = searchSchedule(gm, { from: days[0] });
  const legendary = searchSchedule(gm, { from: days[0], rarity: 4 });

  assert.equal(all.rarities.length, 4, "all four are on the shelf somewhere");
  assert.deepEqual(legendary.rarities, all.rarities, "and still are once one is chosen");
  assert.equal(legendary.total, all.rarities.find((entry) => entry.value === 4).count);
});

test("a day the tables do not reach is empty rather than wrong", async () => {
  const gm = await loadGameMaster();

  assert.deepEqual(stockOn(gm, "1999-01-01"), []);
  assert.equal(dayInProgress(gm, "1999-01-01T12:00:00Z"), null);
});

import { modifierIdFor } from "./store.js";

/**
 * The store's daily rotation, read rather than decided.
 *
 * Twenty-two weapons are on sale at once and they change every day. None of
 * that is chosen here or anywhere else in this process: every one of the 2684
 * weapon rows in `Offers` carries a `StartDate` and an `EndDate`, and the
 * schedule they describe already runs four months out.
 *
 * That matters more than it looks. The client ships the same GameMaster and
 * reads the same two columns to decide what to put on the shelf, so a day this
 * file worked out for itself would be a shop the website advertised and the
 * game did not sell. Everything below is a lookup.
 *
 * It stops at reading. What an offer *is* — the weapon's name, its picture,
 * what the modifiers do — is the same question a market listing asks, and is
 * answered in one place for both; see `describeListings`.
 */

/**
 * The hour the stock turns over, in UTC.
 *
 * Written down because it cannot be derived: at 08:00 the shop is still
 * yesterday's, and nothing in the tables says so except that every window
 * begins at 09:00 — all 2684 of them, checked rather than assumed.
 */
const OPENS_AT = 9;

const DAY_MS = 86_400_000;

/** Midnight UTC on the named day, plus the hour the shop opens. */
const opening = (day) => Date.parse(`${day}T00:00:00Z`) + OPENS_AT * 3_600_000;

/**
 * The rotation day a moment falls in, named by the date its stock went up —
 * which is how the table names it too.
 */
export const rotationDay = (when = new Date()) =>
  new Date(new Date(when).getTime() - OPENS_AT * 3_600_000).toISOString().slice(0, 10);

/** When a named day's stock goes up and comes down. */
export const openingTimes = (day) => ({
  opens_at: new Date(opening(day)).toISOString(),
  closes_at: new Date(opening(day) + DAY_MS).toISOString(),
});

/**
 * The offer's rarity as a number, because everything downstream counts it.
 *
 * An offer says `"LEGENDARY"`; an account row — and so the market card that
 * already knows how to draw one — holds the Rarity table's id. This is the
 * join, and it is the table's own rather than a list written out here.
 */
const rarityIdFor = (gm, word) => {
  const asNumber = Number(word);
  if (Number.isFinite(asNumber) && asNumber) return asNumber;
  return Number(gm.raw.Rarity?.find((row) => row.Type === word)?.Id ?? 1);
};

/**
 * One thing on the shelf: what it costs, when it is there, and the weapon it
 * hands over.
 *
 * The weapon half is built in the shape an account row holds one, because that
 * is the shape everything downstream already knows how to describe. `store.js`
 * assembles the same fields from the same detail when a purchase actually
 * happens — deliberately the same reading, so the site cannot advertise a
 * weapon the shop would not grant.
 */
const shelved = (gm, offer, detail) => ({
  offer_id: offer.Id,
  price: Number(offer.Price) || 0,
  currency: offer.CurrencyType ?? "BASIC",
  day: String(offer.StartDate).slice(0, 10),
  ...openingTimes(String(offer.StartDate).slice(0, 10)),

  item_id: detail.WeaponId,
  power: Number(detail.WeaponPower) || 0,
  requiredlevel: Number(detail.Level) || 1,
  rarity: rarityIdFor(gm, detail.Rarity ?? offer.Rarity),
  modifier1: modifierIdFor(gm, detail.Modifier1),
  modifier2: modifierIdFor(gm, detail.Modifier2),
  legendarymodifier: modifierIdFor(gm, detail.Modifier3, "LegendaryModifiers"),
});

/**
 * The words a row can be found by, worked out once.
 *
 * Kept here rather than on the row because it is an index and not an answer:
 * nobody browsing wants it, and a schedule four months long would carry it to
 * the browser 2684 times over. Built from the tables directly for the same
 * reason — searching by what a modifier does should not cost describing every
 * offer in the schedule when a page only ever shows forty of them.
 */
const findableBy = (gm, row, offer) => {
  const weapon = gm.weaponById.get(Number(row.item_id));
  const modifiers = [
    gm.modifiersById.get(row.modifier1),
    gm.modifiersById.get(row.modifier2),
    gm.raw.LegendaryModifiers?.find((legendary) => legendary.Id === row.legendarymodifier),
  ];
  return [
    offer.Name,
    weapon?.Name,
    weapon?.Mastertype,
    weapon?.ClassType,
    gm.raw.Rarity?.find((rarity) => rarity.Id === row.rarity)?.Type,
    ...modifiers.filter(Boolean).flatMap((modifier) => [modifier.Name, modifier.Description]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
};

/**
 * The whole schedule, indexed once per GameMaster.
 *
 * Held against the loaded tables rather than in a module variable, so that a
 * reload of GameMaster is a new schedule rather than a stale one nothing
 * invalidates.
 */
const schedules = new WeakMap();

const scheduleOf = (gm) => {
  const held = schedules.get(gm);
  if (held) return held;

  const details = new Map((gm.raw.OfferDetails ?? []).map((row) => [row.OfferId, row]));
  const byDay = new Map();
  const rows = [];
  const findable = new Map();

  for (const offer of gm.raw.Offers ?? []) {
    /* The rotating half of the store and nothing else. Heroes, skins, keys and
       gems are on sale every day at the same price, so they have no schedule to
       show and no StartDate to read. */
    if (offer.Tab !== "WEAPON" || !offer.StartDate) continue;
    const detail = details.get(offer.Id);
    if (!detail?.WeaponId) continue;

    const row = shelved(gm, offer, detail);
    rows.push(row);
    findable.set(row.offer_id, findableBy(gm, row, offer));
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push(row);
  }

  /* Best first, which is the order the shelf is read in — the one legendary is
     what the day is checked for, and nine commons are what is scrolled past. */
  for (const stock of byDay.values()) {
    stock.sort((left, right) => right.rarity - left.rarity || right.power - left.power);
  }
  rows.sort((left, right) => left.day.localeCompare(right.day) || right.rarity - left.rarity);

  const built = { byDay, rows, findable, days: [...byDay.keys()].sort() };
  schedules.set(gm, built);
  return built;
};

/** Every day the tables have stock for, in order. */
export const rotationDays = (gm) => scheduleOf(gm).days;

/** What is on the shelf on a named day. Empty for a day the tables do not reach. */
export const stockOn = (gm, day) => scheduleOf(gm).byDay.get(day) ?? [];

/**
 * The day the shop is on now, or nothing once the schedule runs out.
 *
 * Nothing rather than an empty day, because the two want different words: a
 * shop with nothing in it is broken, and a schedule that has ended is a table
 * waiting to be updated.
 */
export const dayInProgress = (gm, when = new Date()) => {
  const day = rotationDay(when);
  return scheduleOf(gm).byDay.has(day) ? day : null;
};

/**
 * What is coming, filtered.
 *
 * Only ever forwards. The question this answers is "when can I next buy this",
 * and a day that has been and gone answers it with a date in the past — which
 * is worse than no answer, because it reads like one.
 */
export const searchSchedule = (gm, options = {}) => {
  const schedule = scheduleOf(gm);
  const wanted = String(options.q ?? "").trim().slice(0, 64).toLowerCase();
  const rarity = Number(options.rarity) || 0;
  const from = String(options.from ?? "") || rotationDay();
  const limit = Math.min(Math.max(Number(options.limit) || 40, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);

  /* Everything the search asked for except the rarity, so the rarity counts
     below can say what choosing one *would* find. Counted after the filter they
     belong to, every count but the chosen one is zero, and the control goes
     dead in the hand exactly when it is being used. */
  const matched = schedule.rows.filter(
    (row) =>
      row.day >= from &&
      (!wanted || schedule.findable.get(row.offer_id).includes(wanted))
  );

  const rarities = new Map();
  for (const row of matched) rarities.set(row.rarity, (rarities.get(row.rarity) ?? 0) + 1);

  const found = rarity ? matched.filter((row) => row.rarity === rarity) : matched;

  return {
    rows: found.slice(offset, offset + limit),
    total: found.length,
    rarities: [...rarities]
      .sort(([left], [right]) => right - left)
      .map(([value, count]) => ({ value, count })),
  };
};

/**
 * What an admin may give an account (docs/operations.md, "Administrative
 * calls"): gold, gems, keys, weapon chests, rolled weapons, powerups and a
 * hero's level — the gifts tools/grant.js gives, here once for both.
 *
 * Trophies are not here, on purpose. A trophy is a boss map beaten, and the
 * Trophies board and the titles are read off them; granting one would make
 * both say something that did not happen.
 */
import { nextObjectId } from "./accounts.js";
import { generateWeapon } from "./chests.js";
import { experienceForLevel, maxLevel, statPointsEarned } from "./progression.js";

export class GrantRefused extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "GrantRefused";
    this.reason = reason;
  }
}

const refuse = (reason, message) => new GrantRefused(reason, message);

/** The most one grant gives of each, so a slip of the keyboard cannot hand out a billion. */
export const GRANT_LIMITS = Object.freeze({
  gold: 100_000_000,
  gems: 1_000_000,
  keys: 1000,
  chests: 100,
  weapons: 50,
  powerups: 999,
});

/** The rarities of the weapon chests and of the keys that open them, lowest first. */
export const RARITIES = Object.freeze(["COMMON", "UNCOMMON", "RARE", "LEGENDARY"]);

/** Where an account keeps the keys of each rarity: a COMMON chest opens with a basic key. */
const KEY_COLUMN = Object.freeze({
  COMMON: "basic_keys",
  UNCOMMON: "uncommon_keys",
  RARE: "rare_keys",
  LEGENDARY: "legendary_keys",
});

/** The four weapon chests, each opened with the key of its rarity; not the item boxes. */
export const weaponChests = (gm) => gm.raw.Chests.filter((chest) => RARITIES.includes(chest.Rarity));

const lower = (rarity) => String(rarity).toLowerCase();

/**
 * A grant as an admin asked for it, checked: whole numbers in range, chests the
 * game has, a level a hero can reach. Anything wrong throws, with what; asking
 * for nothing is refused as well.
 *
 *   { gold, gems, powerups,
 *     keys: n | { COMMON, UNCOMMON, RARE, LEGENDARY },
 *     weapons: n | { count, rarity, hero },
 *     chests: [{ id, count }], level: { level, hero } | [{ level, hero }] }
 *
 * A number of keys is that many of every rarity; a number of weapons is rolled
 * at any rarity for any of the account's heroes.
 */
export const parseGrant = (body, gm) => {
  const asked = body ?? {};
  const whole = (field, value = asked[field]) => {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > GRANT_LIMITS[field]) {
      throw refuse("bad_grant", `${field} is a whole number from 0 to ${GRANT_LIMITS[field].toLocaleString("en")}`);
    }
    return n;
  };

  const known = new Map(weaponChests(gm).map((chest) => [Number(chest.Id), chest]));
  if (asked.chests !== undefined && !Array.isArray(asked.chests)) throw refuse("bad_grant", "chests is a list");
  const chests = (asked.chests ?? [])
    .map((entry) => ({ id: Number(entry?.id), count: whole("chests", entry?.count) }))
    .filter((entry) => entry.count > 0);
  for (const { id } of chests) {
    if (!known.has(id)) throw refuse("bad_grant", `${id} is not a weapon chest`);
  }

  const heroOrNull = (value, what) => {
    if (value === undefined || value === null || value === "") return null;
    const hero = Number(value);
    if (!gm.heroById.has(hero)) throw refuse("bad_grant", `${what}: ${value} is not a hero`);
    return hero;
  };

  let keys = Object.fromEntries(RARITIES.map((rarity) => [rarity, 0]));
  if (asked.keys !== null && typeof asked.keys === "object") {
    for (const [rarity, count] of Object.entries(asked.keys)) {
      if (!RARITIES.includes(rarity)) throw refuse("bad_grant", `keys: ${rarity} is not a rarity`);
      keys[rarity] = whole("keys", count);
    }
  } else {
    const each = whole("keys");
    keys = Object.fromEntries(RARITIES.map((rarity) => [rarity, each]));
  }

  let weapons = { count: 0, rarity: null, hero: null };
  if (asked.weapons !== null && typeof asked.weapons === "object") {
    const rarity = asked.weapons.rarity === undefined || asked.weapons.rarity === "" ? null : asked.weapons.rarity;
    if (rarity !== null && !RARITIES.includes(rarity)) throw refuse("bad_grant", `weapons: ${rarity} is not a rarity`);
    weapons = { count: whole("weapons", asked.weapons.count), rarity, hero: heroOrNull(asked.weapons.hero, "weapons") };
  } else {
    weapons = { count: whole("weapons"), rarity: null, hero: null };
  }

  /* A level for every hero, for one, or — a list — a level of its own for each
     of several, as a page that shows them side by side asks. */
  const levelOf = (entry) => {
    const wanted = Number(entry?.level ?? entry);
    const hero = entry?.hero == null || entry?.hero === "" ? null : Number(entry.hero);
    if (!Number.isSafeInteger(wanted) || wanted < 1) throw refuse("bad_grant", "level is a whole number from 1");
    if (hero !== null && !gm.heroById.has(hero)) throw refuse("bad_grant", `${hero} is not a hero`);
    return { level: wanted, hero };
  };
  let level = null;
  if (Array.isArray(asked.level)) {
    level = asked.level.length ? asked.level.map(levelOf) : null;
  } else if (asked.level !== undefined && asked.level !== null && asked.level !== "") {
    level = [levelOf(asked.level)];
  }

  const grant = {
    gold: whole("gold"),
    gems: whole("gems"),
    keys,
    weapons,
    powerups: whole("powerups"),
    chests,
    level,
  };
  const anyKeys = RARITIES.some((rarity) => keys[rarity] > 0);
  const empty =
    !grant.gold && !grant.gems && !anyKeys && !weapons.count && !grant.powerups && !chests.length && !level;
  if (empty) throw refuse("nothing_to_grant", "the grant gives nothing");
  return grant;
};

/** Every one of a weapon chest, and keys to open them are separate: a chest with no key stays shut. */
export const giveChests = async (account, chestId, count) => {
  account.account_chests ??= [];
  for (let made = 0; made < count; made++) {
    account.account_chests.push({
      id: await nextObjectId(account),
      account_id: account.id,
      chest_id: chestId,
      // NOT NULL in the schema, and an absent field is written as an explicit
      // null rather than falling back to the column default.
      is_new: 1,
    });
  }
};

/** Keys: `count` of every rarity, or `{ COMMON, UNCOMMON, RARE, LEGENDARY }` of each. */
export const giveKeys = (account, count) => {
  for (const rarity of RARITIES) {
    const more = typeof count === "object" ? Number(count[rarity] ?? 0) : count;
    const column = KEY_COLUMN[rarity];
    account[column] = Number(account[column] ?? 0) + more;
  }
};

/**
 * Weapons rolled the way a chest rolls them — a rarity from the same weighted
 * table, a power and a level for it, the modifiers that rarity allows — so what
 * lands in the bag has the shape of a real award. Unequipped, so the market and
 * the inventory both see it. A `rarity` and a `hero` fix what is rolled; left
 * out, each weapon is any rarity, for any of the account's heroes. Returns how
 * many were made: none for an account with no hero and none asked for, since a
 * weapon is rolled against one.
 */
export const rollWeapons = async (account, count, { gm, random = Math.random, rarity: wanted = null, hero: forHero = null }) => {
  const heroes = forHero !== null
    ? [gm.heroById.get(forHero)].filter(Boolean)
    : (account.account_avatars ?? []).map((avatar) => gm.heroById.get(avatar.avatar_id)).filter(Boolean);
  if (!heroes.length) return 0;
  account.account_items ??= [];
  /* The shipped table carries no chest weights, which left every roll
     falling back to uncommon; then the four a chest gives, alike. */
  const weighted = gm.raw.Rarity.filter((row) => (row.ChestWeight ?? 0) > 0);
  const rarities = wanted !== null
    ? gm.raw.Rarity.filter((row) => row.Type === wanted)
    : weighted.length
      ? weighted
      : gm.raw.Rarity.filter((row) => RARITIES.includes(row.Type));
  let made = 0;
  for (let attempt = 0; attempt < count; attempt++) {
    const hero = heroes[Math.floor(random() * heroes.length)];
    const rarity = rarities.length ? rarities[Math.floor(random() * rarities.length)] : gm.raw.Rarity[1];
    const item = generateWeapon({
      gm,
      hero,
      rarity,
      level: 1 + Math.floor(random() * 60),
      accountId: account.id,
      id: await nextObjectId(account),
      random,
    });
    if (item) {
      account.account_items.push(item);
      made += 1;
    }
  }
  return made;
};

/**
 * Every powerup topped up to `count` — never taken down. A slot holds anything
 * whose Stackables row says `ItemCategory: POWERUP`, the test useConsumable
 * applies: the potions, the mushrooms, the shots and the five bombs.
 */
export const topUpPowerups = async (account, count, gm) => {
  account.account_stackables ??= [];
  const powerups = gm.raw.Stackables.filter((row) => row.ItemCategory === "POWERUP");
  for (const row of powerups) {
    const existing = account.account_stackables.find((entry) => Number(entry.stack_id) === Number(row.Id));
    if (existing) {
      existing.count = Math.max(Number(existing.count ?? 0), count);
      continue;
    }
    account.account_stackables.push({
      id: await nextObjectId(account),
      account_id: account.id,
      stack_id: row.Id,
      count,
      is_new: 1,
    });
  }
  return powerups.length;
};

/**
 * A hero at a level, every hero or the one asked for. Experience is what the
 * game stores, so this sets the least that reads as that level, capped at the
 * hero's last. Placed training points are kept unless the hero no longer has
 * them — levelling down — when they are cleared, since the training handler
 * refuses a build it cannot account for and the hero would be stuck.
 */
export const setHeroLevel = (account, { level, hero = null }, gm) => {
  const changed = [];
  for (const avatar of account.account_avatars ?? []) {
    if (hero !== null && Number(avatar.avatar_id) !== hero) continue;
    const row = gm.heroById.get(avatar.avatar_id);
    if (!row) continue;
    const wanted = Math.min(level, maxLevel(gm, row));
    avatar.experience = experienceForLevel(gm, row, wanted);
    const earned = statPointsEarned(gm, row, avatar.experience);
    const spent = [1, 2, 3, 4].reduce((total, slot) => total + Number(avatar[`statupgrade${slot}`] ?? 0), 0);
    if (spent > earned) for (const slot of [1, 2, 3, 4]) avatar[`statupgrade${slot}`] = 0;
    changed.push({ hero: row.Name ?? row.Constant, level: wanted });
  }
  return changed;
};

/**
 * What an account holds of what can be given — the purse, the keys and the
 * unopened weapon chests by rarity, and the powerups — for a page that shows
 * each beside the control that adds to it.
 */
export const holdingsOf = (account, gm) => {
  const chestRarity = new Map(weaponChests(gm).map((chest) => [Number(chest.Id), chest.Rarity]));
  const chests = Object.fromEntries(RARITIES.map((rarity) => [rarity, 0]));
  for (const row of account.account_chests ?? []) {
    const rarity = chestRarity.get(Number(row.chest_id));
    if (rarity) chests[rarity] += 1;
  }
  const held = new Map((account.account_stackables ?? []).map((row) => [Number(row.stack_id), Number(row.count ?? 0)]));
  return {
    gold: Number(account.basic_currency ?? 0),
    gems: Number(account.premium_currency ?? 0),
    keys: Object.fromEntries(RARITIES.map((rarity) => [rarity, Number(account[KEY_COLUMN[rarity]] ?? 0)])),
    chests,
    powerups: gm.raw.Stackables.filter((row) => row.ItemCategory === "POWERUP").map((row) => ({
      id: row.Id,
      name: row.Name,
      count: held.get(Number(row.Id)) ?? 0,
    })),
  };
};

/**
 * A checked grant, given. Returns what was given, in plain words for the
 * admin log and the reply: `[{ what, amount, ... }]`.
 */
export const applyGrant = async (account, grant, { gm, random = Math.random }) => {
  const given = [];
  if (grant.gold) {
    account.basic_currency = Number(account.basic_currency ?? 0) + grant.gold;
    given.push({ what: "gold", amount: grant.gold });
  }
  if (grant.gems) {
    account.premium_currency = Number(account.premium_currency ?? 0) + grant.gems;
    given.push({ what: "gems", amount: grant.gems });
  }
  giveKeys(account, grant.keys);
  for (const rarity of RARITIES) {
    if (grant.keys[rarity]) given.push({ what: `${lower(rarity)} keys`, amount: grant.keys[rarity] });
  }
  const chestNames = new Map(weaponChests(gm).map((chest) => [Number(chest.Id), chest.Name]));
  for (const { id, count } of grant.chests) {
    await giveChests(account, id, count);
    given.push({ what: chestNames.get(id) ?? `chest ${id}`, amount: count });
  }
  if (grant.weapons.count) {
    const { count, rarity, hero } = grant.weapons;
    const made = await rollWeapons(account, count, { gm, random, rarity, hero });
    const heroName = hero === null ? null : gm.heroById.get(hero)?.Name ?? `hero ${hero}`;
    given.push({
      what: `${rarity ? `${lower(rarity)} ` : ""}weapons${heroName ? ` for the ${heroName}` : ""}`,
      amount: made,
    });
  }
  if (grant.powerups) {
    const kinds = await topUpPowerups(account, grant.powerups, gm);
    given.push({ what: `of each of ${kinds} powerups, at least`, amount: grant.powerups });
  }
  for (const asked of grant.level ?? []) {
    for (const { hero, level } of setHeroLevel(account, asked, gm)) {
      given.push({ what: `${hero} to level`, amount: level });
    }
  }
  return given;
};

import { loadGameMaster } from "./gamemaster.js";
import { purchaseOffer } from "./store.js";
import { storageLimit, unequippedWeapons } from "./inventory-space.js";
import { warn } from "./log.js";
import { heroLevel, maxLevel } from "./progression.js";

/**
 * Opening a chest.
 *
 * Most of this is a port rather than a design: the drop distribution, the
 * modifier roll and the pool of eligible weapons all come from GameMaster
 * tables and from one successful capture of the live server. The single number
 * that is *not* settled is the weapon's power — see `rollPower`.
 *
 * Contract, from docs/private-server.md §3.0:
 *   request  [accountId, chestInstanceId, token, forHeroId, forHeroSkinId]
 *   success  the account payload plus OfferId / WeaponId / NewWeaponDetails
 *   failure  error -537 when nothing could be awarded
 */

export class ChestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The live server's code for "rolled something but could not hand it over". */
export const NOTHING_AWARDED = -537;

export const pickWeighted = (weights, random = Math.random) => {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (const [key, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return Object.keys(weights).at(-1);
};

/**
 * ChestDropRates stores one probability distribution per chest rarity, with
 * columns named `id_<offerId>` summing to 1.0. Offers 0 and 1 are not real
 * offers — they stand for "generate a weapon of this rarity".
 */
const dropDistribution = (gm, rarityType) => {
  const row = gm.raw.ChestDropRates.find((entry) => entry.Rarity === rarityType);
  if (!row) return null;

  return Object.fromEntries(
    Object.entries(row)
      .filter(([key, value]) => key.startsWith("id_") && typeof value === "number" && value > 0)
      .map(([key, value]) => [key.slice(3), value])
  );
};

const WEAPON_SENTINELS = new Set(["0", "1"]);

/** A chest is opened with a key of its own rarity, held on the account. */
const KEY_COLUMN_BY_RARITY = {
  COMMON: "basic_keys",
  UNCOMMON: "uncommon_keys",
  RARE: "rare_keys",
  LEGENDARY: "legendary_keys",
};

/**
 * Level from experience is `heroLevel`, and was briefly a second reading of the
 * same table that disagreed with it.
 *
 * The Leveling table's per-hero column is the cost of *that* level, not the
 * total to reach it. The client accumulates it — `GameMaster.hx` does
 * `TotalExperience += levelValue` and files the running sum against the level —
 * and `progression.js` does the same. This file instead compared the raw
 * experience against each row's cost as though it were a threshold, which is
 * only correct for level one and drifts upward from there:
 *
 *   real level     5    10    20    30    50
 *   read as        9    22    57   100   100
 *
 * A level-30 player's chest therefore rolled a level-100 award — priced by
 * `rollPower` at level 100 too — and the client will not let them equip it
 * until they have earned seventy more levels. The best thing the chest could
 * give them was the thing they could not use.
 */

/** Weapon types a hero can wield, from its `*_TYPE` columns. */
const masteryTypes = (hero) =>
  Object.entries(hero)
    .filter(([key, value]) => key.endsWith("_TYPE") && value)
    .map(([key]) => key.replace(/_TYPE$/, ""));

/**
 * Which modifier types a weapon accepts.
 *
 * Each WeaponItem row carries a boolean column per modifier type it can take —
 * a short sword allows ATKSPD and CRIT_DAMAGE, which is exactly what the
 * captured award rolled. Without this filter a weapon ends up with modifiers it
 * has no business carrying.
 *
 * One column is spelled differently from the modifier type it refers to.
 */
const MODIFIER_COLUMNS = {
  DAMAGE: "DAMAGE",
  POISON: "POISON",
  CRIT_CHANCE: "CRIT_CHANCE",
  CRIT_DAMAGE: "CRIT_DAMAGE",
  ATKSPD: "ATKSPD",
  MANA_COST: "MANA_COST",
  CHARGE_TIME_REDUCTION: "CHARGE_REDUC",
};

const acceptedModifierTypes = (weapon) =>
  new Set(
    Object.entries(MODIFIER_COLUMNS)
      .filter(([column]) => weapon[column])
      .map(([, modifierType]) => modifierType)
  );

/**
 * The pool is limited to weapons the target hero can actually use — this is
 * why the request carries the hero and skin at all. Pick a Berserker and no bow
 * can drop.
 *
 * Declaring at least one modifier type doubles as the marker for a current
 * player weapon: every one of the fifty weapons that does is a HERO_ item, and
 * the rest are enemy gear or retired HERO_LEGACY_* pieces that should never
 * drop from a chest.
 */
const eligibleWeapons = (gm, hero) => {
  const mastery = new Set(masteryTypes(hero).map((type) => `${type}_TYPE`));
  return gm.raw.WeaponItem.filter(
    (weapon) =>
      weapon.Mastertype &&
      mastery.has(weapon.Mastertype) &&
      weapon.Power > 0 &&
      acceptedModifierTypes(weapon).size > 0
  );
};

/**
 * Rarity decides how many modifiers a weapon carries and which levels they may
 * be drawn from. The captured award — two level-3 modifiers of different types
 * on a rarity-3 weapon — matches the table exactly.
 */
const rollModifiers = (gm, rarity, weapon, random) => {
  const count = rarity.NumberOfModifiers ?? 0;
  if (!count) return [];

  const min = rarity.MinModifierLevel ?? 1;
  const max = rarity.MaxModifierLevel ?? min;
  const accepted = acceptedModifierTypes(weapon);
  const candidates = gm.raw.Modifiers.filter(
    (modifier) =>
      modifier.MODIFIER_LEVEL >= min &&
      modifier.MODIFIER_LEVEL <= max &&
      accepted.has(modifier.MODIFIER_TYPE)
  );

  const chosen = [];
  const usedTypes = new Set();
  // Distinct MODIFIER_TYPEs: the sample carried ATKSPD and CRIT_DAMAGE rather
  // than two of a kind.
  for (let guard = 0; guard < 50 && chosen.length < count; guard++) {
    const candidate = candidates[Math.floor(random() * candidates.length)];
    if (!candidate || usedTypes.has(candidate.MODIFIER_TYPE)) continue;
    usedTypes.add(candidate.MODIFIER_TYPE);
    chosen.push(candidate.Id);
  }
  return chosen;
};

/**
 * Weapon power. **This is the one part that is not a port.**
 *
 * The single captured award was power 739 on a rarity-3 short sword at level
 * 99. That does not fall out of the obvious combinations of the constants
 * involved, and Rarity also carries LevelWeight/ModifierWeight that hint at a
 * split we cannot separate from one data point. Two candidates land within a
 * couple of percent:
 *
 *   Power × level × BasePowerScale + BasePowerConstant  -> 723
 *   (Power + ScalingFactor) × level                     -> 743
 *
 * The first is used because it lets rarity actually matter, which it must. It
 * is an approximation, and more captures at a known rarity would settle it.
 */
const rollPower = (weapon, rarity, level) =>
  Math.max(1, Math.round(weapon.Power * level * (rarity.BasePowerScale ?? 1) + (rarity.BasePowerConstant ?? 0)));

/**
 * Item level tracks the opener's level with a small spread, reported from play
 * as roughly ±2 and consistent with the one capture.
 *
 * Bounded at the top by the hero's own ladder, because the client refuses to
 * equip past it: `DBInventoryInfo.canAvatarEquipThisItem` returns false when
 * `avatarInfo.level < itemInfo.requiredLevel`, and the Leveling table stops at
 * 100. Unbounded, the +2 handed a level-100 player a legendary they could never
 * hold — the roll's best outcomes were the ones it made worthless.
 *
 * The official server does not produce them. Across 509 item rows on a
 * captured account, 480 of them late-game, the distribution runs 98×136,
 * 99×160, 100×184 and stops: not one row above 100.
 *
 * Clamping rather than re-rolling or sliding the window down, because those
 * would be inventions. The capture pins the ceiling and says nothing about the
 * shape underneath it, so the change is the smallest one that makes the
 * observed fact true; the resulting weight on the top level is a consequence of
 * that and not a claim about the original.
 */
const rollItemLevel = (level, random, ceiling) =>
  Math.min(ceiling, Math.max(1, level + Math.floor(random() * 5) - 2));

/**
 * The top rarity carries a third modifier drawn from a separate table, which is
 * why a legendary weapon shows three where its NumberOfModifiers says two. The
 * rarity row announces it with HasLegendaryModifier.
 */
const rollLegendaryModifier = (gm, rarity, random) => {
  if (!rarity.HasLegendaryModifier) return 0;
  const pool = gm.raw.LegendaryModifiers;
  return pool[Math.floor(random() * pool.length)]?.Id ?? 0;
};

/**
 * One rolled weapon, as a chest would have produced it — exported so a tool
 * can stock a bag without pretending to open something that is not there.
 */
export const generateWeapon = ({ gm, hero, rarity, level, accountId, id, random }) => {
  const pool = eligibleWeapons(gm, hero);
  if (!pool.length) return null;

  const weapon = pool[Math.floor(random() * pool.length)];
  const [modifier1 = 0, modifier2 = 0] = rollModifiers(gm, rarity, weapon, random);

  return {
    id,
    item_id: weapon.Id,
    account_id: accountId,
    power: rollPower(weapon, rarity, level),
    // Awards arrive unequipped; equipping is a separate call that fills these.
    avatar_id: null,
    avatar_slot: null,
    is_new: 1,
    requiredlevel: rollItemLevel(level, random, maxLevel(gm, hero)),
    rarity: rarity.Id,
    modifier1,
    modifier2,
    legendarymodifier: rollLegendaryModifier(gm, rarity, random),
    created: new Date().toISOString(),
  };
};

/**
 * Opens a chest held by the account and returns the reward fields the client
 * expects alongside the account payload. The account object is mutated: the
 * chest is consumed and the award appended.
 */
export const openChest = async ({ account, chestInstanceId, heroInstanceId, nextId, random = Math.random }) => {
  const gm = await loadGameMaster();

  const chest = (account.account_chests ?? []).find((entry) => entry.id === chestInstanceId);
  if (!chest) throw new ChestError(NOTHING_AWARDED, `no chest ${chestInstanceId} on this account`);

  const gmChest = gm.raw.Chests.find((entry) => entry.Id === chest.chest_id);
  if (!gmChest) throw new ChestError(NOTHING_AWARDED, `unknown chest type ${chest.chest_id}`);

  const distribution = dropDistribution(gm, gmChest.Rarity);
  if (!distribution) throw new ChestError(NOTHING_AWARDED, `no drop table for ${gmChest.Rarity}`);

  const avatar = (account.account_avatars ?? []).find((entry) => entry.id === heroInstanceId)
    ?? (account.account_avatars ?? [])[0];
  const hero = avatar && gm.heroById.get(avatar.avatar_id);
  if (!hero) throw new ChestError(NOTHING_AWARDED, `no hero for avatar ${heroInstanceId}`);

  const picked = pickWeighted(distribution, random);
  const keyColumn = KEY_COLUMN_BY_RARITY[gmChest.Rarity];

  /**
   * Not a weapon but an offer, which is the chest ladder pulling the player up
   * a rung: a common chest can pay an uncommon key, an uncommon chest a rare
   * one, a rare chest a legendary one. That reading is what explains the shape
   * of the table — legendary chests are the one rarity with no offer at all,
   * because there is no rung above them. Two of the three also carry gems.
   *
   * This used to refuse. Nothing was destroyed by that — the chest stayed and
   * the key went unspent — but the reward the table promised was quietly
   * withheld on roughly one open in twenty, and on the report screen it looked
   * worse than that: the client clears its own slot before sending, so the
   * chest appeared to vanish and then came back on the next refetch.
   *
   * Handed over by the same code that sells it. `purchaseOffer` already
   * separates the grant from the price for exactly this — a daily box is a
   * purchase minus the payment — so a key won from a chest cannot come out
   * different from one bought in the shop.
   */
  if (!WEAPON_SENTINELS.has(picked)) {
    const offerId = Number(picked);
    if (keyColumn && (account[keyColumn] ?? 0) < 1) {
      throw new ChestError(NOTHING_AWARDED, `no ${keyColumn.replace("_keys", "")} key`);
    }

    try {
      await purchaseOffer({ account, offerId, nextId, free: true });
    } catch (problem) {
      // A refusal from the shop is still a refusal here, and must leave the
      // chest and the key alone rather than half-spending them.
      throw new ChestError(NOTHING_AWARDED, `offer ${offerId} could not be granted: ${problem.message}`);
    }

    account.account_chests = (account.account_chests ?? []).filter(
      (entry) => entry.id !== chestInstanceId
    );
    if (keyColumn) account[keyColumn] = (account[keyColumn] ?? 0) - 1;

    // No weapon, so no NewWeaponDetails: the client draws this one from the
    // offer's own Bundle* columns, which is why TransactionResponse carries an
    // offer id beside the weapon id.
    return { OfferId: offerId, WeaponId: null, NewWeaponDetails: null };
  }

  const rarity = gm.raw.Rarity.find((entry) => entry.Type === gmChest.Rarity);
  if (!rarity) throw new ChestError(NOTHING_AWARDED, `no rarity row for ${gmChest.Rarity}`);

  /**
   * Room for the weapon this is about to become.
   *
   * Unequipped weapons only, and deliberately not the chests. Opening does not
   * make the account fuller — the chest goes and a weapon arrives, and the
   * client counts both, so the number on its screen does not move. Gating that
   * on the chests would leave a player whose storage is full *of chests* unable
   * to open any of them.
   */
  if (unequippedWeapons(account) >= storageLimit(account)) {
    // What the -537 in every early capture actually meant: a full account.
    throw new ChestError(NOTHING_AWARDED, "weapon storage is full");
  }

  if (keyColumn && (account[keyColumn] ?? 0) < 1) {
    throw new ChestError(NOTHING_AWARDED, `no ${keyColumn.replace("_keys", "")} key`);
  }

  const level = heroLevel(gm, hero, avatar.experience ?? 0);
  const item = generateWeapon({
    gm,
    hero,
    rarity,
    level,
    accountId: account.id,
    id: await nextId(),
    random,
  });
  if (!item) throw new ChestError(NOTHING_AWARDED, `no weapon this hero can use`);

  account.account_items = [...(account.account_items ?? []), item];
  account.account_chests = (account.account_chests ?? []).filter(
    (entry) => entry.id !== chestInstanceId
  );
  // The key is spent with the chest, and only once the award is certain — a
  // refused open must not cost anything.
  if (keyColumn) account[keyColumn] = (account[keyColumn] ?? 0) - 1;

  return { OfferId: null, WeaponId: item.id, NewWeaponDetails: item };
};

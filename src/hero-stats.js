import { statPointsEarned, heroLevel, STAT_CAP } from "./progression.js";

/**
 * What a hero's stats actually come to: base, plus level, plus trained points.
 *
 * Nothing here may assume which slot does what. A hero's four training slots are
 * named per hero in the Hero table — Berserker keeps its health stat in slot 3,
 * Ghost Samurai in slot 4, and Ranger and Sorcerer have no health stat at all.
 * Writing "slot 2 is health" would be wrong for four of the six heroes shipped
 * and wrong again for any hero added later, so every slot is resolved through
 * its declared name.
 *
 * The resolution rule is the client's, in GMHero.HeroSlotHelper:
 *
 *   - a slot naming a plain stat (one of STAT_NAMES) contributes AmtStatN of it
 *   - otherwise the name is a SuperStats row, and *every* non-zero column of
 *     that row contributes — one slot can feed several stats at once
 *   - a slot with AmtStatN of zero contributes nothing and is skipped
 *
 * Points are then worth the stat's `Bonus` from the Stats table. Health works
 * out at 5 per point (0.5 × 10), but that falls out of the tables rather than
 * being written down here.
 */

/**
 * The canonical stat order (DBGlobal.StatNames). Only membership matters to us,
 * but the order is kept so the list can be compared against the client's.
 */
export const STAT_NAMES = [
  "HP_BOOST",
  "MP_BOOST",
  "MELEE_ATK",
  "SHOOT_ATK",
  "MAGIC_ATK",
  "SHOOT_DEF",
  "MELEE_DEF",
  "MAGIC_DEF",
  "MELEE_SPD",
  "SHOOT_SPD",
  "MAGIC_SPD",
  "HP_REGEN",
  "MP_REGEN",
  "MOVEMENT",
  "LUCK",
];

const statNames = new Set(STAT_NAMES);

/**
 * GameMaster.PostProcess seeds a bias of 1 into the three attack speeds and
 * movement, and leaves every other stat at zero. Health and mana are among the
 * zeroes, which is why they come out right without it — but the speeds do not.
 */
const STAT_BIAS = new Map([
  ["MELEE_SPD", 1],
  ["SHOOT_SPD", 1],
  ["MAGIC_SPD", 1],
  ["MOVEMENT", 1],
]);

/**
 * Legendary modifiers, applied per weapon carried.
 *
 * These are the one part of the system that is *not* table-driven: GameMaster
 * describes them in prose only ("Increases player health by 10 + Weapon Level *
 * 0.9") and the arithmetic is hard-coded in the client, keyed by modifier id, in
 * HeroGameObject.processLegendaryModifiers. Only three of the twelve are handled
 * there; the rest are nobody's business on the client, which by the usual
 * contract makes them ours.
 *
 * The level in the formula is the *weapon's* required level, not the hero's.
 */
const LEGENDARY_BONUS = new Map([
  [1, (weapon) => ({ health: 10 + Number(weapon.requiredlevel ?? 0) * 0.9 })], // STAMINA
  [2, (weapon) => ({ mana: 10 + Number(weapon.requiredlevel ?? 0) * 0.4 })], // APTITUDE
  [3, () => ({ moveSpeed: 0.1 })], // ACCELERATION
]);

/** What the equipped weapons add on top of the hero's own stats. */
export const legendaryBonuses = (weapons = []) => {
  const totals = { health: 0, mana: 0, moveSpeed: 0 };
  for (const weapon of weapons) {
    const apply = LEGENDARY_BONUS.get(Number(weapon?.legendarymodifier ?? 0));
    if (!apply) continue;
    for (const [key, value] of Object.entries(apply(weapon))) totals[key] += value;
  }
  return totals;
};

/**
 * How much of each stat one point in this slot is worth.
 *
 * Returns a map rather than a single number precisely because a super stat
 * spreads across several entries.
 */
const slotContribution = (gm, name, amount) => {
  const contribution = new Map();
  if (!amount) return contribution;

  if (statNames.has(name)) {
    contribution.set(name, amount);
    return contribution;
  }

  const superStat = gm.raw.SuperStats.find((row) => row.Constant === name);
  if (!superStat) return contribution;

  for (const stat of STAT_NAMES) {
    const value = Number(superStat[stat] ?? 0);
    if (value) contribution.set(stat, value);
  }
  return contribution;
};

/**
 * The points placed in each of the hero's four slots, read off the avatar row.
 * Absent values are zero — an untrained hero, not an error.
 */
const placedPoints = (avatar) =>
  [1, 2, 3, 4].map((slot) => Number(avatar?.[`statupgrade${slot}`] ?? 0));

/**
 * Every stat the hero has, keyed by name, in the units the Stats table's Bonus
 * column is denominated in.
 */
export const statTotals = (gm, hero, avatar) =>
  statVector(gm, hero, {
    level: heroLevel(gm, hero, Number(avatar?.experience ?? 0)),
    points: placedPoints(avatar),
  });

/**
 * A super-stat that is not a combat stat, in its own units.
 *
 * Most SuperStats rows spread across the ordinary columns and are folded into
 * statTotals. A few carry none of them and mean something only the server acts
 * on — COOKING is the Battle Chef's, whose columns are all zero and whose real
 * fields are HitSpawnBase/Increase and DeathSpawnBase/Increase. Those are
 * invisible to the stat vector, so they are read straight off the slots that
 * declare them.
 *
 * Two slots feeding one name combine the way statVector does it, amounts summed
 * against points summed.
 */
export const superStatValue = (gm, hero, avatar, constant) => {
  const points = placedPoints(avatar);
  let perPoint = 0;
  let placed = 0;
  for (const [index, spent] of points.entries()) {
    if (hero?.[`StatUpgrade${index + 1}`] !== constant) continue;
    perPoint += Number(hero[`AmtStat${index + 1}`] ?? 0);
    placed += spent;
  }
  return perPoint * placed;
};

/** The most of it a hero could ever have, every feeding slot filled to the cap. */
export const superStatCeiling = (gm, hero, constant) => {
  let perPoint = 0;
  for (const index of [0, 1, 2, 3]) {
    if (hero?.[`StatUpgrade${index + 1}`] !== constant) continue;
    perPoint += Number(hero[`AmtStat${index + 1}`] ?? 0);
  }
  return perPoint * STAT_CAP;
};

/**
 * The same arithmetic for anything that carries stat columns — heroes, but also
 * the NPC rows, which use identical column names and simply have no training
 * slots and no ladder to climb.
 */
export const statVector = (gm, hero, { level = 0, points = [0, 0, 0, 0] } = {}) => {
  const bonuses = new Map(gm.raw.Stats.map((row) => [row.Constant, Number(row.Bonus ?? 0)]));

  /**
   * Two parallel accumulations, exactly as HeroGameObject.refreshStatVector
   * does them: how much of a stat one point is worth, and how many points were
   * placed into slots feeding it. They are multiplied only at the end, so two
   * slots feeding the same stat combine as (a₁+a₂)×(p₁+p₂) rather than
   * a₁p₁+a₂p₂. That cross term is the client's behaviour, not a rounding
   * accident, so it is reproduced rather than corrected.
   */
  const perPoint = new Map();
  const placed = new Map();
  for (const [index, spent] of points.entries()) {
    const contribution = slotContribution(
      gm,
      hero[`StatUpgrade${index + 1}`],
      Number(hero[`AmtStat${index + 1}`] ?? 0)
    );
    for (const [stat, units] of contribution) {
      perPoint.set(stat, (perPoint.get(stat) ?? 0) + units);
      placed.set(stat, (placed.get(stat) ?? 0) + spent);
    }
  }

  const totals = new Map();
  for (const stat of STAT_NAMES) {
    // The hero's own column is the base, its LV_ twin is the per-level growth.
    const raw =
      Number(hero[stat] ?? 0) +
      Number(hero[`LV_${stat}`] ?? 0) * level +
      (perPoint.get(stat) ?? 0) * (placed.get(stat) ?? 0);

    const value = raw * (bonuses.get(stat) ?? 0) + (STAT_BIAS.get(stat) ?? 0);
    if (value) totals.set(stat, value);
  }

  return totals;
};

/**
 * Maximum health. The hero's flat HP is the floor; HP_BOOST from levels and
 * training is added on top.
 *
 * Pinned by a capture: a level-100 Ghost Samurai with [0, 75, 75, 50] placed
 * arrived at 880 — 180 base, 250 from the 50 points in its health slot, and 450
 * from LV_HP_BOOST across 100 levels.
 */
export const maxHitPoints = (gm, hero, avatar) =>
  Math.max(1, Math.round(Number(hero?.HP ?? 0) + (statTotals(gm, hero, avatar).get("HP_BOOST") ?? 0)));

/** Maximum mana, by the same rule against MP_BOOST. */
export const maxManaPoints = (gm, hero, avatar) =>
  Math.max(0, Math.round(Number(hero?.MP ?? 0) + (statTotals(gm, hero, avatar).get("MP_BOOST") ?? 0)));

/**
 * What the health and mana bars actually read, weapons included.
 *
 * These are deliberately *not* what goes on the wire. The client adds the
 * legendary bonuses itself — get_maxHitPoints is `mStats.maxHitPoints +
 * mStaminaModMultiplier` — so sending a total that already contains them would
 * count them twice. The capture settles it: a hero carrying an APTITUDE weapon
 * worth 49 mana arrived with 79 on the wire against a base of 80, not 129.
 *
 * The server still needs the true ceiling, because it owns hit points and has to
 * agree with the bar the player is watching.
 */
export const effectiveMaxHitPoints = (gm, hero, avatar, weapons = []) =>
  Math.max(1, Math.round(maxHitPoints(gm, hero, avatar) + legendaryBonuses(weapons).health));

export const effectiveMaxManaPoints = (gm, hero, avatar, weapons = []) =>
  Math.max(0, Math.round(maxManaPoints(gm, hero, avatar) + legendaryBonuses(weapons).mana));

/**
 * The four numbers the hero object carries on the wire, and what the training
 * screen reads back. Clamped to what the account actually earned so a corrupt
 * row cannot enter a dungeon with more than it paid for.
 */
export const wireSlotPoints = (gm, hero, avatar) => {
  const points = placedPoints(avatar);
  const earned = statPointsEarned(gm, hero, Number(avatar?.experience ?? 0));
  const spent = points.reduce((total, value) => total + value, 0);
  return spent <= earned ? points : [0, 0, 0, 0];
};

/**
 * The three legendary shields, which are typed and do not stack.
 *
 * `Barrier` takes half of melee damage, `Cover` half of ranged and `Comprehend`
 * half of magic — one per damage type, each saying "Does not stack" in its own
 * description. The client handles none of the nine legendaries past the third,
 * which by the usual contract leaves them here, and they were not here either.
 *
 * Keyed on the defence stat the hit is already priced against, so a weapon that
 * shields against arrows does nothing about a sword. That is the whole point of
 * there being three of them, and the thing most likely to be got wrong by
 * applying whichever one the hero happens to carry.
 *
 * Flat rather than summed. Two weapons carrying `Barrier` are still 50%, which
 * is what "does not stack" means; the caller folds this into the other
 * reductions multiplicatively, as it already does for buffs.
 */
const LEGENDARY_SHIELD = new Map([
  [10, "MELEE_DEF"], // Barrier
  [11, "SHOOT_DEF"], // Cover
  [12, "MAGIC_DEF"], // Comprehend
]);

const LEGENDARY_SHIELD_SHARE = 0.5;

export const legendaryShieldFor = (weapons = [], defenceStat) => {
  if (!defenceStat) return 0;
  for (const weapon of weapons) {
    const shields = LEGENDARY_SHIELD.get(Number(weapon?.legendarymodifier ?? 0));
    if (shields === defenceStat) return LEGENDARY_SHIELD_SHARE;
  }
  return 0;
};

/**
 * The two legendary multipliers on what an enemy drops.
 *
 * `Midas Touch` raises gold by 5% and `Brain Trust` experience by 5%, both in
 * their own words and both unread. Like the shields, neither stacks — the
 * descriptions do not say so outright, but they are written the same way as the
 * three that do, and a flat five per cent is the reading that does not turn
 * four weapons into twenty.
 */
const LEGENDARY_DROP = new Map([
  [8, "xp"], // Brain Trust
  [9, "gold"], // Midas Touch
]);

const LEGENDARY_DROP_SHARE = 0.05;

export const legendaryDropBonus = (weapons = [], kind) => {
  if (!kind) return 0;
  for (const weapon of weapons) {
    if (LEGENDARY_DROP.get(Number(weapon?.legendarymodifier ?? 0)) === kind) {
      return LEGENDARY_DROP_SHARE;
    }
  }
  return 0;
};

/**
 * Whether a weapon pays a Buster point for a kill.
 *
 * `Buster Gen` — "Gain 1 Buster Point per enemy killed!" — and one is one: two
 * of them do not pay two, on the same reading as the shields beside them.
 */
export const legendaryBusterPerKill = (weapons = []) =>
  weapons.some((weapon) => Number(weapon?.legendarymodifier ?? 0) === 7) ? 1 : 0;

/**
 * What the owner's legendaries add to the pet standing beside him.
 *
 * `Beast Master` gives it 10 + Weapon Level * 0.9 health and `Animal Fury`
 * 20 + Weapon Level * 1.8 damage, in the prose the GameMaster describes them
 * with. Neither was read, so a legendary bought for a pet did nothing for it.
 *
 * The level in each formula is the *weapon's* required level, not the hero's or
 * the pet's — the same reading `Stamina` and `Aptitude` already use two blocks
 * above, and they are written in the same sentence pattern.
 *
 * Summed across the weapons that carry them, unlike the shields: these are
 * additions to a number rather than a share taken off one, and nothing in
 * either description says otherwise.
 */
export const legendaryPetBonuses = (weapons = []) => {
  const totals = { health: 0, damage: 0 };
  for (const weapon of weapons) {
    const level = Number(weapon?.requiredlevel ?? 0);
    const id = Number(weapon?.legendarymodifier ?? 0);
    if (id === 4) totals.health += 10 + level * 0.9; // Beast Master
    if (id === 5) totals.damage += 20 + level * 1.8; // Animal Fury
  }
  return totals;
};

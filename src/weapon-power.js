/**
 * How strong a weapon of this kind, rarity and level is.
 *
 *   Power × BasePowerScale × (1 + level^ScalingFactor / 10) + BasePowerConstant
 *
 * The game's own shop says so: its 2692 weapon offers in `OfferDetails` carry
 * a level, a rarity and the power the shop sells them at, and this lands
 * within 2% of 2059 of them, 821 exactly. Past a power of 100 every offer sits
 * between 0.93 and 1.03 of it; below, the misses are rounding on small numbers,
 * and the only real exceptions are eight Kickstarter legacy weapons sold at a
 * flat 9.
 *
 * `ScalingFactor` is what the earlier reading, `Power × level × scale`, left
 * out. It happened to meet the curve at level 100 for the common 1.5 — `1 +
 * 100^1.5/10` is 101 — which is where its one data point was, and nowhere else:
 * a level-10 weapon came out 2.4 times the shop's, a level-100 crossbow
 * (1.35) twice, and a scroll (1) nine times.
 *
 * The shop's powers also carry a spread of a percent or two around this; its
 * shape is not recoverable from the table, so none is invented here.
 */
export const weaponPowerAt = (weapon, rarity, level) => {
  const base = Number(weapon?.Power ?? 0);
  if (!(base > 0) || !rarity) return 0;
  const at = Math.max(1, Number(level) || 1);
  const exponent = Number(weapon.ScalingFactor ?? 1) || 1;
  const scale = Number(rarity.BasePowerScale ?? 1);
  const constant = Number(rarity.BasePowerConstant ?? 0);
  return Math.max(1, Math.round(base * scale * (1 + Math.pow(at, exponent) / 10) + constant));
};

/**
 * What a hero holds at his level when no weapon is behind it:
 *
 *   power × (1 + level^1.5 / 20), rounded down
 *
 * One curve, three measured holders, each with its own `power`:
 *
 *   10  his empty fourth slot, sent as `[0, power, level, 1, 0, 0, 0]` — exact
 *       on all 27 levels across 415 official hero generates: 10 at level 1,
 *       186 at 50, 334 at 75, 510 at 100. Rounding to nearest misses 14.
 *   20  a consumable bomb, `CONSUMABLE_BOMB_WEAPON`'s own Power: generated at
 *       1020 for a level-100 hero and 669 for a level-75 one (5 of 5 bombs),
 *       its blast |DamageMod| × that on 36 of 36 hits.
 *    1  a Dungeon Buster's nuke, `EN_PLACABLE_TRAPS_WEAPON`'s own Power:
 *       generated at 51 for a level-100 hero. THIN — one official session.
 *       Two party members' nukes read 19 at level 49 and 37 at level 80, where
 *       this gives 18 and 36: rounded up there, down for the bomb's 669.5, and
 *       nothing here explains which.
 *
 * The first two used to be written as 5 × (1 + level^1.5/10) + 5 and twice
 * that; they are this curve at 10 and 20, equal on every level 1 to 200. The
 * product is taken last so that a whole result stays whole (14 at level 4, not
 * 13.999…).
 */
export const levelCurvePower = (power, level) => {
  const base = Math.max(0, Number(power) || 0);
  const at = Math.max(1, Number(level) || 1);
  return Math.floor(base + (base * Math.pow(at, 1.5)) / 20);
};

/** The hero's empty fourth slot — see `levelCurvePower`. */
export const consumableSlotPower = (level) => levelCurvePower(10, level);

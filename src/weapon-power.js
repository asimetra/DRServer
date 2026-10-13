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
 * What a hero carries in his fourth weapon slot: no weapon, and a power that is
 * his level's.
 *
 *   5 × (1 + level^1.5 / 10) + 5, rounded down
 *
 * Every official hero generate carries it as `[0, power, level, 1, 0, 0, 0]`
 * (415 of them, 27 distinct levels from 1 to 100), and this is exact on all 27:
 * 10 at level 1, 186 at 50, 334 at 75, 510 at 100. Rounding to nearest instead
 * misses 14 of the 27. The client builds no weapon from it — its type is 0,
 * in every one of the 415.
 */
const consumableCurve = (level) =>
  5 * (1 + Math.pow(Math.max(1, Number(level) || 1), 1.5) / 10) + 5;

export const consumableSlotPower = (level) => Math.floor(consumableCurve(level));

/**
 * What a thrown consumable bomb holds: twice that, doubled before it is rounded
 * down. The official generates its bomb with `CONSUMABLE_BOMB_WEAPON` at 1020
 * for a level-100 hero and 669 for a level-75 one, whose slot reads 334 — so
 * it is not twice the slot as sent. Its blast landed |DamageMod| × that on 36
 * of 36 hits, where the hero's slot 0 fitted none. Rests on two official heroes
 * and five bombs.
 */
export const consumableBombPower = (level) => Math.floor(2 * consumableCurve(level));

/**
 * How strong a weapon of this kind, rarity and level is.
 *
 *   Power × BasePowerScale × (1 + level^ScalingFactor / 10) + BasePowerConstant
 *
 * The game's own shop says so: its 2692 weapon offers in `OfferDetails` carry
 * a level, a rarity and the power the official sold them at, and this lands
 * within 2% of 2059 of them, 821 exactly. Past a power of 100 every offer sits
 * between 0.93 and 1.03 of it; below, the misses are rounding on small numbers,
 * and the only real exceptions are eight Kickstarter legacy weapons sold at a
 * flat 9. The official accounts' own weapons agree across every band, from a
 * level-4 common sword at 12 to a level-100 legendary bow at 1631.
 *
 * `ScalingFactor` is what the earlier reading, `Power × level × scale`, left
 * out. It happened to meet the curve at level 100 for the common 1.5 — `1 +
 * 100^1.5/10` is 101 — which is where its one data point was, and nowhere else:
 * a level-10 weapon came out 2.4 times the official's, a level-100 crossbow
 * (1.35) twice, and a scroll (1) nine times.
 *
 * The official's powers also carry a spread of a percent or two around this;
 * its shape is not recoverable from the corpus, so none is invented here.
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

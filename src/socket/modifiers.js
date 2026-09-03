/**
 * What the modifiers on a weapon do once it is swung.
 *
 * A weapon carries up to two of them — `modifier1` and `modifier2` on the
 * account row, ids into the `Modifiers` table — and the chest that dropped it
 * has been rolling them correctly for a while. Nothing on this side ever read
 * them back, so a Critical katana hit exactly as hard as a plain one.
 *
 * The table holds 24 types across five levels each. This module covers the ones
 * that are settled by measurement; the rest are listed in the note by
 * `critRollFor` so the next pass knows what is left rather than rediscovering
 * it.
 */

/**
 * Whether this swing crits, and by how much.
 *
 * The decision is the server's, which the recordings are unambiguous about:
 * across 13626 results the client proposes `criticalHit` as 0 every single
 * time, and the official server answers with it set on 1818 of 23103 hits —
 * 7.87%. A client that could declare its own crits would be declaring its own
 * damage.
 *
 * Two modifiers roll for it and the table says they are different weapons.
 * `Critical` (`CRIT_CHANCE`) is a 10% to 25% chance of `CRIT_DAMAGE` 1, and
 * `Vicious` (`CRIT_DAMAGE`) is a flat 5% chance of 2 through 4. `CRIT_DAMAGE`
 * is the *extra*, so a multiplier of 1 doubles the hit — which is what the wire
 * shows. Grouping the official's echoes by attack and comparing the median crit
 * against the median ordinary hit gives 2.00 for `KATANA_SOUL_BANG` (1600
 * crits), 2.00 for `KATANA_COMBO_2`, `SLICE&DICE`, `KATANA_COMBO_3`,
 * `AXE_COMBO_1` and `TWO_CHOP_REPEATER`. Exactly two, on six attacks.
 *
 * Rolled per modifier rather than from a pooled chance, because that is what
 * makes both descriptions literally true: "10% chance to deal 100% extra
 * damage! Stacks with Vicious!" and "Adds 5% chance to crit with 200% damage!
 * Stacks with Critical!". Each brings its own chance and its own damage. When
 * both fire the larger one is paid, since a single hit crits once.
 *
 * The `LegendaryModifiers` table carries no crit columns at all — twelve rows,
 * none of them — so a legendary is not consulted here.
 *
 * Still to do, and deliberately not guessed at: the on-hit debuffs
 * (`POISON`, `BURNING`, `STUN`, `SLOW`, `CRIPPLE`, `ROOT`, `CHILLING`,
 * `SHOCKING`), which the official grants as real Buff objects — 23 of the 40
 * constants they name appear in the recordings — and the passive columns
 * (`DAMAGE`, `ATKSPD`, `MANA_COST`, `COOLDOWN_REDUC`, `CHARGE_REDUC`,
 * `INCREASE_COLLISION`, `CHAIN`, `PIERCE`, `SCALING`, `KNOCKBACK`, `PULL`,
 * `SPAWN_FOOD_ON_HIT`, `DEATH_FOOD`, `BUFF_GRANT_DURATION_MULTIPLIER`).
 */
export const critRollFor = (gm, weapon, random = Math.random) => {
  const none = { critical: false, multiplier: 1 };
  if (!weapon) return none;

  let extra = 0;
  for (const id of [weapon.modifier1, weapon.modifier2]) {
    if (!id) continue;
    const modifier = gm?.modifiersById?.get(Number(id));
    const chance = Number(modifier?.CRIT_CHANCE);
    if (!Number.isFinite(chance) || chance <= 0) continue;
    if (random() >= chance) continue;
    extra = Math.max(extra, Number(modifier.CRIT_DAMAGE) || 0);
  }

  // A modifier that rolls a chance without naming any extra damage is not a
  // crit, whatever it rolled; there would be nothing to show for it.
  return extra > 0 ? { critical: true, multiplier: 1 + extra } : none;
};

/**
 * The debuffs a weapon leaves on whatever it hits.
 *
 * Eight of the modifier types name a `BUFF_1` — `POISON`, `BURNING`, `STUN`,
 * `SLOW`, `CRIPPLE`, `ROOT`, `CHILLING`, `SHOCKING` — and the official grants
 * them as real Buff objects: 23 of the 40 constants they name appear in the
 * recordings, `FIRE_L5` 1059 times, `POISON_L4` 471, `CRIPPLE_L3` 440.
 *
 * On every hit, with no roll. Those modifier rows carry eight columns between
 * them — `Id`, `Constant`, `MODIFIER_TYPE`, `MODIFIER_LEVEL`, `BUFF_1`, `Name`,
 * `IconName`, `Description` — and not one of them is a chance. The types that
 * do roll say so in a column of their own, `SPAWN_FOOD_ON_HIT_PERCENTAGE`.
 *
 * Everything after this is `grantBuff`'s, and it already does all of it. The
 * duration is the Buff table's `Duration`, and the recordings agree: of 4628
 * modifier buffs watched from creation to disable, exactly one outlived its
 * authored duration, by 266ms.
 *
 * Stacking too. Poison's own description — "duration stacks" — is `MaxStacks`
 * 6 on `POISON_L1` through `L5`, and a fresh Buff object per hit rather than a
 * refreshed one: repeated hits added a new object 1351 times against 15 that
 * replaced anything. Counted per victim and per constant, the official reaches
 * exactly 6 concurrent poisons and stops, which is what the column says. Fire
 * authors 2, and everything else 1.
 */
export const onHitBuffsFor = (gm, weapon) => {
  if (!weapon) return [];
  const buffs = [];
  for (const id of [weapon.modifier1, weapon.modifier2]) {
    if (!id) continue;
    const named = gm?.modifiersById?.get(Number(id))?.BUFF_1;
    if (named) buffs.push(named);
  }
  return buffs;
};

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
 * Where the other types live, counted rather than assumed — the first draft of
 * this note listed work that was already done, which is worth more care than a
 * list deserves.
 *
 * The client owns six, and `WeaponGameObject.updateStatsForModifiers` is the
 * whole of its list: `ATKSPD` (`MELEE_SPD`, `SHOOT_SPD`, `MAGIC_SPD`), `CHAIN`,
 * `PIERCE`, `CHARGE_REDUC` and `INCREASE_COLLISION`, plus `MANA_COST` and
 * `COOLDOWN_REDUC` which it predicts and this server decides — `buster.js` and
 * `cooldowns.js` have read those two for a while.
 *
 * `SCALING` turned out to be the client's too, and already working:
 * `ScalingWeaponController` reads `MAX_PROJECTILES` off the modifier and puts
 * the result in the choreography header, which this server forwards. All 7943
 * recorded headers carry 1.00 only because no recorded player had a Split bow.
 *
 * `BUFF_GRANT_DURATION_MULTIPLIER` needs nothing at all, which took looking to
 * find out. It has no column on `WeaponItem`, so no weapon may carry it, and it
 * does not appear once in the 66736 filled modifier slots across 33729 official
 * item records. `SCALING` is unreachable the same way. Both are rows the data
 * describes and the game cannot hand out.
 *
 * Which leaves `KNOCKBACK` and `PULL`, and they are reachable — 13 weapons
 * allow one and 3 the other, and the official puts `KNOCKBACK` on 1278 real
 * items. What is missing is the size: the result's knockback byte is a flag,
 * set by the official on 13024 of its echoed hits and by the client on 2 of
 * 13626, so the push is this server's decision, but the distance and duration
 * the modifiers author never cross the wire at all.
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

/**
 * What the weapon's own `DAMAGE` modifiers multiply a hit by.
 *
 * `Sturdy` authors `MELEE_ATK`, `SHOOT_ATK` and `MAGIC_ATK` together — 1.1 at
 * level one — and nothing anywhere read them. Not the server, which prices
 * every hit, and not the client either: `WeaponGameObject.updateStatsForModifiers`
 * is the whole of what a weapon does with its modifiers on that side, and it
 * applies speed, mana, chain, pierce, cooldown, charge and collision scale. The
 * three attack columns are not in it. So a Sturdy weapon hit for exactly what a
 * plain one did, on both sides of the wire.
 *
 * Named by stat rather than applied blind, because the columns are three and an
 * attack is one of them: `statOffsetsFor` already decides whether a swing is
 * melee, shooting or magic, and a modifier that raises all three still only
 * raises the one that is being paid.
 *
 * Multiplied across the modifiers a weapon carries, which is how the client
 * treats every other multiplying column it does read.
 */
export const attackMultiplierFor = (gm, weapon, statName) => {
  if (!weapon || !statName) return 1;
  let multiplier = 1;
  for (const id of [weapon.modifier1, weapon.modifier2]) {
    if (!id) continue;
    const authored = Number(gm?.modifiersById?.get(Number(id))?.[statName]);
    if (Number.isFinite(authored) && authored > 0) multiplier *= authored;
  }
  return multiplier;
};

/**
 * The chance a weapon's modifiers give it of dropping food.
 *
 * `Saucier` is 3% to 15% on hitting, `Cook's` 5% to 25% on killing, and both
 * say so in a percentage column of their own — which is what marks them out
 * from the eight debuff types, whose rows carry no chance at all and so apply
 * every time.
 *
 * Summed rather than rolled apart, because unlike the two crit modifiers these
 * do not each bring a different reward: two sources of food are two chances at
 * the same food, and one hit drops at most one.
 *
 * Read by column name so the caller says which event it is asking about; the
 * two are separate rolls at separate moments and a weapon may carry both.
 */
export const foodChanceFor = (gm, weapon, column) => {
  if (!weapon) return 0;
  let percent = 0;
  for (const id of [weapon.modifier1, weapon.modifier2]) {
    if (!id) continue;
    const authored = Number(gm?.modifiersById?.get(Number(id))?.[column]);
    if (Number.isFinite(authored) && authored > 0) percent += authored;
  }
  return percent / 100;
};

export const FOOD_ON_HIT = "SPAWN_FOOD_ON_HIT_PERCENTAGE";
export const FOOD_ON_DEATH = "SPAWN_FOOD_ON_DEATH_PERCENTAGE";

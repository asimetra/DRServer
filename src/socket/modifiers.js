import { superStatValue } from "../hero-stats.js";

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
 * Stacks with Critical!". Each brings its own chance and its own damage.
 *
 * And when both fire they *multiply*, which took a second look to see. Grouping
 * the official's crits by session and attack and dividing each by the modal
 * ordinary hit of the same group — so the weapon is held constant — the ratios
 * land on clean tiers, and two groups carry the whole ladder at once:
 *
 *     AXE_COMBO_1        x2 ×6    x4 ×4    x8 ×4
 *     KATANA_SOUL_BANG   x2 ×53   x4 ×44   x8 ×18
 *
 * One weapon, one attack, three magnitudes. `Critical` alone is x2, a `Vicious`
 * at 3 extra is x4, and both together are x8 — the product. Summing the extras
 * would put that third tier at x5 and taking the larger would never produce it
 * at all, so both of those readings are ruled out by the same 22 hits.
 *
 * This was `Math.max` first, on the reasoning that a single hit crits once. The
 * reasoning was fine and the data disagrees.
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
 * `KNOCKBACK` and `PULL` were called impossible here once, and that was wrong.
 *
 * The reasoning went: the push is drawn by the client from the attack row, the
 * wire carries a flag, `GMModifier` has no `KNOCKBACK_DISTANCE` field, so
 * nothing this server sends can change how far anything goes. Every one of
 * those statements is true and the conclusion does not follow, because the
 * server does not need the client to move a monster — it owns their positions.
 *
 * Looking at the victim rather than the attack settles it. Holding the attack
 * constant and comparing hits that carry the knockback flag against hits that
 * do not: `TRAP_ARROWS`, whose row authors 30, moves its NPC victim a median 27
 * with the flag and 0 without, over 437 and 61 samples; `TRAP_FLAME_JET`,
 * authoring 60, moves it 57 against 5. The official displaces the body and
 * sends the position. This server published the flag and moved nothing.
 *
 * The weapon's part is measured too, in a capture made for it. An account
 * holding `Blowback` (200) and `Blastback` (250) swings an axe whose combos
 * author `Knockback` 0 — and its monsters move anyway: medians of 119, 132 and
 * 82 for `AXE_COMBO_1`, `_3` and `_2`. Nothing in the attack row can account for
 * that. Across the 49 flagged NPC hits in that run the displacement runs to a
 * median of 134, a 75th of 270 and a maximum of 499, which is the neighbourhood
 * of the two distances the account carries.
 *
 * So the modifier's distance drives the push and the attack's own column does
 * not: `KATANA_SOUL_BANG` authors 50 and moves nothing over 6568 flagged hits,
 * because that katana carried no knockback modifier.
 *
 * So all twenty-four are accounted for. Thirteen are this server's and are
 * done; `MANA_COST` and `COOLDOWN_REDUC` were already; six are the client's and
 * work. The last three — `KNOCKBACK`, `PULL` and
 * `BUFF_GRANT_DURATION_MULTIPLIER` — cannot be made to do anything from here,
 * the first two for want of anywhere to act and the third for want of a weapon
 * that may carry it.
 */
export const critRollFor = (gm, weapon, random = Math.random) => {
  const none = { critical: false, multiplier: 1 };
  if (!weapon) return none;

  let multiplier = 1;
  for (const id of [weapon.modifier1, weapon.modifier2]) {
    if (!id) continue;
    const modifier = gm?.modifiersById?.get(Number(id));
    const chance = Number(modifier?.CRIT_CHANCE);
    if (!Number.isFinite(chance) || chance <= 0) continue;
    if (random() >= chance) continue;
    const extra = Number(modifier.CRIT_DAMAGE) || 0;
    // A modifier that rolls a chance without naming any extra damage is not a
    // crit, whatever it rolled; there would be nothing to show for it.
    if (extra > 0) multiplier *= 1 + extra;
  }

  return multiplier > 1 ? { critical: true, multiplier } : none;
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

/**
 * The Battle Chef's own share of the same two rolls.
 *
 * `COOKING` is his second slot and it is not a combat stat: every ordinary
 * column on the row is zero, and its real fields are `HitSpawnBase` 0.01,
 * `HitSpawnIncrease` 0.00125, `DeathSpawnBase` 0.05 and `DeathSpawnIncrease`
 * 0.0025. Its own description says what it is for — "Better chance to make Food
 * when attacking enemies" — and the two doobers it makes are the ones named
 * after him, `FOOD_CHEF_HIT` and `FOOD_CHEF_DEATH`. Nothing on this server read
 * any of it, so a Chef who had spent every point in the stat produced no food
 * at all unless his weapon happened to carry `Saucier` or `Cook's`.
 *
 * It raises a chance rather than creating one, and the caller enforces that: a
 * weapon with no food modifier makes no food, whoever is holding it. This was
 * first written the other way, reading `HitSpawnBase` 0.01 as a standalone 1%.
 *
 * That rests on a report from the live game — a weapon without the modifier
 * makes none — and on the row's own description once the emphasis is put where
 * it belongs: "Better *chance* to make Food when attacking enemies". It does
 * not rest on the captures, and an earlier version of this note said it did.
 * Two of the three that drop chef food looked like a `GHOST_SAMURAI` making
 * food he has no slot for, which would have settled it; both turn out to be
 * parties with a Battle Chef standing in them. Whose food that was is not a
 * question those captures can answer.
 *
 * Small either way: the slot pays 0.1 units a point, so the hit share runs from
 * 1% untrained to about 1.6% at fifty points and the kill share from 5% to
 * 6.3%.
 *
 * Only for a hero whose slots declare the stat. A Berserker has no `COOKING`
 * slot, so the stat does not exist for him and adds nothing.
 *
 * One capture is solo and therefore worth reading: a Battle Chef alone drops
 * food on 28 of 206 hits and 9 of 31 kills — 13.6% and 29%. A weapon carrying
 * two hit modifiers at 6% plus this stat comes to about 13.6%, and a
 * `DEATH_FOOD_5` at 25% plus this stat to about 31%. Both land close, which is
 * some support for adding the two together rather than taking either alone. It
 * is one run, and the equipped weapon cannot be recovered from a capture, so it
 * is offered as an arithmetic that fits and not as a measurement.
 *
 * The other two are parties. Their rates were computed once anyway — 2.5% and
 * 0.2% — by dividing everybody's food by one player's hits, which is not a rate
 * of anything.
 */
const COOKING_SPAWN_COLUMNS = {
  [FOOD_ON_HIT]: ["HitSpawnBase", "HitSpawnIncrease"],
  [FOOD_ON_DEATH]: ["DeathSpawnBase", "DeathSpawnIncrease"],
};

export const cookingFoodChance = (gm, hero, avatar, column) => {
  const columns = COOKING_SPAWN_COLUMNS[column];
  if (!hero || !columns) return 0;
  const declares = [1, 2, 3, 4].some((slot) => hero[`StatUpgrade${slot}`] === "COOKING");
  if (!declares) return 0;

  const row = (gm?.raw?.SuperStats ?? []).find((entry) => entry.Constant === "COOKING");
  if (!row) return 0;

  const [base, increase] = columns;
  const trained = Math.max(0, superStatValue(gm, hero, avatar, "COOKING"));
  return Math.max(0, Number(row[base]) || 0) + trained * (Number(row[increase]) || 0);
};

/**
 * How far a weapon's `KNOCKBACK` or `PULL` modifiers throw what they hit.
 *
 * Absolute rather than added, and the levels say so: `Hitback` through
 * `Blastback` run 50, 100, 150, 200, 250 and `Grabber` through `Trapper` run
 * -100 to -300, which is the same scale the attacks' own `Knockback` column
 * uses — spikes 30, a mace 90, the party bomb 250. A modifier naming 250 is
 * naming the distance, not a bonus on top of one.
 *
 * Negative is a pull. `pushVictim` moves along the line from the attacker, so
 * the sign is the direction, which is the only reading under which those
 * negatives mean anything at all.
 *
 * The larger magnitude wins when a weapon somehow carries both, since one hit
 * throws a body one way.
 */
export const knockbackFor = (gm, weapon) => {
  if (!weapon) return 0;
  let furthest = 0;
  for (const id of [weapon.modifier1, weapon.modifier2]) {
    if (!id) continue;
    const authored = Number(gm?.modifiersById?.get(Number(id))?.KNOCKBACK_DISTANCE);
    if (Number.isFinite(authored) && Math.abs(authored) > Math.abs(furthest)) furthest = authored;
  }
  return furthest;
};

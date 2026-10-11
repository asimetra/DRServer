/**
 * How much health an NPC brings to a floor.
 *
 * Until now this server gave every NPC the flat `HP` from its GameMaster row
 * and told the client its level was 1. Both halves of that were wrong. Take
 * BRUTE: its row is `HP` 30 and `LV_HP_BOOST` 0.3, and `Stats.HP_BOOST.Bonus`
 * is 10. Its health at a level is
 *
 *   HP + (HP_BOOST + LV_HP_BOOST * level^1.5) * 10
 *
 * which is 33 at level 1, 45 at level 3 and 875 at level 43. The exponent is
 * the client's own: `ActorGameObject.refreshStatVector` scales a level by
 * itself for the player team and by its power of one and a half for everybody
 * else.
 *
 * So a hero's stats grow with its level and everything else's with the power of
 * one and a half. Sending level 1 did not merely mislabel the enemy; it made
 * the client derive stats for it that were hundreds of times too small, while
 * this server handed it an unscaled `HP` that agreed with nothing.
 *
 * The party multiplier is the client's too — `NPCGameObject.get_maxHitPoints`
 * multiplies by `GMPlayerScale.HPBoostByPlayers[numHeroes]`: REWARD_CHEST_A is
 * 1.1 / 3.3 / 13.5 at levels 1 / 8 / 25 before the multiplier, and 1 / 5 / 40
 * once one, two and four heroes are accounted for.
 */

/** The client's own exponent, for everything that is not on the player team. */
const ENEMY_LEVEL_EXPONENT = 1.5;

/**
 * The exception the client's rule already contains: the player team (team 5)
 * scales by the level itself.
 *
 * Team 5 is the player team, and it is not only the hero standing on it — the
 * CharType map that decides an NPC's team puts `PET` there too. So a pet's
 * health grows with its level and a monster's with the power of one and a half,
 * from the same line of client code.
 *
 * So WOLF_PET, DRAGON_PET, RHINO_PET and GHOST_SAMURAI_CLONE all take the
 * linear price, and the gap is large: a level 74 wolf is 840 where the
 * exponent would ask for 6465.
 *
 * Read from CharType rather than taken as an argument because every caller
 * already has the row and none of them has the team.
 */
const isOnPlayerTeam = (npc) => npc?.CharType === "PET" || npc?.CharType === "HERO";

/** `Stats` rows carry the multiplier applied to a boost before it reaches HP. */
const bonusFor = (gm, constant) =>
  Number(gm?.raw?.Stats?.find((row) => row.Constant === constant)?.Bonus ?? 1);

/**
 * `PlayerScale` is indexed by party size and its `HP_BOOST` is a multiplier,
 * not a boost. One player is 1, so a solo run is unaffected either way.
 */
const playerScaleFor = (gm, heroes = 1) => {
  const rows = gm?.raw?.PlayerScale ?? [];
  return rows.find((entry) => Number(entry.Players) === Math.max(1, heroes)) ?? rows[0];
};

export const partyHealthMultiplier = (gm, heroes = 1) => {
  const row = playerScaleFor(gm, heroes);
  return Number(row?.HP_BOOST ?? 1) || 1;
};

/** Party scaling for one authored NPC combat stat. */
export const partyStatMultiplier = (gm, heroes = 1, stat) => {
  const value = Number(playerScaleFor(gm, heroes)?.[stat] ?? 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

/**
 * How much tougher an infinite dungeon's monsters are for having got this deep.
 *
 * Every infinite tier sends its NPCs at level 100 — the level column stops
 * there — so a run that goes fifty-five floors down would otherwise put the
 * same monster on every one of them. `InfiniteDungeons` is where the depth
 * goes instead: one row, `HealthGrowth` 0.65, applied to what the level
 * contributed and not to the flat HP. BRUTE at level 100 — `HP` 30,
 * `LV_HP_BOOST` 0.3, so a level term of 3000 — is `30 + 3000 × (1 + 0.65n)`
 * on the nth floor down: 4980 on the first, 22530 on the tenth.
 *
 * Returned as the surcharge (`term + term × 0.65n`) rather than the multiplier
 * (`term × (1 + 0.65n)`); the two differ only in floating-point rounding.
 *
 * `HealthMax` is read as a ceiling on the growth, which is the reading the
 * column name pairs with; it only starts to matter past floor 152.
 */
const infiniteGrowthBonus = (gm, tier, depth, growthField, maximumField) => {
  if (!/_INFINITE$/.test(String(tier?.Constant ?? ""))) return 0;
  const row = (gm?.raw?.InfiniteDungeons ?? [])[0];
  const growth = Number(row?.[growthField] ?? 0);
  if (!(growth > 0)) return 0;
  const ceiling = Number(row?.[maximumField] ?? 0) || Infinity;
  return Math.min(ceiling, growth * Math.max(0, depth));
};

export const infiniteDepthBonus = (gm, tier, depth = 1) =>
  infiniteGrowthBonus(gm, tier, depth, "HealthGrowth", "HealthMax");

/** Extra NPC offence on an Infinite floor, separate from health growth. */
export const infiniteDamageBonus = (gm, tier, depth = 1) =>
  infiniteGrowthBonus(gm, tier, depth, "DamageGrowth", "DamageMax");

/**
 * The health the client expects for this NPC at this level.
 *
 * Rows with no `LV_HP_BOOST` do not scale at all — the smash statues read 60
 * and 80 at every level from 1 to 100 — and they fall out of the same formula
 * rather than needing a case of their own.
 */
export const npcMaxHitPoints = (gm, npc, level = 1, heroes = 1, depthBonus = 0) => {
  const flat = Number(npc?.HP ?? 0);
  // Zero-HP rows are indestructible scenery. Scaling them would give a gate a
  // health bar, so they stay exactly zero.
  if (!(flat > 0)) return 0;

  const base = Number(npc?.HP_BOOST ?? 0);
  const perLevel = Number(npc?.LV_HP_BOOST ?? 0);
  const at = Math.max(1, level);
  const scaled = base + perLevel * (isOnPlayerTeam(npc) ? at : Math.pow(at, ENEMY_LEVEL_EXPONENT));
  const term = scaled * bonusFor(gm, "HP_BOOST");
  const levelled = term + term * (Number(depthBonus) || 0);
  const total = (flat + levelled) * partyHealthMultiplier(gm, heroes);
  return Math.max(1, Math.floor(total));
};

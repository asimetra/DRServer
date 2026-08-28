/**
 * How much health an NPC brings to a floor.
 *
 * Until now this server gave every NPC the flat `HP` from its GameMaster row
 * and told the client its level was 1. Both halves of that were wrong, and the
 * official's own recordings say so plainly. Take BRUTE, which appears at six
 * different levels across the corpus:
 *
 *   level    1     3     43    45    53
 *   hp      33    45   875   935  1187
 *
 * Its row is `HP` 30 and `LV_HP_BOOST` 0.3, and `Stats.HP_BOOST.Bonus` is 10.
 * Every one of those five numbers is
 *
 *   HP + (HP_BOOST + LV_HP_BOOST * level^1.5) * 10
 *
 * to the unit. The exponent is not a guess either — it is written down in the
 * client, `ActorGameObject.refreshStatVector`:
 *
 *   var scale = mTeam == 5 ? mLevel : Math.pow(mLevel, 1.5);
 *   stats = baseValues + levelValues * scale;
 *
 * so a hero's stats grow with its level and everything else's with the power of
 * one and a half. Sending level 1 did not merely mislabel the enemy; it made
 * the client derive stats for it that were hundreds of times too small, while
 * this server handed it an unscaled `HP` that agreed with nothing.
 *
 * The party multiplier is the client's too — `NPCGameObject.get_maxHitPoints`
 * multiplies by `GMPlayerScale.HPBoostByPlayers[numHeroes]` — and it is what
 * closes the last gap in the fit: REWARD_CHEST_A reads 1 / 5 / 40 at levels
 * 1 / 8 / 25, which is 1.1 / 3.3 / 13.5 before the multiplier and lands on the
 * observed values once one, two and four heroes are accounted for.
 */

/** The client's own exponent, for everything that is not on the player team. */
const ENEMY_LEVEL_EXPONENT = 1.5;

/**
 * The exception the line above already contains: `mTeam == 5 ? mLevel : ...`.
 *
 * Team 5 is the player team, and it is not only the hero standing on it — the
 * CharType map that decides an NPC's team puts `PET` there too. So a pet's
 * health grows with its level and a monster's with the power of one and a half,
 * from the same line of client code.
 *
 * The corpus has no dissenter. Sixty pet generates across WOLF_PET, DRAGON_PET,
 * RHINO_PET and GHOST_SAMURAI_CLONE are all the linear price and none is the
 * exponent, and the gap is not something a rounding argument could cover: a
 * level 74 wolf reads 840 where the exponent asks for 6465.
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
export const partyHealthMultiplier = (gm, heroes = 1) => {
  const rows = gm?.raw?.PlayerScale ?? [];
  const row =
    rows.find((entry) => Number(entry.Players) === Math.max(1, heroes)) ?? rows[0];
  return Number(row?.HP_BOOST ?? 1) || 1;
};


/**
 * How much tougher an infinite dungeon's monsters are for having got this deep.
 *
 * Every infinite tier sends its NPCs at level 100 — the level column stops
 * there — so a run that goes fifty-five floors down would otherwise put the
 * same monster on every one of them. `InfiniteDungeons` is where the depth
 * goes instead: one row, `HealthGrowth` 0.65, and the corpus is unambiguous
 * about how it is applied. BRUTE at level 100 appears at
 *
 *   4980  6930  8879  10830  12780  14729  16680  18630  20580  22530
 *
 * and its row is `HP` 30, `LV_HP_BOOST` 0.3, so its level term is 3000 flat.
 * Every one of those is `30 + 3000 × (1 + 0.65n)` for n = 1…10 — the flat HP
 * is left alone and the growth multiplies only what the level contributed.
 * The populations fall away with depth exactly as players do: 125 sightings at
 * n=1, 52 at n=2, 55 at n=3, down to 10 at n=10.
 *
 * Eight of those ten land to the unit. Floors three and six come out one point
 * of health high, and no association of the multiply reproduces it — the
 * official's own arithmetic loses a unit somewhere this cannot see from
 * outside. Returned as the surcharge rather than the multiplier because
 * `term + term × 0.65n` matches the recordings at floor two where
 * `term × (1 + 0.65n)` does not, and that is the only place the two differ.
 *
 * `HealthMax` is read as a ceiling. Nothing in 54 captures reaches floor
 * eleven, so the corpus cannot say whether it caps the growth or the depth
 * feeding it; this is the reading the column name pairs with, and it only
 * starts to matter past floor 152.
 */
export const infiniteDepthBonus = (gm, tier, depth = 1) => {
  if (!/_INFINITE$/.test(String(tier?.Constant ?? ""))) return 0;
  const row = (gm?.raw?.InfiniteDungeons ?? [])[0];
  const growth = Number(row?.HealthGrowth ?? 0);
  if (!(growth > 0)) return 0;
  const ceiling = Number(row?.HealthMax ?? 0) || Infinity;
  return Math.min(ceiling, growth * Math.max(0, depth));
};

/**
 * The health the official would have sent for this NPC at this level.
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

/**
 * Hero levels and the stat points they earn.
 *
 * The client works both out from GameMaster's `Leveling` table, so this mirrors
 * it exactly rather than approximating a curve. The table has one row per level
 * with a `StatPoints` column and one experience column per hero constant, and
 * the client accumulates down it (GameMaster.hx, LoadingOnly_addExpRecord):
 *
 *   experience[i]     = running sum of the hero's column, minus one
 *   totalStatPoints[i]= running sum of StatPoints
 *
 * A row is skipped entirely when the hero's column is zero, which is how a hero
 * can have a shorter ladder than another. Lookup is "the first row whose
 * experience is at or above the amount held", clamped to the last row — a
 * binary search in the client, a scan here, same answer.
 *
 * As shipped every row grants 2 points across 100 levels, so a maxed hero has
 * 200 to spend. Nothing here hard-codes that; it is read from the table.
 */

/** No single stat can be raised past this. The training screen enforces it too. */
export const STAT_CAP = 75;

/** statupgrade1..4 on the avatar row. */
export const STAT_SLOTS = 4;

const tables = new WeakMap();

const levelTable = (gm, hero) => {
  let byHero = tables.get(gm);
  if (!byHero) tables.set(gm, (byHero = new Map()));

  const cached = byHero.get(hero.Constant);
  if (cached) return cached;

  let experience = 0;
  let statPoints = 0;
  const table = [];
  for (const row of gm.raw.Leveling) {
    const cost = Number(row[hero.Constant] ?? 0);
    if (!cost) continue;
    experience += cost;
    statPoints += Number(row.StatPoints ?? 0);
    table.push({ level: Number(row.Level), experience: experience - 1, statPoints });
  }

  byHero.set(hero.Constant, table);
  return table;
};

const rowFor = (gm, hero, experience) => {
  const table = levelTable(gm, hero);
  return table.find((row) => row.experience >= experience) ?? table[table.length - 1];
};

export const heroLevel = (gm, hero, experience = 0) => rowFor(gm, hero, experience)?.level ?? 1;

/** Every point the hero has ever earned, spent or not. */
export const statPointsEarned = (gm, hero, experience = 0) =>
  rowFor(gm, hero, experience)?.statPoints ?? 0;

/** The highest level this hero's ladder goes to. */
export const maxLevel = (gm, hero) => {
  const table = levelTable(gm, hero);
  return table[table.length - 1]?.level ?? 1;
};

/**
 * The least experience that reads as the given level.
 *
 * The lookup takes the first row at or above the amount held, so landing exactly
 * on the previous row's total is what tips it over: one point past the boundary
 * would still be the same level, and one short would be the level below.
 */
export const experienceForLevel = (gm, hero, level) => {
  const table = levelTable(gm, hero);
  const index = Math.min(Math.max(Math.trunc(level), 1), table.length) - 1;
  return index === 0 ? 0 : table[index - 1].experience + 1;
};

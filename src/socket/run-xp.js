/**
 * What a kill is worth on this run.
 *
 * A monster's row says how it compares with the others — `XP` is 1, 3 or 10 —
 * and the map node says what the whole dungeon pays, in `TotalEnemyXP`. Neither
 * is an amount on its own. The official shares the second out by the first, up
 * front: one unit of weight is the node's total over everything the run will
 * ever put on its floors, the monsters its generators have yet to make
 * included.
 *
 * Measured on its best-explored floors, where the client had seen nearly
 * everything the server counted:
 *
 *   node     TotalEnemyXP  floors  weight seen  a unit, paid   predicted
 *   50078    4665          1       243          19.04          19.20
 *   50081    4820          2       319           7.64           7.55
 *   50081    4820          2       266           9.05           9.06
 *   Infinite 50000         55      ~106          8.57           8.58
 *   50002    55            2       ~90           0.6            0.61
 *
 * The last line is the tutorial and it is the one that shows the method. Its
 * 55 is less than its monsters weigh, and the official does not pay fractions
 * of a point: each monster's share is rounded to a whole number, up or down by
 * chance in proportion to the fraction. At 0.6 a knight is worth 1 six times in
 * ten and nothing the other four — and a monster worth nothing drops no star.
 * 242 recorded tutorial kills dropped one, 168 did not, mixed together from the
 * first kill to the last; every star that dropped paid exactly 1 and the
 * minotaur's, weighing ten, paid 6. The same rounding is on every other node:
 * at 9.16 a unit the small stars paid 9 thirty-nine times and 10 seven, at
 * 24.2 they paid 24 and 25.
 *
 * So nothing is ever cut off for having come late. A run that is worth less
 * than its monsters simply has some that carry nothing, spread evenly.
 *
 * The unit is settled once, on the first floor that holds anything, and kept:
 * both floors of each recorded two-floor run paid alike though they held
 * different monsters, and five Infinite floors running paid 8.48 to 8.80. The
 * official can price a run exactly, having every floor before the first is
 * entered; this server counts the floor in hand and takes the floors still to
 * come from their plan.
 *
 * Not modelled: a party. `PlayerScale.Exp` authors +10% a head and the two
 * party recordings that could be read fit it, which is too few to pin it.
 */

/**
 * A row's share of the floor: its `XP`, if it names a star and is worth
 * experience at all.
 *
 * `Exp` is the last of those and it is not decoration. The princess, her
 * barricades and her orbs carry `XP` 1 and a star's name with `Exp` 0 — they
 * are what a party defends, and without this a defence map was priced by its
 * own furniture. Every monster the official was recorded dropping a star for
 * has all three.
 */
export const xpWeightOf = (npc) => {
  const weight = Number(npc?.XP);
  const worthAnything = Number(npc?.Exp) > 0;
  return npc?.XP_DOOBER_VISUAL && worthAnything && Number.isFinite(weight) && weight > 0
    ? weight
    : 0;
};

/** A new run has no price until its first floor has been counted. */
export const beginRunXp = (session) => {
  session.runXp = { weight: 0, unit: null };
  return session.runXp;
};

/** One monster placed while a floor is being built. */
export const countFloorXp = (session, npc) => {
  const plan = session.runXp;
  if (!plan || plan.unit !== null || session.floorSettled) return;
  plan.weight += xpWeightOf(npc);
};

/**
 * The floor is built; if it is the first to hold anything, it prices the run.
 *
 * `fromGenerators` is what this floor's generators will go on to make, which
 * belongs in the count as much as what is already standing: the tutorial's
 * 0.6 only comes out with its thirty-four generator spawns in it.
 *
 * `elsewhere` is what the run's other floors are expected to weigh. Left out,
 * each is taken to weigh what this one does, which is right for floors laid out
 * from one tier and one quota and wrong for an authored map — a boss floor
 * holds the boss and little else.
 *
 * A floor that holds nothing and makes nothing settles nothing, and the next
 * one is counted afresh.
 */
export const settleFloorXp = (session, elsewhere, fromGenerators = 0) => {
  const plan = session.runXp;
  if (!plan || plan.unit !== null) return plan?.unit ?? null;

  const total = Number(session.mapPage?.TotalEnemyXP);
  const floors = Math.max(1, Math.trunc(Number(session.floorCount) || 1));
  plan.weight += Math.max(0, Number(fromGenerators) || 0);
  if (plan.weight > 0 && Number.isFinite(total) && total > 0) {
    const rest = Number.isFinite(elsewhere) ? Math.max(0, elsewhere) : plan.weight * (floors - 1);
    plan.unit = total / (plan.weight + rest);
  } else {
    plan.weight = 0;
  }
  return plan.unit;
};

/**
 * This monster's exact share, or undefined where the run has no price — a node
 * that authors no total, or a session that never counted a floor.
 */
export const xpWorthOf = (session, npc) => {
  const unit = session.runXp?.unit;
  const weight = xpWeightOf(npc);
  return Number.isFinite(unit) && weight > 0 ? weight * unit : undefined;
};

/**
 * The star for one kill: the share as a whole number of points.
 *
 * Rounded up or down by chance, in proportion to the fraction, so that the
 * shares still add up to the node over a run. A share that rounds to nothing is
 * a kill with no star — see the tutorial, above.
 *
 * Returns the points, `null` for no star, or undefined where the run has no
 * price and the star falls back to its own column.
 */
export const claimXpStar = (session, npc, random = Math.random) => {
  const worth = xpWorthOf(session, npc);
  if (worth === undefined) return undefined;

  const whole = Math.floor(worth);
  const points = whole + (random() < worth - whole ? 1 : 0);
  return points > 0 ? points : null;
};

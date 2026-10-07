/**
 * Elo, as MCSR Ranked runs it (https://wiki.mcsrranked.com/gameplay/elo_and_ranks):
 * a race between equals moves each player 20, and the gap between two ratings
 * decides how far a result moves them — an upset across a wide gap moves the
 * most, beating somebody far below moves almost nothing. No step is ever more
 * than K.
 *
 * This replaced Glicko-2, whose first races moved a newcomer by ±160: right in
 * the rating's own terms, how unsure it was, and absurd to read beside a league
 * that is a few hundred points wide.
 *
 * Nothing here is stored. A rating is what the match log says it is —
 * `replayRatings` turns the log into ratings — so voiding a match, resetting a
 * season or changing K is a recalculation and never a migration.
 */

/**
 * The scale, and the operator's three knobs on it (`ranked.rating` in the
 * configuration): where everybody starts, how far one race can move a rating,
 * and the least anybody falls to. What matters between them is the ratio of
 * the start to K: it says how many losses in a row reach the floor, where a
 * loss costs the loser less than the winner gains and the scale starts to
 * inflate. The defaults keep the floor out of practical reach — a hundred net
 * losses against equals from the start — and read like chess ratings.
 */

/** How far one race can move a rating; equals move K/2. MCSR Ranked's standard 20 is K = 40. */
export const K = 40;

/** Where everybody starts, in the first league (leagues.js). */
export const START = 1000;

/**
 * Nobody goes below this, as a League of Legends tier floors at 0 LP: a run of
 * losses ends at the bottom of the first league rather than under it.
 */
export const FLOOR = 100;

export const NEW_PLAYER = Object.freeze({ rating: START });

/** The rules as given, with the defaults for what is not, checked. */
export const ratingRules = ({ start = START, k = K, floor = FLOOR } = {}) => {
  if (![start, k, floor].every(Number.isFinite)) throw new Error("ranked rating: start, k and floor must be numbers");
  if (!(k > 0)) throw new Error("ranked rating: k must be above 0");
  if (floor > start) throw new Error("ranked rating: the floor cannot be above the start");
  return Object.freeze({ start, k, floor });
};

/** A player who has not raced yet. */
export const newPlayer = (rules) => ({ rating: ratingRules(rules).start });

/** How likely `rating` is to beat `opponent`: 200 points is three to one, 400 is ten to one. */
export const expectedScore = (rating, opponent) => 1 / (1 + 10 ** ((opponent - rating) / 400));

/**
 * Both players after one race. `score` is the first player's: 1, 0.5 or 0. One
 * whole-number step, given to one and taken from the other, so ratings stay
 * whole and only the floor ever makes a race give more than it takes.
 */
export const rateMatch = (first, second, score, rules) => {
  const { k, floor } = ratingRules(rules);
  const step = Math.round(k * (score - expectedScore(first.rating, second.rating)));
  return {
    first: { rating: Math.max(floor, first.rating + step) },
    second: { rating: Math.max(floor, second.rating - step) },
  };
};

/** How a rating is shown: the number, which is also what a board sorts by. */
export const displayRating = ({ rating }) => ({ rating: Math.round(rating) });

/** A board's order, `{ accountId, rating, games }` rows: the rating, then more races, then the older account. */
export const byStanding = (a, b) => b.rating - a.rating || b.games - a.games || Number(a.accountId) - Number(b.accountId);

/**
 * Every player's rating from the match log, oldest match first.
 *
 * Only finished matches count. A cancelled pairing never started, and a void
 * one ended for a reason that was nobody's doing; neither moves a rating.
 */
export const replayRatings = (matches, rules) => {
  const ratings = new Map();
  const current = (id) => ratings.get(id) ?? { ...newPlayer(rules), games: 0 };
  for (const match of matches) {
    if (match?.state !== "finished") continue;
    const [a, b] = match.players;
    const score = match.winner == null ? 0.5 : match.winner === a ? 1 : 0;
    const before = { a: current(a), b: current(b) };
    const { first, second } = rateMatch(before.a, before.b, score, rules);
    ratings.set(a, { ...first, games: before.a.games + 1 });
    ratings.set(b, { ...second, games: before.b.games + 1 });
  }
  return ratings;
};

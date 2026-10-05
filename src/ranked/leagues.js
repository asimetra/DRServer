/**
 * Ranked leagues: names over the board (docs/ranked.md, "Leagues").
 *
 * All but the last are bands of the rating, each from a number up. The last
 * may instead be a share of the board — `top: 0.03`, the best three in a
 * hundred — among those in the band under it, the way Valorant's Radiant is
 * its top 500 and League of Legends' Challenger its top 300. A fixed edge
 * cannot hold a share: Elo ratings spread the longer a community plays, so an
 * edge that three in a hundred reach after fifty races is reached by eleven
 * after two hundred. The cost is the same as theirs — the top league can be
 * lost without playing, by somebody else passing.
 *
 * Pairing still goes by the rating alone. Everybody starts at 1000 (rating.js,
 * START), in the first league; the edges here go with that scale. The names are the game's own chest tiers
 * and the colours are taken from the chests' art.
 */

export const DEFAULT_LEAGUES = Object.freeze([
  Object.freeze({ name: "Wooden", from: 0, color: "#A0703C" }),
  Object.freeze({ name: "Silver", from: 1050, color: "#5B8FD9" }),
  Object.freeze({ name: "Gold", from: 1200, color: "#E8B830" }),
  Object.freeze({ name: "Dragon", top: 0.03, color: "#9B59D0" }),
]);

const NAME = /^[A-Za-z][A-Za-z ]{0,15}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The leagues a configuration names, checked: a name of letters, a `#rrggbb`
 * colour, and a starting rating each higher than the last — or, for the last
 * alone, a `top` share of the board between 0 and 1. Anything wrong throws,
 * with what.
 */
export const parseLeagues = (list) => {
  if (!Array.isArray(list) || !list.length) throw new Error("leagues must be a non-empty list");
  return Object.freeze(
    list.map((league, i) => {
      const { name, from, top, color } = league ?? {};
      const last = i === list.length - 1;
      if (typeof name !== "string" || !NAME.test(name)) throw new Error(`league ${i + 1} needs a name of letters`);
      if (typeof color !== "string" || !COLOR.test(color)) throw new Error(`league "${name}" needs a #rrggbb colour`);
      if (top !== undefined) {
        if (!last || i === 0) throw new Error(`league "${name}": only the last league, above another, can be a share of the board`);
        if (!(Number.isFinite(top) && top > 0 && top < 1)) throw new Error(`league "${name}" needs a share between 0 and 1`);
        return Object.freeze({ name, top, color });
      }
      if (!Number.isFinite(from)) throw new Error(`league "${name}" needs a number to start from`);
      if (i > 0 && from <= list[i - 1].from) throw new Error(`league "${name}" must start above "${list[i - 1].name}"`);
      return Object.freeze({ name, from, color });
    })
  );
};

/** The configured leagues, or the defaults when none are configured. */
export const leaguesOf = (configured) => (configured == null ? DEFAULT_LEAGUES : parseLeagues(configured));

const bandsOf = (leagues) => leagues.filter((league) => league.top === undefined);

/** The band a rating is in: the last whose start it has reached, or the first. */
export const leagueOf = (rating, leagues = DEFAULT_LEAGUES) => {
  const bands = bandsOf(leagues);
  return [...bands].reverse().find((league) => Number(rating) >= league.from) ?? bands[0];
};

/** How many of `of` players on the board a share league holds. */
export const placesIn = (league, of) => Math.round(Number(of) * league.top);

/**
 * The league of somebody standing at `place` of `of` on the board with this
 * rating: the share league if they are within its places and in the band under
 * it, their band otherwise. No place — not on the board yet — is a band.
 */
export const leagueAt = ({ rating, place, of }, leagues = DEFAULT_LEAGUES) => {
  const band = leagueOf(rating, leagues);
  const last = leagues.at(-1);
  if (last.top === undefined || !place) return band;
  return place <= placesIn(last, of) && band === leagues.at(-2) ? last : band;
};

/**
 * The league above this standing: the next band and where it starts, or the
 * share league and its share; null at the top.
 */
export const nextLeague = (standing, leagues = DEFAULT_LEAGUES) => {
  const at = leagues.indexOf(leagueAt(standing, leagues));
  const next = leagues[at + 1];
  if (!next) return null;
  return next.top === undefined ? { league: next.name, from: next.from } : { league: next.name, top: next.top };
};

/** Higher or lower: where two leagues stand in the list. */
export const leagueRank = (league, leagues = DEFAULT_LEAGUES) => leagues.indexOf(league);

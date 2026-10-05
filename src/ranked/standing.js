/**
 * Where a player stands in ranked, read from the match log the way the service
 * reads it at start (rating.js, replayRatings). That gives the same answer on
 * every thread — the ranked service lives on one, a player asking may be in a
 * dungeon on another — and keeps one store, the log, with nothing to drift.
 */
import { config } from "../config.js";
import { leagueAt, leaguesOf, nextLeague } from "./leagues.js";
import { byStanding, displayRating, newPlayer, ratingRules, replayRatings } from "./rating.js";
import { createRecords } from "./records.js";

/** A rating as it is shown, with the league its place on the board puts it in. */
const shown = (rating, { place, of }, leagues) => {
  const display = displayRating(rating);
  const league = leagueAt({ rating: display.rating, place, of }, leagues);
  return { ...display, league: league.name, color: league.color };
};

/**
 * The board as the service sorts it (index.js, board), and each player's
 * place, league and record on it.
 */
export const standingsFrom = (
  matches,
  { leagues = leaguesOf(config.ranked?.leagues), rating = ratingRules(config.ranked?.rating) } = {}
) => {
  const rated = [...replayRatings(matches, rating).entries()]
    .filter(([, rating]) => rating.games > 0)
    .map(([accountId, rating]) => ({ accountId: Number(accountId), games: rating.games, rating: rating.rating }))
    .sort(byStanding);
  const board = rated.map((row, index) => ({
    ...row,
    ...shown(row, { place: index + 1, of: rated.length }, leagues),
  }));

  const tally = new Map();
  for (const match of matches) {
    if (match?.state !== "finished") continue;
    for (const id of match.players.map(Number)) {
      const count = tally.get(id) ?? { won: 0, lost: 0, drawn: 0 };
      if (match.winner == null) count.drawn += 1;
      else if (Number(match.winner) === id) count.won += 1;
      else count.lost += 1;
      tally.set(id, count);
    }
  }

  // Where each player sits, so a page of the board asks after each row in turn.
  const indexOf = new Map(board.map((row, index) => [row.accountId, index]));

  return {
    board,
    /** `place` is null for somebody who has not finished a race yet. */
    of: (accountId) => {
      const id = Number(accountId);
      const index = indexOf.get(id) ?? -1;
      const row = index >= 0 ? board[index] : { accountId: id, games: 0, ...shown(newPlayer(rating), { place: null, of: board.length }, leagues) };
      return { ...row, place: index >= 0 ? index + 1 : null, of: board.length, ...(tally.get(id) ?? { won: 0, lost: 0, drawn: 0 }) };
    },
  };
};

/**
 * A rating as the lines show it. Only the number: there is no placement, so
 * nothing marks one as not yet settled — a league is earned from the first race.
 */
export const shownRating = ({ rating }) => `${rating}`;

/**
 * "Silver 640, #2 of 5" — or, before a first finished race, no place yet — in
 * the effect book's words (`part`, ui-effects.js `bookWords`).
 */
export const placeLine = (standing, part) =>
  part(standing.place ? "standing.placed" : "standing.unplaced", {
    league: standing.league,
    rating: shownRating(standing),
    place: standing.place,
    of: standing.of,
  });

/**
 * The /rank answer: the caller's line, then the top of the board with names,
 * in the book's words. One message of two lines — the chat log keeps fifty
 * entries, not fifty lines.
 */
export const rankReply = async ({ standings, accountId, nameOf, part, top = 3 }) => {
  const me = standings.of(accountId);
  const record = me.games
    ? part(me.games === 1 ? "rank.record.one" : "rank.record.many", {
      games: me.games,
      won: me.won,
      lost: me.lost,
      drawn: me.drawn ? part("rank.drawn", { drawn: me.drawn }) : "",
    })
    : "";
  const lines = [part("rank.own", { standing: placeLine(me, part), record })];
  const leaders = standings.board.slice(0, top);
  if (leaders.length) {
    const names = await Promise.all(
      leaders.map((row) => (row.accountId === Number(accountId) ? part("rank.you") : nameOf(row.accountId)))
    );
    const board = leaders.map((row, i) =>
      part("rank.leader", { place: i + 1, name: names[i], league: row.league, rating: shownRating(row) })
    );
    lines.push(part("rank.top", { leaders: board.join(part("rank.between")) }));
  }
  return lines.filter(Boolean).join("\n");
};

/**
 * What a page or a client is told of one player's standing: the league and its
 * colour, the number, the place and the record, and the next league up — what
 * the website's profile and board draw, and a mod's title (docs/ranked.md).
 */
export const publicStanding = (standing, leagues = leaguesOf(config.ranked?.leagues)) => {
  const next = nextLeague(standing, leagues);
  return {
    league: standing.league,
    color: standing.color,
    rating: standing.rating,
    place: standing.place,
    of: standing.of,
    games: standing.games,
    won: standing.won,
    lost: standing.lost,
    drawn: standing.drawn,
    // `{ league, from }` for a band, `{ league, top }` for a share of the board; null at the top.
    next,
  };
};

/** The server's own log, opened once per thread. */
let serverRecords = null;
const logRecords = () => (serverRecords ??= createRecords({ storage: config.storage, dataDir: config.dataDir }));

/**
 * records -> { version, standings }. Every profile, board read and /rank asks,
 * and replaying the whole log for each grows with every race ever played; the
 * log only grows, so the board is replayed again only once it has. The version
 * is read before the log, so a match added in between is caught next time.
 */
const replayed = new WeakMap();

export const readStandings = async (records = logRecords()) => {
  const version = await records.version?.();
  const kept = replayed.get(records);
  if (kept && version != null && kept.version === version) return kept.standings;
  const standings = standingsFrom(await records.all());
  if (version != null) replayed.set(records, { version, standings });
  return standings;
};

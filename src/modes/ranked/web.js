/**
 * What ranked adds to the server's HTTP side (src/modes/web.js): the caller's
 * own standing for a client that shows it, the board for the website, and the
 * standing on every profile. Registered whether ranked runs or not, so a page
 * is told "off" rather than "not found" — the URLs are the website's to rely on.
 */
import { addModeRoute, addProfileField } from "../web.js";
import { playerName } from "../players.js";
import { warn } from "../../log.js";
import { leaguesOf } from "./leagues.js";
import { rankedSettings } from "./settings.js";
import { publicStanding, readStandings } from "./standing.js";

/** The most rows one board read may ask for. */
const RANKED_BOARD_MOST = 500;

/**
 * GET /api/ranked/standing — the caller's own ranked league, rating, place and
 * record, as the website's profile has them. For a client that shows them
 * itself — a mod's title in town (docs/ranked.md, "The modded-client adapter").
 */
const ownStanding = async ({ accountId }) => {
  if (!rankedSettings.enabled) return { status: 404, body: { error: "ranked races are off on this server" } };
  return { body: publicStanding((await readStandings()).of(accountId)) };
};

/**
 * GET /internal/v1/ranked/board?limit=100 — the ranked board, best first: each
 * player's name, league, rating, place and record, and the leagues themselves
 * for a page to draw a key with. Names and not account ids, as on a profile.
 */
const board = async ({ query }) => {
  // A band has `from`; the top league may instead be a share of the board, `top`.
  const leagues = leaguesOf(rankedSettings.leagues).map(({ name, from, top, color, mark }) => ({ name, from, top, color, mark }));
  if (!rankedSettings.enabled) return { body: { enabled: false, leagues, players: [] } };
  const asked = Number(query?.get("limit") ?? 100);
  const limit = Math.min(RANKED_BOARD_MOST, Math.max(1, Number.isInteger(asked) ? asked : 100));
  let standings;
  try {
    standings = await readStandings();
  } catch (problem) {
    warn(`ranked: the board cannot be read: ${problem.message}`);
    return { status: 503, body: { error: "the ranked board cannot be read right now" } };
  }
  const rows = standings.board.slice(0, limit);
  const names = await Promise.all(rows.map((row) => playerName(row.accountId)));
  return {
    body: {
      enabled: true,
      leagues,
      players: rows.map((row, i) => ({ name: names[i], ...publicStanding(standings.of(row.accountId)) })),
    },
  };
};

/**
 * One player's standing for their profile, or null: where ranked is off, and
 * where its log cannot be read — a ranked fault is not a profile fault.
 */
const profileStanding = async (accountId) => {
  if (!rankedSettings.enabled) return null;
  try {
    return publicStanding((await readStandings()).of(accountId));
  } catch (problem) {
    warn(`ranked: no standing for ${accountId}'s profile: ${problem.message}`);
    return null;
  }
};

/** Puts ranked's routes and profile field up; returns a function that takes them down. */
export const installRankedWeb = () => {
  const undo = [
    addModeRoute({ side: "public", method: "GET", pattern: "/api/ranked/standing", handler: ownStanding }),
    addModeRoute({ side: "internal", method: "GET", pattern: "/internal/v1/ranked/board", handler: board }),
    addProfileField("ranked", profileStanding),
  ];
  return () => undo.forEach((step) => step());
};

/**
 * Ranked's settings (docs/ranked.md): the config file's "ranked" section,
 * with ODS_RANKED_* overrides. Off unless asked for: ODS_RANKED=1. The rest
 * has the defaults the design settled on; the lobby node must be one the stock
 * client's own game data has, and the lobby floor one of its own tile files,
 * or the client cannot build them.
 *
 * Read by ranked alone (src/modes/settings.js): the core keeps no setting of
 * any mode's.
 */
import { modeSettings } from "../settings.js";

/** The settings from a config file section and an environment: for a test, or the server's own below. */
export const readRankedSettings = (environment = process.env) => {
  const { file, env, int } = modeSettings("ranked", environment);
  return {
    enabled:
      env("RANKED") === undefined
        ? Boolean(file.enabled)
        : env("RANKED") === "1",
    lobbyNode: int("RANKED_LOBBY_NODE", file.lobbyNode ?? 50003),
    lobbyFloor: env("RANKED_LOBBY_FLOOR") ??
      file.lobbyFloor ?? "castle/arena/db_floor_TUTORIAL_LEVEL_final.json",
    nodeTypes: file.nodeTypes ?? ["DUNGEON"],
    exclude: file.exclude ?? [],
    countdownMs: int("RANKED_COUNTDOWN_MS", file.countdownMs ?? 5_000),
    lobbyIdleMs: int("RANKED_LOBBY_IDLE_MS", file.lobbyIdleMs ?? 300_000),
    maxDurationMs: int("RANKED_MAX_DURATION_MS", file.maxDurationMs ?? 1_800_000),
    forfeitWindowMs: int("RANKED_FORFEIT_WINDOW_MS", file.forfeitWindowMs ?? 120_000),
    drawWindowMs: int("RANKED_DRAW_WINDOW_MS", file.drawWindowMs ?? 5_000),
    loadTimeoutMs: int("RANKED_LOAD_TIMEOUT_MS", file.loadTimeoutMs ?? 120_000),
    /**
     * Where in the lobby standing means waiting for a race, in floor
     * coordinates; outside it are the stands, for talking. Its edge is drawn
     * in skull piles (ranked/stock-client/ring.js). Belongs to the lobby
     * floor: the default is a square around the tutorial arena's pillar,
     * so another lobby floor needs its own, or null for "anywhere is the
     * ring" and no piles.
     */
    ring: file.ring === undefined ? { x0: 3830, y0: 3653, x1: 4270, y1: 4093 } : file.ring,
    /**
     * Where heroes arrive in the lobby: outside the ring, or arriving would
     * be queueing. The default is between the ring's way in and the arena's
     * south gate. Null keeps the floor's own spawn.
     */
    lobbySpawn: file.lobbySpawn === undefined ? { x: 4050, y: 4200 } : file.lobbySpawn,
    /**
     * Tiles of the lobby floor's own library to stand in place of the file's,
     * `[{ x, y, tileId }]` (floors.js, loadFloor). The default puts the
     * arena's two forest fillers on every neighbour but the north one, whose
     * lower half is the arena's own gate yard; empty keeps the file's.
     */
    lobbyTiles: file.lobbyTiles ?? [],
    /**
     * The leagues, `[{ name, from, color }]` in rising order (ranked/leagues.js):
     * labels over bands of the rating, the first where everybody starts.
     * Unset, the defaults there — MCSR Ranked's bands, named for the game's
     * chest tiers.
     */
    leagues: file.leagues ?? null,
    /**
     * How many of the others waiting each lobby shows, as nameless copies of
     * their heroes (ranked/stock-client/copies.js); the first to arrive
     * first. 0 shows nobody: every lobby is its own world again.
     */
    lobbyCopies: Math.max(0, int("RANKED_LOBBY_COPIES", file.lobbyCopies ?? 8)),
    /**
     * The rival's ghost in a race (ranked/stock-client/adapter.js): drawn
     * with one of the game's buffs as a shade (`buff`, a Buff constant;
     * SHADOW_SLOW is a dark, pulsing one), under `name`, and shown to whoever
     * entered the room first, for `showMs` after the other came in; two
     * entering within `graceMs` see nothing of each other. Null draws no
     * ghost.
     */
    raceGhost:
      file.raceGhost === undefined
        ? { buff: "SHADOW_SLOW", name: "RIVAL", graceMs: 2000, showMs: 3000 }
        : file.raceGhost,
    /** Whether the two racers hear each other's chat. */
    raceChat: file.raceChat !== false,
    /**
     * Who may enter ranked: a least level for the active hero, and the
     * tutorial done. Both off by default — the bar an operator raises when
     * throwaway accounts start trading wins.
     */
    entry: {
      minHeroLevel: Math.max(0, int("RANKED_MIN_HERO_LEVEL", file.entry?.minHeroLevel ?? 0)),
      requireTutorial:
        env("RANKED_REQUIRE_TUTORIAL") === undefined
          ? file.entry?.requireTutorial === true
          : env("RANKED_REQUIRE_TUTORIAL") === "1",
    },
    /**
     * What a race pays, as a gift from MATCHMAKER waiting in town: an offer
     * id (`Offers` in the game data — 51101 is 1000 coins, 51102 3500, 51103
     * 8000) per league name, `"*"` for the rest, under `win` and `loss`.
     * Null pays nothing. The run itself pays no experience or chest
     * (`src/socket/run-rules.js`); this is the prize, and the only reward a
     * loser gets, so it is small.
     */
    rewards:
      file.rewards === undefined
        ? { win: { "*": 51101, Gold: 51102, Dragon: 51103 }, loss: { "*": 51101 } }
        : file.rewards,
    /**
     * The rating scale (ranked/rating.js): where everybody starts, the most
     * one race moves a rating, and the least anybody falls to. The leagues'
     * edges go with it.
     */
    rating: {
      start: int("RANKED_RATING_START", file.rating?.start ?? 1000),
      k: int("RANKED_RATING_K", file.rating?.k ?? 40),
      floor: int("RANKED_RATING_FLOOR", file.rating?.floor ?? 100),
    },
  };
};

/** This server's ranked settings, read once per thread. A test may change them in place. */
export const rankedSettings = readRankedSettings();

/**
 * How busy each dungeon is, for the world map.
 *
 * The map polls GET /game-status every 59 seconds (uI/map/PlayerActivityCount.hx)
 * and reads one field, `publicDungeonActivityLevel`: a level per node id, drawn
 * as a glow on the node and as the "POPULATION:" line in its popup. Answered
 * with a fixed `{ players: 1 }` before this, every node read UNKNOWN and none
 * glowed. The shape is the official server's, read live:
 *
 *   {"environmentName":"blue","statsAvailable":true,"currentHeroesInDungeons":122,
 *    "publicDungeonActivityLevel":{"50002":"Quiet","50003":"Active",…,"50158":"Bustling"}}
 *
 * Every node is listed, the empty ones as Quiet. The levels are the client's
 * five; the thresholds behind them are not in anything the official sends, so
 * they are this server's, set by party size and configurable.
 *
 * Counted from the main thread's registry, which admits every run whether or
 * not match workers play them, so one count serves both.
 */
import { config } from "./config.js";
import { loadGameMaster } from "./gamemaster.js";
import { dungeonMatches, isHubNode } from "./socket/matches.js";

/**
 * The client upper-cases a level before it looks it up, and its locale has
 * PLAYER_ACTIVITY_RAMPAGING while its glow check wants "RAMPAGING!". Sending
 * "Rampaging" reads right in the popup at the cost of that one glow; the
 * spelling with the mark would glow and print "mia:PLAYER_ACTIVITY_RAMPAGING!".
 */
const LEVELS = ["Quiet", "Active", "Popular", "Bustling", "Rampaging"];

/** A run that people can still join is a run that makes a node busy. */
const OPEN_STATES = new Set(["forming", "active"]);

const CACHE_MS = 5000;
let cached = null;

/** The level for this many players: the first threshold not yet reached decides. */
export const activityLevelFor = (players, thresholds = config.activityThresholds) => {
  let level = 0;
  for (const minimum of thresholds) {
    if (players >= minimum) level += 1;
  }
  return LEVELS[Math.min(level, LEVELS.length - 1)];
};

/**
 * The answer itself. `registry` and `gameMaster` are for tests; the route
 * uses the process registry, cached for a few seconds because every player on
 * the map asks for it once a minute.
 */
export const gameStatusFor = async ({
  registry = dungeonMatches,
  gameMaster = null,
  now = Date.now(),
} = {}) => {
  const useCache = registry === dungeonMatches;
  if (useCache && cached && now - cached.at < CACHE_MS) return cached.value;

  const gm = gameMaster ?? (await loadGameMaster());
  const nodeOf = (id) => gm.mapNodeById?.get(Number(id));
  const publicPlayers = new Map();
  let heroes = 0;

  for (const match of registry.matches.values()) {
    if (isHubNode(nodeOf(match.mapNodeId))) continue;
    const players = match.members?.size ?? 0;
    heroes += players;
    if (match.private || !OPEN_STATES.has(match.state)) continue;
    publicPlayers.set(match.mapNodeId, (publicPlayers.get(match.mapNodeId) ?? 0) + players);
  }

  const publicDungeonActivityLevel = {};
  for (const node of gm.raw?.MapPage ?? []) {
    if (isHubNode(node)) continue;
    publicDungeonActivityLevel[String(node.Id)] = activityLevelFor(publicPlayers.get(node.Id) ?? 0);
  }

  const value = {
    environmentName: config.serverName,
    statsAvailable: true,
    currentHeroesInDungeons: heroes,
    publicDungeonActivityLevel,
  };
  if (useCache) cached = { at: now, value };
  return value;
};

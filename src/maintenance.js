/**
 * The dungeons closed for a while, without a restart.
 *
 * A restart ends every run in progress, and the switch that kept dungeons shut
 * (`ODS_DUNGEON=0`) is read at startup — so before this, the only way to stop
 * runs starting ahead of a restart was the restart itself. Now the door can be
 * closed through the internal API: nobody starts a run or joins one, and the
 * client says the game is not enterable; whoever is already in a dungeon plays
 * on, through its doors, to the end of it. Opening it again is the same call
 * undone.
 *
 * Kept by the main thread, which is where every request to enter arrives, and
 * kept in memory only: maintenance is what comes before a restart, and the
 * server that comes back is open unless `ODS_DUNGEON=0` says otherwise.
 */
import { config } from "./config.js";

let state = null;

/** `{ since, by, message }` while the dungeons are closed, or null. */
export const maintenanceState = () => state;

export const beginMaintenance = ({ by = null, message = null } = {}, now = Date.now()) => {
  state = { since: new Date(now).toISOString(), by, message };
  return state;
};

export const endMaintenance = () => {
  state = null;
  return state;
};

/** Why a run cannot start now, or null when it can. */
export const dungeonsClosedBecause = () => {
  if (!config.dungeonsEnabled) return "dungeons are disabled (ODS_DUNGEON=0)";
  if (state) return `the dungeons are closed for maintenance since ${state.since}`;
  return null;
};

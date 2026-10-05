/**
 * What a run pays, and what it counts for — the one place a game mode says so.
 *
 * The stock game pays everything: experience and gold as they are picked up,
 * the node's completion bonus, the keys, trophy and gems of a first clear, the
 * chests a treasure is worth; a run marks the node done and stands on the run
 * boards, and friends may join it. A mode that wants less of that — ranked
 * races pay no experience and no chests, mark nothing done and take nobody in
 * — answers `runRules(session)` with its own rules, and every pay point reads
 * them here rather than asking what the mode is. A mode written later has
 * these knobs and no others to find.
 *
 * `modeHooks` is where a mode installs its answers (modes/hooks.js); nothing
 * here knows which mode answered.
 */
import { modeHooks } from "../modes/hooks.js";

export const STOCK_RUN_RULES = Object.freeze({
  /** The mode's name — what `request.mode`, `match.mode` and `session.modeEntry` carry; null for the game as shipped. */
  mode: null,
  /** Whether entering asks the map's unlock check: has this hero opened the node. */
  unlockCheck: true,
  pays: Object.freeze({
    /** Experience, from stars picked up and the node's completion bonus. */
    experience: true,
    /** Gold picked up off the floor and carried by a boss's reward. */
    gold: true,
    /** The chest a treasure is worth, owed on the report. */
    chests: true,
    /** A first clear's keys, trophy and gems. */
    keys: true,
    trophies: true,
    gems: true,
  }),
  /** The node marked done on the map, and counted as a dungeon completed. */
  mapCredit: true,
  /** A finished run stands on the run boards. */
  rankable: true,
  /** Friends may follow a player into the run. */
  joinable: true,
});

/** The stock rules with `overrides` on top, `pays` merged a level down. */
export const runRules = (overrides = {}) =>
  Object.freeze({
    ...STOCK_RUN_RULES,
    ...overrides,
    pays: Object.freeze({ ...STOCK_RUN_RULES.pays, ...(overrides.pays ?? {}) }),
  });

/** The rules this session's run is under: a mode's, or the game's own. */
export const runRulesOf = (session) => modeHooks.runRules(session) ?? STOCK_RUN_RULES;

/** The rules a mode plays by, by its name — for what is asked before there is a run. */
export const rulesOfMode = (mode) => (mode ? modeHooks.modeRules(mode) : null) ?? STOCK_RUN_RULES;

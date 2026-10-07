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
  /**
   * A hero who falls may be got back up: a Health or Party Bomb, or an ally's
   * rescue. Off, no bomb is accepted, no rescue lands, and a floor with
   * nobody standing is lost at once rather than after the defeat countdown.
   */
  revives: true,
  /** The node marked done on the map, and counted as a dungeon completed. */
  mapCredit: true,
  /** A finished run stands on the run boards. */
  rankable: true,
  /** Friends may follow a player into the run. */
  joinable: true,
  /**
   * On how many of the run's first floors strangers may be matched into it: 1,
   * as the game does it — the first floor only; public filling stops once the
   * run is under way, and only friends follow (`joinable`). A run that goes on
   * long (delve) may take them a few floors in, and not deep; null for every
   * floor.
   */
  strangersUntil: 1,
  /**
   * Every run of the mode on one match worker, the seat (SEAT_WORKER), however
   * busy it is: for a mode whose runs reach each other — ranked starts a race
   * by moving two runs on together, so both have to be in the thread that does
   * it. Off, a run goes to the least busy worker like any other. A party is one
   * run, so a party mode does not need it.
   */
  together: false,
  /**
   * When a chest picked up is the player's: "report", as the game does — kept
   * from the end-of-run report, and lost by walking out before it — or
   * "pickup", on the account the moment it is picked up, for a run whose
   * report may be a long way off (a run with no last floor).
   */
  chestsKept: "report",
  /**
   * Seconds to be revived in once every hero is down, or null for the node's
   * own (sixty; ten on Infinite). The client counts down from what it is sent.
   */
  defeatCountdownSeconds: null,
  /**
   * What a floor's reward spots (the maps' TREASURE and RANDOM_REWARD) and a
   * boss's chest pay: null for the node's own; one of the treasure doobers —
   * WOODEN_CHEST, SILVER_CHEST, GOLD_CHEST, DRAGON_CHEST, SMALL_ITEM_BOX,
   * ROYAL_ITEM_BOX, by constant or id — for every one of them; or "none", gold
   * in their place. A floor plan's own `treasure` wins over it. What a map
   * places by name is placed as it is.
   */
  treasure: null,
  /** How many of a run's reward spots pay a treasure; null for the node's own (MaxTreasure). */
  treasureCount: null,
  /** The best chest a treasure may be, 1 common to 4 legendary; null for no limit. A floor plan's own wins. */
  chestMost: null,
});

/** The match worker every run of a `together` mode goes to. */
export const SEAT_WORKER = 0;

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

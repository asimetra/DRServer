import assert from "node:assert/strict";
import test from "node:test";

import { MODE_HOOK_COMBINE, MODE_HOOK_NAMES } from "../src/modes/hooks.js";
import { STOCK_RUN_RULES, runRules } from "../src/socket/run-rules.js";
import { EFFECT_SPEC_KEYS } from "../src/socket/ui-effects.js";
import { ACTIONS } from "../src/notices.js";
import { commands, define, resetCommands, undefineMode } from "../src/socket/commands.js";

/**
 * The surface a mode may rely on (src/modes/README.md, "What a mode may rely
 * on"). Changing any of it is allowed; doing it without noticing is not, which
 * is what these pins are for: a hook added, renamed or recombined, a run-rule
 * knob added, a book key — each fails here first, and the commit that changes
 * it changes this file with a note.
 */

test("the hooks: seventeen names, in the order a run meets them, each combined one known way", () => {
  assert.deepEqual([...MODE_HOOK_NAMES], [
    "routeEntry", "entryAllowed", "modeRules", "drawOffered", "planFor", "heroRequested", "floorCompleting",
    "runFailed", "runLeft", "idle", "idlingAllowed", "runRules", "friendList", "loggedIn",
    "isSystemAccount", "heroEvent", "reportRows",
  ]);
  assert.deepEqual({ ...MODE_HOOK_COMBINE }, {
    routeEntry: "chain", friendList: "chain", reportRows: "chain",
    entryAllowed: "named", modeRules: "named",
    planFor: "first", runRules: "first",
    floorCompleting: "all",
    idlingAllowed: "any", isSystemAccount: "any", drawOffered: "any",
    heroRequested: "each", runFailed: "each", runLeft: "each", idle: "each", loggedIn: "each", heroEvent: "each",
  });
  for (const name of MODE_HOOK_NAMES) assert.ok(name in MODE_HOOK_COMBINE, `${name} has no combine rule`);
});

test("the run rules: these knobs and no others, and the game as shipped pays everything", () => {
  assert.deepEqual(Object.keys(STOCK_RUN_RULES), ["mode", "unlockCheck", "pays", "revives", "mapCredit", "rankable", "joinable"]);
  assert.deepEqual(Object.keys(STOCK_RUN_RULES.pays), ["experience", "gold", "chests", "keys", "trophies", "gems"]);
  assert.deepEqual(STOCK_RUN_RULES, {
    mode: null, unlockCheck: true,
    pays: { experience: true, gold: true, chests: true, keys: true, trophies: true, gems: true },
    revives: true, mapCredit: true, rankable: true, joinable: true,
  });
  const mine = runRules({ mode: "m", pays: { chests: false } });
  assert.equal(mine.pays.chests, false);
  assert.equal(mine.pays.gold, true, "everything unsaid is the game\'s own");
});

test("the effect book: an event says these things and nothing else", () => {
  assert.deepEqual([...EFFECT_SPEC_KEYS], ["banner", "sound", "shake", "zoom", "countdown", "floater", "to", "replacesChat"]);
});

test("the notice board: the buttons the client has", () => {
  assert.deepEqual([...ACTIONS], ["MAP", "BATTLE", "SHOP", "STORE", "INVENTORY", "TRAINING", "GEMS", "TAVERN", "CLOSE"]);
});

test("chat commands: a mode\'s are tagged with it and leave with it", () => {
  resetCommands();
  define({ name: "x", role: 0, summary: "s", run: () => {}, mode: "m" });
  define({ name: "y", role: 0, summary: "s", run: () => {} });
  assert.deepEqual(commands().map((c) => [c.name, c.mode]), [["x", "m"], ["y", null]]);
  undefineMode("m");
  assert.deepEqual(commands().map((c) => c.name), ["y"]);
  resetCommands();
});

import assert from "node:assert/strict";
import test from "node:test";

import { MODE_HOOK_COMBINE, MODE_HOOK_NAMES } from "../src/modes/hooks.js";
import { STOCK_RUN_RULES, runRules } from "../src/socket/run-rules.js";
import { EFFECT_SPEC_KEYS } from "../src/socket/ui-effects.js";
import { ACTIONS } from "../src/notices.js";
import { commands, define, resetCommands, undefineMode } from "../src/socket/commands.js";
import { installSessionLookup, runControls } from "../src/modes/runtime.js";
import { createModeRecords } from "../src/modes/records.js";

/**
 * The surface a mode may rely on (src/modes/README.md, "What a mode may rely
 * on"). Changing any of it is allowed; doing it without noticing is not, which
 * is what these pins are for: a hook added, renamed or recombined, a run-rule
 * knob added, a book key — each fails here first, and the commit that changes
 * it changes this file with a note.
 */

test("the hooks: eighteen names, in the order a run meets them, each combined one known way", () => {
  assert.deepEqual([...MODE_HOOK_NAMES], [
    "routeEntry", "entryAllowed", "modeRules", "drawOffered", "planFor", "heroRequested", "floorCompleting",
    "runFailed", "runLeft", "idle", "idlingAllowed", "runRules", "friendList", "loggedIn",
    "isSystemAccount", "heroEvent", "combatEvent", "reportRows",
  ]);
  assert.deepEqual({ ...MODE_HOOK_COMBINE }, {
    routeEntry: "chain", friendList: "chain", reportRows: "chain",
    entryAllowed: "named", modeRules: "named",
    planFor: "first", runRules: "first",
    floorCompleting: "all",
    idlingAllowed: "any", isSystemAccount: "any", drawOffered: "any",
    heroRequested: "each", runFailed: "each", runLeft: "each", idle: "each", loggedIn: "each", heroEvent: "each", combatEvent: "each",
  });
  for (const name of MODE_HOOK_NAMES) assert.ok(name in MODE_HOOK_COMBINE, `${name} has no combine rule`);
});

test("the run rules: these knobs and no others, and the game as shipped pays everything", () => {
  assert.deepEqual(Object.keys(STOCK_RUN_RULES), ["mode", "unlockCheck", "pays", "revives", "mapCredit", "rankable", "joinable", "together", "chestsKept", "defeatCountdownSeconds"]);
  assert.deepEqual(Object.keys(STOCK_RUN_RULES.pays), ["experience", "gold", "chests", "keys", "trophies", "gems"]);
  assert.deepEqual(STOCK_RUN_RULES, {
    mode: null, unlockCheck: true,
    pays: { experience: true, gold: true, chests: true, keys: true, trophies: true, gems: true },
    revives: true, mapCredit: true, rankable: true, joinable: true, together: false,
    chestsKept: "report", defeatCountdownSeconds: null,
  });
  const mine = runRules({ mode: "m", pays: { chests: false } });
  assert.equal(mine.pays.chests, false);
  assert.equal(mine.pays.gold, true, "everything unsaid is the game\'s own");
});

test("the run controls: what a mode may ask the core, these and no others", async () => {
  assert.deepEqual(Object.keys(runControls), ["party", "sessionOf", "win", "lose", "sendHome", "planAhead", "endFloor", "reward", "heal", "gift", "weapon", "say", "grantBuff"]);
  const held = { accountId: 7 };
  const undo = installSessionLookup((id) => (id === 7 ? held : null));
  assert.equal(runControls.sessionOf(7), held, "a thread's own lookup finds its runs");
  assert.equal(runControls.sessionOf(8), null);
  undo();
  // A session with no run has nothing to end or buff: the "not done" answer, never a throw.
  assert.equal(runControls.win(null), false);
  assert.equal(runControls.lose(null), false);
  assert.equal(await runControls.sendHome(null), false);
  assert.equal(await runControls.grantBuff(null, "ANY"), null);
  assert.equal(await runControls.weapon(null, { rarity: "RARE", level: 10, from: 0 }), null);
  assert.equal(runControls.endFloor(null), false);
  assert.equal(runControls.planAhead(null, []), null);
  assert.deepEqual(runControls.reward(null, { gold: 5 }), { gold: 0, experience: 0 });
  assert.deepEqual(runControls.heal(null, { health: 1 }), { health: 0, mana: 0 });
  assert.equal(await runControls.gift(null, 1, { from: 999 }), null);
});

test("reward and heal: what a mode pays and gives back, as given and no more", () => {
  const sent = [];
  const hero = { hitPoints: 20, maxHitPoints: 100 };
  const run = {
    member: {},
    playerDoid: 1,
    heroDoid: 2,
    actors: new Map([[2, hero]]),
    heroManaPoints: 0,
    maxHeroManaPoints: 50,
    dungeonAccount: { basic_currency: 10 },
    dungeonAvatar: { experience: 5 },
    send: (frame) => sent.push(frame),
  };
  assert.deepEqual(runControls.reward(run, { gold: 7.9, experience: 30 }), { gold: 7, experience: 30 }, "whole amounts");
  assert.equal(run.dungeonAccount.basic_currency, 17);
  assert.equal(run.dungeonAvatar.experience, 35);
  assert.deepEqual(run.dungeonRewards, { gold: 7, gems: 0, xp: 30 }, "and on the report");
  assert.equal(run.accountChanged, true, "kept with the account");

  assert.deepEqual(runControls.heal(run, { health: 0.5, mana: 1 }), { health: 50, mana: 50 });
  assert.equal(hero.hitPoints, 70);
  assert.deepEqual(runControls.heal(run, { health: 1 }), { health: 30, mana: 0 }, "no more than its most");
  hero.dead = true;
  assert.deepEqual(runControls.heal(run, { health: 1 }), { health: 0, mana: 0 }, "a hero that is down is revived, not healed");
  assert.ok(sent.length > 0, "the client is told");
});

test("planAhead: floors after the plan's last, or in place of what follows this one, and back again", () => {
  const a = { authored: "a.json" };
  const b = { generated: { tileLibrary: "t", seed: 1 } };
  const c = { authored: "c.json" };
  const run = { member: {}, floorIndex: 0, floorCount: 2, floorPlan: { floors: [a, b] } };

  const undo = runControls.planAhead(run, [c]);
  assert.deepEqual(run.floorPlan.floors, [a, b, c]);
  assert.equal(run.floorCount, 3, "the count goes with the plan");
  undo();
  assert.deepEqual(run.floorPlan.floors, [a, b]);
  assert.equal(run.floorCount, 2);

  runControls.planAhead(run, [c], { replace: true });
  assert.deepEqual(run.floorPlan.floors, [a, c], "everything after the floor in hand, replaced");
  assert.throws(() => runControls.planAhead(run, [{ name: "not a floor" }]), TypeError);
  assert.throws(() => runControls.planAhead(run, [{ generated: true }]), TypeError, "a generated floor names its library");

  // An earlier undo after a later change would throw the later away: it does nothing.
  const first = runControls.planAhead(run, [b]);
  runControls.planAhead(run, [c]);
  assert.equal(first(), false);
  assert.deepEqual(run.floorPlan.floors, [a, c, b, c], "the later change stands");
});

test("gift: said to be from somebody, or not given", async () => {
  const run = { member: {}, dungeonAccount: { id: 7 } };
  assert.equal(await runControls.gift(run, 1), null, "no `from`");
  assert.equal(await runControls.gift(run, 1, { from: "x" }), null);
});

test("the records: what a mode keeps, and nothing else on them", () => {
  assert.deepEqual(Object.keys(createModeRecords({ mode: "m", storage: "memory" })), ["append", "all", "forAccount", "version"]);
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

test("the registry and the seat: how a mode is added, and what the main thread knows of the seat", async () => {
  const registry = await import("../src/modes/index.js");
  const seat = await import("../src/modes/seat.js");
  assert.deepEqual(["registerMode", "registeredModes", "startModes"].filter((name) => typeof registry[name] !== "function"), []);
  assert.deepEqual(["seatRuns", "seatSaid", "tellMain"].filter((name) => typeof seat[name] !== "function"), []);
  assert.deepEqual(registry.registeredModes().slice(0, 2), [
    { name: "onelife", together: false },
    { name: "ranked", together: true },
  ]);
});

test("the game data a mode may read: nodes, a node's floors, their tile files, any table", async () => {
  const data = await import("../src/modes/game-data.js");
  assert.deepEqual(Object.keys(data).sort(), ["gameTable", "mapNode", "mapNodes", "nodePlan", "planTileLibraries"]);
});

test("the friend door: the hooks it answers, its row, and its ids", async () => {
  const { friendDoorHooks, friendDoorRow, FRIEND_DOOR_ID_MOST } = await import("../src/modes/friend-door.js");
  const told = [];
  const door = friendDoorHooks({ id: 990, name: "DOOR", where: 50002, entry: (c, r) => ({ ...r, mode: "m" }), tellPresence: (...a) => told.push(a) });
  assert.deepEqual(Object.keys(door).sort(), ["friendList", "isSystemAccount", "loggedIn", "routeEntry"]);
  assert.deepEqual(Object.keys(friendDoorRow({ id: 990, name: "x" })).sort(), [
    "account_id", "active_skin", "avatar_url", "current_dungeon", "friend_code", "identifier", "is_ingame_friend", "is_online", "name", "trophies",
  ]);
  assert.equal(door.routeEntry({}, { friendId: 990 }).mode, "m");
  const other = { friendId: 5 };
  assert.equal(door.routeEntry({}, other), other, "anybody else's JOIN is left alone");
  assert.equal(FRIEND_DOOR_ID_MOST, 999);
  assert.throws(() => friendDoorHooks({ id: 1000, entry: () => null }), /1 to 999/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { MODE_HOOK_NAMES, installModeHooks, modeHooks, modeInstalled, modesInstalled } from "../src/modes/hooks.js";
import { installRankedHooks, rankedHooks, rankedHooksInstalled } from "../src/modes/ranked/hooks.js";

/**
 * The mode seam (src/modes/hooks.js): more than one mode at once, each
 * answering under its own name, their answers put together by each hook's rule.
 */
const installed = (t, ...pairs) => {
  const undo = pairs.map(([mode, hooks]) => installModeHooks(mode, hooks));
  t.after(() => undo.forEach((fn) => fn()));
};

test("with nothing installed every hook is the no-op that leaves the runtime as it was", async () => {
  assert.equal(modesInstalled().length, 0);
  const request = { mapNodeId: 1 };
  assert.equal(modeHooks.routeEntry({}, request), request);
  assert.equal(await modeHooks.planFor({}, 1), null);
  assert.equal(modeHooks.floorCompleting({}), true);
  assert.equal(modeHooks.idlingAllowed({}), false);
  assert.equal(modeHooks.runRules({}), null);
  assert.deepEqual(modeHooks.friendList([1, 2]), [1, 2]);
  assert.equal(modeHooks.heroRequested({}), undefined);
});

test("two modes installed: a chain rewrites in turn, the first answer wins, all must agree, any may say yes", async (t) => {
  installed(
    t,
    ["a", {
      routeEntry: (connection, request) => (request.friendId === 1 ? { ...request, mode: "a" } : request),
      friendList: (rows) => [...rows, "a"],
      planFor: async (session) => (session.modeEntry === "a" ? { floors: ["a"] } : null),
      floorCompleting: (session) => session.hold !== "a",
      idlingAllowed: (session) => session.lobby === "a",
      runRules: (session) => (session.modeEntry === "a" ? { mode: "a" } : null),
      heroRequested: (session) => session.seen.push("a"),
    }],
    ["b", {
      routeEntry: (connection, request) => (request.friendId === 2 ? { ...request, mode: "b" } : request),
      friendList: (rows) => [...rows, "b"],
      planFor: async (session) => (session.modeEntry === "b" ? { floors: ["b"] } : null),
      floorCompleting: (session) => session.hold !== "b",
      idlingAllowed: (session) => session.lobby === "b",
      runRules: (session) => (session.modeEntry === "b" ? { mode: "b" } : null),
      heroRequested: (session) => session.seen.push("b"),
    }]
  );
  assert.deepEqual(modesInstalled(), ["a", "b"]);
  assert.equal(modeHooks.routeEntry({}, { friendId: 2 }).mode, "b");
  assert.equal(modeHooks.routeEntry({}, { friendId: 9 }).mode, undefined);
  assert.deepEqual(modeHooks.friendList(["me"]), ["me", "a", "b"]);
  assert.deepEqual(await modeHooks.planFor({ modeEntry: "b" }, 1), { floors: ["b"] });
  assert.equal(await modeHooks.planFor({ modeEntry: "c" }, 1), null);
  assert.equal(modeHooks.floorCompleting({ hold: "b" }), false, "one mode holding holds");
  assert.equal(modeHooks.floorCompleting({}), true);
  assert.equal(modeHooks.idlingAllowed({ lobby: "a" }), true);
  assert.equal(modeHooks.idlingAllowed({}), false);
  assert.deepEqual(modeHooks.runRules({ modeEntry: "b" }), { mode: "b" });
  const session = { seen: [] };
  modeHooks.heroRequested(session);
  assert.deepEqual(session.seen, ["a", "b"], "news goes to every mode");
});

test("a named hook asks only the mode named: its gate, its rules", async (t) => {
  installed(t, ["a", { entryAllowed: async () => ({ ok: false, reason: "a says no" }), modeRules: () => ({ mode: "a" }) }]);
  assert.equal((await modeHooks.entryAllowed({}, "a")).ok, false);
  assert.deepEqual(await modeHooks.entryAllowed({}, "b"), { ok: true }, "a mode not installed is the default");
  assert.deepEqual(modeHooks.modeRules("a"), { mode: "a" });
  assert.equal(modeHooks.modeRules("b"), null);
});

test("a mode's fault is logged and answered with the default, never thrown into the runtime", async (t) => {
  installed(t, ["bad", {
    floorCompleting: () => { throw new Error("boom"); },
    planFor: async () => { throw new Error("boom"); },
  }]);
  assert.equal(modeHooks.floorCompleting({}), true);
  assert.equal(await modeHooks.planFor({}, 1), null);
});

test("an answer under a name the runtime never asks is ignored and said so; uninstalling takes only that mode out", (t) => {
  const undoA = installModeHooks("a", { notAHook: () => {}, idlingAllowed: () => true });
  const undoB = installModeHooks("b", { idlingAllowed: () => false });
  t.after(() => (undoA(), undoB()));
  assert.ok(MODE_HOOK_NAMES.includes("idlingAllowed") && !MODE_HOOK_NAMES.includes("notAHook"));
  assert.equal(modeHooks.idlingAllowed({}), true);
  undoA();
  assert.equal(modeInstalled("a"), false);
  assert.equal(modeInstalled("b"), true);
  assert.equal(modeHooks.idlingAllowed({}), false);
});

test("ranked's name on the seam is the same seam", (t) => {
  assert.equal(rankedHooks, modeHooks);
  const undo = installRankedHooks({ idlingAllowed: () => true });
  t.after(undo);
  assert.equal(rankedHooksInstalled(), true);
  assert.equal(modeInstalled("ranked"), true);
});

test("a chain hands each mode the last one's answer in its own place, and every other argument as it came", (t) => {
  const seen = [];
  const uninstallA = installModeHooks("chain-a", {
    routeEntry: (connection, request) => (seen.push(["a", connection.accountId]), { ...request, a: true }),
    reportRows: (recipient, rows) => (seen.push(["a rows", recipient.accountId]), [...rows, "a"]),
  });
  const uninstallB = installModeHooks("chain-b", {
    routeEntry: (connection, request) => (seen.push(["b", connection.accountId]), { ...request, b: request.a === true }),
    reportRows: (recipient, rows) => (seen.push(["b rows", recipient.accountId]), [...rows, "b"]),
  });
  t.after(() => (uninstallA(), uninstallB()));
  const connection = { accountId: 7 };
  assert.deepEqual(modeHooks.routeEntry(connection, { mapNodeId: 1 }), { mapNodeId: 1, a: true, b: true });
  assert.deepEqual(modeHooks.reportRows({ accountId: 9 }, ["own"], {}), ["own", "a", "b"]);
  assert.deepEqual(seen, [["a", 7], ["b", 7], ["a rows", 9], ["b rows", 9]], "the second mode still sees the connection, and the recipient");
});

test("an entry one mode has marked is that mode's: no later mode in the chain takes it over", async (t) => {
  const { stockClientEntryHooks } = await import("../src/modes/ranked/stock-client/adapter.js");
  const { createDelve } = await import("../src/modes/delve/index.js");
  const { createOneLife } = await import("../src/modes/one-life/index.js");
  const oneLife = createOneLife();
  const delve = createDelve({ bosses: [{ node: { Id: 50004 }, floors: [{ authored: "x.json" }] }], tellPresence: () => {} });
  // The registry's own order (modes/index.js): one life, ranked, delve.
  installed(
    t,
    ["onelife", oneLife.hooks],
    ["ranked", stockClientEntryHooks({ settings: { lobbyNode: 50003, entry: {} }, waiting: () => 0 })],
    ["delve", delve.hooks]
  );

  delve.arm(7);
  const matchmaker = modeHooks.routeEntry({ accountId: 7 }, { mapNodeId: 0, friendId: 999, mapId: 0, friendOnly: 0 });
  assert.equal(matchmaker.mode, "ranked", "JOIN on MATCHMAKER is ranked, whatever the player armed");
  assert.equal(matchmaker.mapNodeId, 50003);
  assert.equal(delve.armed(7), true, "and the delve waits for the player's own next run");

  oneLife.arm(8);
  delve.arm(8);
  const plain = modeHooks.routeEntry({ accountId: 8 }, { mapNodeId: 50010, friendId: 0, mapId: 0 });
  assert.equal(plain.mode, "onelife", "the first mode to mark it keeps it");
  assert.equal(plain.mapNodeId, 50010);
  assert.equal(delve.armed(8), true, "the other arming is not spent on a run it did not get");
});

test("the chain itself stops at the first mark: a later mode with no guard of its own never sees the entry", (t) => {
  const seen = [];
  installed(
    t,
    ["marks", { routeEntry: (connection, request) => ({ ...request, mode: "marks" }) }],
    // Takes everything over, as a careless mode would.
    ["careless", { routeEntry: (connection, request) => (seen.push(request.mode), { ...request, mode: "careless" }) }]
  );
  assert.equal(modeHooks.routeEntry({ accountId: 7 }, { mapNodeId: 1 }).mode, "marks");
  assert.deepEqual(seen, [], "never asked");
});

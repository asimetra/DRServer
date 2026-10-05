import assert from "node:assert/strict";
import test from "node:test";

import { createRankedService } from "../src/ranked/index.js";
import { createRecords } from "../src/ranked/records.js";
import { createSpec, fixedPicker } from "../src/ranked/race-spec.js";
import { createStockClientAdapter } from "../src/ranked/stock-client/adapter.js";
import { insideRing, ringMarkers } from "../src/ranked/stock-client/ring.js";
import { bookWords } from "../src/socket/ui-effects.js";
import {
  SYSTEM_FRIEND_ID,
  isSystemAccount,
  systemFriendRow,
  withSystemFriend,
} from "../src/ranked/stock-client/system-friend.js";

/**
 * The stock-client adapter against the real core, with the dungeon runtime
 * replaced by the few things the adapter asks of it. A "session" here is what
 * the runtime would hand the hooks: an account, a floor index, a plan.
 */
const A = 1000000101;
const B = 1000000202;
const LOBBY = 50003;
const s = (seconds) => seconds * 1000;
const settings = {
  lobbyNode: LOBBY,
  lobbyFloor: "castle/arena/lobby.json",
  lobbyIdleMs: s(300),
  raceTileLibraries: ["Resources/Levels/nordic/caves/tiles.json", "Resources/Levels/jungle/tribal/tiles.json"],
};

const setup = ({
  show,
  defeat,
  victory,
  ring = null,
  lobbySpawn = null,
  relay,
  snapshot,
  words = bookWords,
  records = createRecords({ storage: "memory" }),
  raceFloors,
  copyFrames = null,
  extraSettings = {},
  heroLevelOf,
  tutorialDoneFor,
} = {}) => {
  let now = 0;
  const clock = () => now;
  const lines = [];
  const shown = [];
  const defeated = [];
  const won = [];
  const sentHome = [];
  const sessions = new Map();
  const service = createRankedService({
    records,
    picker: fixedPicker(createSpec({ mapNodeId: 50006, seed: 42 })),
    rules: { countdownMs: s(10), maxDurationMs: s(1800), forfeitWindowMs: s(120), drawWindowMs: s(5) },
    clock,
    start: (race) => adapter.start(race),
  });
  const adapter = createStockClientAdapter({
    service,
    settings: { ...settings, ring, lobbySpawn, ...extraSettings },
    copyFrames,
    sessionOf: (accountId) => sessions.get(accountId),
    contextOf: (session) => session,
    say: (session, text) => lines.push({ accountId: session.accountId, text }),
    show: show ?? ((session, notice) => shown.push({ session, notice })),
    defeat: defeat ?? ((session) => defeated.push(session.accountId)),
    victory: victory ?? ((session) => won.push(session.accountId)),
    sendHome: (session) => sentHome.push(session.accountId),
    relay,
    snapshot: snapshot ?? ((session) => ({ name: session.dungeonAccount?.name ?? "?", weaponType1: 5 })),
    raceFloors: raceFloors ?? (async (spec) => [
      { generated: { tileLibrary: "nordic", seed: spec.seed }, node: { Id: spec.mapNodeId } },
      { generated: { tileLibrary: "nordic", seed: spec.seed + 1 }, node: { Id: spec.mapNodeId } },
    ]),
    // The runtime's completeFloor: refuses a floor already ending, asks the hook, then moves on a floor.
    completeFloor: (session) => {
      if (session.floorFinished) return false;
      if (!adapter.hooks.floorCompleting(session)) return false;
      if (session.floorIndex + 1 < session.floorCount) session.floorIndex += 1;
      return true;
    },
    nameOf: async (accountId) => (accountId === A ? "Alice" : "Bob"),
    words,
    clock,
    heroLevelOf,
    tutorialDoneFor,
  });
  service.onNotice(adapter.onNotice);

  /** Pressing JOIN on MATCHMAKER, through to standing on the lobby floor. */
  const join = async (accountId, { at } = {}) => {
    const request = adapter.hooks.routeEntry({ accountId }, { mapNodeId: 0, friendId: SYSTEM_FRIEND_ID, mapId: 0 });
    const plan = await adapter.hooks.planFor({ accountId }, request.mapNodeId);
    const session = { accountId, floorIndex: 0, floorPlan: plan, floorCount: plan.floors.length, heroPosition: at };
    sessions.set(accountId, session);
    adapter.hooks.heroRequested(session);
    return { request, session };
  };
  const at = (seconds) => {
    now = s(seconds);
  };
  const said = (accountId) => lines.filter((line) => line.accountId === accountId).map((line) => line.text);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { service, adapter, join, at, said, shown, defeated, won, sentHome, sessions, flush };
};

test("JOIN on MATCHMAKER becomes a private ranked run of the lobby node, with one quiet floor", async () => {
  const { join } = setup();
  const { request, session } = await join(A);
  assert.equal(request.mapNodeId, LOBBY);
  assert.equal(request.friendId, 0);
  assert.equal(request.friendOnly, 1);
  assert.equal(request.mode, "ranked");
  assert.deepEqual(session.floorPlan.floors, [{ authored: settings.lobbyFloor, quiet: { npc: [] } }], "no ring, no piles");
  // The client cannot build a floor whose tile library its area did not preload,
  // and the race is drawn after the area is built: every possible one goes in.
  assert.deepEqual(session.floorPlan.preloadTileLibraries, settings.raceTileLibraries);
});

test("a join for anybody else, or a plan for any other run, is left alone", async () => {
  const { adapter } = setup();
  const request = { mapNodeId: 50006, friendId: 1234 };
  assert.equal(adapter.hooks.routeEntry({ accountId: A }, request), request);
  assert.equal(await adapter.hooks.planFor({ accountId: A }, 50006), null);
  assert.equal(adapter.hooks.runRules({ accountId: A }), null, "the game's own rules");
});

test("standing on the lobby floor is being queued; the lobby never ends by itself", async () => {
  const { join, service, adapter, said, flush } = setup();
  const { session } = await join(A);
  assert.equal(service.statusOf(A).state, "queued");
  assert.equal(adapter.hooks.floorCompleting(session), false);
  await flush();
  assert.equal(
    said(A)[0],
    "Ranked: you are Wooden 1000, no place until your first race. Waiting here is waiting for a race; /rank shows the board.",
    "arriving says where they stand, in chat whatever the client's strings"
  );
  assert.ok(said(A).some((line) => /looking for an opponent/.test(line)));
});

test("two in their lobbies are paired, moved into the race together, and each clock starts on its own floor", async () => {
  const context = setup();
  const { join, service, at, said, sessions, flush } = context;
  await join(A);
  await join(B);

  at(1);
  await service.tick();
  await flush();
  assert.ok(said(A).some((line) => /a rival \(Wooden 1000\) was found\. Starting in 10 seconds/.test(line)));
  assert.ok(said(A).every((line) => !/Bob/.test(line)), "the rival is not named until the race is over");

  at(11);
  await service.tick();
  const a = sessions.get(A);
  assert.equal(a.floorIndex, 1, "the lobby floor ended and the race's first began");
  assert.equal(a.floorCount, 3);
  assert.equal(a.floorPlan.floors[1].node.Id, 50006);
  assert.deepEqual(a.floorPlan.floors[1].numbered, { index: 0, of: 2 }, "the race's first floor is its floor 1");

  at(15);
  context.adapter.hooks.heroRequested(a);
  assert.equal(service.statusOf(A).raceState, "loading", "B's floor is not ready yet");
  at(16);
  context.adapter.hooks.heroRequested(sessions.get(B));
  assert.equal(service.statusOf(A).raceState, "running");
  await flush();
  assert.ok(said(B).some((line) => /go!/.test(line)));
});

test("every notice is also shown, on the player's own floor, for the effect book to play", async () => {
  const { join, service, at, shown, sessions } = setup();
  await join(A);
  await join(B);
  at(1);
  await service.tick();

  const forA = shown.filter(({ session }) => session === sessions.get(A));
  assert.deepEqual(
    forA.map(({ notice }) => notice.type),
    ["welcome", "queued", "paired"],
    "the whole notice goes, not the chat line: the book decides which ones play — the welcome too"
  );
  assert.equal(forA[2].notice.countdownSeconds, 10, "with the fields a {param} fills from");
  assert.equal(forA[2].notice.opponent, B, "A's own notice, about B, on A's own floor");
});

test("a notice the screen already said is not said again in chat", async () => {
  const { join, said, flush } = setup({
    show: (session, notice) => ({ replacesChat: notice.type === "queued" }),
  });
  await join(A);
  await flush();
  assert.ok(said(A).every((line) => !/looking for an opponent/.test(line)), "the banner said it");
});

test("an effect that fails costs nothing else: the chat line still goes", async () => {
  const { join, said, flush } = setup({
    show: () => {
      throw new Error("a broken effect");
    },
  });
  await join(A);
  await flush();
  assert.ok(said(A).some((line) => /looking for an opponent/.test(line)));
});

test("clearing race floors tells the opponent, and clearing the last one wins", async () => {
  const context = setup();
  const { join, service, at, said, sessions, flush, adapter } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  at(15);
  adapter.hooks.heroRequested(sessions.get(A));
  adapter.hooks.heroRequested(sessions.get(B));

  const a = sessions.get(A);
  at(60);
  assert.equal(adapter.hooks.floorCompleting(a), true);
  a.floorIndex = 2;
  await flush();
  assert.ok(said(B).some((line) => /opponent cleared floor 1 of 2/.test(line)));

  at(120);
  adapter.hooks.floorCompleting(a);
  await flush();
  assert.ok(said(A).some((line) => /you won \(faster time\), 1:45\.0; your rival had not finished\. \w+ \d+ \(\+\d+\)\./.test(line)));
  assert.ok(said(B).some((line) => /you lost/.test(line)));
});

/** Both in the race, on its first floor, with the clock running. */
const racing = async (context) => {
  const { join, service, at, sessions, adapter } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  at(15);
  adapter.hooks.heroRequested(sessions.get(A));
  adapter.hooks.heroRequested(sessions.get(B));
};

test("the rival winning ends the loser's run, the way a wiped party's ends", async () => {
  const context = setup();
  const { at, sessions, adapter, defeated, flush } = context;
  await racing(context);

  const a = sessions.get(A);
  at(60);
  adapter.hooks.floorCompleting(a);
  a.floorIndex = 2;
  at(120);
  adapter.hooks.floorCompleting(a);
  await flush();

  assert.deepEqual(defeated, [B], "the loser's run ends; the winner's goes on to its own victory");
});

/** A clears both race floors, which wins it. */
const aWins = async ({ at, sessions, adapter, flush }) => {
  const a = sessions.get(A);
  at(60);
  adapter.hooks.floorCompleting(a);
  a.floorIndex = 2;
  at(120);
  adapter.hooks.floorCompleting(a);
  await flush();
};

test("a defeat that finds the loser between floors is sent once the next floor is there", async () => {
  let floorThere = false;
  const tried = [];
  const context = setup({
    defeat: (session) => {
      tried.push(session.accountId);
      return floorThere;
    },
  });
  await racing(context);
  await aWins(context);
  assert.deepEqual(tried, [B], "tried at once, but B was loading a floor");

  context.adapter.sweep();
  assert.deepEqual(tried, [B, B], "and again a second later");
  floorThere = true;
  context.adapter.sweep();
  context.adapter.sweep();
  assert.deepEqual(tried, [B, B, B], "until it was delivered, and not after");
});

test("a beaten player's floor goes no further, not even through a door", async () => {
  const context = setup();
  await racing(context);
  await aWins(context);
  assert.equal(context.adapter.hooks.floorCompleting(context.sessions.get(B)), false);
});

test("a run that is already over is not ended again", async () => {
  // B's own run failed: that failure is B's defeat, and it is already on screen.
  const failed = setup();
  await racing(failed);
  failed.at(300);
  failed.adapter.hooks.runFailed(failed.sessions.get(B));
  failed.at(306);
  await failed.service.tick();
  await failed.flush();
  assert.equal(failed.service.statusOf(B).state, "idle", "the race was decided");
  assert.deepEqual(failed.defeated, []);

  // B walked out: there is no run left to end.
  const left = setup();
  await racing(left);
  left.at(300);
  left.adapter.hooks.runLeft(left.sessions.get(B), "left");
  left.at(306);
  await left.service.tick();
  await left.flush();
  assert.deepEqual(left.defeated, []);
});

test("a failed run, or walking out, is the race's loss", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  at(15);
  adapter.hooks.heroRequested(sessions.get(A));
  adapter.hooks.heroRequested(sessions.get(B));

  at(300);
  adapter.hooks.runFailed(sessions.get(A));
  at(306);
  await service.tick();
  assert.equal(service.statusOf(A).state, "idle");
  assert.ok(service.ratingOf(B).rating > service.ratingOf(A).rating);
});

test("leaving the lobby leaves the queue; leaving during the countdown cancels it", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter } = context;
  await join(A);
  adapter.hooks.runLeft(sessions.get(A), "left");
  assert.equal(service.statusOf(A).state, "idle");

  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(5);
  adapter.hooks.runLeft(sessions.get(A), "dropped");
  assert.equal(service.statusOf(B).state, "queued");
  assert.equal(service.join(A).reason, "cooldown");
});

test("idle in the lobby is not ready, and idle too long leaves the queue until they move", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter, said, flush } = context;
  const { session } = await join(A);
  await join(B);
  adapter.hooks.idle(session, true);
  at(1);
  await service.tick();
  assert.equal(service.statusOf(A).state, "queued", "an idle player is not paired");

  at(400);
  adapter.sweep();
  assert.equal(service.statusOf(A).state, "idle");
  await flush();
  assert.ok(said(A).some((line) => /idle, so you left the queue/.test(line)));

  adapter.hooks.idle(session, false);
  assert.equal(service.statusOf(A).state, "queued");
  assert.equal(adapter.hooks.idlingAllowed(sessions.get(A)), true);
});

test("a start that cannot find both players in their lobbies changes neither run", async () => {
  const context = setup();
  const { join, service, at, sessions } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  sessions.delete(B); // gone without a word reaching ranked
  at(11);
  await service.tick();
  assert.equal(sessions.get(A).floorIndex, 0);
  assert.equal(sessions.get(A).floorPlan.floors.length, 1);
  assert.equal(service.statusOf(A).state, "queued", "still on the lobby floor, so back in the queue");
});

test("the adapter puts MATCHMAKER on the friend list and online for every player", async () => {
  const { adapter, join } = setup();
  await join(A);
  const list = adapter.hooks.friendList([{ account_id: 5 }]);
  assert.equal(list[0].name, "MATCHMAKER (1)");
  assert.equal(list[0].current_dungeon, LOBBY);
  assert.equal(adapter.hooks.isSystemAccount(SYSTEM_FRIEND_ID), true);
});

test("MATCHMAKER heads the friend list, says how many wait, and replaces any stored copy", () => {
  const row = systemFriendRow({ waiting: 2, where: LOBBY });
  assert.equal(row.name, "MATCHMAKER (2)");
  assert.equal(row.trophies, 999);
  assert.equal(systemFriendRow().name, "MATCHMAKER");
  const list = withSystemFriend([{ account_id: 5 }, { account_id: SYSTEM_FRIEND_ID, name: "stale" }], row);
  assert.deepEqual(list.map((friend) => friend.account_id), [SYSTEM_FRIEND_ID, 5]);
  assert.equal(isSystemAccount("999"), true);
  assert.equal(isSystemAccount(A), false);
});

// --- How a race ends, edge by edge ---------------------------------------------------
//
// The core decides (race.js); these check that every decision reaches each run as
// the right ending, once: the game's own victory or defeat, or back to town.

/** Paired, started, and each clock running from that player's own first race floor. */
const raceUnderWay = async (context, { aStarts = 15, bStarts = 15, standing } = {}) => {
  const { join, service, at, sessions, adapter } = context;
  await join(A, { at: standing });
  await join(B, { at: standing });
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  for (const [id, when] of [[A, aStarts], [B, bStarts]].sort((x, y) => x[1] - y[1])) {
    at(when);
    adapter.hooks.heroRequested(sessions.get(id));
  }
};

/** Clears both race floors, the last at `when`: what the last floor's completion was answered. */
const clearsRace = (context, id, when) => {
  const { at, sessions, adapter } = context;
  const session = sessions.get(id);
  at(when - 1);
  adapter.hooks.floorCompleting(session);
  session.floorIndex = 2;
  at(when);
  return adapter.hooks.floorCompleting(session);
};

test("the result line carries both times, so who finished first is the server's clock", async () => {
  const both = setup();
  await raceUnderWay(both, { aStarts: 15, bStarts: 20 });
  clearsRace(both, A, 120);
  clearsRace(both, B, 122);
  await both.flush();
  const line = (id) => both.said(id).find((text) => /you (won|lost)/.test(text));
  assert.match(line(B), /you won \(faster time\), 1:42\.0 vs 1:45\.0\. \w+ \d+ \(\+\d+\)\./);
  assert.match(line(A), /you lost \(faster time\), 1:45\.0 vs 1:42\.0\. \w+ \d+ \(-\d+\)\./);

  const ahead = setup();
  await raceUnderWay(ahead);
  clearsRace(ahead, A, 120);
  await ahead.flush();
  assert.match(ahead.said(A).find((text) => /you won/.test(text)), /, 1:45\.0; your rival had not finished\./);
  assert.match(ahead.said(B).find((text) => /you lost/.test(text)), /, your rival's 1:45\.0\./);
});

test("a race that crosses a league says so on the result line", async () => {
  // Two wins over somebody else first put A at 1038, still Wooden; beating B,
  // at 1000, is worth 18 (rating.js): past 1050, into Silver.
  const records = createRecords({ storage: "memory" });
  for (let n = 0; n < 2; n++) {
    await records.append({ id: `earlier-${n}`, state: "finished", players: [A, 1000000909], winner: A, decidedAt: n });
  }
  const context = setup({ records });
  await context.service.load();
  await raceUnderWay(context);
  clearsRace(context, A, 120);
  await context.flush();
  assert.ok(context.said(A).some((line) => /\. Silver \d+ \(\+\d+\)\. Up to Silver!$/.test(line)), "up");
  assert.ok(context.said(B).some((line) => /\. Wooden \d+ \(-\d+\)\.$/.test(line)), "no league to fall from");
});

test("back in the lobby after a race, the welcome names the rating and the place", async () => {
  const context = setup({ ring: { x0: 100, y0: 100, x1: 200, y1: 200 } });
  await raceUnderWay(context, { standing: { x: 150, y: 150 } });
  clearsRace(context, A, 120);
  await context.flush();
  const before = context.said(A).length;
  await context.join(A, { at: { x: 40, y: 150 } });
  await context.flush();
  const [welcome] = context.said(A).slice(before);
  assert.match(welcome, /^Ranked: you are \w+ \d+, #1 of 2\. Stand in the skull ring to race; \/rank shows the board\.$/);
});

const finishes = (context, id) =>
  context.shown.filter(({ session, notice }) => session.accountId === id && notice.type === "finished").length;

test("a rival who walks out loses, and the one left wins with the game's victory, no door needed", async () => {
  const context = setup();
  await raceUnderWay(context);
  context.at(100);
  context.adapter.hooks.runLeft(context.sessions.get(A), "left");
  assert.deepEqual(context.won, [], "not yet: the draw window is open in case B goes out too");

  context.at(106);
  await context.service.tick();
  await context.flush();
  assert.deepEqual(context.won, [B]);
  assert.deepEqual(context.defeated, [], "A is gone; there is no run of A's to end");
  assert.ok(context.said(B).some((line) => /you won \(opponent out\)/.test(line)));
});

test("having won that way, reaching the exit after wins nothing twice", async () => {
  const context = setup();
  await raceUnderWay(context);
  context.at(100);
  context.adapter.hooks.runLeft(context.sessions.get(A), "left");
  context.at(106);
  await context.service.tick();
  const rating = context.service.ratingOf(B).rating;

  assert.equal(clearsRace(context, B, 110), false, "the floor is held: the victory is already on screen");
  await context.flush();
  assert.deepEqual(context.won, [B]);
  assert.equal(finishes(context, B), 1, "one result");
  assert.equal(context.service.ratingOf(B).rating, rating);
});

test("walking out, and the rival finishing inside the draw window: the rival wins by finishing", async () => {
  const context = setup();
  await raceUnderWay(context);
  context.at(100);
  context.adapter.hooks.runLeft(context.sessions.get(A), "left");
  assert.equal(clearsRace(context, B, 102), true, "B's own last floor completes: the game's victory");
  await context.flush();
  assert.deepEqual(context.won, [], "no second, forced victory");
  assert.equal(finishes(context, B), 1);
});

test("both walking out inside the draw window is a draw, and no ending is forced on anyone", async () => {
  const context = setup();
  await raceUnderWay(context);
  context.at(100);
  context.adapter.hooks.runLeft(context.sessions.get(A), "left");
  context.at(103);
  context.adapter.hooks.runLeft(context.sessions.get(B), "left");
  await context.flush();
  assert.deepEqual([context.won, context.defeated, context.sentHome], [[], [], []]);
  assert.ok(context.said(A).some((line) => /a draw \(both out\)/.test(line)));
});

test("dying is a loss like leaving: the rival's run ends in victory", async () => {
  const context = setup();
  await raceUnderWay(context);
  context.at(100);
  context.adapter.hooks.runFailed(context.sessions.get(A));
  context.at(106);
  await context.service.tick();
  assert.deepEqual(context.won, [B]);
  assert.deepEqual(context.defeated, [], "A's defeat is the one its own failure showed");
});

test("both dying inside the draw window is a draw; each already has its defeat", async () => {
  const context = setup();
  await raceUnderWay(context);
  context.at(100);
  context.adapter.hooks.runFailed(context.sessions.get(A));
  context.at(103);
  context.adapter.hooks.runFailed(context.sessions.get(B));
  await context.flush();
  assert.deepEqual([context.won, context.defeated, context.sentHome], [[], [], []]);
});

test("a victory that finds the winner between floors is sent once the next floor is there", async () => {
  let floorThere = false;
  const tried = [];
  const context = setup({
    victory: (session) => {
      tried.push(session.accountId);
      return floorThere;
    },
  });
  await raceUnderWay(context);
  context.at(100);
  context.adapter.hooks.runLeft(context.sessions.get(A), "left");
  context.at(106);
  await context.service.tick();
  context.adapter.sweep();
  floorThere = true;
  context.adapter.sweep();
  context.adapter.sweep();
  assert.deepEqual(tried, [B, B, B]);
});

test("a race cancelled while its floors load sends the one left home: nothing was raced", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter, flush } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  at(12);
  adapter.hooks.runLeft(sessions.get(A), "left");
  await flush();
  assert.deepEqual(context.sentHome, [B]);
  assert.deepEqual([context.won, context.defeated], [[], []]);
  assert.equal(service.statusOf(B).state, "idle", "not queued: B is no longer in a lobby");
});

test("a race cancelled during the countdown leaves the other in the lobby, queued again", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter, flush } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(5);
  adapter.hooks.runLeft(sessions.get(A), "left");
  await flush();
  assert.equal(service.statusOf(B).state, "queued");
  assert.deepEqual([context.won, context.defeated, context.sentHome], [[], [], []]);
});

test("a pairing called off in its countdown moves the one still waiting to a fresh lobby, not a black screen", async () => {
  // The game's own countdown cannot be stopped (FloorEndingGui): at zero the
  // client fades out and waits for a floor change, so the change has to come.
  const ring = { x0: 100, y0: 100, x1: 200, y1: 200 };
  const context = setup({
    ring,
    lobbySpawn: { x: 40, y: 150 },
    show: (session, notice) => ({ sent: notice.type === "paired" ? ["countdown"] : [], replacesChat: false }),
  });
  const { join, service, at, sessions, adapter, flush } = context;
  await join(A, { at: { x: 150, y: 150 } });
  await join(B, { at: { x: 150, y: 150 } });
  at(1);
  await service.tick();
  at(5);
  adapter.hooks.runLeft(sessions.get(A), "left");
  await flush();

  const b = sessions.get(B);
  assert.equal(b.floorIndex, 1, "the lobby floor ended into another");
  assert.equal(b.floorPlan.floors[1].authored, settings.lobbyFloor);
  assert.equal(b.floorPlan.floors.length, 2);
  assert.equal(service.statusOf(B).state, "queued", "still in line");
  assert.ok(insideRing(ring, b.floorPlan.floors[1].quiet.spawn), "so put down in the ring, where the line is");

  // The next pairing starts the race from there.
  b.heroPosition = b.floorPlan.floors[1].quiet.spawn;
  adapter.hooks.heroRequested(b);
  await join(1000000404, { at: { x: 150, y: 150 } });
  at(40);
  await service.tick();
  at(50);
  await service.tick();
  assert.equal(b.floorIndex, 2, "into the race, after both lobby floors");
});

test("without the game's countdown on screen, a called-off pairing changes no floor", async () => {
  const context = setup();
  await context.join(A);
  await context.join(B);
  context.at(1);
  await context.service.tick();
  context.at(5);
  context.adapter.hooks.runLeft(context.sessions.get(A), "left");
  await context.flush();
  assert.equal(context.sessions.get(B).floorIndex, 0);
});

test("the lines that have no banner are the book's too: a cancel, a cooldown, an idle player", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter, said, flush } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(5);
  adapter.hooks.runLeft(sessions.get(A), "left");
  await flush();
  assert.ok(said(B).some((line) => /^Ranked: race cancelled \(\w+\)\. You are back in the queue\.$/.test(line)));

  await join(A);
  await flush();
  assert.ok(said(A).some((line) => /^Ranked: you can queue again in \d+s\.$/.test(line)), "the one who left waits");

  adapter.hooks.idle(sessions.get(B), true);
  at(5 + 301);
  adapter.sweep();
  await flush();
  assert.ok(said(B).includes("Ranked: you were idle, so you left the queue. Move to join it again."));
});

test("a client that shows ranked notices itself is drawn nothing and kept them as data", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter, said, shown, flush } = context;
  await join(A);
  await flush();
  sessions.get(A).capabilities = ["ranked.notices@1"];
  const drawn = () => shown.filter(({ session }) => session === sessions.get(A)).length;
  const before = { drawn: drawn(), said: said(A).length };
  await join(B);
  at(1);
  await service.tick();
  await flush();
  assert.equal(drawn(), before.drawn, "nothing drawn since it said so");
  assert.equal(said(A).length, before.said, "and no chat line");
  const types = adapter.notices(A).map((notice) => notice.type);
  assert.ok(types.includes("paired"), "the pairing is kept, as data");
  assert.equal(adapter.notices(A).find((notice) => notice.type === "paired").opponent, B);
  assert.deepEqual(adapter.notices(B), [], "and nothing is kept for a client that did not say so");
});

test("the wording is the book's to change: a line reworded there is what is said", async () => {
  const words = { ...bookWords, line: (notice, params) => (notice.type === "queued" ? `Ranked: ${params.waiting} in line.` : bookWords.line(notice, params)) };
  const { join, said, flush } = setup({ words });
  await join(A);
  await flush();
  assert.ok(said(A).includes("Ranked: 1 in line."));
});

test("the time limit with nobody finished is a draw: both are sent home", async () => {
  const context = setup();
  await raceUnderWay(context);
  context.at(15 + 1800);
  await context.service.tick();
  await context.flush();
  assert.ok(context.said(A).some((line) => /^Ranked: Alice vs Bob: a draw \(time limit\)\. Wooden 1000 \(\+0\)\.$/.test(line)));
  assert.deepEqual(context.sentHome.sort(), [A, B].sort());
  assert.deepEqual([context.won, context.defeated], [[], []]);
});

test("the loser walking out during their defeat changes nothing", async () => {
  const context = setup();
  await raceUnderWay(context);
  assert.equal(clearsRace(context, A, 120), true);
  assert.deepEqual(context.defeated, [B]);
  const ratings = [context.service.ratingOf(A).rating, context.service.ratingOf(B).rating];

  context.at(125);
  context.adapter.hooks.runLeft(context.sessions.get(B), "left");
  await context.service.tick();
  await context.flush();
  assert.deepEqual([context.service.ratingOf(A).rating, context.service.ratingOf(B).rating], ratings);
  assert.equal(finishes(context, A), 1);
});

test("first over the line, having started earlier, waits: the rival's own clock may still beat it", async () => {
  // A's floor was ready at 15, B's at 20: B has until 125 to beat A's 105.
  const context = setup();
  await raceUnderWay(context, { aStarts: 15, bStarts: 20 });
  assert.equal(clearsRace(context, A, 120), false, "held at the exit, with no victory yet");
  assert.deepEqual([context.won, context.defeated], [[], []]);

  assert.equal(clearsRace(context, B, 124), true, "104 beats 105: B's own victory");
  assert.deepEqual(context.defeated, [A], "and A, held, is given the defeat — never a victory first");
  assert.deepEqual(context.won, []);
});

test("first over the line wins once the rival's time runs out, with the victory it was held for", async () => {
  const context = setup();
  await raceUnderWay(context, { aStarts: 15, bStarts: 20 });
  assert.equal(clearsRace(context, A, 120), false);
  context.at(125);
  await context.service.tick();
  assert.deepEqual(context.won, [A]);
  assert.deepEqual(context.defeated, [B]);
});

test("the same time to the millisecond is a draw, and both go home", async () => {
  const context = setup();
  await raceUnderWay(context, { aStarts: 15, bStarts: 20 });
  assert.equal(clearsRace(context, A, 120), false);
  assert.equal(clearsRace(context, B, 125), false, "105 and 105");
  assert.deepEqual(context.sentHome.sort(), [A, B].sort());
  assert.deepEqual([context.won, context.defeated], [[], []]);
});

// --- The lobby: its ring, its talk, and the report after ------------------------------

const C = 1000000303;
const RING = { x0: 100, y0: 100, x1: 200, y1: 200 };
const IN_RING = { x: 150, y: 150 };
const IN_STANDS = { x: 40, y: 150 };

test("the ring is the queue: out to the stands leaves it and says so, back in joins it again", async () => {
  const context = setup({ ring: RING });
  const { join, service, adapter, sessions, shown, said, flush } = context;
  await join(A, { at: IN_RING });
  assert.equal(service.statusOf(A).state, "queued", "spawned in the ring");

  sessions.get(A).heroPosition = IN_STANDS;
  adapter.sweep();
  await flush();
  assert.equal(service.statusOf(A).state, "idle");
  assert.ok(shown.some(({ notice }) => notice.type === "stands"), "the stands banner");
  assert.ok(said(A).some((line) => /in the stands/.test(line)), "and the line, for a client without our strings");

  sessions.get(A).heroPosition = IN_RING;
  adapter.sweep();
  assert.equal(service.statusOf(A).state, "queued");
});

test("the lobby draws its ring in skull piles and puts the hero down outside it", async () => {
  const { join } = setup({ ring: RING, lobbySpawn: IN_STANDS });
  const { session } = await join(A, { at: IN_STANDS });
  assert.deepEqual(session.floorPlan.floors, [
    { authored: settings.lobbyFloor, quiet: { npc: ringMarkers(RING), spawn: IN_STANDS } },
  ]);
});

test("arriving before the hero stands anywhere decides nothing: the first place it stands does", async () => {
  // The runtime asks for the hero before it has put it down (the log reads
  // ranked.queued, then the hero's generate): a missing position is not the ring.
  const outside = setup({ ring: RING });
  await outside.join(A, { at: undefined });
  assert.equal(outside.service.statusOf(A).state, "idle", "not queued on a guess");
  outside.sessions.get(A).heroPosition = IN_STANDS;
  outside.adapter.sweep();
  await outside.flush();
  assert.deepEqual(outside.shown.map(({ notice }) => notice.type), ["welcome", "stands"], "never shown the ring's banner");
  assert.equal(outside.said(A).filter((line) => /in the stands/.test(line)).length, 0, "the welcome said where to go");

  const inside = setup({ ring: RING });
  await inside.join(A, { at: undefined });
  inside.sessions.get(A).heroPosition = IN_RING;
  inside.adapter.sweep();
  assert.equal(inside.service.statusOf(A).state, "queued", "and standing in the ring is still the queue");
});

test("in the stands, moving about queues nobody; a step out during the countdown undoes nothing", async () => {
  const stands = setup({ ring: RING });
  await stands.join(A, { at: IN_STANDS });
  assert.equal(stands.service.statusOf(A).state, "idle", "spawned outside: not queued");
  await stands.flush();
  assert.ok(stands.shown.some(({ notice }) => notice.type === "stands"), "and told so on arrival, not only on leaving");
  assert.ok(stands.said(A).some((line) => /skull ring/.test(line)), "the line says where to go");
  stands.adapter.hooks.idle(stands.sessions.get(A), true);
  stands.adapter.hooks.idle(stands.sessions.get(A), false);
  assert.equal(stands.service.statusOf(A).state, "idle", "moving in the stands is not stepping into the ring");

  const paired = setup({ ring: RING });
  await paired.join(A, { at: IN_RING });
  await paired.join(B, { at: IN_RING });
  paired.at(1);
  await paired.service.tick();
  paired.sessions.get(A).heroPosition = IN_STANDS;
  paired.adapter.sweep();
  paired.at(11);
  await paired.service.tick();
  assert.equal(paired.sessions.get(A).floorIndex, 1, "the race went ahead: the countdown had decided it");
});

test("a line said in a lobby reaches everybody else waiting, and no racer", async () => {
  const relayed = [];
  const context = setup({
    relay: (speaker, line, listeners) => relayed.push([speaker.accountId, line, listeners.map((l) => l.accountId)]),
  });
  const { join, service, at, adapter, sessions } = context;
  await join(A);
  await join(B);
  adapter.hooks.heroEvent(sessions.get(A), { type: "said", line: "anyone up for it?" });
  assert.deepEqual(relayed, [[A, "anyone up for it?", [B]]], "not back to the speaker");

  at(1);
  await service.tick();
  at(11);
  await service.tick();
  await join(C);
  adapter.hooks.heroEvent(sessions.get(C), { type: "said", line: "hello?" });
  assert.equal(relayed.length, 1, "the racers do not hear the lobby");
  adapter.hooks.heroEvent(sessions.get(A), { type: "said", line: "racing!" });
  assert.deepEqual(relayed[1], [A, "racing!", [B]], "a racer's line reaches the rival alone");
});

test("a racer's own report row carries what the race did to their rating; the chat line names the rival", async () => {
  const context = setup();
  const { adapter, sessions, said, flush } = context;
  await raceUnderWay(context);
  sessions.get(A).dungeonAccount = { name: "Alice" };
  sessions.get(B).dungeonAccount = { name: "Bob" };
  clearsRace(context, A, 120);
  await flush();

  const own = (id) => [{ id: 1, name: sessions.get(id)?.dungeonAccount?.name ?? "?" }];
  const report = (id) => adapter.hooks.reportRows(sessions.get(id) ?? { accountId: id }, own(id), { success: true, reportOf: () => null });
  assert.match(report(A)[0].name, /^Alice \+\d+$/);
  assert.match(report(B)[0].name, /^Bob -\d+$/);
  const plain = [{ id: 1, name: "Someone" }];
  assert.equal(adapter.hooks.reportRows({ accountId: 42 }, plain), plain, "an ordinary run keeps its report");

  assert.ok(said(A).some((line) => /^Ranked: Alice vs Bob: you won/.test(line)), "the log keeps who raced whom");
});

test("a finish leaves a gift from MATCHMAKER on each racer's account, by result, and the line says so", async () => {
  const coins = { offerId: 51101, name: "1000 Coins" };
  const context = setup({ extraSettings: { rewards: { win: { "*": { offerId: 51102, name: "3500 Coins" } }, loss: { "*": coins } } } });
  const { sessions, said, flush } = context;
  await raceUnderWay(context);
  sessions.get(A).dungeonAccount = { id: A, name: "Alice", gifts: [] };
  sessions.get(B).dungeonAccount = { id: B, name: "Bob" };
  clearsRace(context, A, 120);
  await flush();

  const [won] = sessions.get(A).dungeonAccount.gifts;
  const [lost] = sessions.get(B).dungeonAccount.gifts;
  assert.deepEqual([won.offer_id, won.from_account_id], [51102, SYSTEM_FRIEND_ID], "the winner's prize, from MATCHMAKER");
  assert.deepEqual([lost.offer_id, lost.from_account_id], [51101, SYSTEM_FRIEND_ID], "the loser's smaller one");
  assert.ok(said(A).some((line) => /you won.* A gift of 3500 Coins waits in town\.$/.test(line)), said(A).join("\n"));
  assert.ok(said(B).some((line) => /you lost.* A gift of 1000 Coins waits in town\.$/.test(line)), said(B).join("\n"));
});

test("with no prizes configured, a finish leaves no gift and the line ends as it did", async () => {
  const context = setup();
  const { sessions, said, flush } = context;
  await raceUnderWay(context);
  sessions.get(A).dungeonAccount = { id: A, name: "Alice" };
  sessions.get(B).dungeonAccount = { id: B, name: "Bob" };
  clearsRace(context, A, 120);
  await flush();
  assert.equal(sessions.get(A).dungeonAccount.gifts, undefined);
  assert.ok(said(A).some((line) => /you won.*\)\.( Up to \w+!)?$/.test(line)), said(A).join("\n"));
});

test("the rival's row on the report: read live while they race, as they began once they have gone", async () => {
  const named = async (context) => {
    const { join, service, at, sessions, adapter } = context;
    await join(A);
    await join(B);
    sessions.get(A).dungeonAccount = { name: "Alice" };
    sessions.get(B).dungeonAccount = { name: "Bob" };
    at(1);
    await service.tick();
    at(11);
    await service.tick();
    at(15);
    adapter.hooks.heroRequested(sessions.get(A));
    adapter.hooks.heroRequested(sessions.get(B));
  };

  const mine = [{ id: 1, name: "Alice" }];
  const stayed = setup();
  await named(stayed);
  clearsRace(stayed, A, 120);
  const readFrom = [];
  const live = stayed.adapter.hooks.reportRows(stayed.sessions.get(A), mine, {
    success: true,
    reportOf: (context, won) => (readFrom.push([context.accountId, won]), { name: context.dungeonAccount.name, kills: 9 }),
  });
  assert.deepEqual(readFrom, [[B, false]], "Bob is still in his run: his row is read from it, as a loser's");
  assert.equal(live[1].kills, 9);
  assert.equal(live[1].transient, true, "a row for somebody not in this run");
  assert.match(live[1].name, /^Bob -\d+$/, "named, with what the race did to him");

  const left = setup();
  await named(left);
  left.at(100);
  left.adapter.hooks.runLeft(left.sessions.get(B), "left");
  left.at(106);
  await left.service.tick();
  const gone = left.adapter.hooks.reportRows(left.sessions.get(A), mine, { success: true, reportOf: () => assert.fail("read live") });
  assert.equal(gone[1].weaponType1, 5, "Bob has gone: his build as the race began");
  assert.match(gone[1].name, /^Bob -\d+$/);

  assert.equal(left.adapter.hooks.reportRows({ accountId: 42 }, mine), mine);
});

/**
 * `start` reads the race's floors from disk before it touches either run. A
 * player who drops while it reads has cancelled the race: the survivor is back
 * in the queue and must be left standing in their lobby, not moved alone into
 * a race the service no longer knows.
 */
test("a drop while the race's floors are being read leaves the survivor queued in their lobby", async () => {
  let release;
  const floors = new Promise((resolve) => {
    release = resolve;
  });
  const context = setup({ raceFloors: () => floors });
  const { join, service, at, sessions, adapter } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(11);
  const starting = service.tick(); // begin → start, now awaiting the floors
  await context.flush();
  adapter.hooks.runLeft(sessions.get(B), "dropped");
  release([{ generated: { tileLibrary: "nordic", seed: 1 }, node: { Id: 50006 } }]);
  await starting;

  const a = sessions.get(A);
  assert.equal(a.floorIndex, 0, "still on the lobby floor");
  assert.equal(a.floorPlan.floors.length, 1, "no race floors were added");
  assert.equal(adapter.players.get(A).phase, "lobby");
  assert.equal(adapter.players.get(A).releasing, undefined);
  assert.equal(service.statusOf(A).state, "queued");
  assert.equal(adapter.hooks.floorCompleting(a), false, "the lobby still holds");
});

/**
 * A pairing called off during its countdown re-lobbies the player, which is a
 * floor transition. Until the new lobby floor stands they cannot start a race,
 * so they are not ready; the floor's hero request makes them ready again. And
 * a transition that cannot begin — the floor is already ending — changes
 * nothing: the plan is put back and the lobby still holds.
 */
test("re-lobbying after a cancelled countdown keeps the player unready until the new floor stands", async () => {
  const countdownShown = () => ({ sent: ["countdown"], skipped: [], replacesChat: false });
  const context = setup({ show: countdownShown });
  const { join, service, at, sessions, adapter } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  assert.equal(adapter.players.get(A).countingDown, true);

  at(5);
  adapter.hooks.runLeft(sessions.get(B), "dropped");
  const a = sessions.get(A);
  assert.equal(a.floorIndex, 1, "moved on to a fresh lobby floor");
  assert.equal(a.floorPlan.floors.length, 2);
  assert.equal(adapter.players.get(A).releasing, false);
  assert.equal(service.queue.entry(A)?.ready, false, "not pairable mid-transition");
  at(6);
  await service.tick();
  assert.equal(service.statusOf(A).state, "queued");

  adapter.hooks.heroRequested(a);
  assert.equal(service.queue.entry(A)?.ready, true, "ready once the new lobby floor stands");
  assert.equal(adapter.hooks.floorCompleting(a), false, "and the lobby still holds");
});

test("a re-lobby that cannot begin puts the plan back and leaves the lobby holding", async () => {
  const countdownShown = () => ({ sent: ["countdown"], skipped: [], replacesChat: false });
  const context = setup({ show: countdownShown });
  const { join, service, at, sessions, adapter } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  const a = sessions.get(A);
  a.floorFinished = true; // a transition already under way
  at(5);
  adapter.hooks.runLeft(sessions.get(B), "dropped");
  assert.equal(a.floorIndex, 0);
  assert.equal(a.floorPlan.floors.length, 1, "the plan was put back");
  assert.equal(a.floorPlan.floors.length, 1);
  assert.equal(a.floorCount, 1);
  assert.equal(adapter.players.get(A).releasing, false);
  a.floorFinished = false;
  assert.equal(adapter.hooks.floorCompleting(a), false, "the lobby still holds");
});

test("idle during the countdown is not paired again the moment the pairing is called off", async () => {
  const context = setup();
  const { join, service, at, sessions, adapter } = context;
  const { session: a } = await join(A);
  await join(B);
  at(1);
  await service.tick();
  adapter.hooks.idle(a, true);

  at(5);
  adapter.hooks.runLeft(sessions.get(B), "dropped");
  assert.equal(service.statusOf(A).state, "queued", "back in line");
  assert.equal(service.queue.entry(A).ready, false, "but idle, so not to be paired");

  const C = 1000000303;
  await join(C);
  at(6);
  await service.tick();
  assert.equal(service.statusOf(C).state, "queued", "nobody to pair with while A is idle");

  adapter.hooks.idle(a, false);
  at(7);
  await service.tick();
  assert.equal(service.statusOf(A).state, "in_race");
});

test("a player who leaves takes their kept notices with them, and a JOIN that led nowhere is forgotten", async () => {
  const context = setup();
  const { service, at, sessions, adapter } = context;
  const request = adapter.hooks.routeEntry({ accountId: A }, { mapNodeId: 0, friendId: SYSTEM_FRIEND_ID, mapId: 0 });
  const plan = await adapter.hooks.planFor({ accountId: A }, request.mapNodeId);
  const session = { accountId: A, floorIndex: 0, floorPlan: plan, floorCount: 1, capabilities: ["ranked.notices@1"] };
  sessions.set(A, session);
  adapter.hooks.heroRequested(session);
  assert.ok(adapter.notices(A).length > 0, "a client that shows its own notices is kept them");
  adapter.hooks.runLeft(session, "left");
  assert.deepEqual(adapter.notices(A), []);

  adapter.hooks.routeEntry({ accountId: B }, { mapNodeId: 0, friendId: SYSTEM_FRIEND_ID, mapId: 0 });
  at(61);
  adapter.sweep();
  assert.equal(await adapter.hooks.planFor({ accountId: B }, LOBBY), null, "the mark did not outlive its entry");
  assert.equal(service.statusOf(B).state, "idle");
});

/**
 * The race ghost (docs/ranked.md, "The race ghost"): the rival's copy in a
 * racer's own run, shown to whoever entered the room first. The runtime hands
 * the adapter positions as they are accepted; a session here carries what a
 * copy touches, as the lobby copies' tests do.
 */
const ghostFrames = {
  player: (details) => ({ kind: "player", ...details }),
  hero: (details) => ({ kind: "hero", ...details }),
  position: (doid, at) => ({ kind: "position", doid, at: { ...at } }),
  heading: (doid, heading) => ({ kind: "heading", doid, heading }),
  afk: (doid, afk) => ({ kind: "afk", doid, afk }),
  attack: (doid, payload, skinType) => ({ kind: "attack", doid, payload, skinType }),
  stopAttack: (doid) => ({ kind: "stopAttack", doid }),
  buff: (details) => ({ kind: "buff", ...details }),
  disable: (doid) => ({ kind: "disable", doid }),
};
const SHADE = 35092;

/** A and B into a race, both race floors built, with everything a copy touches on each session. */
const ghostRace = async ({ startGap, ...options } = {}) => {
  const context = setup({
    copyFrames: ghostFrames,
    extraSettings: { raceGhost: { buff: SHADE, name: "RIVAL", graceMs: 2000, showMs: 3000 }, lobbyCopies: 0 },
    ...options,
  });
  options.startGap = startGap;
  const { join, service, at, sessions, adapter } = context;
  await join(A);
  await join(B);
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  for (const [i, id] of [A, B].entries()) {
    let doid = 9000 + i * 100;
    Object.assign(sessions.get(id), {
      floorDoid: 500 + i,
      areaDoid: 400,
      dungeonZone: 10,
      objects: new Map(),
      allocateDoid: () => (doid += 1),
      sent: [],
      sendDirect(frame) {
        this.sent.push(frame);
      },
      heroSpawn: { heroType: 101, skinType: 151 + i, scale: 1.176 },
      heroPosition: { x: 100, y: 100 },
      heroHeading: 0,
      idleState: null,
    });
  }
  at(15);
  adapter.hooks.heroRequested(sessions.get(A));
  // B's floor may be ready later: their clock then runs behind A's by `startGap` seconds.
  at(15 + (options.startGap ?? 0));
  adapter.hooks.heroRequested(sessions.get(B));
  const sentTo = (id, kind) => sessions.get(id).sent.filter((frame) => !kind || frame.kind === kind);
  const move = (id, x, y) => {
    sessions.get(id).heroPosition = { x, y };
    adapter.hooks.heroEvent(sessions.get(id), { type: "moved", position: { x, y } });
  };
  return { ...context, sentTo, move };
};

test("the race ghost: whoever enters a room first is shown the one who follows, who is shown nobody", async () => {
  const { adapter, at, move, sentTo, shown } = await ghostRace();
  at(20);
  move(A, 100, 100);
  at(25);
  move(B, 150, 120); // the same room, five seconds behind
  adapter.sweep();

  const [hero] = sentTo(A, "hero");
  assert.ok(hero, "A, first in, is shown B");
  assert.equal(hero.screenName, "RIVAL");
  const [shade] = sentTo(A, "buff");
  assert.equal(shade.buffType, SHADE, "drawn as a shade");
  assert.equal(shade.affectedActor, hero.doid);
  assert.equal(sentTo(B, "hero").length, 0, "B, following, is shown nobody");
  assert.equal(shown.filter((s) => s.session.accountId === A && s.notice.type === "rival_seen").length, 1);

  at(30);
  move(B, 1000, 100); // out through the door
  adapter.sweep();
  const [player] = sentTo(A, "player");
  assert.deepEqual(sentTo(A, "disable").map((frame) => frame.doid), [shade.doid, hero.doid, player.doid], "the shade goes with the room");

  at(35);
  move(A, 1000, 120); // A follows: now B was first in
  adapter.sweep();
  assert.equal(sentTo(B, "hero").length, 1, "B is shown A on their heels");
  assert.equal(sentTo(A, "hero").length, 1, "and A is shown nothing new");

  at(40);
  move(A, 2000, 100);
  at(45);
  move(B, 2000, 100);
  adapter.sweep();
  assert.equal(sentTo(A, "hero").length, 2, "shown again in a later room");
  assert.equal(shown.filter((s) => s.session.accountId === A && s.notice.type === "rival_seen").length, 1, "but told only once");
});

test("the ghost is a moment: shown for showMs after the follower came in, then gone, back in the next room", async () => {
  const { adapter, at, move, sentTo } = await ghostRace();
  at(20);
  move(A, 100, 100);
  at(25);
  move(B, 150, 120); // five seconds behind
  adapter.sweep();
  const [hero] = sentTo(A, "hero");
  assert.ok(hero, "shown on arrival");
  at(27);
  adapter.sweep();
  assert.equal(sentTo(A, "disable").length, 0, "still there two seconds in");
  at(29);
  adapter.sweep();
  assert.ok(sentTo(A, "disable").some((frame) => frame.doid === hero.doid), "gone after three, though B still stands there");
  at(30);
  adapter.sweep();
  assert.equal(sentTo(A, "hero").length, 1, "and not shown again for standing there");

  at(31);
  move(A, 1000, 100);
  at(37);
  move(B, 1000, 120); // follows into the next room
  adapter.sweep();
  assert.equal(sentTo(A, "hero").length, 2, "shown again for a moment in the next room");
});

test("the start's zoom is brought home a moment after the start, from the sweep", async () => {
  const { adapter, at, shown } = await ghostRace();
  const settles = () => shown.filter((s) => s.session.accountId === A && s.notice.type === "started_settle").length;
  assert.equal(settles(), 0, "not with the start itself");
  at(16);
  adapter.sweep();
  assert.equal(settles(), 0, "nor a second in: the zoom is still tweening");
  at(17);
  adapter.sweep();
  assert.equal(settles(), 1, "a second and a half after the start");
  at(20);
  adapter.sweep();
  assert.equal(settles(), 1, "once");
});

test("two who enter a room together are shown nothing of each other", async () => {
  const { adapter, at, move, sentTo } = await ghostRace();
  at(20);
  move(A, 100, 100);
  at(21);
  move(B, 120, 110);
  adapter.sweep();
  assert.equal(sentTo(A, "hero").length, 0);
  assert.equal(sentTo(B, "hero").length, 0);
});

test("over the line, a racer is shown the rival wherever they are on the floor: the wait is watching", async () => {
  // B's floor was ready ten seconds after A's: when A crosses, B's own clock is still short of A's time.
  const { adapter, at, move, sentTo, sessions } = await ghostRace({ startGap: 10 });
  sessions.get(A).floorIndex = 2;
  sessions.get(B).floorIndex = 2;
  at(50);
  move(A, 100, 100);
  at(60);
  move(B, 3000, 100); // another room, which A would otherwise never be shown
  adapter.sweep();
  assert.equal(sentTo(A, "hero").length, 0);

  assert.equal(adapter.hooks.floorCompleting(sessions.get(A)), false, "A crosses the line; the race waits on B's clock");
  adapter.sweep();
  assert.equal(sentTo(A, "hero").length, 1, "and A watches B's last stretch");
  assert.equal(sentTo(B, "hero").length, 0, "B is still shown nobody");
});

test("racing, a line reaches the rival alone — unless the server keeps the racers quiet", async () => {
  const relayed = [];
  const relay = (speaker, line, listeners) => relayed.push([speaker.accountId, line, listeners.map((l) => l.accountId)]);
  const talking = await ghostRace({ relay });
  talking.adapter.hooks.heroEvent(talking.sessions.get(A), { type: "said", line: "gl hf" });
  assert.deepEqual(relayed, [[A, "gl hf", [B]]]);

  relayed.length = 0;
  const quiet = await ghostRace({ relay, extraSettings: { raceGhost: null, raceChat: false, lobbyCopies: 0 } });
  quiet.adapter.hooks.heroEvent(quiet.sessions.get(A), { type: "said", line: "gl hf" });
  assert.deepEqual(relayed, []);
});

test("the gate: a least hero level and the tutorial, both off unless the operator says", async () => {
  const open = setup();
  assert.deepEqual(await open.adapter.hooks.entryAllowed({ id: A }), { ok: true });

  const barred = setup({
    extraSettings: { entry: { minHeroLevel: 5, requireTutorial: true } },
    heroLevelOf: async (account) => account.level,
    tutorialDoneFor: (account) => account.tutorial === true,
  });
  const { entryAllowed } = barred.adapter.hooks;
  assert.equal((await entryAllowed({ level: 3, tutorial: true })).ok, false);
  assert.match((await entryAllowed({ level: 3, tutorial: true })).reason, /level 3 is under 5/);
  assert.match((await entryAllowed({ level: 9, tutorial: false })).reason, /tutorial/);
  assert.deepEqual(await entryAllowed({ level: 9, tutorial: true }), { ok: true });
});

test("/draw reaches the race only from a racer", async () => {
  const context = setup();
  const { join, service, adapter, sessions, at } = context;
  await join(A);
  assert.equal(adapter.hooks.drawOffered(sessions.get(A)), false, "a lobby is not a race");
  await join(B);
  at(1);
  await service.tick();
  at(11);
  await service.tick();
  at(15);
  adapter.hooks.heroRequested(sessions.get(A));
  adapter.hooks.heroRequested(sessions.get(B));
  assert.equal(adapter.hooks.drawOffered(sessions.get(A)), true);
  assert.equal(adapter.hooks.drawOffered(sessions.get(B)), true);
  assert.equal(service.statusOf(A).state, "idle", "called off together");
});

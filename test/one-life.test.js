import assert from "node:assert/strict";
import test from "node:test";

import { ONE_LIFE_MODE, ONE_LIFE_RUN_RULES, createOneLife, installOneLifeCommands } from "../src/modes/one-life/index.js";
import { installModeHooks, modeHooks } from "../src/modes/hooks.js";
import { STOCK_RUN_RULES, rulesOfMode, runRulesOf } from "../src/socket/run-rules.js";
import { commands, resetCommands, runCommand } from "../src/socket/commands.js";
import { handleProposeSelfRevive } from "../src/socket/revive.js";
import { beginFloorFailing, clearFloorFailing } from "../src/socket/floorstate.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";
import { createEffectBook, eventForNotice } from "../src/socket/ui-effects.js";
import { fileURLToPath } from "node:url";

/**
 * One life (src/modes/one-life): the worked example of a mode. A set of
 * answers on the seam, one command, two events in the book — and one run
 * rule, `revives`, that the core reads where a hero gets back up.
 */
const installed = (t, mode = createOneLife()) => {
  t.after(installModeHooks(ONE_LIFE_MODE, mode.hooks));
  return mode;
};

const fieldOf = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  reader.u32();
  return { fieldId: reader.u16(), reader };
};

test("the rules: no revives and nobody joining; everything else the game's own", () => {
  assert.equal(ONE_LIFE_RUN_RULES.mode, ONE_LIFE_MODE);
  assert.equal(ONE_LIFE_RUN_RULES.revives, false);
  assert.equal(ONE_LIFE_RUN_RULES.joinable, false);
  assert.deepEqual(ONE_LIFE_RUN_RULES.pays, STOCK_RUN_RULES.pays, "it pays what any dungeon pays");
  assert.deepEqual(
    [ONE_LIFE_RUN_RULES.unlockCheck, ONE_LIFE_RUN_RULES.mapCredit, ONE_LIFE_RUN_RULES.rankable],
    [true, true, true]
  );
  assert.equal(STOCK_RUN_RULES.revives, true, "the game as shipped revives");
});

test("/onelife arms the next entry only: routed once, then the player is ordinary again", async (t) => {
  const mode = installed(t);
  const request = { mapNodeId: 50005, friendId: 0 };
  assert.equal(modeHooks.routeEntry({ accountId: 7 }, request), request, "unarmed: the request as it came");

  assert.equal(mode.toggle(7), true);
  assert.deepEqual(modeHooks.routeEntry({ accountId: 7 }, request), { ...request, mode: ONE_LIFE_MODE });
  assert.equal(modeHooks.routeEntry({ accountId: 7 }, request), request, "one entry, not every entry after");
  assert.equal(modeHooks.routeEntry({ accountId: 8 }, request), request, "somebody else's entry is their own");

  assert.equal(mode.toggle(7), true);
  assert.equal(mode.toggle(7), false, "said again, called off");
  assert.equal(modeHooks.routeEntry({ accountId: 7 }, request), request);
});

test("the rules answer by the mark on the session and by the mode's name", (t) => {
  installed(t);
  assert.equal(runRulesOf({ modeEntry: ONE_LIFE_MODE }), ONE_LIFE_RUN_RULES);
  assert.equal(runRulesOf({ modeEntry: null }), STOCK_RUN_RULES);
  assert.equal(rulesOfMode(ONE_LIFE_MODE), ONE_LIFE_RUN_RULES);
  assert.equal(rulesOfMode("ranked"), STOCK_RUN_RULES, "another mode's name is not this mode's to answer");
});

test("the player is told on the first floor, and when the run is lost; a banner shown spares the chat line", (t) => {
  const shown = [];
  const said = [];
  const mode = createOneLife({
    show: (session, notice) => (shown.push(notice.type), { replacesChat: notice.type === "entered" }),
    say: (session, text) => said.push(text),
    line: (notice) => `line:${notice.type}`,
  });
  installed(t, mode);
  modeHooks.heroRequested({ modeEntry: ONE_LIFE_MODE, floorIndex: 0 });
  modeHooks.heroRequested({ modeEntry: ONE_LIFE_MODE, floorIndex: 1 });
  modeHooks.heroRequested({ modeEntry: null, floorIndex: 0 });
  modeHooks.runFailed({ modeEntry: ONE_LIFE_MODE });
  modeHooks.runFailed({ modeEntry: "ranked" });
  assert.deepEqual(shown, ["entered", "lost"]);
  assert.deepEqual(said, ["line:lost"], "the banner said 'entered'; nothing shows a loss, so chat does");
});

test("the shipped book has both events' wording, under the mode's own name", () => {
  const book = createEffectBook(fileURLToPath(new URL("../config/ui-effects.json", import.meta.url)));
  assert.equal(eventForNotice({ mode: ONE_LIFE_MODE, type: "entered" }), "onelife.entered");
  assert.ok(book.events()["onelife.entered"].banner, "a banner for the first floor");
  assert.match(book.line({ mode: ONE_LIFE_MODE, type: "entered" }), /no revives/i);
  assert.match(book.line({ mode: ONE_LIFE_MODE, type: "lost" }), /fell/);
  assert.equal(eventForNotice({ type: "queued" }), "ranked.queued", "a notice naming no mode is ranked's, as before");
});

test("the command: in town it arms and disarms; in a dungeon, or on a match worker, it points home", async () => {
  resetCommands();
  const mode = createOneLife();
  const replies = [];
  const reply = (line) => replies.push(line);
  reply.warn = (line) => replies.push(`warn: ${line}`);
  const uninstall = installOneLifeCommands({ toggle: mode.toggle });
  try {
    assert.deepEqual(commands().map((c) => [c.name, c.mode]), [["onelife", ONE_LIFE_MODE]]);
    const town = { accountId: 7, dungeonAccount: { rank: 0 } };
    await runCommand(town, "/onelife", reply);
    assert.match(replies.at(-1), /^one life: your next dungeon/);
    assert.equal(mode.armed(7), true);
    await runCommand(town, "/onelife", reply);
    assert.match(replies.at(-1), /^one life: off/);
    assert.equal(mode.armed(7), false);

    await runCommand({ ...town, dungeonActive: true, areaDoid: 1 }, "/onelife", reply);
    assert.match(replies.at(-1), /^warn: say \/onelife in town/);
    assert.equal(mode.armed(7), false);
  } finally {
    uninstall();
  }
  assert.deepEqual(commands(), [], "gone with the mode");

  const worker = installOneLifeCommands({ toggle: mode.toggle, where: "worker" });
  try {
    await runCommand({ accountId: 7, dungeonAccount: { rank: 0 } }, "/onelife", reply);
    assert.match(replies.at(-1), /^warn: say \/onelife in town/);
    assert.equal(mode.armed(7), false);
  } finally {
    worker();
    resetCommands();
  }
});

// --- The core's side of the rule: where a hero gets back up, and where a floor waits for it.

test("under no revives a bomb is refused before it is spent, and the hero stays down", async (t) => {
  installed(t);
  const sent = [];
  const heroDoid = 10;
  const session = {
    id: 7,
    areaDoid: 30,
    heroDoid,
    modeEntry: ONE_LIFE_MODE,
    dungeonAccount: { account_stackables: [{ stack_id: 60001, count: 3 }, { stack_id: 60018, count: 2 }] },
    queueAccountSave: () => {},
    heroManaPoints: 0,
    maxHeroManaPoints: 250,
    objects: new Map([[heroDoid, CLID.HeroGameObject]]),
    actors: new Map([[heroDoid, { hitPoints: 0, dead: true, maxHitPoints: 200, position: { x: 0, y: 0 } }]]),
    send: (frame) => sent.push(frame),
  };
  const reader = new PacketReader(Buffer.from([0]));
  assert.equal(await handleProposeSelfRevive(session, reader), true);
  const { fieldId, reader: body } = fieldOf(sent[0]);
  assert.equal(fieldId, 175, "the client is answered");
  assert.equal(body.u8(), 0, "no");
  assert.equal(sent.length, 1, "nothing else: no detonation, no hit points");
  assert.equal(session.actors.get(heroDoid).dead, true);
  assert.equal(session.dungeonAccount.account_stackables[0].count, 3, "the bomb is kept");
});

test("under no revives a floor with nobody standing is lost at once, with no countdown to wait out", (t) => {
  installed(t);
  const sent = [];
  const failed = [];
  const session = {
    id: 1,
    areaDoid: 4000,
    heroDoid: 77,
    modeEntry: ONE_LIFE_MODE,
    actors: new Map([[77, { dead: true }]]),
    send: (frame) => sent.push(frame),
    dungeonActive: true,
    reportFloorFailed: (target) => failed.push(target.id),
  };
  beginFloorFailing(session);
  assert.deepEqual(failed, [1]);
  assert.equal(session.floorFailingTimer ?? null, null, "no timer was started");
  assert.deepEqual(sent, [], "no floorfailing countdown went to the client");

  session.modeEntry = null;
  beginFloorFailing(session);
  assert.ok(session.floorFailingTimer, "an ordinary run gets its countdown");
  clearFloorFailing(session);
  assert.deepEqual(failed, [1], "and is not lost yet");
});

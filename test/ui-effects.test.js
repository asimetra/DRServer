import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SHAKE_PRESETS,
  createEffectBook,
  eventForNotice,
  playEffects,
} from "../src/socket/ui-effects.js";
import {
  buildCameraShake,
  buildCameraZoom,
  buildPlaySound,
  buildShowText,
} from "../src/socket/floorstate.js";
import { buffEffectReport } from "../src/socket/buffs.js";
import { buildFloorEnding } from "../src/socket/objects.js";
import { BANNER_CHARS, declaredUiStrings, parseStrings, stringsIdOf, tooLongForBanner } from "../src/socket/ui-strings.js";

/**
 * A member on a floor, recording where each frame went. `sendDirect` is the
 * member's own socket; `send` is the world, which in a party reaches everybody.
 */
const member = ({ floorDoid = 400, heroDoid = 500, areaDoid = 300, uiStrings = null, direct = true } = {}) => {
  const party = [];
  const own = [];
  const session = { id: 1, floorDoid, heroDoid, areaDoid, uiStrings, send: (frame) => party.push(frame) };
  if (direct) session.sendDirect = (frame) => own.push(frame);
  return { session, party, own };
};

/** Strings of the server's own, and a client that has them installed. */
const STRINGS = parseStrings({ RIVAL_FOUND: "RIVAL FOUND!", RIVAL_FLOOR_1: "FLOOR 1", RIVAL_FLOOR_2: "FLOOR 2" });
const withStrings = { strings: STRINGS };

const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

test("the shake presets are the game's own, measured from its floors", () => {
  // Lava Golem's stomp is the captured one; 14/25/10 is the strongest the
  // game authors anywhere; the Ice Dragon's 2/2/5 is the faintest.
  assert.deepEqual(SHAKE_PRESETS.light, [8, 12, 5]);
  assert.deepEqual(SHAKE_PRESETS.heavy, [14, 25, 10]);
  assert.deepEqual(SHAKE_PRESETS.subtle, [2, 2, 5]);
});

test("a named shake goes out as the floor's own camera-shake frame", () => {
  const { session, own } = member();
  const result = playEffects(session, { shake: "light" });

  assert.deepEqual(result.sent, ["shake"]);
  assert.ok(
    same(own[0], buildCameraShake(400, { shakeDuration: 8, shakeStrength: 12, shakeCount: 5 })),
    "built by the same builder the map's own shakes use"
  );
});

test("a raw [frames, strength, count] shake works as well as a preset", () => {
  const { session, own } = member();
  playEffects(session, { shake: [10, 13, 8] });
  assert.ok(same(own[0], buildCameraShake(400, { shakeDuration: 10, shakeStrength: 13, shakeCount: 8 })));
});

test("an unknown shake preset is skipped, not guessed at", () => {
  const { session, own, party } = member();
  const result = playEffects(session, { shake: "earthquake" });
  assert.equal(own.length + party.length, 0);
  assert.match(result.skipped[0], /shake/);
});

test("a banner fills {params} into one of the book's own keys", () => {
  const { session, own } = member({ uiStrings: STRINGS.id });
  playEffects(session, { banner: "RIVAL_FLOOR_{floor}" }, { floor: 2 }, withStrings);
  assert.ok(same(own[0], buildShowText(400, "RIVAL_FLOOR_2")));
});

test("a {param} key the strings do not cover moves on, rather than print mia:", () => {
  // The strings stop at floor 2; a third floor takes the next key in the list.
  const { session, own } = member({ uiStrings: STRINGS.id });
  playEffects(session, { banner: ["RIVAL_FLOOR_{floor}", "DEFEAT_THE_RIVAL"] }, { floor: 3 }, withStrings);
  assert.ok(same(own[0], buildShowText(400, "DEFEAT_THE_RIVAL")));

  const alone = member({ uiStrings: STRINGS.id });
  const result = playEffects(alone.session, { banner: "RIVAL_FLOOR_{floor}" }, { floor: 3 }, withStrings);
  assert.equal(alone.own.length, 0);
  assert.match(result.skipped[0], /banner/);
});

test("the book's own key reaches only a client that declared it holds the strings", () => {
  const spec = { banner: ["RIVAL_FOUND", "DEFEAT_THE_RIVAL"] };

  const declared = member({ uiStrings: STRINGS.id });
  playEffects(declared.session, spec, {}, withStrings);
  assert.ok(same(declared.own[0], buildShowText(400, "RIVAL_FOUND")));

  const stock = member();
  playEffects(stock.session, spec, {}, withStrings);
  assert.ok(same(stock.own[0], buildShowText(400, "DEFEAT_THE_RIVAL")), "the game's own key, which every client has");

  // Holding an older set of keys is not holding these: it could be missing one.
  const older = member({ uiStrings: "0badc0de" });
  const result = playEffects(older.session, { banner: "RIVAL_FOUND" }, {}, withStrings);
  assert.equal(older.own.length, 0);
  assert.match(result.skipped[0], /has not declared/);
});

test("a banner for the whole party is one of the game's own keys, whatever this member holds", () => {
  // The party is reached through the world, which cannot tell who installed
  // the strings: the book's key would print as mia: on a party mate's screen.
  const declared = member({ uiStrings: STRINGS.id });
  playEffects(declared.session, { banner: ["RIVAL_FOUND", "DEFEAT_THE_RIVAL"], to: "party" }, {}, withStrings);
  assert.equal(declared.party.length, 1);
  assert.ok(same(declared.party[0], buildShowText(400, "DEFEAT_THE_RIVAL")), "the game's key, not the book's");

  const alone = member({ uiStrings: STRINGS.id });
  const result = playEffects(alone.session, { banner: "RIVAL_FOUND", to: "party" }, {}, withStrings);
  assert.equal(alone.party.length + alone.own.length, 0);
  assert.match(result.skipped[0], /whole party/);
});

test("'self' reaches only this member; 'party' reaches the whole floor", () => {
  const solo = member();
  playEffects(solo.session, { sound: "LevelUp1" });
  assert.equal(solo.own.length, 1, "self is the default, and goes direct");
  assert.equal(solo.party.length, 0, "and not to the rest of the party");

  const shared = member();
  playEffects(shared.session, { sound: "LevelUp1", to: "party" });
  assert.equal(shared.party.length, 1, "party goes through the world");
  assert.ok(same(shared.party[0], buildPlaySound(400, "LevelUp1")));
});

test("off a floor, the floor's effects are skipped and the floater still goes", () => {
  // Town has no DistributedDungeonFloor: show_text, play_sound and the camera
  // fields exist only on a dungeon floor.
  const { session, own } = member({ floorDoid: 0 });
  const result = playEffects(session, {
    banner: "VICTORY",
    sound: "LevelUp1",
    shake: "light",
    floater: { amount: 3 },
  });

  assert.deepEqual(result.sent, ["floater"]);
  assert.equal(result.skipped.filter((r) => /no floor/.test(r)).length, 3);
  assert.equal(own.length, 1);
});

test("a floater always goes to the hero's owner, never the party", () => {
  const { session, own, party } = member();
  playEffects(session, { floater: { amount: "{seconds}", color: 2 }, to: "party" }, { seconds: 3 });

  assert.equal(party.length, 0, "the floater is drawn by the owner; nobody else needs it");
  assert.ok(
    same(own[0], buffEffectReport({ heroDoid: 500, actorDoid: 500, amount: 3, colorType: 2 })),
    "the same floater a damage-over-time tick draws"
  );
});

test("a zoom must be a positive number, and 'reset' is 1", () => {
  const { session, own } = member();
  const bad = playEffects(session, { zoom: -1 });
  assert.equal(own.length, 0);
  assert.match(bad.skipped[0], /zoom/);

  playEffects(session, { zoom: "reset" });
  assert.ok(same(own[0], buildCameraZoom(400, 1)));
});

test("a countdown is the game's own, drawn by the area's floor-ending field", () => {
  const { session, own } = member();
  const result = playEffects(session, { countdown: "{countdownSeconds}" }, { countdownSeconds: 5 });
  assert.deepEqual(result.sent, ["countdown"]);
  assert.ok(same(own[0], buildFloorEnding(300, 5)), "the same frame a door sends a party waiting at it");
});

test("a countdown needs an area, a sane length, and never an infinite dungeon", () => {
  const off = member({ areaDoid: 0 });
  assert.match(playEffects(off.session, { countdown: 5 }).skipped[0], /no dungeon area/);

  for (const seconds of [0, -3, 61, "soon"]) {
    const { session, own } = member();
    assert.match(playEffects(session, { countdown: seconds }).skipped[0], /not a usable value/);
    assert.equal(own.length, 0);
  }

  // The infinite dungeon's client reads the field as the floor done and adds
  // that floor's gold to the run's total.
  const infinite = member();
  infinite.session.infiniteDefinition = { id: 1 };
  assert.match(playEffects(infinite.session, { countdown: 5 }).skipped[0], /infinite/);
  assert.equal(infinite.own.length, 0);
});

test("replacesChat holds only when the spec asks for it and a banner went out", () => {
  const shown = member();
  assert.equal(playEffects(shown.session, { banner: "VICTORY", replacesChat: true }).replacesChat, true);

  const unasked = member();
  assert.equal(playEffects(unasked.session, { banner: "VICTORY" }).replacesChat, false);

  // Nothing on screen said it, so the chat line still has to.
  const withheld = member();
  assert.equal(
    playEffects(withheld.session, { banner: "RIVAL_FOUND", replacesChat: true }, {}, withStrings).replacesChat,
    false
  );
});

test("a client declares its strings in the Demographics it sends, as JSON or as the object", () => {
  assert.equal(declaredUiStrings(JSON.stringify({ contentPacks: ["knight@1"], uiStrings: "1a2b3c4d" })), "1a2b3c4d");
  assert.equal(declaredUiStrings({ uiStrings: "1a2b3c4d" }), "1a2b3c4d");
  for (const junk of [undefined, null, "", "{not json", { uiStrings: 7 }, { uiStrings: "../../x" }, "x".repeat(5000)]) {
    assert.equal(declaredUiStrings(junk), null);
  }
});

test("strings are named by their keys, not their words", () => {
  assert.equal(stringsIdOf({ A: "one", B: "two" }), stringsIdOf({ B: "changed", A: "words" }));
  assert.notEqual(stringsIdOf({ A: "one" }), stringsIdOf({ A: "one", B: "two" }));
  assert.throws(() => parseStrings({ "lower case": "x" }), /KEY_LIKE_THIS/);
  assert.throws(() => parseStrings({ EMPTY: " " }), /no text/);
  assert.equal(parseStrings({}).id, null);
});

test("a value that is not a number after filling does not reach the wire", () => {
  const { session, own } = member();
  const result = playEffects(session, { floater: { amount: "{missing}" } }, {});
  assert.equal(own.length, 0);
  assert.match(result.skipped[0], /floater/);
});

test("ranked notices name their events, and a finish names its result", () => {
  assert.equal(eventForNotice({ type: "queued", waiting: 3 }), "ranked.queued");
  assert.equal(eventForNotice({ type: "paired" }), "ranked.paired");
  assert.equal(eventForNotice({ type: "finished", result: "win" }), "ranked.finished.win");
  assert.equal(eventForNotice({ type: "finished", result: "loss" }), "ranked.finished.loss");
  assert.equal(eventForNotice({}), null);
});

/** A config file the test owns, removed afterwards. */
const tempBook = (t, contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-effects-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ui-effects.json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
};

test("an event plays what the book says for it", (t) => {
  const file = tempBook(t, { events: { "ranked.paired": { shake: "medium", sound: "LevelUp1" } } });
  const book = createEffectBook(file);
  const { session, own } = member();

  const result = book.playEvent(session, "ranked.paired");
  assert.deepEqual(result.sent.sort(), ["shake", "sound"]);
  assert.equal(own.length, 2);
});

test("an event the book does not mention is a quiet no-op", (t) => {
  const book = createEffectBook(tempBook(t, { events: {} }));
  const { session, own } = member();
  assert.doesNotThrow(() => book.playEvent(session, "nothing.here"));
  assert.equal(own.length, 0);
});

test("a book that is not JSON does not take the server down", (t) => {
  const book = createEffectBook(tempBook(t, "{ this is not json"));
  const { session, own } = member();
  assert.doesNotThrow(() => book.playEvent(session, "ranked.paired"));
  assert.equal(own.length, 0, "no events, rather than a crash");
});

test("editing the book applies without a restart, and a broken edit keeps the last good one", (t) => {
  const file = tempBook(t, { events: { e: { sound: "LevelUp1" } } });
  // Every call looks, rather than once a second, so each edit is seen at once.
  const book = createEffectBook(file, { checkEveryMs: 0 });
  const { session, own } = member();

  book.playEvent(session, "e");
  assert.ok(same(own.at(-1), buildPlaySound(400, "LevelUp1")));

  // A later mtime, so the change is seen.
  fs.writeFileSync(file, JSON.stringify({ events: { e: { sound: "GolemStomp" } } }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  book.playEvent(session, "e");
  assert.ok(same(own.at(-1), buildPlaySound(400, "GolemStomp")), "the edit is live");

  fs.writeFileSync(file, "{ broken");
  const latest = new Date(Date.now() + 10000);
  fs.utimesSync(file, latest, latest);
  book.playEvent(session, "e");
  assert.ok(same(own.at(-1), buildPlaySound(400, "GolemStomp")), "a broken edit keeps the last good book");
});

/**
 * The book this server ships, against the notices the ranked core really sends.
 *
 * The shapes below are copied from src/ranked/index.js, not from docs/ranked.md,
 * because the two disagree: the document lists a `countdown {seconds}` notice the
 * core never emits, and a `progress {opponentFloor}` whose field is really
 * `floor`. A book written to the document would have played nothing for either,
 * silently. This catches that kind of drift the day it happens.
 */
const SHIPPED = fileURLToPath(new URL("../config/ui-effects.json", import.meta.url));
const REAL_NOTICES = [
  // The stock adapter's own: the first time a race shows the rival's ghost.
  { type: "rival_seen" },
  // The rival asking to call the race off.
  { type: "draw_offered" },
  // One life's own (src/modes/one-life): the first floor's hero, and the run lost.
  { mode: "onelife", type: "entered" },
  { mode: "onelife", type: "lost" },
  // Delve's (examples/modes/delve): the first boss, each next one, a curse, a gift, the fall.
  { mode: "delve", type: "entered" },
  { mode: "delve", type: "boss", depth: 2, name: "Frostgaard Boss", level: 16, mods: "" },
  { mode: "delve", type: "cursed", curse: "BEEFY BROS" },
  { mode: "delve", type: "gift", beaten: 3, what: "1 Common Key" },
  { mode: "delve", type: "lost", depth: 4, beaten: 3 },
  { type: "queued", waiting: 1, ready: 0 },
  { type: "paired", race: "r", opponent: 2, opponentRating: 1500, countdownSeconds: 5 },
  { type: "started", race: "r" },
  // The stock adapter's own: the start's zoom brought home a moment later.
  { type: "started_settle" },
  { type: "progress", race: "r", floor: 2, of: 3 },
  { type: "finished", race: "r", result: "win", rating: 1520, ratingChange: 20 },
  { type: "finished", race: "r", result: "loss", rating: 1480, ratingChange: -20 },
  { type: "finished", race: "r", result: "draw", rating: 1500, ratingChange: 0 },
  { type: "cancelled", race: "r", reason: "left", requeued: true },
  // The adapter's own, not the core's: walking out of the lobby's ring.
  { type: "stands" },
];

test("every event the shipped book defines plays cleanly from a real notice", () => {
  const book = createEffectBook(SHIPPED);
  const reached = new Set();

  for (const notice of REAL_NOTICES) {
    const name = eventForNotice(notice);
    const { session } = member({ uiStrings: book.strings().id });
    const result = book.playEvent(session, name, notice);
    if (/^no event/.test(result.skipped[0] ?? "")) continue; // not every notice needs an effect
    reached.add(name);
    assert.deepEqual(
      result.skipped,
      [],
      `${name} skipped something on a floor: ${result.skipped.join("; ")}`
    );
    assert.ok(result.sent.length > 0, `${name} sent nothing`);
  }

  for (const name of Object.keys(book.events())) {
    assert.ok(reached.has(name), `"${name}" is in the book but no real notice reaches it`);
  }
});

test("every sound the shipped book names is one the game itself plays", (t) => {
  const gmFile = fileURLToPath(new URL("../content/Resources/Levels/DB_GameMaster.json", import.meta.url));
  if (!fs.existsSync(gmFile)) return t.skip("no compatibility data");
  const gm = JSON.parse(fs.readFileSync(gmFile, "utf8"));
  // Every *Sound column the game authors names a clip in soundEffects.swf.
  const known = new Set();
  for (const rows of Object.values(gm)) {
    for (const row of Object.values(rows ?? {})) {
      if (!row || typeof row !== "object") continue;
      for (const [key, value] of Object.entries(row)) {
        if (/sound$/i.test(key) && typeof value === "string" && value.trim()) known.add(value);
      }
    }
  }

  const sounds = Object.values(createEffectBook(SHIPPED).events())
    .map((spec) => spec.sound)
    .filter(Boolean);
  assert.ok(sounds.length > 0);
  for (const sound of sounds) {
    assert.ok(known.has(sound), `"${sound}" is not a sound the game ever plays`);
  }
});

test("a client without the strings is never sent one of them, so never sees mia:", () => {
  const book = createEffectBook(SHIPPED);
  const ours = [...book.strings().keys].map((key) => buildShowText(400, key));
  assert.ok(ours.length > 0, "the shipped book has strings of its own");

  for (const notice of REAL_NOTICES) {
    const { session, own, party } = member();
    const result = book.playEvent(session, eventForNotice(notice), notice);
    for (const frame of [...own, ...party]) {
      assert.ok(!ours.some((key) => same(frame, key)), `${notice.type} sent a key this client lacks`);
    }
    // A notice the book has no event for says nothing on screen, which is a choice (its line still says it).
    for (const reason of result.skipped) assert.match(reason, /^(banner: the client has not declared|no event)/);
  }
});

test("every string the shipped book defines fits on a banner, as the game's own do", () => {
  const { table } = createEffectBook(SHIPPED).strings();
  assert.deepEqual(tooLongForBanner(table), [], `longer than ${BANNER_CHARS} characters is cut off on screen`);
  assert.deepEqual(tooLongForBanner({ LONG: "IN THE RING - LOOKING FOR A RIVAL" }), ["LONG"], "the one that was");
});

test("a line fills from its event; one naming a param the event lacks says nothing; a missing part is empty", (t) => {
  const book = createEffectBook(tempBook(t, {
    lines: { "ranked.queued": "Ranked: {waiting} waiting{tail}." },
    parts: { tail: ", {who} first" },
  }));
  assert.equal(book.line({ type: "queued" }, { waiting: 2, tail: "" }), "Ranked: 2 waiting.");
  assert.equal(book.line({ type: "queued" }, { waiting: 2 }), null, "no {tail}: not said with a hole in it");
  assert.equal(book.line({ type: "paired" }, {}), null, "no line for the event");
  assert.equal(book.part("tail", { who: "Alice" }), ", Alice first");
  assert.equal(book.part("nowhere"), "");
  assert.equal(book.part("tail", {}), "", "a part missing a param is left out");
});

test("a line that is not text, or longer than a line can be, keeps the book from being used", (t) => {
  for (const lines of [{ "ranked.queued": 7 }, { "ranked.queued": "x".repeat(401) }]) {
    const book = createEffectBook(tempBook(t, { lines }));
    assert.equal(book.line({ type: "queued" }, {}), null);
  }
});

test("every line in the shipped book is one the server says, and every one it says has a line", () => {
  const shipped = JSON.parse(fs.readFileSync(SHIPPED, "utf8"));
  // The core's notices, and the stock adapter's own: its welcome, a cooldown, an idle player.
  const said = new Set([...REAL_NOTICES, { type: "welcome" }, { type: "cooldown" }, { type: "idle" }].map(eventForNotice));
  const lines = Object.keys(shipped.lines).filter((name) => !name.startsWith("_"));
  // Said with `line: false` by the adapter: a camera brought home has nothing to say.
  const silent = new Set(["ranked.started_settle"]);
  for (const name of lines) assert.ok(said.has(name), `the line "${name}" belongs to nothing the server says`);
  for (const name of said) if (!silent.has(name)) assert.ok(lines.includes(name), `nothing would be said for ${name}`);
});

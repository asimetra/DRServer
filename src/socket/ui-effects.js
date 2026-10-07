/**
 * What a game event shows the player, on a client nobody has changed.
 *
 * Chat is the only channel most server features reach for, and it is a poor
 * one: a ranked countdown scrolling past as three chat lines is information,
 * not a moment. The stock client draws more than chat on the server's say-so,
 * and every one of these is a field it already reads:
 *
 *   banner     DistributedDungeonFloor::show_text (201) — the big centred line
 *   sound      DistributedDungeonFloor::play_sound (202) — from soundEffects.swf
 *   zoom       DistributedDungeonFloor::trigger_camera_zoom (203)
 *   shake      DistributedDungeonFloor::trigger_camera_shake (204)
 *   countdown  DistributedDungionArea::floorEnding — the game's own 5-4-3-2-1
 *   floater    HeroGameObject::ReportBuffEffect (168) — a coloured number
 *
 * This module is the one place that knows how to send them, so nothing else
 * has to. What an event *does* is data, in `config/ui-effects.json`: a server
 * operator edits that file and the next event plays the new version, with no
 * restart and no code. See docs/race-ui-channels.md for why each channel and
 * not others.
 *
 * Two facts about the client decide the shape:
 *
 * The four floor fields exist only on a dungeon floor. Town has no
 * DistributedDungeonFloor and the town floor carries nothing but its tiles, so
 * off a floor those effects are skipped and the reason reported — a floater,
 * which rides the hero, still goes.
 *
 * And a match world broadcasts field updates on anything that is not a
 * PlayerGameObject (`publish` in match-world.js), so a floor effect sent with
 * plain `send` reaches the whole party. That is right for a boss going down and
 * wrong for "VICTORY", which the loser must not see. An effect is therefore
 * sent to this member alone unless it says `"to": "party"`.
 *
 * A banner is a key in the client's string table, not text. The game's own
 * keys work on every client; the book's `strings` only on a client that has
 * them installed and says so (ui-strings.js). So a banner may be a list, and
 * the first key this client can show is the one sent.
 *
 * The chat lines that go with an event are the book's too: `lines`, one per
 * event, and the `parts` they are put together from. They are text the server
 * sends, so they need nothing installed — what makes them data is that an
 * operator can reword them without code.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCameraShake,
  buildCameraZoom,
  buildPlaySound,
  buildShowText,
} from "./floorstate.js";
import { buffEffectReport } from "./buffs.js";
import { buildFloorEnding } from "./objects.js";
import { BANNER_CHARS, NO_STRINGS, parseStrings, tooLongForBanner } from "./ui-strings.js";
import { info, warn, warnOnce } from "../log.js";

/**
 * Camera shakes by name, as `[frames, strength, count]`, taken from the shakes
 * the game's own floors author — not invented. The duration is in frames; the
 * client divides by 24 itself (`DistributedDungeonFloor.trigger_camera_shake`).
 *
 *   subtle  2/2/5     the Ice Dragon, barely there
 *   light   8/12/5    the Lava Golem's stomp — the one a capture recorded
 *   medium  13/16/9   the Golem, a heavier blow
 *   heavy   14/25/10  the strongest strength the game uses anywhere
 *   rumble  60/12/32  the Golem's long quake, two and a half seconds
 */
export const SHAKE_PRESETS = Object.freeze({
  subtle: Object.freeze([2, 2, 5]),
  light: Object.freeze([8, 12, 5]),
  medium: Object.freeze([13, 16, 9]),
  heavy: Object.freeze([14, 25, 10]),
  rumble: Object.freeze([60, 12, 32]),
});

/** Long enough for any locale key or sound name; a bound on what a param can make us send. */
const MAX_NAME = 128;

/** The field is a u16 of seconds; past a minute it is a wait, not a countdown. */
const MAX_COUNTDOWN_SECONDS = 60;

/** A chat line or a part of one: more than the client's input box allows, a bound all the same. */
const MAX_LINE = 400;

/**
 * `{name}` filled from the event's params, or null if any is left unfilled.
 *
 * Null rather than the literal placeholder, so a config that names a param the
 * event does not carry sends nothing instead of a key the client will print as
 * `mia:RANKED_{floor}`.
 */
const fill = (template, params) => {
  let unfilled = false;
  const filled = String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const value = params?.[key];
    if (value === undefined || value === null) {
      unfilled = true;
      return "";
    }
    return String(value);
  });
  return unfilled ? null : filled;
};

/** A key or sound name fit for the wire: filled, printable, bounded. */
const nameFrom = (template, params) => {
  const filled = fill(template, params);
  if (filled === null) return null;
  // eslint-disable-next-line no-control-regex
  const clean = filled.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean && clean.length <= MAX_NAME ? clean : null;
};

/** A finite integer from a number or a `{param}` template, or null. */
const integerFrom = (value, params) => {
  const raw = typeof value === "string" ? fill(value, params) : value;
  if (raw === null || raw === undefined || raw === "") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? Math.trunc(number) : null;
};

const shakeFrom = (shake, shakes) => {
  const triple = typeof shake === "string" ? shakes[shake] : shake;
  if (!Array.isArray(triple) || triple.length !== 3) return null;
  const [shakeDuration, shakeStrength, shakeCount] = triple.map(Number);
  if (![shakeDuration, shakeStrength, shakeCount].every(Number.isFinite)) return null;
  return { shakeDuration, shakeStrength, shakeCount };
};

const zoomFrom = (zoom) => {
  if (zoom === "reset") return 1;
  const value = Number(zoom);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** To this member only, or to the whole floor. See the note at the top. */
const deliver = (session, frame, toParty) => {
  if (!toParty && typeof session.sendDirect === "function") return session.sendDirect(frame);
  return session.send(frame);
};

/** A banner withheld because every key in it is one this client has not said it holds. */
const UNDECLARED = Symbol("undeclared");
/** Withheld because it is for the whole party, and every key in it is the book's own. */
const PARTY_WIDE = Symbol("party-wide");

/**
 * The first banner in the spec this client can show.
 *
 * A key of the book's strings goes only to a client that declared them; any
 * other key is taken to be the game's, which every client has. A key made from
 * a `{param}` can only be the book's, so one its strings do not cover (a ninth
 * floor where they stop at eight) moves on to the next instead of printing
 * `mia:`.
 */
const bannerFor = (banner, params, session, strings, toParty = false) => {
  let undeclared = false;
  let partyWide = false;
  for (const template of Array.isArray(banner) ? banner : [banner]) {
    const key = nameFrom(template, params);
    if (!key) continue;
    const ours = strings.keys.has(key);
    if (!ours && /\{\w+\}/.test(String(template))) continue;
    // Sent to the whole floor through the world, which asks nobody what they
    // hold: only a key every client has can go that way.
    if (ours && toParty) {
      partyWide = true;
      continue;
    }
    if (ours && session.uiStrings !== strings.id) {
      undeclared = true;
      continue;
    }
    return key;
  }
  return partyWide ? PARTY_WIDE : undeclared ? UNDECLARED : null;
};

/** What an event in the book may say; part of the stable surface (src/modes/README.md). */
export const EFFECT_SPEC_KEYS = Object.freeze(["banner", "sound", "shake", "zoom", "countdown", "floater", "to", "replacesChat"]);

/**
 * Plays one effect spec on one member. Returns what was sent and, for anything
 * that was not, why — so a misconfigured event can be diagnosed from its result
 * rather than guessed at.
 *
 * `spec` holds the `EFFECT_SPEC_KEYS` — `{ banner, sound, shake, zoom,
 * countdown, floater, to, replacesChat }`, every part optional. `replacesChat` comes back true when the spec asked for
 * it and a banner went out: the screen has said it, so a chat line need not.
 */
export const playEffects = (
  session,
  spec = {},
  params = {},
  { shakes = SHAKE_PRESETS, strings = NO_STRINGS } = {}
) => {
  const sent = [];
  const skipped = [];
  if (!session || typeof session.send !== "function") {
    return { sent, skipped: ["no session to send to"], replacesChat: false };
  }
  const toParty = spec.to === "party";
  const floor = session.floorDoid;

  const onFloor = (what, build) => {
    if (!floor) return skipped.push(`${what}: no floor to show it on`);
    const frame = build();
    if (!frame) return skipped.push(`${what}: not a usable value`);
    deliver(session, frame, toParty);
    sent.push(what);
  };

  if (spec.banner !== undefined) {
    const key = bannerFor(spec.banner, params, session, strings, toParty);
    if (key === UNDECLARED) skipped.push("banner: the client has not declared this server's strings");
    else if (key === PARTY_WIDE) skipped.push("banner: only the game's own keys can go to a whole party");
    else onFloor("banner", () => key && buildShowText(floor, key));
  }
  if (spec.sound !== undefined) {
    onFloor("sound", () => {
      const name = nameFrom(spec.sound, params);
      return name && buildPlaySound(floor, name);
    });
  }
  if (spec.shake !== undefined) {
    onFloor("shake", () => {
      const shake = shakeFrom(spec.shake, shakes);
      return shake && buildCameraShake(floor, shake);
    });
  }
  if (spec.zoom !== undefined) {
    onFloor("zoom", () => {
      const zoom = zoomFrom(spec.zoom);
      return zoom && buildCameraZoom(floor, zoom);
    });
  }

  /**
   * The game's own countdown, the one a party sees when somebody has gone
   * through the door ahead of it. `floorEnding(seconds)` on the area draws the
   * number and counts it down a second at a time by itself, then fades; it
   * ends nothing. Not in an infinite dungeon, whose client reads the same
   * field as the floor done and adds that floor's gold to the run's.
   */
  if (spec.countdown !== undefined) {
    const seconds = integerFrom(spec.countdown, params);
    if (!session.areaDoid) {
      skipped.push("countdown: no dungeon area to show it on");
    } else if (session.infiniteDefinition) {
      skipped.push("countdown: an infinite dungeon pays the floor out on it");
    } else if (seconds === null || seconds < 1 || seconds > MAX_COUNTDOWN_SECONDS) {
      skipped.push("countdown: not a usable value");
    } else {
      deliver(session, buildFloorEnding(session.areaDoid, seconds), toParty);
      sent.push("countdown");
    }
  }

  /**
   * The floater rides the hero, not the floor, so it goes where a floor effect
   * cannot. Always to the owner: only `HeroGameObjectOwner` draws it, so sending
   * it to the party would be traffic nobody shows. A negative amount is drawn
   * as damage and a positive one as healing.
   */
  if (spec.floater !== undefined) {
    const amount = integerFrom(spec.floater?.amount, params);
    const colorType = integerFrom(spec.floater?.color ?? 0, params);
    if (!session.heroDoid) {
      skipped.push("floater: no hero to draw it over");
    } else if (amount === null || colorType === null || colorType < 0) {
      skipped.push("floater: not a usable value");
    } else {
      deliver(
        session,
        buffEffectReport({ heroDoid: session.heroDoid, actorDoid: session.heroDoid, amount, colorType }),
        false
      );
      sent.push("floater");
    }
  }

  return { sent, skipped, replacesChat: spec.replacesChat === true && sent.includes("banner") };
};

/**
 * A mode's notice as an event name in the book: `<mode>.<type>`, and
 * `.<variant>` after it where one moment comes in kinds — ranked's finish is
 * named for its result, because "VICTORY" and "DEFEAT" are not the same
 * moment. A notice naming no mode is nobody's, and plays nothing.
 */
export const eventForNotice = (notice) => {
  if (!notice?.type || typeof notice.mode !== "string" || !notice.mode) return null;
  const variant = notice.variant == null || notice.variant === "" ? "" : `.${notice.variant}`;
  return `${notice.mode}.${notice.type}${variant}`;
};

const EMPTY_BOOK = Object.freeze({
  shakes: SHAKE_PRESETS,
  strings: NO_STRINGS,
  events: Object.freeze({}),
  lines: Object.freeze({}),
  parts: Object.freeze({}),
});

/** Keys that start with `_` are notes for whoever edits the file. */
const entriesOf = (object) =>
  Object.entries(object ?? {}).filter(([key]) => !key.startsWith("_"));

const parseBook = (json) => {
  if (!json || typeof json !== "object") throw new Error("the book is not an object");
  const shakes = { ...SHAKE_PRESETS };
  for (const [name, triple] of entriesOf(json.shakes)) {
    if (shakeFrom(triple, {}) === null) throw new Error(`shake "${name}" is not [frames, strength, count]`);
    shakes[name] = triple;
  }
  const events = {};
  for (const [name, spec] of entriesOf(json.events)) {
    if (!spec || typeof spec !== "object") throw new Error(`event "${name}" is not an object`);
    events[name] = spec;
  }
  return { shakes, strings: parseStrings(json.strings), events, lines: textsOf(json.lines, "line"), parts: textsOf(json.parts, "part") };
};

/** A table of chat text: every value a string, none past MAX_LINE. */
const textsOf = (table, what) => {
  const texts = {};
  for (const [name, text] of entriesOf(table)) {
    if (typeof text !== "string") throw new Error(`${what} "${name}" is not text`);
    if (text.length > MAX_LINE) throw new Error(`${what} "${name}" is longer than ${MAX_LINE} characters`);
    texts[name] = text;
  }
  return texts;
};

/**
 * The book of events, read from `file` and kept current.
 *
 * Read on first use rather than at import, and re-read whenever the file's
 * modification time changes — so an operator can tune a shake, save, and see
 * it within a second. A file that does not parse never takes the server
 * down: the first bad read leaves no events, and a bad edit keeps the last good
 * book until the file is fixed.
 *
 * The time is looked at no more than once every `checkEveryMs`: the stat is
 * synchronous, on a thread that also runs dungeons, and one ranked notice asks
 * the book for a line and half a dozen parts of it.
 */
export const createEffectBook = (file, { checkEveryMs = 1000, now = Date.now } = {}) => {
  let book = EMPTY_BOOK;
  let seen = null;
  let checkedAt = -Infinity;

  const refresh = () => {
    const at = now();
    if (at - checkedAt < checkEveryMs) return;
    checkedAt = at;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      warnOnce(`ui-effects:missing:${file}`, `ui-effects: no book at ${file}; events play nothing`);
      return;
    }
    if (mtime === seen) return;
    seen = mtime;
    try {
      book = parseBook(JSON.parse(fs.readFileSync(file, "utf8")));
      info(
        `ui-effects: ${Object.keys(book.events).length} event(s), ` +
          `${book.strings.keys.size} string(s) (uiStrings ${book.strings.id ?? "none"}), ` +
          `${Object.keys(book.lines).length} line(s) from ${file}`
      );
      const long = tooLongForBanner(book.strings.table);
      if (long.length) warn(`ui-effects: ${long.join(", ")} longer than ${BANNER_CHARS} characters: a banner cuts it off`);
    } catch (problem) {
      warn(`ui-effects: ${file} was not used (${problem.message}); keeping the last good book`);
    }
  };

  return {
    playEvent(session, name, params = {}) {
      refresh();
      const spec = book.events[name];
      if (!spec) return { sent: [], skipped: [`no event "${name}" in the book`], replacesChat: false };
      return playEffects(session, spec, params, book);
    },
    events() {
      refresh();
      return book.events;
    },
    /** `{ table, keys, id }`: what tools/install-ui-strings.js writes into a client. */
    strings() {
      refresh();
      return book.strings;
    },
    /**
     * The chat line for a notice, filled from `params`; null when the book has
     * none for it or names a param it was not given — nothing said rather than
     * a line with a hole in it.
     */
    line(notice, params = {}) {
      refresh();
      const template = book.lines[eventForNotice(notice)];
      return template === undefined ? null : fill(template, params);
    },
    /** A part of a line, filled from `params`; "" when the book has none. */
    part(name, params = {}) {
      refresh();
      const template = book.parts[name];
      return template === undefined ? "" : fill(template, params) ?? "";
    },
  };
};

const DEFAULT_FILE = fileURLToPath(new URL("../../config/ui-effects.json", import.meta.url));

/** The server's own book: `ODS_UI_EFFECTS_FILE`, or config/ui-effects.json. */
export const effectBook = createEffectBook(process.env.ODS_UI_EFFECTS_FILE || DEFAULT_FILE);

export const playEvent = (session, name, params) => effectBook.playEvent(session, name, params);

/** The server's book's chat wording, for whatever says the lines (the ranked adapter, /rank). */
export const bookWords = Object.freeze({
  line: (notice, params) => effectBook.line(notice, params),
  part: (name, params) => effectBook.part(name, params),
});

/**
 * The one line a ranked adapter needs: play whatever the book says for this
 * notice. The notice itself is the params, so `{countdownSeconds}`, `{floor}`
 * and the rest fill straight from it.
 *
 * What played goes to the log, and what the book asked for but could not be
 * shown is warned about: "nothing appeared" is then told apart from "nothing
 * was sent" by the server's log alone. An event the book leaves out is a
 * choice, not a fault, and says nothing.
 */
export const playNotice = (session, notice) => {
  const name = eventForNotice(notice);
  if (!name) return null;
  const result = effectBook.playEvent(session, name, notice);
  const who = `#${session?.accountId ?? "?"}`;
  if (result.sent.length) info(`ui-effects: ${name} for ${who}: ${result.sent.join(", ")}`);
  const faults = result.skipped.filter((why) => !why.startsWith("no event"));
  if (faults.length) warn(`ui-effects: ${name} for ${who} skipped ${faults.join("; ")}`);
  return result;
};

/**
 * The banner strings this server adds to a client's string table, and how a
 * client says it holds them.
 *
 * A banner (`show_text`) carries a key, not text, and a key the client's table
 * lacks prints as `mia:KEY`. The game's own keys are in every client; these are
 * in a client only once tools/install-ui-strings.js has written them into its
 * Locale.override.json — and that tool also writes `Demographics.uiStrings`
 * into its Config.json, which the client sends with every entry request. A
 * client that has not said so is never sent one (ui-effects.js).
 */
import { createHash } from "node:crypto";

/** A key as the game writes its own: `RIVAL_FOUND`, `3_SECONDS_LEFT`. */
const KEY = /^[A-Z0-9_]+$/;
const DECLARED = /^[0-9a-f]{8}$/;
/** Generous for a declaration of a few names; a bound on what is parsed. */
const MAX_DECLARATION = 4096;

export const NO_STRINGS = Object.freeze({ table: Object.freeze({}), keys: new Set(), id: null });

/**
 * About as long as a banner draws whole: the longest line the game's own maps
 * send to it is 24 characters ("WELCOME TO THE GAUNTLET!"). Longer is cut off
 * on screen; the book is still read, and the loader says which ones.
 */
export const BANNER_CHARS = 24;

/** The keys whose text a banner would cut off. */
export const tooLongForBanner = (table) =>
  Object.entries(table ?? {})
    .filter(([, text]) => text.length > BANNER_CHARS)
    .map(([key]) => key);

/**
 * What names a set of strings: its keys, not their wording.
 *
 * A client holding an older file with the same keys still shows every banner,
 * in the older words. One missing a key would print `mia:KEY`, so a new key
 * changes the name, and every client falls back to the game's own banners
 * until the strings are installed again.
 */
export const stringsIdOf = (table) =>
  createHash("sha1").update(JSON.stringify(Object.keys(table).sort())).digest("hex").slice(0, 8);

/** The book's `strings`, checked. Keys that start with `_` are notes. */
export const parseStrings = (json) => {
  const table = {};
  for (const [key, text] of Object.entries(json ?? {})) {
    if (key.startsWith("_")) continue;
    if (!KEY.test(key)) throw new Error(`string "${key}" is not a KEY_LIKE_THIS`);
    if (typeof text !== "string" || !text.trim()) throw new Error(`string "${key}" has no text`);
    table[key] = text;
  }
  if (!Object.keys(table).length) return NO_STRINGS;
  return { table, keys: new Set(Object.keys(table)), id: stringsIdOf(table) };
};

/**
 * The strings a client says it holds, from the Demographics of an entry
 * request: a string of JSON or the object, as content packs read it
 * (content-packs.js). Anything else is none.
 */
export const declaredUiStrings = (demographics) => {
  let object = demographics;
  if (typeof object === "string") {
    if (!object || object.length > MAX_DECLARATION) return null;
    try {
      object = JSON.parse(object);
    } catch {
      return null;
    }
  }
  const id = object && typeof object === "object" ? object.uiStrings : null;
  return typeof id === "string" && DECLARED.test(id) ? id : null;
};

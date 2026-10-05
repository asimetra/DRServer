/**
 * What a client says it does beyond the stock game, so the server can leave it
 * to do it.
 *
 * Declared the way content packs and banner strings are (content-packs.js,
 * ui-strings.js): in the `Demographics` object of the client's Config.json,
 * which it sends with every entry request — `"capabilities": ["ranked.notices@1"]`.
 * A name is a dotted feature and the version of its contract (docs/ranked.md,
 * "The modded-client adapter"). A declaration is believed, not checked: it
 * changes only what this client is told and how it enters, never a result.
 */

/** `ranked.notices@1`: lower-case dotted words, then the contract's version. */
const NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*@[1-9]\d{0,3}$/;
const MAX_DECLARED = 32;
/** Generous for a declaration of a few names; a bound on what is parsed. */
const MAX_DECLARATION = 4096;

export const NO_CAPABILITIES = Object.freeze([]);

/** The names a client declares, from a Demographics string of JSON or the object. */
export const declaredCapabilities = (demographics) => {
  let object = demographics;
  if (typeof object === "string") {
    if (!object || object.length > MAX_DECLARATION) return NO_CAPABILITIES;
    try {
      object = JSON.parse(object);
    } catch {
      return NO_CAPABILITIES;
    }
  }
  const list = object && typeof object === "object" ? object.capabilities : null;
  if (!Array.isArray(list)) return NO_CAPABILITIES;
  const names = [...new Set(list.filter((name) => typeof name === "string" && NAME.test(name)))];
  return Object.freeze(names.slice(0, MAX_DECLARED));
};

/** Whether this session's client declared `capability`, version included. */
export const declares = (session, capability) =>
  Array.isArray(session?.capabilities) && session.capabilities.includes(capability);

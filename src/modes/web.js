/**
 * What a mode adds to the server's HTTP side: routes of its own, and fields
 * on a player's profile. Ranked's board and standing are the first; the core
 * serves them without knowing what they are.
 *
 *   side "public"    the game's HTTP API (routes.js): signed like every
 *                    call the client makes; the handler is given the caller's
 *                    proved account id.
 *   side "internal"  the internal API (internal.js), for the website: the
 *                    internal token is checked before the handler runs.
 *
 * A handler is `async ({ req, query, captures, accountId }) => ({ status?, body })`.
 * Registered on the thread that serves HTTP — the main one, or the only one.
 */
import { warn } from "../log.js";

const routes = [];
const profileFields = new Map();

const SIDES = new Set(["public", "internal"]);

/** Adds a route; returns a function that takes it away. A method and pattern already taken is refused. */
export const addModeRoute = ({ side, method, pattern, handler } = {}) => {
  if (!SIDES.has(side)) throw new Error(`a mode route is "public" or "internal", not ${JSON.stringify(side)}`);
  if (typeof pattern !== "string" || !pattern.startsWith("/")) throw new Error(`a mode route's pattern is a path, not ${JSON.stringify(pattern)}`);
  if (typeof handler !== "function") throw new Error(`mode route ${pattern} has no handler`);
  if (routes.some((route) => route.side === side && route.method === method && route.pattern === pattern)) {
    throw new Error(`${method} ${pattern} is a mode route already`);
  }
  const route = Object.freeze({ side, method, pattern, handler });
  routes.push(route);
  return () => {
    const at = routes.indexOf(route);
    if (at >= 0) routes.splice(at, 1);
  };
};

/** The routes of one side, as the core serves them. */
export const modeRoutes = (side) => routes.filter((route) => route.side === side);

/**
 * Adds a field to every player's profile on the internal API: `read(accountId)`
 * answers its value, null for none. One that fails answers null — a mode's
 * fault is not a profile's. Returns a function that takes it away.
 */
export const addProfileField = (name, read) => {
  if (typeof name !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error(`a profile field is a plain name, not ${JSON.stringify(name)}`);
  if (typeof read !== "function") throw new Error(`profile field ${name} has no reader`);
  if (profileFields.has(name)) throw new Error(`there is a profile field ${name} already`);
  profileFields.set(name, read);
  return () => {
    if (profileFields.get(name) === read) profileFields.delete(name);
  };
};

/** Every mode's fields for one account, as `{ name: value }`. */
export const profileFieldsFor = async (accountId) => {
  const fields = {};
  for (const [name, read] of profileFields) {
    try {
      fields[name] = (await read(accountId)) ?? null;
    } catch (problem) {
      warn(`modes: no profile field ${name} for ${accountId}: ${problem.message}`);
      fields[name] = null;
    }
  }
  return fields;
};

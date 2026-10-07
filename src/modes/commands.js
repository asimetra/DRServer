/**
 * A mode's chat commands (src/socket/commands.js): `define` one under the
 * mode's name, `undefineMode` to take them all away with it, and the roles a
 * command may be held to.
 */
export { define, undefineMode } from "../socket/commands.js";
export { ROLE } from "../socket/roles.js";

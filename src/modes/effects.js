/**
 * The effect book (config/ui-effects.json) as a mode speaks through it:
 * `playNotice(session, notice)` its banner, sound and shake for a notice
 * `{ mode, type, variant?, ...params }`, and `bookWords` its lines and parts.
 */
export { bookWords, playNotice } from "../socket/ui-effects.js";

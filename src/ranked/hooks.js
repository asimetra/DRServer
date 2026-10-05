/**
 * Ranked's name on the mode seam (src/modes/hooks.js): what it installs, and
 * the runtime calls, is the modes' — these are the same functions under the
 * name the ranked code and its tests have used.
 */
import { installModeHooks, modeHooks, modeInstalled } from "../modes/hooks.js";

export const RANKED_MODE = "ranked";

export const rankedHooks = modeHooks;
export const installRankedHooks = (hooks) => installModeHooks(RANKED_MODE, hooks);
export const rankedHooksInstalled = () => modeInstalled(RANKED_MODE);

/**
 * One life: a dungeon run with no revives. A hero who falls stays down, and a
 * floor with nobody standing is lost at once. Everything else is the game as
 * shipped: the same nodes, the same pay, the same map credit.
 *
 * It is the smallest mode there is, and it is here as the worked example of
 * src/modes/README.md: a mode is a set of answers on the seam and nothing of
 * the core's. This one answers five hooks, defines one command, and names two
 * events in the effect book. It touches no socket, no actor and no floor.
 *
 *   /onelife           arms the player's next entry, said wherever they can
 *                      chat (a dungeon, on the stock client): that run is one
 *                      life. /onelife off disarms it.
 *   routeEntry         marks an armed player's next entry `mode: "onelife"`;
 *                      the mark rides the request to whichever thread runs it.
 *   modeRules/runRules the rules by name and by mark: `revives: false`, and
 *                      `joinable: false` so no friend walks into a run they
 *                      did not choose.
 *   heroRequested      the first floor's hero: say so on screen (onelife.entered).
 *   runFailed          the run is lost: say so (onelife.lost).
 *
 * The core knows none of this. `revives` is a run rule (socket/run-rules.js):
 * the bomb and the rescue read it, and the defeat countdown skips itself
 * under it. That rule came with this mode, which is how the seam grows — a
 * knob the core reads, never a branch on the mode's name.
 */
import { config } from "../../config.js";
import { info } from "../../log.js";
import { installModeHooks, modeInstalled } from "../hooks.js";
import { onTold, tellMain } from "../seat.js";
import { runRules } from "../run-rules.js";
import { ROLE, define, undefineMode } from "../commands.js";
import { modeSettings } from "../settings.js";
import { runControls } from "../runtime.js";
import { bookWords, playNotice } from "../effects.js";

export const ONE_LIFE_MODE = "onelife";

export const ONE_LIFE_RUN_RULES = runRules({ mode: ONE_LIFE_MODE, revives: false, joinable: false });

const notice = (type) => ({ mode: ONE_LIFE_MODE, type });

/**
 * The mode's answers, over the two things it says with: `show(session, notice)`
 * plays the book's event, `say(session, text)` is a chat line from the server.
 * `line(notice)` is the book's wording for it, or null.
 */
export const createOneLife = ({ show = () => null, say = () => {}, line = () => null } = {}) => {
  /** Account ids whose next entry is one life. */
  const armed = new Set();

  const tell = (session, what) => {
    const shown = show(session, what);
    const text = line(what, what);
    if (text && !shown?.replacesChat) say(session, text);
  };

  const hooks = {
    routeEntry(connection, request) {
      const accountId = Number(connection?.accountId);
      if (!armed.has(accountId)) return request;
      // Joining somebody — a friend's run, or a mode's own row (MATCHMAKER) —
      // is their run, played by its rules: the arming waits for the player's own.
      if (Number(request?.friendId) || Number(request?.mapId)) return request;
      // One entry: refused or not, the player says so again for the next.
      armed.delete(accountId);
      return { ...request, mode: ONE_LIFE_MODE };
    },
    modeRules: (mode) => (mode === ONE_LIFE_MODE ? ONE_LIFE_RUN_RULES : null),
    runRules: (session) => (session?.modeEntry === ONE_LIFE_MODE ? ONE_LIFE_RUN_RULES : null),
    heroRequested(session) {
      if (session?.modeEntry !== ONE_LIFE_MODE || (session.floorIndex ?? 0) !== 0) return;
      tell(session, notice("entered"));
    },
    runFailed(session) {
      if (session?.modeEntry !== ONE_LIFE_MODE) return;
      tell(session, notice("lost"));
    },
  };

  /** Arms (`on`) or disarms the account's next entry; answers whether it is armed now, or null for no account. */
  const arm = (accountId, on = true) => {
    const id = Number(accountId);
    if (!id) return null;
    if (on) armed.add(id);
    else armed.delete(id);
    return armed.has(id);
  };

  /** Arms or disarms by turns. */
  const toggle = (accountId) => arm(accountId, !armed.has(Number(accountId)));

  return { hooks, arm, toggle, armed: (accountId) => armed.has(Number(accountId)) };
};

/**
 * The one command, said wherever the player can say it — which on the stock
 * client is in a dungeon: it hides chat in town. `/onelife` arms the next
 * entry and `/onelife off` calls it off; the run the player is in now is as it
 * is. The arming is kept where entries are routed — the main thread, or the
 * only one — so it is told there (`tell`, modes/seat.js tellMain), from a
 * dungeon on a match worker as from anywhere else.
 */
export const installOneLifeCommands = ({ tell = (accountId, on) => tellMain(ONE_LIFE_MODE, { accountId, on }) } = {}) => {
  define({
    name: "onelife",
    mode: ONE_LIFE_MODE,
    role: ROLE.PLAYER,
    summary: "make your next dungeon a one-life run: no revives, and a fall ends it. /onelife off calls it off",
    usage: "[off]",
    run: ({ session, args = [], reply }) => {
      const accountId = Number(session?.accountId);
      if (!accountId) return reply.warn("no account to arm");
      const on = String(args[0] ?? "").toLowerCase() !== "off";
      tell(accountId, on);
      reply(
        on
          ? "one life: your next dungeon has no revives, and a fall ends it. /onelife off to call it off"
          : "one life: off. Your next dungeon is an ordinary one"
      );
    },
  });
  return () => undefineMode(ONE_LIFE_MODE);
};

/**
 * Starts the mode, if the operator asked for it (ODS_ONELIFE=1), on whichever
 * thread this is: `main` with match workers on, `worker` inside one, `local`
 * with none. The hooks go on every thread, since a run may be anywhere; the
 * command is answered for real only where entries are routed.
 */
/** Whether the operator asked for it: ODS_ONELIFE=1, or `"oneLife": { "enabled": true }` in the config file. */
export const oneLifeEnabled = (environment = process.env) => {
  const { file, flag } = modeSettings("oneLife", environment);
  return flag("ONELIFE", file.enabled);
};

export const startOneLife = async ({ where = config.matchWorkerCount > 0 ? "main" : "local" } = {}) => {
  if (!oneLifeEnabled()) return async () => {};
  const mode = createOneLife({ show: playNotice, say: runControls.say, line: bookWords.line });
  const uninstallHooks = installModeHooks(ONE_LIFE_MODE, mode.hooks);
  const uninstallCommands = installOneLifeCommands();
  // Where entries are routed, the arming is kept: told from wherever the command was said.
  const unlisten = where === "worker" ? () => {} : onTold(ONE_LIFE_MODE, ({ accountId, on } = {}) => mode.arm(accountId, on));
  info(`one life: on (${where})`);
  return async () => {
    unlisten();
    uninstallCommands();
    uninstallHooks();
  };
};

export const oneLifeInstalled = () => modeInstalled(ONE_LIFE_MODE);

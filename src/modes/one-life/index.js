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
 *   /onelife           in town, arms the player's next entry: that run is one
 *                      life. Said again, disarms it.
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
import { runRules } from "../../socket/run-rules.js";
import { define, undefineMode } from "../../socket/commands.js";
import { ROLE } from "../../socket/roles.js";

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

  /** Arms or disarms; answers what the next entry will be. */
  const toggle = (accountId) => {
    const id = Number(accountId);
    if (!id) return null;
    if (armed.has(id)) {
      armed.delete(id);
      return false;
    }
    armed.add(id);
    return true;
  };

  return { hooks, toggle, armed: (accountId) => armed.has(Number(accountId)) };
};

/**
 * The one command. Arming is kept where entries are routed — the main thread,
 * or the only thread — so a dungeon on a match worker can only point the
 * player home: said there, it would arm a set nobody routes from.
 */
export const installOneLifeCommands = ({ toggle, where = "local" }) => {
  define({
    name: "onelife",
    mode: ONE_LIFE_MODE,
    role: ROLE.PLAYER,
    summary: "make your next dungeon a one-life run: no revives, and a fall ends it",
    run: ({ session, reply }) => {
      if (where === "worker" || session?.dungeonActive || session?.areaDoid) {
        return reply.warn("say /onelife in town: it is your next dungeon that becomes one life");
      }
      const armedNow = toggle(session?.accountId);
      if (armedNow === null) return reply.warn("no account to arm");
      reply(
        armedNow
          ? "one life: your next dungeon has no revives, and a fall ends it. /onelife again to call it off"
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
export const startOneLife = async ({ where = config.matchWorkerCount > 0 ? "main" : "local" } = {}) => {
  if (!config.oneLife?.enabled) return async () => {};
  const { playNotice, bookWords } = await import("../../socket/ui-effects.js");
  const { tellAsServer } = await import("../../socket/chat.js");
  const mode = createOneLife({ show: playNotice, say: tellAsServer, line: bookWords.line });
  const uninstallHooks = installModeHooks(ONE_LIFE_MODE, mode.hooks);
  const uninstallCommands = installOneLifeCommands({ toggle: mode.toggle, where });
  info(`one life: on (${where})`);
  return async () => {
    uninstallCommands();
    uninstallHooks();
  };
};

export const oneLifeInstalled = () => modeInstalled(ONE_LIFE_MODE);

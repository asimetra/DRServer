/**
 * The ranked mode's chat commands, defined when the mode starts and taken away
 * when it stops (src/modes/README.md, "Commands"). The core's command set has
 * none of these: a server with ranked off answers `/rank` with "unknown
 * command", which is the truth, rather than a line about a feature it lacks.
 *
 * Installed on every thread that answers chat — the main thread for town and
 * the match worker for a dungeon — which is why `startRanked` calls it on each.
 */
import { ROLE, define, undefineMode } from "../commands.js";
import { modeHooks } from "../hooks.js";
import { warn } from "../../log.js";
import { RANKED_MODE } from "./hooks.js";
import { rankReply, readStandings } from "./standing.js";

export const installRankedCommands = ({ bookWords, nameOf = async (id) => `#${id}` }) => {
  /**
   * The caller's ranked rating and place, and the top of the board.
   *
   * Read from the match log (standing.js) rather than asked of the ranked
   * service, which runs on one thread while this may be answered in a dungeon
   * on another. Names are read as a page shows them; the log keeps ids.
   */
  define({
    name: "rank",
    mode: RANKED_MODE,
    role: ROLE.PLAYER,
    summary: "say your ranked rating and place, and who leads",
    run: async ({ session, reply }) => {
      const { part } = bookWords;
      let standings;
      try {
        standings = await readStandings();
      } catch (problem) {
        warn(`/rank: could not read the ranked log: ${problem.message}`);
        return reply.warn(part("rank.unreadable"));
      }
      reply(await rankReply({ standings, accountId: session.accountId, nameOf, part }));
    },
  });

  /**
   * A racer asks to call the race off. Both asking ends it with nobody's
   * rating moved: for a run that went wrong — a door that will not open — not
   * for a race somebody is losing, since the rival has to agree.
   */
  define({
    name: "draw",
    mode: RANKED_MODE,
    role: ROLE.PLAYER,
    summary: "offer to call your ranked race off; both offering ends it with no rating moved",
    run: ({ session, reply }) => {
      if (!modeHooks.drawOffered(session)) return reply.warn("you are not in a ranked race");
      reply("offered: the race ends with no rating moved once your rival says /draw too");
    },
  });

  return () => undefineMode(RANKED_MODE);
};

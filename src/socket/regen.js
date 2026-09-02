import { heroById, loadGameMaster } from "../gamemaster.js";
import { grantMana } from "./rewards.js";
import { info } from "../log.js";

/**
 * Mana coming back on its own.
 *
 * Every hero authors an `MP_REGEN`: three for the Berserker up to six for the
 * Sorcerer. It does not grow with level — `LV_MP_REGEN` is zero on all six —
 * and three of them can train it, at a fifth of a point each up to seventy-five
 * points, so a fully trained Sorcerer sits at twenty-one against a Berserker's
 * flat three. The Sorcerer, the Battle Chef and the Vampire Hunter are the ones
 * with the slot, which is what "some characters" meant.
 *
 * Nothing here ever gave any of it back, so Mana only ever came from potions
 * and the blue drops on the floor.
 *
 * The cadence is not authored anywhere and was guessed at a second, which made
 * the bar refill five times faster than the game's — fast enough that a spell's
 * cost was back before the animation finished, which is how it was reported.
 *
 * It is measured now. Field 163 is the Mana bar, and across 49 official socket
 * captures its unprompted rises are exactly one hero's `MP_REGEN` and arrive on
 * a five-second clock: of 409 such rises the median gap is 4.999s, p75 5.008s,
 * p90 5.026s. The amounts settle whose they are — +3 Berserker, +4 Ranger and
 * Battle Chef, +5 Vampire Hunter and Ghost Samurai, +6 Sorcerer, and +20/+21
 * for a fully trained Vampire Hunter and Sorcerer — which is `manaRegenFor` to
 * the point, so only the clock was ever wrong.
 *
 * The shorter gaps in that sample are not a second rate. The timer free-runs
 * rather than restarting on a cast, so the first tick after a spend lands
 * wherever the cycle already was; only tick-to-tick gaps carry the period, and
 * those are the ones at five seconds.
 */

/** Exported so a readout can say the period rather than restate it. */
export const TICK_MS = 5000;

/** Base plus what the training slots have been fed, which is where it grows. */
export const manaRegenFor = (hero, avatar) => {
  if (!hero) return 0;
  let regen = Number(hero.MP_REGEN ?? 0);
  for (const slot of [1, 2, 3, 4]) {
    if (hero[`StatUpgrade${slot}`] !== "MP_REGEN") continue;
    regen += Number(hero[`AmtStat${slot}`] ?? 0) * Number(avatar?.[`statupgrade${slot}`] ?? 0);
  }
  return Math.max(0, regen);
};

/** Starts the trickle for one dungeon; returns the stopper. */
export const startManaRegen = async (session) => {
  const hero = await heroById(session.dungeonAvatar?.avatar_id);
  const perTick = manaRegenFor(hero, session.dungeonAvatar);
  if (!perTick) return () => {};
  await loadGameMaster();

  /**
   * Carried between ticks rather than rounded away. A Berserker regenerates
   * three a tick and a trained Sorcerer twenty-one; rounding each tick would be
   * harmless for both, but a fractional trained value would not survive it — a
   * Sorcerer one point into the slot is 6.2, and the fifth of a point is the
   * whole difference training that slot makes.
   */
  let carry = 0;
  const timer = setInterval(() => {
    if (!session.dungeonActive || !session.heroDoid) return;
    const heroActor = session.actors?.get(session.heroDoid);
    if (heroActor?.dead) return;

    carry += perTick;
    const whole = Math.floor(carry);
    if (whole <= 0) return;
    carry -= whole;
    grantMana(session, whole);
  }, TICK_MS);

  timer.unref?.();
  info(`[${session.id}] Mana regenerating at ${perTick} every ${TICK_MS / 1000}s`);
  return () => clearInterval(timer);
};

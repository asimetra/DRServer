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
 * The one number not authored anywhere is the cadence. A second is the reading
 * that makes both halves of the report true — it refills slowly enough to be
 * felt in a fight, and training it is the difference between a Sorcerer's bar
 * returning in seven seconds and twenty-five. Being a designed rate rather than
 * a measured one, it is the obvious knob for a fork to turn.
 */

const TICK_MS = 1000;

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
  const perSecond = manaRegenFor(hero, session.dungeonAvatar);
  if (!perSecond) return () => {};
  await loadGameMaster();

  /**
   * Carried between ticks rather than rounded away. A Berserker regenerates
   * three a second and a trained Sorcerer twenty-one; rounding each tick would
   * be harmless for both, but a fractional trained value would not survive it.
   */
  let carry = 0;
  const timer = setInterval(() => {
    if (!session.dungeonActive || !session.heroDoid) return;
    const heroActor = session.actors?.get(session.heroDoid);
    if (heroActor?.dead) return;

    carry += perSecond;
    const whole = Math.floor(carry);
    if (whole <= 0) return;
    carry -= whole;
    grantMana(session, whole);
  }, TICK_MS);

  timer.unref?.();
  info(`[${session.id}] Mana regenerating at ${perSecond}/s`);
  return () => clearInterval(timer);
};

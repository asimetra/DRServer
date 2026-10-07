/**
 * What a game mode hears of a fight (modes/hooks.js, `combatEvent`).
 *
 * The core counted all of this already, for the report and for the defeat
 * countdown, and told nobody. These are the same moments, said once each and
 * from one place, so that a mode scoring kills or watching a party go down
 * reads the same numbers the report shows:
 *
 *   hit      { target: { doid, constant }, amount }  the player's hit on an enemy,
 *            the amount the report credits (no more than the hit points it had)
 *   killed   { target: { doid, constant } }          the player's hit finished it
 *   downed   { hero }                                 the player's hero went down
 *   revived  { hero, by }                             back up: "ally", "healthBomb", "partyBomb",
 *                                                     or "floor" — down when the last floor ended,
 *                                                     standing on the next
 *
 * `hit` and `killed` go to the session of whoever was credited; `downed` and
 * `revived` to the hero's own player, whichever context ran it. With no mode
 * installed each is one check and nothing more.
 */
import { modeHooks } from "../modes/hooks.js";
import { memberForHero } from "./match-world.js";

const targetOf = (doid, actor) => ({ doid, constant: actor?.constant ?? null });

/** The hero's own player in this run, or the context that ran it when there is no one else to ask. */
const ownerOf = (session, heroDoid) => {
  try {
    return memberForHero(session, heroDoid) ?? session;
  } catch {
    return session;
  }
};

/** A credited hit on an enemy, and the kill when it was the last one. */
export const tellHit = (session, doid, actor, amount, killed) => {
  if (amount > 0) modeHooks.combatEvent(session, { type: "hit", target: targetOf(doid, actor), amount });
  if (killed) modeHooks.combatEvent(session, { type: "killed", target: targetOf(doid, actor) });
};

/** A hero is down: recoverably, until revived or the floor is lost. */
export const tellDowned = (session, heroDoid) =>
  modeHooks.combatEvent(ownerOf(session, heroDoid), { type: "downed", hero: heroDoid });

/** A hero is back up. */
export const tellRevived = (session, heroDoid, by) =>
  modeHooks.combatEvent(ownerOf(session, heroDoid), { type: "revived", hero: heroDoid, by });

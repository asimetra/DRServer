/**
 * What an actor holds as its target, and how long a pick holds: the clock
 * the pets' and the allies' selectors look again on (npc-targeting.js,
 * behaviours/pet.js). `ai.targetDoid`, `ai.nextTargetAt` and `ai.engaged`
 * are written here alone.
 *
 * A pick holds for its row's `ChangeTargetT` and a fresh roll of up to
 * `ChangeTargetRand` on top, a quarter of a second at least (`lockOn`);
 * until then the one it locked on to is kept while it is still on the floor
 * (`stillLocked`).
 */

/** When it next picks a target. */
const nextTargetPick = (ai, now) =>
  now + Math.max(250, (ai.targetTimerMs ?? 2000) + Math.random() * (ai.targetRandMs ?? 0));

/** Takes `victim` as its target until the next pick; answers with it. */
export const lockOn = (ai, victim, now) => {
  ai.targetDoid = victim?.doid ?? null;
  ai.nextTargetAt = nextTargetPick(ai, now);
  return victim;
};

/**
 * Takes `victim` as its target, with no clock on it: a monster holds its
 * target until it is gone (npc-targeting.js `enemyTarget`). Answers with it.
 */
export const take = (ai, victim) => {
  ai.targetDoid = victim?.doid ?? null;
  return victim;
};

/** It holds no target; when it next picks is left as it was. */
export const letGoOfTarget = (ai) => {
  ai.targetDoid = null;
};

/** It has noticed its target: aggro (ai.js). */
export const engage = (ai) => {
  ai.engaged = true;
};

/** It is engaged with nothing. */
export const disengage = (ai) => {
  ai.engaged = false;
};

/** Whether the pick it made still holds. */
export const stillLocked = (ai, now) => now < (ai.nextTargetAt ?? 0);

/** A target to fight, as a selector answers it: `{ victim, following: false }`, or null for none. */
export const fighting = (victim) => (victim ? { victim, following: false } : null);

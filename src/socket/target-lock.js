/**
 * How long a pick holds: the clock the pets' and the allies' selectors look
 * again on (npc-targeting.js, behaviours/pet.js).
 *
 * A pick holds for its row's `ChangeTargetT` and a fresh roll of up to
 * `ChangeTargetRand` on top, a quarter of a second at least (`lockOn`);
 * until then the one it locked on to is kept while it is still on the floor
 * (`stillLocked`). `ai.targetDoid` and `ai.nextTargetAt` are written here
 * alone, but for letting go of a target altogether (npc-targeting.js
 * `clearNpcTarget`).
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

/** Whether the pick it made still holds. */
export const stillLocked = (ai, now) => now < (ai.nextTargetAt ?? 0);

/** A target to fight, as a selector answers it: `{ victim, following: false }`, or null for none. */
export const fighting = (victim) => (victim ? { victim, following: false } : null);

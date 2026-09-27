/**
 * What an actor on the floor is, for everything that has to ask.
 *
 * Three questions, answered from three flags `spawnNpc` sets, and they have to
 * stay separate — each time two of them shared an answer something broke. When
 * "an enemy" also meant "holds the floor", a boss's summoned clones were nobody's
 * target but the hero's sword. When "an enemy" stopped meaning that and nothing
 * else asked, Infinite's ice bombs — `IsAttackable 0` — became something a
 * hero's bomb could put out.
 *
 * The defaults are part of the rule. An actor built by hand, as most tests and
 * a few older paths do, carries `isEnemy` and nothing else, and means the
 * ordinary thing: a monster anybody may fight, that holds its floor.
 */

/** Something the server may pick to hit on its own: a pet's or beast's target, what a hero's placeable catches. */
export const isHuntable = (actor) => Boolean(actor?.isEnemy) && actor.attackable !== false;

/** Something the floor waits on before it is cleared. A boss's summons and Infinite's spawns are not. */
export const holdsFloor = (actor) => Boolean(actor?.isEnemy) && actor.holdsFloor !== false;

/**
 * A kill the hero is credited for, on the report and in `Buster Gen`. Summons
 * count: the official's solo samurai run reports 29, which is 28 ordinary
 * enemies and the one clone the hero killed.
 */
export const countsAsKill = (actor) => Boolean(actor?.isEnemy);

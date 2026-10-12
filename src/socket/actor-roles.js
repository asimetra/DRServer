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

/**
 * Scenery that breaks: a barrel, a crate, a table — a PROP row the client lets
 * the hero hit. It fights nobody and springs nothing, but what the data says
 * `AffectsProps` reaches it.
 */
export const isScenery = (actor) => Boolean(actor?.isProp) && actor.attackable !== false;

/** Something the floor waits on before it is cleared. A boss's summons and Infinite's spawns are not. */
export const holdsFloor = (actor) => Boolean(actor?.isEnemy) && actor.holdsFloor !== false;

/**
 * A kill the hero is credited for, on the report and in `Buster Gen`. Summons
 * count: the official's solo samurai run reports 29, which is 28 ordinary
 * enemies and the one clone the hero killed.
 */
export const countsAsKill = (actor) => Boolean(actor?.isEnemy);

/**
 * Whether its body and `other`'s pass through each other: the
 * friendly-bodies rule, by which heroes have always walked through one
 * another. `playersSide` is the team the players are on, as the floor's
 * heroes carry it (npc-crowd.js `senseCrowd`); the rule asks only whether a
 * body is on that side, never what kind of thing it is.
 *
 * The client builds every actor's collision filter from its team
 * (`ActorGameObject.buildFilter`): it collides with every other team, and
 * with its own only when its row says `CollideWithTeam` (or it is the local
 * hero himself). So a player's pet, the chef, a hero's walking summon and
 * the other players are not in his way, nor he in theirs; the barricades,
 * the defence orb and the princesses (`CollideWithTeam`) are, and so are
 * they to anything on his side. The official agrees: in its solo captures a
 * hero's step ends inside a standing pet's body 98 times (centre distance
 * p50 35).
 *
 * That filter decides only the player's own body, the one body the client
 * moves; every other actor is a static body there, and two static bodies
 * never meet. How far apart two NPCs keep is the server's, and on the
 * monsters' side it is measured: the official does not walk one monster
 * into another (npc-crowd.js `separationDisplacement`). On the players'
 * side there is no such measure, so the side keeps the rule of the body
 * that is on it to move: it passes through itself, his pets, allies and
 * summons through him and through one another. A monster put on his side
 * by some mode would join it as it is.
 *
 * The official AI did keep its pets off their owner as they walked — a
 * moving pet overlaps its owner's body on 2.2%, 1.8% and 1.4% of samples
 * (wolf, dragon, rhino), and 1 of 99, 0 of 10 and 0 of 41 steps past him
 * went through him. Ours lets them through: a walk is never stopped by a
 * body it does not collide with, but for the one it walks at, where it ends
 * (`keptOutOfHeroes`, npc-move.js). That is simpler than a wait behind a
 * body that holds nothing, and costs only a picture of the two overlapping
 * for a moment. Resting is another matter: the crowd's push still lifts two
 * bodies on the side out of each other, and a pet keeps its standoff from
 * the players (`separationDisplacement`, npc-crowd.js).
 *
 * An actor built without a team, as most tests build a monster, collides.
 */
export const friendlyBodies = (actor, other, playersSide) =>
  actor?.team != null &&
  actor.team === playersSide &&
  other?.team === playersSide &&
  !actor.collidesWithTeam &&
  !other.collidesWithTeam;

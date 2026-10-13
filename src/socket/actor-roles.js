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
 * Its roles, from its row and whether a player owns it as a pet: the flags
 * the crowd sorts it by (`candidateSetOf`) and the questions above answer.
 *
 * Two questions, and they used to share one answer. Whether this is an
 * enemy is what pets hunt, what the hero's bombs and fissures catch, what
 * FLOOR_KILL_ALL_NPCS takes and what counts on the report. Whether it holds
 * the floor open is only the floor's question — a boss's clones and an
 * Infinite modifier's spawns are enemies it did not stock. Answered
 * together, a summoned clone was nobody's target but the hero's sword. The
 * official counts it: its solo samurai run reports 29 kills, which is the
 * 28 ordinary enemies and the one clone the hero killed, and not the two
 * its pet killed.
 *
 * And a third: whether anything may pick it as a target. `IsAttackable` is
 * the client's own answer — `isAttackable = IsAttackable && triggerState`
 * — so a hero is never offered one to hit. Thirty ENEMY rows say no: every
 * placeable, Infinite's ice bombs and lightning orbs, and the lava golem
 * boss. A pet chasing an orb, or a hero's bomb putting out an ice bomb
 * before it goes off, is this server choosing a target the client never
 * could.
 *
 * A moving BEAST is a neutral third-party combatant; static BEAST rows are
 * traps and placeables and never enter target selection. `isAlly`: on the
 * players' side without being a player — the chef to be saved, a princess,
 * a barricade, a defence orb. The official's monsters go for these as for
 * anybody: Battleheim's warhogs land 517 hits on barricades and 308 on
 * defence orbs, and the Cretaceous sorcerers put 20 on the chef. Targeted by
 * distance like a hero (npc-targeting.js), and the one that walks (the
 * chef) fights back with an AI of its own.
 */
export const rolesOfRow = (npc, { petOwnerDoid = 0, countsForFloor } = {}) => ({
  isEnemy: npc.CharType === "ENEMY",
  isProp: npc.CharType === "PROP",
  holdsFloor: npc.CharType === "ENEMY" && countsForFloor !== false,
  attackable: Boolean(npc.IsAttackable),
  isBeast: npc.CharType === "BEAST" && Boolean(npc.IsMover),
  isPet: npc.CharType === "PET" && Boolean(petOwnerDoid),
  isAlly: npc.CharType === "HERO" && !petOwnerDoid && Boolean(npc.IsAttackable),
});

/**
 * A hero's placeable (placeables.js): a summon that walks (`mobile`) is his
 * pet, as one he brings is; anything else he puts down is on nobody's list
 * and never an enemy — counted, a cloud the player made would hold the floor
 * open until it expired.
 *
 * And it is as attackable as its row says, which for nearly every one that
 * stands still is not at all: 34 of the 35 static rows a timeline or a thrown
 * projectile places author IsAttackable 0 — the fissures, the five consumable
 * bombs, the clouds, the garlic, mines and firebombs; the odd one is the ice
 * dragon's shards, which are scenery. Left unsaid, a bomb was a live
 * one-hit-point target for the 80ms before it goes off; monsters' swings took
 * 2 of 14 of ours, where the official's 5 bombs were never hit.
 */
export const rolesOfPlaceable = (npc, ownerDoid, mobile) =>
  mobile
    ? rolesOfRow(npc, { petOwnerDoid: ownerDoid })
    : { isEnemy: false, isPet: false, attackable: Boolean(npc.IsAttackable) };

/** The selector its AI picks with (npc-targeting.js `pickTarget`): a player's pet, a beast, an ally, or an enemy. */
export const kindOfRow = (npc, { petOwnerDoid = 0 } = {}) =>
  petOwnerDoid ? "pet" : npc.CharType === "BEAST" ? "beast" : npc.CharType === "HERO" ? "ally" : "enemy";

/** The crowd's set it is a candidate in (npc-crowd.js `senseCrowd`), or null for none. */
export const candidateSetOf = (actor) =>
  actor.isPet ? "pets" : actor.isEnemy ? "enemies" : actor.isBeast ? "beasts" : actor.isAlly ? "allies" : null;

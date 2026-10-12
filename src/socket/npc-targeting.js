import { contact } from "./body.js";
import { reachOf, unlockSwing } from "./npc-act.js";
import { nearestTo, squaredDistanceTo } from "./npc-crowd.js";
import { forgetRoute } from "./routing.js";
import { restWalk } from "./behaviours/chase.js";
import { forgetBackOff } from "./behaviours/kite.js";
import { forgetPetTarget, petTarget } from "./behaviours/pet.js";
import { forgetQueue } from "./npc-move.js";
import { disengage, fighting, letGoOfTarget, lockOn, stillLocked, take } from "./target-lock.js";

/**
 * Who each one goes for this tick, one selector per kind.
 *
 * `pickTarget` asks the selector for the actor's `ai.kind` — an enemy, a wild
 * beast, a player's pet, an ally — and answers with the target, `LET_GO` when
 * the selector says to drop whatever it was doing (`clearNpcTarget`), or null
 * when there is nobody to go for. A target is `{ victim, following }`: the
 * victim is a candidate of the crowd (npc-crowd.js), and `following` says a
 * pet is walking back to its owner rather than fighting.
 *
 * An ally's pick, and a pet's, holds on its row's clock (target-lock.js
 * `lockOn`); a monster's until its target is gone (`enemyTarget`). The
 * pet's selector is its behaviour's (behaviours/pet.js `petTarget`).
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/** What a selector answers when the actor is to drop its target altogether. */
export const LET_GO = Object.freeze({ letGo: true });

/**
 * The target is gone or out of reach: everything it was doing about it is
 * dropped, its way out of the scenery too (`forgetRoute`). It shows as idle,
 * which the AI says for it (ai.js `letGo`). When it next picks is left as it
 * was: with no target to hold, every selector but the pet's picks again at
 * once, and the pet looks again at what it passed over on its own clock
 * (behaviours/pet.js `petTarget`).
 *
 * A cage release given up on hands the cage's mouth on as the way out after
 * letting go, not through it (npc-release.js `endRelease`).
 */
export const clearNpcTarget = (actor) => {
  const { ai } = actor;
  if (!ai) return;
  disengage(ai);
  forgetRoute(ai);
  letGoOfTarget(ai);
  restWalk(ai);
  unlockSwing(ai);
  forgetBackOff(ai);
  forgetQueue(ai);
  forgetPetTarget(ai);
};

/**
 * A monster's target: the one it already has, while it lives, is on the
 * floor (not hidden in a teleport) and the monster is engaged — past its
 * DisengageDist it lets go (ai.js) — and otherwise the player, unless a
 * pet is in its reach and no player is.
 *
 * It holds. Over the official solo captures a melee monster on the pet
 * swung at it again in 94% of the chances it had, the pet alive and in
 * reach (strict n 33; 76% of n 45 by the looser count), and one on the hero
 * at him in 99% and more (n 852-1716); a hero coming nearer did not take
 * it, nor did hitting it (he had hit it in the 3 s before 0-5% of
 * switches). Most of the hold on a pet is one capture,
 * socket-20260816-225257 (castle arena, node 50053), where one pet held
 * seven melee monsters at once, so there is no cap on how many a pet may
 * hold. In the multiplayer captures (45 floors, 176 monsters) 10 of 11
 * strict switches from one hero to another came once the old one was down
 * or out of reach, every one to the nearest, and a melee monster whose
 * target walked out of its reach with another hero in it kept after the
 * first 10 of 16 times: what drops a target is death, the floor, and the
 * DisengageDist, not leaving its reach. Let go of past it (ai.js,
 * `clearNpcTarget`), or fallen, or gone from the floor, a target is
 * forgotten: the monster stands disengaged where it is, and its next pick,
 * when anyone comes within its AggroRadius, is a fresh one. A monster that
 * walked on to the next hero, wherever he was, crossed the room to one 1200
 * off with an AggroRadius of 300 (player-eye #3). `ChangeTargetT` is no clock for a
 * monster to look again (it kept the hero 99% across many periods; time on
 * a target before a switch p50 ~6 s, with no gathering at 2-3 s). The shooters do move to the nearest hero
 * with the old one still in reach (SKELETON_ARCHER 30 of 59 switches, the
 * throwers, the imps); this holds them longer than the official does, and
 * is left so. Nor does a monster that re-targets the nearest hero all the
 * time (the maintainer reports NEMESIS does; no capture has it, and this
 * server never spawns it) come from here: whatever placed one would say so.
 *
 * Its first pick is the player's. The official went for the pet first in
 * 45 of 1494 monsters' first swings (3%), and with the pet 100 or more
 * nearer than the hero only 14 of 42 times; about half of its runs at the
 * pet began with the pet in reach of the monster's attack and the hero
 * not. So a pet is taken only in reach of one of its attacks
 * (`reachOf`, npc-act.js) when no player is, and not for being nearer:
 * reckoned by distance (a pet 100 nearer, two monsters a pet at most), ours
 * put 29-32% of its hits on the pet in a played capture
 * (socket-20261012-123340), where the official solo captures put 10.9% of
 * hits and 16.1% of damage. A shooter, whose reach takes in the hero as well,
 * so stays on him. An ally stands in for a hero, by distance alone: the
 * official's monsters hit the barricade in their way as readily as the
 * player behind it. A beast nearer than the player is taken, as any
 * monster of another side.
 */
const enemyTarget = (crowd, actor) => {
  const held = heldTarget(crowd, actor);
  if (held) return fighting(held);
  // Engaged with one that fell or left the floor: dropped and forgotten, as
  // past its DisengageDist (ai.js); its next pick is a fresh one, of what is
  // within its AggroRadius. One engaged with none yet (a summon, spawned
  // into its fight) picks.
  if (actor.ai.engaged && actor.ai.targetDoid != null) return LET_GO;
  return fighting(take(actor.ai, firstPick(crowd, actor)));
};

/** The one it holds: on the floor, alive, and it engaged (past its DisengageDist ai.js lets go). */
const heldTarget = ({ heroByDoid, petByDoid, beastByDoid, allyByDoid }, { ai }) => {
  if (!ai.engaged) return null;
  return heroByDoid.get(ai.targetDoid) ?? petByDoid.get(ai.targetDoid) ??
    beastByDoid.get(ai.targetDoid) ?? allyByDoid.get(ai.targetDoid) ?? null;
};

/** Its pick with nothing held: the nearest player, a pet in reach with no player in it, a nearer beast. */
const firstPick = ({ heroes, pets, beasts, allies }, actor) => {
  const { ai } = actor;
  const inReach = (candidate) =>
    distanceTo(actor.position, candidate.position) <= reachOf(ai, contact(actor, candidate.actor));
  const hero = nearestTo(actor.position, heroes);
  const ally = nearestTo(actor.position, allies);
  let player = hero;
  if (
    ally &&
    (!player ||
      squaredDistanceTo(actor.position, ally.position) < squaredDistanceTo(actor.position, player.position))
  ) player = ally;
  const pet = nearestTo(actor.position, pets.filter(inReach));
  if (pet && !heroes.some(inReach) && !allies.some(inReach)) player = pet;
  const beast = nearestTo(actor.position, beasts);
  return beast && (!player || squaredDistanceTo(actor.position, beast.position) <
    squaredDistanceTo(actor.position, player.position))
    ? beast
    : player;
};

/**
 * Team 7 fights every living combatant outside team 7, the nearest when it
 * picks, and holds it as a monster does (`enemyTarget`).
 */
const beastTarget = ({ beastTargets }, actor) => {
  const { ai } = actor;
  const held = beastTargets.find(({ doid }) => doid === ai.targetDoid);
  if (held && ai.engaged) return fighting(held);
  if (ai.engaged && ai.targetDoid != null) return LET_GO;
  return fighting(take(ai, nearestTo(actor.position, beastTargets)));
};

/**
 * A walking ally fights what the player fights, nearest first — the
 * official's chef walks to the nearer sorcerer and swings every two
 * seconds; it does not follow the hero (stood 9 s at spawn, 150-600
 * away, until an enemy appeared).
 */
const allyTarget = ({ huntable }, actor, now) => {
  const { ai } = actor;
  const locked = huntable.find(({ doid: enemyDoid }) => enemyDoid === ai.targetDoid);
  const victim = locked && stillLocked(ai, now)
    ? locked
    : lockOn(ai, nearestTo(actor.position, huntable), now);
  return victim ? fighting(victim) : LET_GO;
};

/** One selector per `ai.kind`; anything else picks as an enemy does. */
const SELECTORS = new Map([
  ["enemy", enemyTarget],
  ["beast", beastTarget],
  ["pet", (crowd, actor, now) => petTarget(crowd, actor, now) ?? LET_GO],
  ["ally", allyTarget],
]);

/** Its target this tick: `{ victim, following }`, `LET_GO`, or null for nobody. */
export const pickTarget = (crowd, actor, now) =>
  (SELECTORS.get(actor.ai.kind) ?? enemyTarget)(crowd, actor, now);

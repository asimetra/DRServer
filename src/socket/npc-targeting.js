import { contact } from "./body.js";
import { nearestTo, squaredDistanceTo } from "./npc-crowd.js";
import { collectNearbyForPet } from "./pickups.js";
import { forgetRoute } from "./routing.js";

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
 * A pick holds for `ChangeTargetT` and a roll of `ChangeTargetRand`
 * (`lockOn`); until then the one it locked on to is kept while it is still
 * on the floor.
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/** Only this many enemies may deliberately choose one pet over a live hero. */
export const MAX_PET_AGGRESSORS = 2;
/** A pet must be materially ahead of the hero before it is an aggro candidate. */
const PET_AGGRO_DISTANCE_ADVANTAGE = 100;

/** What a selector answers when the actor is to drop its target altogether. */
export const LET_GO = Object.freeze({ letGo: true });

/**
 * When it next picks a target: `ChangeTargetT` and a fresh roll of up to
 * `ChangeTargetRand` on top, a quarter of a second at least.
 */
const nextTargetPick = (ai, now) =>
  now + Math.max(250, (ai.targetTimerMs ?? 2000) + Math.random() * (ai.targetRandMs ?? 0));

/** Takes `victim` as its target until the next pick. */
const lockOn = (ai, victim, now) => {
  ai.targetDoid = victim?.doid ?? null;
  ai.nextTargetAt = nextTargetPick(ai, now);
  return victim;
};

/** Whether the pick it made still holds. */
const stillLocked = (ai, now) => now < (ai.nextTargetAt ?? 0);

/** The target is gone or out of reach: everything it was doing about it is dropped. */
export const clearNpcTarget = (actor) => {
  const { ai } = actor;
  if (!ai) return;
  ai.engaged = false;
  ai.state = "idle";
  forgetRoute(ai);
  ai.targetDoid = null;
  ai.nextTargetAt = 0;
  ai.walkSpeed = 0;
  ai.attackLockedUntil = 0;
  ai.fleeUntil = 0;
  ai.targetSeen = null;
};

const fighting = (victim) => (victim ? { victim, following: false } : null);

/** Keeps the pet aggressor tally right as an enemy changes its target. */
const rememberEnemyTarget = ({ petByDoid, petAggressors }, ai, target, now) => {
  const previousPet = petByDoid.has(ai.targetDoid) ? ai.targetDoid : null;
  const nextPet = petByDoid.has(target?.doid) ? target.doid : null;
  if (previousPet && previousPet !== nextPet) {
    petAggressors.set(previousPet, Math.max(0, (petAggressors.get(previousPet) ?? 1) - 1));
  }
  if (nextPet && previousPet !== nextPet) {
    petAggressors.set(nextPet, (petAggressors.get(nextPet) ?? 0) + 1);
  }
  return lockOn(ai, target, now);
};

/**
 * Heroes own aggro; pets only peel a small number of enemies when they are
 * clearly screening ahead. Official pet floors put just 3.4% of enemy damage
 * on pets, and heading analysis shows most of even that was collateral from
 * a swing aimed at the hero. Nearest-body targeting inverted that ratio.
 */
const enemyTarget = (crowd, actor, now) => {
  const { ai } = actor;
  const { heroes, pets, beasts, allies, heroByDoid, petByDoid, beastByDoid, allyByDoid, petAggressors } = crowd;
  const lockedHero = heroByDoid.get(ai.targetDoid);
  if (lockedHero && stillLocked(ai, now)) return fighting(lockedHero);
  const lockedPet = petByDoid.get(ai.targetDoid);
  if (
    lockedPet &&
    stillLocked(ai, now) &&
    (petAggressors.get(lockedPet.doid) ?? 0) <= MAX_PET_AGGRESSORS
  ) return fighting(lockedPet);
  const lockedBeast = beastByDoid.get(ai.targetDoid);
  if (lockedBeast && stillLocked(ai, now)) return fighting(lockedBeast);
  const lockedAlly = allyByDoid.get(ai.targetDoid);
  if (lockedAlly && stillLocked(ai, now)) return fighting(lockedAlly);

  const hero = nearestTo(actor.position, heroes);
  const pet = nearestTo(actor.position, pets);
  // An ally stands in for a hero as a target, by distance alone: the
  // official's monsters hit the barricade in their way as readily as the
  // player behind it.
  const ally = nearestTo(actor.position, allies);
  let player = hero;
  if (
    ally &&
    (!player ||
      squaredDistanceTo(actor.position, ally.position) < squaredDistanceTo(actor.position, player.position))
  ) player = ally;
  if (pet && (petAggressors.get(pet.doid) ?? 0) < MAX_PET_AGGRESSORS) {
    const heroDistance = hero ? distanceTo(actor.position, hero.position) : Infinity;
    const petDistance = distanceTo(actor.position, pet.position);
    if (petDistance + PET_AGGRO_DISTANCE_ADVANTAGE < heroDistance) {
      player = pet;
    }
  }
  const beast = nearestTo(actor.position, beasts);
  const victim =
    beast && (!player || squaredDistanceTo(actor.position, beast.position) <
      squaredDistanceTo(actor.position, player.position))
      ? beast
      : player;
  return fighting(rememberEnemyTarget(crowd, ai, victim, now));
};

/** Team 7 fights every living combatant outside team 7, whichever is near. */
const beastTarget = ({ beastTargets }, actor, now) => {
  const { ai } = actor;
  const locked = beastTargets.find(({ doid }) => doid === ai.targetDoid);
  if (locked && stillLocked(ai, now)) return fighting(locked);
  return fighting(lockOn(ai, nearestTo(actor.position, beastTargets), now));
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

/**
 * A player's pet: the nearest monster while it is engaged or one comes within
 * its aggro radius, and its owner otherwise, or when it has been outside its
 * tether too long. Back at its owner it lets go and waits. It also picks up
 * for its owner, four times a second.
 */
const petTarget = ({ heroes, petTargets }, actor, now) => {
  const { ai } = actor;
  const owner = heroes.find(({ doid: heroDoid }) => heroDoid === ai.ownerDoid);
  if (!owner) return LET_GO;
  if (now >= (ai.nextPickupAt ?? 0)) {
    ai.nextPickupAt = now + 250;
    const ownerSession = owner.member.world?.contextFor(owner.member) ?? owner.member;
    collectNearbyForPet(ownerSession, actor.position, ai.collects);
  }
  const enemy = nearestTo(actor.position, petTargets);
  const ownerDistance = distanceTo(actor.position, owner.position);
  const enemyDistance = enemy ? distanceTo(actor.position, enemy.position) : Infinity;
  if (ai.tetherDistance > 0 && ownerDistance > ai.tetherDistance) {
    ai.outsideTetherAt ??= now;
  } else {
    ai.outsideTetherAt = null;
  }
  const mustReturn =
    ai.outsideTetherAt != null && now - ai.outsideTetherAt >= (ai.tetherTimerMs ?? 0);
  if (mustReturn || !enemy || (!ai.engaged && enemyDistance > ai.aggroRadius)) {
    if (ownerDistance <= Math.max(contact(actor, owner.actor), ai.returnDistance ?? 0)) {
      return LET_GO;
    }
    ai.engaged = false;
    ai.state = "return";
    ai.targetDoid = owner.doid;
    return { victim: owner, following: true };
  }
  ai.targetDoid = enemy.doid;
  return fighting(enemy);
};

/** One selector per `ai.kind`; anything else picks as an enemy does. */
const SELECTORS = new Map([
  ["enemy", enemyTarget],
  ["beast", beastTarget],
  ["pet", petTarget],
  ["ally", allyTarget],
]);

/** Its target this tick: `{ victim, following }`, `LET_GO`, or null for nobody. */
export const pickTarget = (crowd, actor, now) =>
  (SELECTORS.get(actor.ai.kind) ?? enemyTarget)(crowd, actor, now);

import { contact } from "./body.js";
import { reachOf } from "./npc-act.js";
import { nearestTo, squaredDistanceTo } from "./npc-crowd.js";
import { canGetAt, forgetRoute } from "./routing.js";
import { forgetBackOff } from "./behaviours/kite.js";
import { backAt, leashed, ownerOf, pickUpFor } from "./behaviours/pet.js";
import { teleportsOnCycle } from "./behaviours/teleport.js";

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
 * A pet's and an ally's pick holds for `ChangeTargetT` and a roll of
 * `ChangeTargetRand` (`lockOn`); until then the one it locked on to is kept
 * while it is still on the floor. A monster's holds until its target is
 * gone (`enemyTarget`).
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

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

/**
 * The target is gone or out of reach: everything it was doing about it is
 * dropped, its way out of the scenery too (`forgetRoute`). It shows as idle,
 * which the AI says for it (ai.js `letGo`). When it next picks is left as it
 * was: with no target to hold, every selector but the pet's picks again at
 * once, and the pet looks again at what it passed over on its own clock
 * (`petTarget`).
 *
 * A cage release given up on hands the cage's mouth on as the way out after
 * letting go, not through it (npc-release.js `endRelease`).
 */
export const clearNpcTarget = (actor) => {
  const { ai } = actor;
  if (!ai) return;
  ai.engaged = false;
  forgetRoute(ai);
  ai.targetDoid = null;
  ai.walkSpeed = 0;
  ai.attackLockedUntil = 0;
  forgetBackOff(ai);
};

const fighting = (victim) => (victim ? { victim, following: false } : null);

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
 * `clearNpcTarget`), a target is forgotten: the monster stands disengaged
 * where it is, and its next pick, when anyone comes within its AggroRadius,
 * is a fresh one. `ChangeTargetT` is no clock for a
 * monster to look again (it kept the hero 99% across many periods; time on
 * a target before a switch p50 ~6 s, with no gathering at 2-3 s): a target
 * gone, it picks again at once. The shooters do move to the nearest hero
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
const enemyTarget = (crowd, actor, now) => {
  const { ai } = actor;
  const { heroes, pets, beasts, allies, heroByDoid, petByDoid, beastByDoid, allyByDoid } = crowd;
  const held =
    heroByDoid.get(ai.targetDoid) ?? petByDoid.get(ai.targetDoid) ??
    beastByDoid.get(ai.targetDoid) ?? allyByDoid.get(ai.targetDoid);
  if (held && ai.engaged) return fighting(held);

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
  const victim =
    beast && (!player || squaredDistanceTo(actor.position, beast.position) <
      squaredDistanceTo(actor.position, player.position))
      ? beast
      : player;
  return fighting(lockOn(ai, victim, now));
};

/**
 * Team 7 fights every living combatant outside team 7, the nearest when it
 * picks, and holds it as a monster does (`enemyTarget`).
 */
const beastTarget = ({ beastTargets }, actor, now) => {
  const { ai } = actor;
  const held = beastTargets.find(({ doid }) => doid === ai.targetDoid);
  if (held && ai.engaged) return fighting(held);
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
 * A pet's pick, when it has none to hold: the monster nearest it that it can
 * get at without leaving its tether (`canGetAt`, routing.js — from where it
 * stands, straight, or by a route all within TetherDist of its owner; a
 * teleporter, which comes back beside its victim, at anything), among those
 * within its AggroRadius and within its TetherDist of its owner. A way out
 * past the tether would only end in the leash and back, again and again: a
 * dragon so went to and fro at a skeleton round a corner, 300 from its
 * owner every other second (tools/ai-sim.js, scenario pet-dragon seed 2).
 * One it cannot get at is passed over until it looks again, `ChangeTargetT`
 * after it last picked (`lockOn`): the search for a way to it is not made
 * every tick, and one that becomes reachable is taken then. Null for none.
 */
const petPick = ({ petTargets, navigation }, actor, owner, now) => {
  const { ai } = actor;
  if (!stillLocked(ai, now) || !ai.passedOver) ai.passedOver = new Set();
  const tether = ai.tetherDistance > 0 ? ai.tetherDistance : Infinity;
  const candidates = petTargets
    .filter(
      ({ doid, position }) =>
        !ai.passedOver?.has(doid) &&
        distanceTo(actor.position, position) <= ai.aggroRadius &&
        distanceTo(owner.position, position) <= tether
    )
    .sort((a, b) => squaredDistanceTo(actor.position, a.position) - squaredDistanceTo(actor.position, b.position));
  const withinTether = (point) => distanceTo(owner.position, point) <= tether;
  const getsAt = (candidate) =>
    teleportsOnCycle(actor) ||
    canGetAt(navigation, actor, candidate, reachOf(ai, contact(actor, candidate.actor)), withinTether);
  for (const candidate of candidates) {
    if (getsAt(candidate)) return lockOn(ai, candidate, now);
    ai.passedOver.add(candidate.doid);
  }
  if (!stillLocked(ai, now)) lockOn(ai, null, now);
  return null;
};

/**
 * A player's pet, the same for every pet row, every number its row's
 * (behaviours/pet.js `petAiOf`):
 *
 *   leash   once farther than TetherDist from its owner it drops what it
 *           fights and walks back, and takes nothing on until it is back
 *           at ReturnDist (`leashed`);
 *   target  what it picked it holds until ChangeTargetT is up (`lockOn`)
 *           or the target is gone, and then picks again (`petPick`): a
 *           target it lost sight of and has no way to is held that long at
 *           most, and no timer of its own is needed. The official wolf
 *           (ChangeTargetT 2) stood facing a monster behind a wall 3.8% of
 *           its time, 14 times in 20 pet-minutes and 7 s at the longest
 *           (the time counted from 2 s of standing); ours, going for the
 *           nearest monster whatever stood between them, 3.4% over 110
 *           pet-minutes, up to 33 s, and 37% in socket-20261012-013624;
 *   idle    with nothing to fight it follows its owner, by a route, to
 *           ReturnDist, and stands there (`backAt`). The official rests
 *           nearer, p50 0.61, 0.68 and 0.55 of ReturnDist for the wolf,
 *           rhino and dragon, but in 7, 17 and 5 stands; on the official
 *           owners' own tracks neither ending the walk at ReturnDist nor
 *           a whole tick's walk past it gives that, so it ends where the
 *           row says.
 *
 * Null when its owner is not on the floor, and when it is back at its
 * owner with nothing to fight: either way it lets go and stands.
 */
const petTarget = (crowd, actor, now) => {
  const { ai } = actor;
  const owner = ownerOf(crowd.heroes, ai);
  if (!owner) return null;
  pickUpFor(owner, actor, now);
  const ownerDistance = distanceTo(actor.position, owner.position);
  const following = { victim: owner, following: true };
  const blocker = clearing(crowd, actor, now);
  if (blocker) return fighting(blocker);
  if (leashed(actor, owner, ownerDistance)) {
    ai.targetDoid = null;
    ai.engaged = false;
    return following;
  }
  const locked = crowd.petTargets.find(({ doid }) => doid === ai.targetDoid);
  const victim = locked && stillLocked(ai, now) ? locked : petPick(crowd, actor, owner, now);
  if (victim) return fighting(victim);
  ai.engaged = false;
  return backAt(actor, owner, ownerDistance) ? null : following;
};

/**
 * Its way back cleared: the monster that pins it (behaviours/pet.js
 * `pinnedBy`), taken as its target as any pick is (`lockOn`), so it keeps
 * at it if the monster gives half a step. When its pick is up
 * (`ChangeTargetT`), or the scenery has changed since it was pinned — a
 * spike row dropping, a gate opening: the navigation revision a route is
 * searched again on (routing.js) — it lets go and walks back again: the
 * walk is the test of whether it can, and one that goes nowhere pins it on
 * the monster again. On its pick alone, the wolf (ChangeTargetT 2 s, no
 * roll) would try in step with a spike cycle of about as long, and could
 * find it shut every time. One that falls, or leaves the floor, is let go
 * at once. Null when nothing pins it.
 */
const clearing = ({ petTargets, navigation }, actor, now) => {
  const { ai } = actor;
  if (ai.pinnedBy == null) return null;
  const blocker = petTargets.find(({ doid }) => doid === ai.pinnedBy);
  const holding = blocker && ai.targetDoid === blocker.doid;
  const sceneryChanged = navigation && ai.pinnedRevision !== navigation.revision;
  if (!blocker || (holding && (!stillLocked(ai, now) || sceneryChanged))) {
    if (holding || !blocker) ai.targetDoid = null;
    ai.pinnedBy = null;
    return null;
  }
  return holding ? blocker : lockOn(ai, blocker, now);
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

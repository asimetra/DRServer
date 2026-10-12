import { bodyClearSpot, bodyRadius, bodyWalkClear, contact } from "../body.js";
import { inBand, reachOf } from "../npc-act.js";
import { squaredDistanceTo } from "../npc-crowd.js";
import { touchingInTheWay } from "../npc-move.js";
import { collectNearbyForPet } from "../pickups.js";
import { canGetAt } from "../routing.js";
import { disengage, fighting, letGoOfTarget, lockOn, stillLocked } from "../target-lock.js";
import { STILL, walkEndsAt, walkTowards } from "./chase.js";
import { backsOffFrom } from "./kite.js";
import { teleportsOnCycle } from "./teleport.js";

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/**
 * A player's pet, and a hero's walking summon: on the player's side, and
 * the player's to keep close. Its rules, all here:
 *
 *   target  a monster near it and its owner that it can get at, held on
 *           its row's clock, or its owner to walk back to (`petTarget`,
 *           `petPick`);
 *   leash   past TetherDist from its owner, back to him first (`leashed`);
 *   return  to ReturnDist, where it rests (`backAt`);
 *   clear   walking back with no way on, it fights what pins it
 *           (`pinnedBy`, `clearing`);
 *   snap    fallen too far behind, it is put back beside him
 *           (`snapBackSpot`);
 *   pick up for its owner what it walks over (`pickUpFor`).
 *
 * It walks at its full speed, without the ramp a monster's walk has
 * (`npcWalkingSpeed`), and a ranged one backs out of a gap where none of
 * its attacks can go (`petRetreat`). Three of its rules live where the
 * thing they change is: a pet honours its attacks' MinRange
 * (`usableAttacks`, npc-act.js), in the crowd it keeps a standoff from the
 * players rather than touching them (`separationDisplacement`,
 * npc-crowd.js), and it walks through them (npc-move.js `bodyRule`).
 */

/**
 * What a pet's row says about how it keeps to its owner, as its `ai` holds
 * it: one place for the equipped pet (npc-spawn.js) and the hero's walking
 * summon (placeables.js), which are the same thing on the floor. How often
 * it looks again at what it fights is its row's ChangeTargetT
 * (target-lock.js).
 *
 *   tetherDistance  TetherDist: how far from its owner it may be before it
 *                   breaks off and goes back (`leashed`);
 *   returnDistance  ReturnDist: where that walk back, and any walk to its
 *                   owner, ends (`walkEndsAt`, behaviours/chase.js);
 *   collects        CollectsGold, CollectsXp, CollectsCrowd (`pickUpFor`).
 *
 * TetherTimer is not read. Taken literally — out past TetherDist that long
 * before it breaks off — ours turned back after about TetherTimer (p50 0.8,
 * 2.0 and 2.5 s for the wolf, dragon and rhino, TetherTimer 1, 3 and 4 s),
 * already 770, 522 and 834 from its owner. The official turns back almost at
 * once whatever the row says: p50 0.5, 0.3 and 0.5 s after crossing
 * TetherDist (p90 2.0, 1.0, 3.3 s), at 576, 383 and 644, in 83, 25 and 66
 * break-offs of the solo captures. Nor is it how long it then leaves
 * enemies alone: the rhino (TetherTimer 4) swung again within 1.4 s of
 * turning back in a tenth of 26 cases, the wolf (1) no sooner than 2.0 s.
 * What does hold is that it goes back to its owner first: its next swing
 * came once it had been within 105 of the wolf's owner (p50; ReturnDist
 * 100) and 125 of the rhino's (150).
 */
export const petAiOf = (npc) => ({
  tetherDistance: Math.max(0, Number(npc.TetherDist ?? 0)),
  returnDistance: Math.max(0, Number(npc.ReturnDist ?? 0)),
  collects: {
    gold: Boolean(npc.CollectsGold),
    xp: Boolean(npc.CollectsXp),
    crowd: Boolean(npc.CollectsCrowd),
  },
});

/** Its owner on the floor, or undefined when the owner is not there. */
export const ownerOf = (heroes, ai) => heroes.find(({ doid }) => doid === ai.ownerDoid);

/**
 * Whether it is back at its owner: where a walk to him ends, from its own
 * body and his (`walkEndsAt`, behaviours/chase.js). The walk ends there to
 * the last bit of a float and no nearer, so the arithmetic's rounding is
 * allowed for.
 */
const ROUNDING = 1e-6;
export const backAt = (actor, owner, ownerDistance) =>
  ownerDistance <= walkEndsAt(actor, contact(actor, owner.actor), true) + ROUNDING;

/**
 * Whether it is on its way back to its owner, taking nothing on: from the
 * tick it is found farther than its `TetherDist` from its owner until it is
 * back where a walk to its owner ends (`backAt`). See `petAiOf` for why it
 * turns back at once, and why not at a target until it is back.
 */
export const leashed = (actor, owner, ownerDistance) => {
  const { ai } = actor;
  if (ai.tetherDistance > 0 && ownerDistance > ai.tetherDistance) ai.leashed = true;
  else if (backAt(actor, owner, ownerDistance)) ai.leashed = false;
  return Boolean(ai.leashed);
};

/**
 * It picks up for its owner what it walks over, four times a second: the
 * progression pickups its row's Collects flags name (`collectNearbyForPet`,
 * pickups.js). It does not go out of its way for them. The official wolf
 * (CollectsGold, CollectsXp, CollectsCrowd: "Collects any Star Items that it
 * walks over") took 109 of 2,265 pickups in the solo captures and ours 424
 * of 8,492 — 4.8% and 5.0% — after closing 100 or more on the spot in the
 * 2 s before in 78% and 73% of them, with nothing here but the pickups it
 * passes. Of the 53 official ones that can be placed to the tick, every one
 * came with an enemy within its aggro radius: on its way to a fight, as
 * ours (446 of 453). The rhino, dragon and samurai, without the flags, took
 * none.
 */
export const pickUpFor = (owner, actor, now) => {
  const { ai } = actor;
  if (now < (ai.nextPickupAt ?? 0)) return;
  ai.nextPickupAt = now + 250;
  const ownerSession = owner.member.world?.contextFor(owner.member) ?? owner.member;
  collectNearbyForPet(ownerSession, actor.position, ai.collects);
};

/**
 * The step of a pet backing out to its keep distance, or null when it does
 * not: given where it now stands from its target and where its walk ends.
 *
 * A ranged pet caught between its bite and projectile bands backs out to
 * the projectile's authored MinRange. Without this, a stationary target
 * at 100-199 units left Dragon with neither bite nor fireball available,
 * so both actors could stand still forever.
 *
 * Only when none of its contact attacks can go from here, and only from a
 * target it may back off from (`backsOffFrom`, behaviours/kite.js). A target
 * on top of it gives no direction: it stands.
 */
export const petRetreat = (actor, { target, route, distance, stopAt, bodies, topSpeed, deltaSeconds, now }) => {
  const { ai } = actor;
  const backsOut =
    (ai.keepDistance ?? 0) > 0 &&
    backsOffFrom(route) &&
    distance < stopAt &&
    !(ai.attacks ?? []).some((attack) => !attack.projectile && inBand(attack, distance, bodies, now, true));
  if (!backsOut) return null;
  const retreat = Math.min(topSpeed * deltaSeconds, stopAt - distance);
  if (!(distance > 0.001)) return STILL;
  return {
    ...STILL,
    x: ((actor.position.x - target.x) / distance) * retreat,
    y: ((actor.position.y - target.y) / distance) * retreat,
  };
};

/**
 * How far behind its owner a pet may fall before it is put back beside him
 * (`snapBackSpot`): 2000.
 *
 * The official's pets do not trail a running owner across the floor. In the
 * solo captures a pet's position jumped, in one update and with no
 * TELEPORT timeline, from 1996-2205 off its owner to 55-225 off him 14
 * times (13 RHINO_PET, 1 WOLF_PET); the farthest one got without that was
 * 1751 (rhino), and in a 250 ms sample at 1985 it had not. No row holds the
 * number: DisengageDist is 1600 for all three, and the time past 1600 before
 * the jump, 0.5-1.75 s (one 3.75 s), is no timer on top of it. Ours walked
 * back from as far as 5008 (dragon), 3732 (rhino) and 3436 (wolf), past
 * 2000 for 3.4%, 2.6% and 0.5% of their time (68, 70 and 109 pet-minutes
 * of our played captures), in stretches up to 87 s.
 *
 * Asked every tick. Of the 13 rhino jumps, 10 came on the first quarter
 * second sampled past 2000, 2 on the second and 1 on the third: a slower
 * clock, a second's, would spread them over four. The overshoot to 2205 is
 * the owner's pace — a rhino walks 200 a second behind a running hero — and
 * the lag of the owner's reports, not the clock.
 */
export const SNAP_BACK_DISTANCE = 2000;

/**
 * Where a pet beyond `SNAP_BACK_DISTANCE` from its `owner` (a crowd
 * candidate) is put, or null when it is not.
 *
 * Beside him, at his ReturnDist, on the side it came from: the official
 * landed 55-225 from him (p50 131 for the rhino, ReturnDist 150; the wolf
 * 92, ReturnDist 100), 10 of 14 within 60 degrees of the way back to where
 * it had been. The nearest clear spot to that, as the spawn finds one
 * (floor-population.js `spawnEquippedPet`), that he could walk to straight.
 */
export const snapBackSpot = (navigation, actor, owner) => {
  const away = Math.hypot(actor.position.x - owner.position.x, actor.position.y - owner.position.y);
  if (!(away > SNAP_BACK_DISTANCE)) return null;
  const returnDistance = walkEndsAt(actor, contact(actor, owner.actor), true);
  const desired = {
    x: owner.position.x + ((actor.position.x - owner.position.x) / away) * returnDistance,
    y: owner.position.y + ((actor.position.y - owner.position.y) / away) * returnDistance,
  };
  const radius = bodyRadius(actor);
  return (
    bodyClearSpot(navigation, actor, desired, radius, {
      reach: 220,
      towards: owner.position,
      accept: (spot) => bodyWalkClear(navigation, actor, owner.position, spot, radius),
    }) ?? desired
  );
};

/** Less than this share of the walk it asked for, a walk back went nowhere. */
const NO_HEADWAY = 0.1;

/**
 * What pins it: walking back to its owner, a tick it could not make a
 * tenth of its walk, or was put back the way it came by as much —
 * monsters closing both ways round, or the scenery with no way through —
 * the nearest monster's body touching it in its way
 * (`touchingInTheWay`, npc-move.js), whose doid it keeps as `ai.pinnedBy`
 * for its next pick to take (`clearing`). A walk that
 * went anywhere, round a body or along a wall, pins it on nothing.
 *
 * The leash keeps a pet from chasing what is far; it does not keep it from
 * fighting what holds it in place. The official's pets held so got round:
 * past their TetherDist with a monster touching them in their way they
 * swung on 0-3% of quarter seconds (wolf n 189, rhino n 60, dragon n 18)
 * and were held p50 0.5 s; one with no way round at all is not in the
 * captures, and this is the maintainer's call for it. Ours stood, or went
 * to and fro, where nothing would let it through.
 */
const pinnedBy = (turn, intent, before) => {
  const { actor, ai } = turn;
  // Fighting what pins it, it is pinned on it still (`clearing`).
  if (!turn.following) return;
  const asked = Math.hypot(intent.x, intent.y);
  const step = { x: actor.position.x - before.x, y: actor.position.y - before.y };
  const went = Math.hypot(step.x, step.y);
  // Back the way it came is no way on, and aside, round a body, is.
  const back = asked > 0.001 && (step.x * intent.x + step.y * intent.y) / asked < -NO_HEADWAY * asked;
  const stuck = asked > 0.001 && (went < NO_HEADWAY * asked || back);
  ai.pinnedBy = stuck ? (touchingInTheWay(actor, intent, turn.around)[0]?.doid ?? null) : null;
  // The scenery as it stood: a change to it may open the way (`clearing`).
  ai.pinnedRevision = turn.session.navigation?.revision ?? null;
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
 * A pet's target this tick, its rules applied in turn, the same for every
 * pet row, every number its row's (`petAiOf`):
 *
 *   clear   walking back with no way on, it fights what pins it
 *           (`clearing`);
 *   leash   once farther than TetherDist from its owner it drops what it
 *           fights and walks back, and takes nothing on until it is back
 *           at ReturnDist (`leashed`);
 *   target  what it picked it holds until ChangeTargetT is up (`lockOn`)
 *           or the target is gone, and then picks again (`petPick`): a
 *           target it lost sight of and has no way to is held that long at
 *           most, and no timer of its own is needed (target-lock.js). The official wolf
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
 * owner with nothing to fight: either way it lets go and stands
 * (npc-targeting.js `pickTarget`, `LET_GO`).
 */
export const petTarget = (crowd, actor, now) => {
  const { ai } = actor;
  const owner = ownerOf(crowd.heroes, ai);
  if (!owner) return null;
  pickUpFor(owner, actor, now);
  const ownerDistance = distanceTo(actor.position, owner.position);
  const following = { victim: owner, following: true };
  const blocker = clearing(crowd, actor, now);
  if (blocker) return fighting(blocker);
  if (leashed(actor, owner, ownerDistance)) {
    letGoOfTarget(ai);
    disengage(ai);
    return following;
  }
  const locked = crowd.petTargets.find(({ doid }) => doid === ai.targetDoid);
  const victim = locked && stillLocked(ai, now) ? locked : petPick(crowd, actor, owner, now);
  if (victim) return fighting(victim);
  disengage(ai);
  return backAt(actor, owner, ownerDistance) ? null : following;
};

/**
 * Its way back cleared: the monster that pins it (`pinnedBy`), taken as its target as any pick is (`lockOn`), so it keeps
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
    if (holding || !blocker) letGoOfTarget(ai);
    ai.pinnedBy = null;
    return null;
  }
  return holding ? blocker : lockOn(ai, blocker, now);
};

/** A pet walks, at its full speed, unless it is backing out. */
export const pet = {
  intent: (turn) => petRetreat(turn.actor, turn) ?? walkTowards(turn, false),
  moved: pinnedBy,
};

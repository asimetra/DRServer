import { bodyClearSpot, bodyRadius, bodyWalkClear, contact } from "../body.js";
import { inBand } from "../npc-act.js";
import { collectNearbyForPet } from "../pickups.js";
import { STILL, walkEndsAt, walkTowards } from "./chase.js";
import { backsOffFrom } from "./kite.js";

/**
 * A player's pet, and a hero's walking summon: on the player's side, and
 * the player's to keep close.
 *
 * It picks its own target (`petTarget`, npc-targeting.js) — a monster near
 * it and its owner that it can get at, or its owner to walk back to — and
 * picks up for its owner on the way (`pickUpFor`). Fallen too far behind,
 * it is put back beside him (`snapBackSpot`). It walks at its
 * full speed, without the ramp a monster's walk has (`npcWalkingSpeed`),
 * and a ranged one backs out of a gap where none of its attacks can go
 * (`petRetreat`). Two of its rules live where the thing they change is: a
 * pet honours its attacks' MinRange (`usableAttacks`, npc-act.js), and in
 * the crowd it keeps a standoff from the players rather than touching them
 * (`separationDisplacement`, npc-crowd.js).
 */

/**
 * What a pet's row says about how it keeps to its owner, as its `ai` holds
 * it: one place for the equipped pet (npc-spawn.js) and the hero's walking
 * summon (placeables.js), which are the same thing on the floor. How often
 * it looks again at what it fights is every actor's ChangeTargetT
 * (npc-targeting.js).
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

/** A pet walks, at its full speed, unless it is backing out. */
export const pet = {
  intent: (turn) => petRetreat(turn.actor, turn) ?? walkTowards(turn, false),
};

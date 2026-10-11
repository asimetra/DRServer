import { contact } from "../body.js";
import { inBand } from "../npc-act.js";
import { nearestTo } from "../npc-crowd.js";
import { collectNearbyForPet } from "../pickups.js";
import { STILL, walkTowards } from "./chase.js";
import { backsOffFrom } from "./kite.js";

/**
 * A player's pet, and a hero's walking summon: on the player's side, and
 * the player's to keep close.
 *
 * It picks its own target (`petTarget`) — a monster near it, or its owner
 * to walk back to — and picks up for its owner on the way. It walks at its
 * full speed, without the ramp a monster's walk has (`npcWalkingSpeed`),
 * and a ranged one backs out of a gap where none of its attacks can go
 * (`petRetreat`). Two of its rules live where the thing they change is: a
 * pet honours its attacks' MinRange (`usableAttacks`, npc-act.js), and in
 * the crowd it keeps a standoff from the players rather than touching them
 * (`separationDisplacement`, npc-crowd.js).
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/**
 * Its target (npc-targeting.js): the nearest monster while it is engaged or
 * one comes within its aggro radius, and its owner otherwise, or when it has
 * been outside its tether too long — `following`, then. Null when it has no
 * owner on the floor, or is back at it with nothing to fight: it lets go and
 * waits. It also picks up for its owner, four times a second.
 */
export const petTarget = ({ heroes, petTargets }, actor, now) => {
  const { ai } = actor;
  const owner = heroes.find(({ doid: heroDoid }) => heroDoid === ai.ownerDoid);
  if (!owner) return null;
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
      return null;
    }
    ai.engaged = false;
    ai.state = "return";
    ai.targetDoid = owner.doid;
    return { victim: owner, following: true };
  }
  ai.targetDoid = enemy.doid;
  return { victim: enemy, following: false };
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

/** A pet walks, at its full speed, unless it is backing out. */
export const pet = {
  intent: (turn) => petRetreat(turn.actor, turn) ?? walkTowards(turn, false),
};

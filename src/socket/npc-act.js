import { FRAMES_PER_SECOND } from "../gamemaster.js";
import { furthestReach, bodyPointOf, reach, sightOrigin } from "./body.js";
import { buffMultiplierFor } from "./buffs.js";
import { performNpcAttack } from "./combat.js";
import { hasLineOfSight } from "./navigation.js";
import { floorAttackSpeedScale, npcAttackSpeed } from "./npc-attacks.js";
import { face } from "./npc-facing.js";
import { endBackOff } from "./behaviours/kite.js";

/**
 * Whether it swings this tick, and with what: the act stage of the AI.
 *
 * `act` asks, in order, what keeps it from swinging — following its owner,
 * being in the scenery, a swing of its own still under way, the victim out
 * of reach or out of sight, a back-off with no swing due, a stun, the
 * cadence, nothing to throw from here — and swings when nothing does. It
 * answers with the reason, which is what the state the floor command shows
 * is read from (ai.js).
 */

export const ATTACK_RANGE_EPSILON = 2;

/**
 * The attacks this one has, in the per-attack shape `usableAttacks` reads.
 *
 * An `ai` built before `attacks` existed, or by a test, has its single attack
 * promoted into the same shape rather than being special-cased anywhere.
 */
const attacksOf = (ai) =>
  (ai.attacks ??= [
    {
      attackType: ai.attackType,
      range: ai.attackRange ?? 0,
      minRange: 0,
      rechargeMs: 0,
      readyAt: 0,
      projectile: ai.projectile ?? null,
    },
  ]);

/**
 * Whether a swing from here can see its victim: a hero's feet or its body.
 *
 * A hero's wire position is its feet and its body is the circle 22 units above
 * them (`collisionPointOf`). The client keeps that body out of the walls, not
 * the feet, so a hero leaning on a wall *below* it has its feet on the wall's
 * edge or a unit or two inside it. A sight line to the feet alone then ends
 * inside the wall and every monster around reads the hero as behind it: they
 * walk up to contact and stand there. In one played floor (nordic caves, seed
 * 169884306) monsters spent 226 monster-seconds within 100 units of a hero
 * leaning on NORDIC_CAVE_WALL_B/D and landed 4 hits, against 0.76 a second
 * when the feet were clear. The official keeps swinging there: across the 96
 * official captures, with the feet inside this server's geometry at a wall
 * below, monsters within 100 units attacked 0.61 times a monster-second,
 * against 0.75 elsewhere.
 *
 * The feet are still asked first, so nothing that could be hit before is safe
 * now; the body only adds the hero whose feet are in the wall. A wall between
 * the monster and the hero hides both: the body is 22 above feet that are at
 * most on the near edge of a wall below, and 22 nearer a wall above them.
 *
 * Only for heroes. A monster's position is the point this server's own
 * navigation keeps clear of the walls, so it is already the right end.
 */
const victimInSight = (navigation, actor, victim, target, heroDoids) => {
  const origin = sightOrigin(actor);
  if (hasLineOfSight(navigation, origin, target, 0)) return true;
  if (!heroDoids.has(victim.doid)) return false;
  const body = bodyPointOf(victim.actor, target);
  return Boolean(body) && body !== target && hasLineOfSight(navigation, origin, body, 0);
};

/** The farthest it may swing from at all, given the two bodies: the bar `act` holds a swing to. */
export const reachOf = (ai, bodies) => furthestReach(attacksOf(ai), bodies);

/**
 * Whether one attack can go from `distance` now: off its own cooldown, within
 * its reach and, when `honoursMinRange`, outside its MinRange.
 */
export const inBand = (attack, distance, bodies, now, honoursMinRange) =>
  now >= (attack.readyAt ?? 0) &&
  (!honoursMinRange || distance + ATTACK_RANGE_EPSILON >= (attack.minRange ?? 0)) &&
  distance <= reach(attack, bodies) + ATTACK_RANGE_EPSILON;

/**
 * The attacks it could use from here, right now.
 *
 * `Range` is the most it may reach — from the edge of its body for a swing and
 * from the middle for a shot, see `reach` (body.js) — and `AI_RechargeT` is that
 * attack's own cooldown, which is what makes a shaman's fifteen-second summon
 * rare among its three-second bolts.
 *
 * `MinRange` is not a floor for a monster. It reads like one — a spear throw at
 * 400 to 700 — and the official ignores it: the ice imp's throw, authored
 * MinRange 400, went out below 400 on 53% of 1123 recorded casts (median 349,
 * a tenth under 135), its headbutt below 200 on 21%, Infinite's lightning orb
 * below 300 on 96%. The top is kept to: the throw's p90 is 637 against 700, the
 * back-off's 479 against 500. Treating it as a floor left an imp that had
 * hopped back and walked in again with nothing but another hop, so ours threw
 * 16% of the time against the official's 36% and hopped 48% against 27%.
 *
 * A pet keeps it: a ranged pet backs out to its projectile's MinRange (see
 * `petRetreat`, behaviours/pet.js), which is measured on pets and is theirs.
 */
const usableAttacks = (ai, distance, bodies, now) => {
  const honoursMinRange = ai.kind === "pet";
  return attacksOf(ai).filter((attack) => inBand(attack, distance, bodies, now, honoursMinRange));
};

/** Chooses uniformly from the authored attacks usable in this range/cooldown band. */
export const chooseNpcAttack = (
  ai,
  distance,
  bodies,
  now,
  random = Math.random
) => {
  const choices = usableAttacks(ai, distance, bodies, now);
  if (!choices.length) return null;
  const roll = Math.min(1 - Number.EPSILON, Math.max(0, Number(random()) || 0));
  return choices[Math.floor(roll * choices.length)];
};

/**
 * The gap before this NPC may swing again, rolled fresh each time.
 *
 * `AttackTimer` is the floor and `AttackTimeRand` the spread above it; see the
 * cadence figures where the two are read off the NPC row in dungeon.js. Rolling
 * per swing rather than once per NPC is what the corpus shows and what stops a
 * pack of four knights hitting on the same millisecond for a whole fight.
 *
 * The 100ms floor is for the four enemy rows that author `AttackTimer` 0 with
 * no spread. Without it they attack on every tick of the AI loop.
 */
/**
 * How long until this one swings again, and what is slowing it down.
 *
 * `slowness` is the reciprocal of an attack-speed multiplier: `CRIPPLE_L4`
 * authors `MELEE_SPD` 0.2, so a muzzled monster waits five times as long.
 *
 * This is the whole of what `CRIPPLE` — "Muzzling" at five stars, "Slow enemy
 * attacks for 6 sec!" — was supposed to do, and nothing read those columns. The
 * buff object was created and drawn and the monster swung on exactly the same
 * clock, which is the same shape of bug the stun check in `act` was written
 * for: a debuff that was a picture on the health bar.
 */
export const attackIntervalMs = (ai, slowness = 1) =>
  Math.max(
    100,
    ((ai.attackTimerMs ?? 1500) + Math.random() * (ai.attackRandMs ?? 0)) * Math.max(1, slowness)
  );

/** The swing itself, once `act` has said it happens, at `victim` standing at `target`. */
const swing = async (session, doid, actor, victim, target, chosen, now) => {
  const { ai } = actor;
  chosen.readyAt = now + (chosen.rechargeMs ?? 0);
  // Exactly at its victim, and the client told with the swing (npc-facing.js).
  face(session, doid, actor, target, { swing: true });

  /**
   * Both authored speed layers pace the cast.
   *
   * `AttackSpd` belongs to the selected attack, while an active buff modifies
   * the matching MELEE/SHOOT/MAGIC speed column. SAVAGE_BOW is the decisive
   * capture: EN_POISON_ARROW authors 0.25, the official sends playSpeed 0.25,
   * and its 1.5-second AttackTimer starts producing casts around six seconds.
   * This server dropped AttackSpd and did both four times too quickly.
   */
  const buffSpeed = buffMultiplierFor(session, doid, chosen.speedStat ?? "MELEE_SPD");
  const authoredSpeed = npcAttackSpeed(chosen.attackSpeed);
  const castSpeed = authoredSpeed * (buffSpeed > 0 ? buffSpeed : 1) * floorAttackSpeedScale(session);
  const buffSlowness = buffSpeed > 0 ? 1 / buffSpeed : 1;
  const frameMs = (frame) => Math.max(0, Number(frame ?? 0)) * (1000 / FRAMES_PER_SECOND) / castSpeed;

  /**
   * The lunge the attack itself carries, if it carries one.
   *
   * A constant velocity for `MoveDuration` at `MoveAngle` degrees off the way
   * it is facing, which is what the client does for the player and what the
   * corpus shows the official doing for monsters. It has just faced its
   * victim exactly, so an angle of 0 is a charge at them while 180 is a hop
   * backwards.
   *
   * From the frame the timeline puts `attackautomove` on (gamemaster.js,
   * `autoMoveFrame`), at the pace the cast plays: a frost troll winds its
   * drill up for fifteen frames and then goes, and started here on the swing
   * it had arrived before its own animation left the ground. An attack with
   * no frame of its own (a test's hand-made one) goes at once, as before.
   */
  if (chosen.moveAmount > 0 && chosen.moveDurationMs > 0) {
    const angle = ((actor.heading + chosen.moveAngle) * Math.PI) / 180;
    const speed = chosen.moveAmount / (chosen.moveDurationMs / 1000);
    const from = now + frameMs(chosen.moveFrame ?? 0);
    ai.lunge = {
      from,
      until: from + chosen.moveDurationMs,
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
    };
  }
  ai.attackLockedUntil = now +
    Math.max(0, Number(chosen.attackLockFrame ?? chosen.impactFrame ?? 0)) *
      (1000 / FRAMES_PER_SECOND) /
      castSpeed;
  ai.nextAttackAt = now + Math.max(100, attackIntervalMs(ai, buffSlowness) / authoredSpeed);
  // Awaited so the hit lands before the tick moves on: damage is the
  // server's own bookkeeping and must not race the next frame.
  const victimSession = victim.member
    ? victim.member.world?.contextFor(victim.member) ?? victim.member
    : session;
  ai.attackHeading = actor.heading;
  // A shot ends a back-off: it stands for the swing and fights from there.
  endBackOff(ai);
  await performNpcAttack(
    victimSession,
    doid,
    { ...ai, ...chosen, attackHeading: actor.heading },
    victim.doid
  );
};

/**
 * Whether it swings, given where the tick has left it: `turn` is the actor,
 * its victim and the victim's position, the two bodies, the distance it now
 * stands at, the route, and what the tick has found out — `following` its
 * owner, `attackLocked`, `cannotAttack`, `fleeing`, `seesAlways` for one that
 * does not ask the scenery. Answers with why it did not swing, or "swung".
 */
export const act = async (session, turn) => {
  const { doid, actor, victim, target, bodies, distance, route, now } = turn;
  const { ai } = actor;
  if (turn.following) return "following";
  // Nothing is fought from inside the scenery: out first. See routeToTarget.
  if (route.escaping) return "escaping";
  if (turn.attackLocked) return "locked";

  const clearAttack =
    turn.seesAlways || victimInSight(turn.navigation, actor, victim, target, turn.heroDoids);
  if (distance > reachOf(ai, bodies) || !clearAttack) return "out-of-reach";
  // Backing off, it still shoots when its swing is due: it stands for the
  // swing (the lock above) and carries on after.
  if (turn.fleeing && (turn.cannotAttack || now < ai.nextAttackAt)) return "backing-off";

  // A garlic trap's whole point: STUN_L4 for three seconds, during which it
  // does not swing. Without this the debuff was a picture on the health bar.
  if (turn.cannotAttack) return "stopped";
  if (now < ai.nextAttackAt) return "not-due";

  /**
   * Which of its moves this swing is.
   *
   * Being in reach is not the same as having something to throw: an imp
   * standing on the player is inside the MinRange of its spear and may have
   * spent its headbutt, and the honest answer then is that this swing does not
   * happen. Not rolling the cadence in that case is deliberate — it retries on
   * the next tick rather than burning the interval on a swing it could not
   * make.
   */
  const random = session.random ?? Math.random;
  const chosen = chooseNpcAttack(ai, distance, bodies, now, random);
  if (!chosen) return "no-attack";
  await swing(session, doid, actor, victim, target, chosen, now);
  return "swung";
};

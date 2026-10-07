import { attackById, FRAMES_PER_SECOND, invulnerableForMs, suicideDelayMs } from "../gamemaster.js";
import { buffMultiplierFor, grantBuff, hasAbility } from "./buffs.js";
import { collisionPointOf } from "./navigation.js";
import { floorAttackSpeedScale, npcAttackSpeed, npcAttackSpeedStat } from "./npc-attacks.js";
import { worldColliders } from "./heading.js";
import { info, warn } from "../log.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { RECEIVE_FIELD_BY_CLID, encodeCombatResults, npcAttackChoreography, receiveCombatResult } from "./combat-wire.js";
import { heroStaggerFor } from "./impact.js";
import { hazardVictims } from "./trap-attacks.js";
import { applyTargetBuff } from "./combat-effects.js";
import { priceHit, computePetDamage } from "./hit-pricing.js";
import { isInvulnerable, applyDamage } from "./combat.js";

/**
 * An NPC's attack as it lands: the swing's timeline frames, the projectile it
 * launches, the hit it deals and the state it leaves the victim in.
 * `performNpcAttack` is what the AI tick calls (ai.js).
 */

/**
 * Lands one monster swing, if it is still landing on anybody.
 *
 * `shape` is the attack's own colliders in world space, or nothing for an
 * attack that authors none. Given a shape, the hero has to be inside it — this
 * is the moment of contact, not the moment the monster decided to swing.
 */
/**
 * Prices and publishes one hit dealt by a monster, on whoever it landed on.
 *
 * Shared by the swing and by the shot, which is the point: a monster's arrow
 * costs the same as its sword by the same formula, and both are the server's to
 * decide. The official is unambiguous about that last part — across 54 captures
 * the client proposes 4646 combat results and every one of them is the hero
 * hitting something. It never once proposes a monster hitting the hero, and the
 * 4469 results that do are all sent by the server.
 */
const dealNpcHit = async (session, attackerDoid, { attack, attackType, weaponPower }, victimDoid) => {
  const victim = session.actors?.get(victimDoid);
  const attacker = session.actors?.get(attackerDoid);
  const clid = session.objects?.get(victimDoid);
  if (!victim || victim.dead || !RECEIVE_FIELD_BY_CLID[clid]) return false;

  const dealsDamage = Number(attack?.DamageMod ?? 0) < 0;
  if (dealsDamage && isInvulnerable(session, victimDoid)) return false;
  const priced = !dealsDamage
    ? { damage: 0, neutral: 0, effectiveness: 0 }
    : attacker?.isPet
      ? await computePetDamage(session, attackerDoid, victimDoid, attack, weaponPower)
      : await priceHit(
          session,
          { attacker: attackerDoid, attackee: victimDoid },
          attack,
          weaponPower
        );
  const { damage } = priced;

  /**
   * Monster attacks use the same authored effects as every other hit. Official
   * captures create POISON_L1 from EN_POISON_ARROW, both CHILL_L1 and FREEZE
   * from EN_BABY_YETI_SUICIDE, and STUN_L0 from the juggernaut charge. The NPC
   * path previously stopped at damage and discarded all of them.
   */
  await applyTargetBuff(session, {
    attack,
    victimDoid,
    attackerDoid,
    damage: priced.neutral,
  });

  // Roars, taunts and self-buff moves author DamageMod zero. The official sends
  // their choreography (and any buff generate), but no CombatResult at all.
  if (!dealsDamage) return Boolean(attack?.TargetBuff1 || attack?.TargetBuff2);

  const reaction = receiveCombatResult(
    victimDoid,
    RECEIVE_FIELD_BY_CLID[clid],
    encodeCombatResults({
      doid: attackerDoid,
      attackType,
      combatResults: [
        {
          attacker: attackerDoid,
          attackee: victimDoid,
          damage: -damage,
          attackType,
          targetActorDoid: 0,
          effectiveness: priced.effectiveness,
          ...heroStaggerFor(session, attack, damage, victimDoid, session.random ?? Math.random),
        },
      ],
    })
  );
  applyDamage(session, victimDoid, damage, () => session.send(reaction));
  info(
    `[${session.id}] AI ${attackerDoid} hit ${victimDoid} for ${damage} ` +
      `(${victim.hitPoints}/${victim.maxHitPoints}hp)`
  );
  return true;
};

const npcAttackDisabled = (session, doid) =>
  ["STUN", "SHOCK", "PARALYZED", "DISABLE_CONTROLS"]
    .some((ability) => hasAbility(session, doid, ability));

const landNpcSwing = async (
  session,
  attackerDoid,
  ai,
  attack,
  shape,
  victimDoid,
  alreadyHit = null
) => {
  const attacker = session.actors?.get(attackerDoid);
  const victim = session.actors?.get(victimDoid);
  if (!attacker || attacker.dead || !victim || victim.dead) return false;
  if (npcAttackDisabled(session, attackerDoid)) return false;

  if (shape?.length) {
    const reach = worldColliders(
      attacker.position,
      ai.attackHeading ?? attacker.heading ?? 0,
      shape
    );
    const caught = hazardVictims(session, reach, { attack, team: attacker.team })
      .filter(({ doid }) => doid !== attackerDoid && !alreadyHit?.has(doid));
    if (!caught.length) return false;

    /**
     * The chosen target decides where the NPC faces, not everything the arc
     * touches. This distinction is what lets a pet take the occasional melee
     * hit without owning the monster's aggro: in official pet captures only
     * 12.7% of measurable pet hits align with the pet, while most align with a
     * nearby hero. Resolving only `victimDoid` turned collateral into target
     * selection and forced AI to aggro pets merely so they could ever be hit.
     */
    let hits = 0;
    for (const caughtActor of caught) {
      if (
        await dealNpcHit(
          session,
          attackerDoid,
          { attack, attackType: ai.attackType, weaponPower: ai.weaponPower },
          caughtActor.doid
        )
      ) {
        alreadyHit?.add(caughtActor.doid);
        hits += 1;
      }
    }
    return hits > 0;
  }

  return dealNpcHit(
    session,
    attackerDoid,
    { attack, attackType: ai.attackType, weaponPower: ai.weaponPower },
    victimDoid
  );
};

/**
 * Puts a monster's shot into the air, to be resolved by where it gets to.
 *
 * The same flight the traps have used since their arrows stopped passing
 * through people: one record on the shared list, swept against actors and
 * walls, dead at its authored range. Only the pricing differs, so only the
 * pricing is passed in.
 *
 * Launched from the frame the timeline authors rather than from the start of
 * the animation, and that frame is not a rounding detail — a bow looses on
 * frame 2 and a specter's cast leaves its hands on frame 30, which is 1250ms.
 * The official's median delay between a `PURPLE_SPECTER` announcing and the
 * hero's result arriving is 1494ms, so the cast is most of it.
 */
const launchNpcProjectile = (session, attackerDoid, ai, attack, launch = {}) => {
  const attacker = session.actors?.get(attackerDoid);
  const projectile = ai.projectile;
  if (!attacker || attacker.dead || !projectile || !attacker.position) return false;
  if (npcAttackDisabled(session, attackerDoid)) return false;

  /**
   * The client's own transform, which keeps four things apart:
   *
   *   ProjectileAttackTimelineAction.execute
   *     angle  = heading + headingOffsetAngle (+ rand(-r, r))
   *     origin = worldCenter
   *            + headingOffset x (cos, sin)(angle)     <- a distance
   *            + (xOffset, yOffset)                    <- world axes, unrotated
   *     direction = getHeadingAsVector(headingOffsetAngle)
   *
   * This read `headingOffset` as though it were degrees. It is not, and
   * `TM_GATLING_ARROW` says so loudest: 40 with an angle of zero, which turned
   * six arrows out of a statue's mouth into six fired forty degrees off the
   * ones the player can see.
   *
   * `worldCenter` is the body above the feet — the same `collisionPointOf` the
   * victims are tested at, so both ends of the shot are finally in one
   * coordinate system.
   */
  const spread = Number(launch.headingRandomnessAngle ?? 0);
  const random = session.random ?? Math.random;
  const angle =
    Number(ai.attackHeading ?? attacker.heading ?? 0) +
    Number(launch.headingOffsetAngle ?? 0) +
    (spread ? (random() * 2 - 1) * spread : 0);
  const radians = (angle * Math.PI) / 180;
  const centre = collisionPointOf(attacker, attacker.position) ?? attacker.position;
  const muzzle = Number(launch.headingOffset ?? 0);
  const origin = {
    x: centre.x + muzzle * Math.cos(radians) + Number(launch.xOffset ?? 0),
    y: centre.y + muzzle * Math.sin(radians) + Number(launch.yOffset ?? 0),
  };
  const radius = Math.max(0, projectile.CollisionSize ?? 15);

  session.activeTrapProjectiles ??= [];
  session.activeTrapProjectiles.push({
    attackerDoid,
    attack,
    attackerTeam: attacker.team,
    position: origin,
    direction: { x: Math.cos(radians), y: Math.sin(radians) },
    // It leaves from inside the shooter's own body, so the shooter cannot be
    // the first thing it hits.
    ignoreDoid: attackerDoid,
    speed: Math.max(1, projectile.ProjSpeed ?? 1),
    range: Math.max(1, projectile.Range ?? attack?.Range ?? 400),
    radius,
    ignoreWalls: Object.hasOwn(projectile, "IgnoreWalls"),
    traveled: 0,
    // What makes this a monster's shot rather than a trap's: an actor's damage
    // formula instead of a share of the health bar.
    deal: (victimDoid) =>
      dealNpcHit(
        session,
        attackerDoid,
        { attack, attackType: ai.attackType, weaponPower: ai.weaponPower },
        victimDoid
      ),
  });
  return true;
};

/**
 * A monster swings, and the swing is resolved where and when it actually lands.
 *
 * "Their attacks don't connect and we take damage anyway." Both halves of the
 * geometry were wrong, and each on its own is enough to produce that.
 *
 * *When*: this used to compute the damage and take it off the bar in the same
 * breath as sending the animation, while telling the client the impact was at
 * frame `impactFrame`. A knight's `EN_SWORD_SLASH` authors its collider at
 * frame 11 of 12 — 458ms of windup — so the health dropped while the sword was
 * still going up, and a player who stepped away during it was hit by a swing
 * they watched miss.
 *
 * *Where*: reach was `Range` measured from the monster's middle in every
 * direction, so a knight hit whoever stood behind it. The timeline says
 * otherwise, and it says it per attack:
 *
 *   EN_SWORD_SLASH    circle r40 at 45 in front, frame 11
 *   EN_MACE_CHOP      circle r35 at 70 in front, frame 3
 *   EN_SPEAR_THRUST   200x70 box at 100 in front, frame 4
 *   EN_RAPTOR_BITE    circle r35 at 70 in front, frame 3
 *
 * These are the same shapes, read the same way, that traps have been resolved
 * with since the mace stopped hurting people it swung over.
 *
 * Ranged attacks author no collider — `EN_ICE_IMP_ATTACK` and `EN_ARROW_SHOT`
 * carry Range 700 and 600 and nothing else — and are left resolving as they
 * did, at the moment they are thrown. Giving them a projectile of their own is
 * a separate piece of work; making them miss in the meantime would be worse
 * than the bug.
 */
export const performNpcAttack = async (
  session,
  attackerDoid,
  ai,
  victimDoid = session.heroDoid
) => {
  const victim = session.actors?.get(victimDoid);
  if (!victim || victim.dead || !ai?.attackType) return false;
  const attack = await attackById(ai.attackType);
  // Snapshot the speed before this cast's own SelfBuff is granted. The official
  // juggernaut stream sends its speed buff first but still plays that cast at 1;
  // the new buff begins affecting the next attack.
  const buffSpeed = buffMultiplierFor(
    session,
    attackerDoid,
    ai.speedStat ?? npcAttackSpeedStat(attack?.AttackType)
  );
  const attackSpeed = npcAttackSpeed(ai.attackSpeed ?? attack?.AttackSpd) *
    (buffSpeed > 0 ? buffSpeed : 1) *
    floorAttackSpeedScale(session);

  /**
   * A self buff precedes the animation. In the official stream the two captured
   * EN_JUGGERNAUT_SWING casts create SUPER_SPEED_BOOSTER_L3 one millisecond
   * before ReceiveAttackChoreography; this server created nothing.
   */
  if (attack?.SelfBuff) {
    await grantBuff(session, attack.SelfBuff, {
      affectedActor: attackerDoid,
      attackerActor: attackerDoid,
    });
  }

  const untouchableMs = await invulnerableForMs(attack?.AttackTimeline);
  if (untouchableMs > 0) {
    session.invulnerableUntil ??= new Map();
    session.invulnerableUntil.set(attackerDoid, Date.now() + untouchableMs / attackSpeed);
  }

  /**
   * Announced once, on its own. `ReceiveAttackChoreography` restarts the
   * animation from frame zero, so the result cannot ride along on a second one
   * — it goes out by itself when the swing connects, the way a trap's does.
   */
  /**
   * And it swings at whatever speed its debuffs leave it.
   *
   * `playSpeed` scales the animation the client plays, and the official scales
   * it by exactly the attack-speed multiplier the actor is carrying: of its
   * `ReceiveAttackChoreography` packets, 57 land on 0.20 while the monster holds
   * a `CRIPPLE_L3` or `CRIPPLE_L4` — both authoring `MELEE_SPD` 0.2 — and 3 on
   * 0.85 under `CHILL_L1`, which authors 0.85. Fifty-seven of fifty-seven, on
   * the nose.
   *
   * This is the half of Muzzling that was reported missing twice. The interval
   * between swings was lengthened first, and the swing itself went on playing at
   * full speed — so a muzzled monster hit less often and looked exactly as
   * quick, which is the opposite of what the modifier promises.
   */
  session.send(
    npcAttackChoreography({
      doid: attackerDoid,
      attackType: ai.attackType,
      targetActorDoid: victimDoid,
      playSpeed: attackSpeed,
      // The weapon this swing is drawn with (npc-attacks.js `weaponSlot`).
      weaponSlot: ai.weaponSlot ?? 0,
    })
  );

  // Some boss timelines drive the floor itself. The floor installs this hook
  // only for NPC placements watched by NPC_EVENT_TRIGGER, so ordinary attacks
  // pay no behavioural cost and cannot accidentally start unrelated wiring.
  Promise.resolve(session.runNpcTimeline?.(attackerDoid, attack, attackSpeed)).catch((error) =>
    warn(`npc timeline ${attackerDoid}: ${error.message ?? error}`)
  );

  // Whatever the attack calls onto the floor — see summons.js. Before the
  // no-contact return below, because a summon is exactly an attack that
  // touches nobody.
  session.summon?.(attackerDoid, attack, attackSpeed);

  /**
   * A shot is put in the air and resolved by where it gets to; a swing is
   * resolved by what its collider covers when it comes round. Which of the two
   * this is comes from the attack row, not from a list of names.
   */
  const shape = ai.attackColliders ?? [];
  const shots = ai.projectile ? ai.projectileLaunches ?? [] : [];
  const frameMs = (frame) =>
    Math.max(0, Number(frame ?? 0)) * (1000 / FRAMES_PER_SECOND) / attackSpeed;

  /**
   * No authored contact means no hit.
   *
   * The official corpus contains 2,043 casts of four negative-DamageMod NPC
   * attacks with neither colliders nor projectile launches and zero combat
   * results: the imp's showoff/backoff, its spawn, and Papa Yeti spawning
   * babies. Their timeline animation or spawned actor is the effect. Turning
   * the negative table value into a direct fallback hit made those actions
   * damage their selected target at any distance, with nothing touching it.
   */
  if (!shots.length && !shape.length) {
    return true;
  }

  const cancelTimers = [];
  const immediate = [];
  const later = (delay, run) => {
    if (!delay && !session.combatClock?.setTimeout) {
      immediate.push(Promise.resolve(run()).catch(report));
      return;
    }
    const invoke = () => Promise.resolve(run()).catch(report);
    if (session.combatClock?.setTimeout) {
      const handle = session.combatClock.setTimeout(invoke, delay);
      cancelTimers.push(() => session.combatClock?.clearTimeout?.(handle));
      return;
    }
    const scope = session.floorScope;
    const handle = scope ? scope.timeout(invoke, delay) : setTimeout(invoke, delay);
    if (!scope) handle.unref?.();
    cancelTimers.push(() => cancelScopedTimer(scope, handle, clearTimeout));
  };
  const report = (error) =>
    warn(`npc attack ${attackerDoid}: ${error.stack ?? error.message ?? error}`);

  /**
   * Every shot the timeline authors, each on its own frame. A gatling statue
   * looses six between frames 35 and 54 and a specter's triple cast three on
   * one frame; taking only the first left five sixths of the burst drawn by
   * the client and unknown to the server.
   *
   * And its colliders as well, not instead: two attacks author both. The Mini
   * Boss Imp's pulse pulls with a 500-unit circle on frame 0 and then looses
   * sixteen bolts, and the official's hero took up to seventeen hits from one
   * cast — the circle and every bolt. Ours fired the bolts and dropped the
   * circle.
   */
  for (const launch of shots) {
    later(frameMs(launch.frame), () =>
      launchNpcProjectile(session, attackerDoid, ai, attack, launch)
    );
  }

  /**
   * Each collider frame is its own hit. A moving or persistent attack authors
   * one collider set per active frame, and the client builds a CombatGameObject
   * per collider action with its own hit map — so a body standing in three
   * frames of a scratch is scratched three times, not once.
   *
   * Across the official corpus the most hits one cast landed on one hero equals
   * the attack's collider frame count for all 40 monster attacks with any:
   * BABY_YETI_SCRATCH 3 of 3 frames (349 casts once, 119 twice, 152 three
   * times), YETI_PUNCH 2, FART 2, TROLL_DRILL 4, SHADOW_SLASH 6, every
   * single-frame swing 1. This server allowed one hit per cast, so every
   * multi-frame attack — most of what makes a boss or a miniboss hit hard —
   * landed a fraction of itself. Several shapes on one frame are still one hit:
   * CLONE_BLITZ's three together landed once.
   *
   * A collider authoring `lifeTime` stays that many frames and, with
   * `hitDelayPerObject`, strikes again every that many: the green warthog's
   * puke three times twenty frames every five, the flame dive ten every five.
   */
  const byFrame = new Map();
  for (const collider of shape) {
    const frame = Math.max(0, Number(collider.frame ?? 0));
    const colliders = byFrame.get(frame) ?? [];
    colliders.push(collider);
    byFrame.set(frame, colliders);
  }
  for (const [frame, colliders] of byFrame) {
    const lifetime = Math.max(1, ...colliders.map((collider) => Number(collider.lifeTime) || 1));
    const rehit = Math.max(0, ...colliders.map((collider) => Number(collider.hitDelayPerObject) || 0));
    const eligibleAt = new Map();
    const oneLifetimeHitMap = new Set();
    for (let offset = 0; offset < lifetime; offset += 1) {
      // Check overlap on every active frame. hitDelayPerObject controls when a
      // body becomes eligible again; it is not the collider's polling rate.
      const hits = rehit
        ? {
            has: (doid) => offset < (eligibleAt.get(doid) ?? 0),
            add: (doid) => eligibleAt.set(doid, offset + rehit),
          }
        : oneLifetimeHitMap;
      later(frameMs(frame + offset), () =>
        landNpcSwing(session, attackerDoid, ai, attack, colliders, victimDoid, hits)
      );
    }
  }

  /**
   * `suicide` is another server-owned timeline action. The official removes a
   * SUICIDE_BABY_YETI a median 1075ms after its cast; its action is on frame 24,
   * exactly one second at the authored 24fps before the server tick notices it.
   */
  const suicideMs = await suicideDelayMs(attack?.AttackTimeline);
  if (suicideMs != null) {
    later(suicideMs / attackSpeed, () => {
      const attacker = session.actors?.get(attackerDoid);
      if (!attacker || attacker.dead) return false;
      return applyDamage(session, attackerDoid, Math.max(1, Number(attacker.hitPoints) || 1));
    });
  }

  // The AI loop awaits this function. Frame-zero damage and buffs therefore
  // finish their authoritative bookkeeping before that tick moves on, while
  // later authored frames remain scheduled independently.
  if (immediate.length) await Promise.all(immediate);

  // Keyed by the attacker, so its next attack replaces this one and a floor
  // change cancels every beat still in flight.
  if (cancelTimers.length) {
    session.hazardBeats ??= new Map();
    session.hazardBeats.get(`swing:${attackerDoid}`)?.();
    session.hazardBeats.set(`swing:${attackerDoid}`, () =>
      cancelTimers.forEach((cancel) => cancel())
    );
  }
  return true;
};

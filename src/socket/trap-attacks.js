import { CLID } from "./opcodes.js";
import { config } from "../config.js";
import { legendaryShieldFor, legendaryTrapShield } from "../hero-stats.js";
import { collisionPointOf, hasLineOfSight } from "./navigation.js";
import { matchStateOf, worldOf } from "./match-world.js";
import { info, warn } from "../log.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { RECEIVE_FIELD_BY_CLID, encodeCombatResults, npcAttackChoreography, receiveCombatResult, isPartyHero } from "./combat-wire.js";
import { trapStaggerFor } from "./impact.js";
import { applyTargetBuff } from "./combat-effects.js";
import { weaponsForHero, priceHit } from "./hit-pricing.js";
import { applyDamage } from "./combat.js";
import { isScenery } from "./actor-roles.js";

/**
 * Traps and hazards as attackers: which colliders catch whom (circle, segment
 * and area hits, the hazard index), what a trap hit costs, and the trap
 * projectiles — launched, flown and landed on the floor's own clock. A trap is
 * the floor's, priced from the floor and not from any session.
 */

const circleHitsCollider = (center, radius, collider) => {
  if (!center || !collider) return false;
  if (collider.type === "circle") {
    const dx = center.x - collider.x;
    const dy = center.y - collider.y;
    const combinedRadius = radius + Math.max(0, collider.radius ?? 0);
    return dx * dx + dy * dy <= combinedRadius * combinedRadius;
  }

  if (collider.type !== "rectangle") return false;
  const angle = -(collider.angle ?? 0);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = center.x - collider.x;
  const dy = center.y - collider.y;
  const localX = dx * cosine - dy * sine;
  const localY = dx * sine + dy * cosine;
  const closestX = Math.max(
    -(collider.halfWidth ?? 0),
    Math.min(collider.halfWidth ?? 0, localX)
  );
  const closestY = Math.max(
    -(collider.halfHeight ?? 0),
    Math.min(collider.halfHeight ?? 0, localY)
  );
  const distanceX = localX - closestX;
  const distanceY = localY - closestY;
  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
};

/**
 * Everything standing in a trap is standing in it.
 *
 * This asked only about the hero, so a spike bed or a flame jet was scenery to
 * every monster in the room — they walked through it untouched while the player
 * beside them burned.
 */
export const areaTrapHits = (hazard, position, victim) => {
  const radius = Math.max(0, victim?.collisionRadius ?? 30);
  const centre = collisionPointOf(victim, position);
  return (hazard?.combatColliders ?? []).some((collider) =>
    circleHitsCollider(centre, radius, collider)
  );
};

/**
 * Whether an attack is allowed to connect at all, by side.
 *
 * `CombatGameObject.determineIfHitBasedOnTeam` is the entire rule and this
 * server had no equivalent: a HOSTILE attack lands when the teams differ, a
 * FRIENDLY one when they match, and 506 of the game's 573 attacks are HOSTILE.
 *
 * Without it every trap hit everything standing in it. Nine `MINE_PLACEABLE_ALL`
 * sit together on a temple floor, all on team 7 with ten hit points each, and a
 * mine's blast does 52 — so the first to go off killed the other eight inside
 * three milliseconds, on every floor, before the player had moved. The mines
 * were not invisible; there were none left to see.
 *
 * An unknown team is not a reason to refuse: a victim this server has not
 * classified should still be hittable, which is what it was before.
 */
const teamAllowsHit = (attack, attackerTeam, victimTeam) => {
  if (attackerTeam === undefined || victimTeam === undefined) return true;
  return String(attack?.Team) === "FRIENDLY"
    ? attackerTeam === victimTeam
    : attackerTeam !== victimTeam;
};

/**
 * Who a trap can reach, asked of one actor.
 *
 * `includeBodies` is for the one caller that needs a body rather than a target:
 * a projectile is stopped by a downed player, which is what the client draws.
 * It admits fallen *heroes* only — a dead monster is faded out and is not cover
 * — and everything else asks who can be hurt, which a corpse cannot be.
 *
 * Nor can anything whose row says IsAttackable 0, and this is the one place
 * every NPC swing, floor trap and shot chooses its victims. It is the client's
 * own rule, word for word: `CombatGameObject.collisionCallback` passes over an
 * actor that is not `isAttackable` before it asks about sides, and
 * `ProjectileGameObject.enterContact` treats one as a wall. So a shot is still
 * stopped by one (`includeBodies`) and nothing hurts it. Across the official
 * corpus 426 such actors with hit points were generated — 84 floor mines, 144
 * burning patches, 61 garlic, 39 lightning orbs, the 5 consumable bombs — and
 * not one combat result names any of them as its victim, against 26587 on
 * attackable NPCs. Ours, with this unasked, let monsters' swings take 2 of 14
 * of its bombs, which vanished without going off, and on `sim:ai` kill the
 * temple's and village's floor mines and fire patches.
 *
 * Returns where the actor stands, or null when the trap cannot reach it.
 */
const reachablePosition = (session, state, doid, actor, { attack, attackerTeam, includeBodies }) => {
  if (!actor) return null;
  if (actor.teleportHidden) return null;
  // Only a fallen *hero* counts as still being there. Killing an NPC leaves
  // its entry in the map with `dead` set — nothing removes it on the ordinary
  // path — so admitting every corpse turned each dead monster into cover and
  // an arrow trap with anything dead in front of it stopped hurting anybody.
  if (actor.dead && !(includeBodies && isPartyHero(session, doid))) return null;
  if (actor.attackable === false && !includeBodies) return null;
  const clid = state.objects?.get(doid);
  if (!RECEIVE_FIELD_BY_CLID[clid]) return null;
  // A late join installs its actor before replay so its create/state can be
  // composed, but it is not part of live gameplay until snapshot activation.
  // Without this, shared traps could damage an unseen hero during that gap.
  if (clid === CLID.HeroGameObject && !isPartyHero(session, doid)) return null;
  if (attack && !teamAllowsHit(attack, attackerTeam, actor.team)) return null;
  /**
   * The session's cached position is preferred for its own hero because it is
   * the fresher of the two, but it is only a preference. Reading it as the
   * *only* source dropped that actor out of the list whenever the cache was
   * empty — and an actor missing from this list is not merely unhurt, it also
   * stops a projectile from noticing it at all.
   */
  return (doid === session.heroDoid ? session.heroPosition : null) ?? actor.position ?? null;
};

/**
 * Every actor a trap can reach, in the floor's own order, each handed to
 * `visit(doid, actor, position)` until one returns true.
 *
 * Walked live and built into nothing. This is asked per hazard per contact
 * tick and per flying shot per 20 ms projectile tick, and it used to answer
 * with a `{ doid, actor, position }` for every living actor, read off the
 * actor Map's entries, every time: across the nine libraries x 4000 ticks of
 * `sim:ai` (loadsim hero, seed 1) that was 3.8M calls, 100M entries walked and
 * 28.6M records, of which the shots kept 14M only to ask `find` for the first
 * one in the way. The entry arrays alone were 10.4 GB of 34.5 GB sampled
 * garbage. Walking the keys allocates nothing, and the callers' own test runs
 * as it goes, so only an actor that passes it becomes a record.
 *
 * The answer is not kept between calls, even within one tick: it changes
 * between two neighbouring bites — the first one kills, a monster steps, a
 * thrown trap lands and is an actor — and the actor Map has no version to tell
 * a stale list from a fresh one. Only the side test is worth keeping, and only
 * while nothing happens; see `shotTargets`.
 */
const eachTrapVictim = (
  session,
  { attack, attackerTeam, includeBodies = false, candidateDoids = null },
  visit
) => {
  const state = matchStateOf(session);
  const actors = state.actors;
  if (!actors) return;
  const asked = { attack, attackerTeam, includeBodies };
  const consider = (doid) => {
    const actor = actors.get(doid);
    const position = reachablePosition(session, state, doid, actor, asked);
    return position ? visit(doid, actor, position) : false;
  };
  // Two loops rather than one over either: a loop that meets both a Set and a
  // Map's keys is generic, and a generic loop allocates a result per step.
  if (candidateDoids) {
    for (const doid of candidateDoids) if (consider(doid)) return;
    return;
  }
  for (const doid of actors.keys()) if (consider(doid)) return;
};

const always = () => true;

/**
 * Who a trap can reach, and of those whoever passes `test(doid, actor, position)`:
 * the shape a trap asks about, so that nobody who is not in it is ever made
 * into a record.
 */
export const trapVictims = (session, options = {}, test = always) => {
  const victims = [];
  eachTrapVictim(session, options, (doid, actor, position) => {
    if (test(doid, actor, position)) victims.push({ doid, actor, position });
    return false;
  });
  return victims;
};

/** The first actor, in the floor's order, a trap can reach and `test` admits. */
const firstTrapVictim = (session, options, test) => {
  let found = null;
  eachTrapVictim(session, options, (doid, actor, position) => {
    if (!test(doid, actor, position)) return false;
    found = { doid, actor, position };
    return true;
  });
  return found;
};

const HAZARD_ACTOR_CELL = 256;
/**
 * A grid cell as one number rather than an "x,y" string: unique while a row
 * index stays under 2^19 cells (134M units) either side of zero, and it builds
 * and hashes without making a string per cell per actor per contact tick.
 */
const hazardCellKey = (x, y) => x * 1048576 + y;

const hazardColliderBounds = (collider) => {
  if (collider?.type === "circle") {
    const radius = Math.max(0, Number(collider.radius ?? 0));
    return {
      minX: collider.x - radius,
      maxX: collider.x + radius,
      minY: collider.y - radius,
      maxY: collider.y + radius,
    };
  }
  if (collider?.type !== "rectangle") return null;
  const cosine = Math.abs(Math.cos(Number(collider.angle ?? 0)));
  const sine = Math.abs(Math.sin(Number(collider.angle ?? 0)));
  const spanX = Number(collider.halfWidth ?? 0) * cosine +
    Number(collider.halfHeight ?? 0) * sine;
  const spanY = Number(collider.halfWidth ?? 0) * sine +
    Number(collider.halfHeight ?? 0) * cosine;
  return {
    minX: collider.x - spanX,
    maxX: collider.x + spanX,
    minY: collider.y - spanY,
    maxY: collider.y + spanY,
  };
};

/**
 * Where the grid build and a shot's sweep read each body from: written by
 * `collisionPointOf`, read at once, never kept.
 */
const bodyCentre = { x: 0, y: 0 };

/**
 * Builds one actor grid for every sustained hazard sharing this timestamp.
 *
 * Each cell holds its actors in an array, in the floor's order: an actor is
 * walked once and enters a cell at most once, so a Set per cell bought
 * nothing. In the run measured at `eachTrapVictim` the build was 7.4 GB of
 * the 34.5 GB of sampled garbage — the Sets 2.7, the string keys and points
 * 2.75, the records it was read from 1.0 — and with arrays, numeric keys and
 * no records it is 3.5.
 *
 * The grid is a function of one list and nothing else: who the walk admits,
 * in the floor's order, each with the centre and radius of its body. So the
 * walk writes that list down, and when it is the very list the last build
 * wrote, the last build's cells are the answer and are handed on unchanged.
 * Same numbers in the same order make the same cells; any difference — one
 * actor moved, fell, joined or left, a NaN anywhere — builds afresh. On the
 * same run 94,771 of 103,156 builds (92%) found the floor as the last one
 * left it, and 13,363 of 16,315 (82%) with the `walls` hero on three
 * libraries x 2000 ticks: the contact tick runs every 100 ms and most of
 * what traps can reach stands still between two of them. The grid went from
 * 14.6% to 11.5% of the run's CPU; what is left is the walk itself, which a
 * hand-on cannot skip, because the walk is how it knows nothing moved.
 */
const hazardVictimIndex = (session, now) => {
  const state = matchStateOf(session);
  const actors = state.actors;
  const cached = state.hazardVictimIndex;
  if (cached?.at === now && cached.actors === actors && cached.size === actors?.size) return cached;

  // Written into the list the build before last used, so neither is remade.
  const bodies = cached?.spare ?? [];
  let length = 0;
  eachTrapVictim(session, {}, (doid, actor, position) => {
    const center = collisionPointOf(actor, position, bodyCentre);
    bodies[length++] = doid;
    bodies[length++] = center.x;
    bodies[length++] = center.y;
    bodies[length++] = Math.max(0, Number(actor?.collisionRadius ?? 30));
    return false;
  });
  const cells = cached && sameBodies(cached.bodies, cached.length, bodies, length)
    ? cached.cells
    : gridOf(bodies, length);
  const index = {
    at: now,
    actors,
    size: actors?.size ?? 0,
    cells,
    bodies,
    length,
    spare: cached?.bodies ?? [],
  };
  state.hazardVictimIndex = index;
  return index;
};

/** Whether two walks wrote the same list, number for number (NaN never matches). */
const sameBodies = (before, beforeLength, after, afterLength) => {
  if (beforeLength !== afterLength) return false;
  for (let at = 0; at < afterLength; at++) if (before[at] !== after[at]) return false;
  return true;
};

/** The cells of a walk's list: each body in every cell its circle's bounds touch. */
const gridOf = (bodies, length) => {
  const cells = new Map();
  for (let at = 0; at < length; at += 4) {
    const doid = bodies[at];
    const centreX = bodies[at + 1];
    const centreY = bodies[at + 2];
    const radius = bodies[at + 3];
    const fromX = Math.floor((centreX - radius) / HAZARD_ACTOR_CELL);
    const toX = Math.floor((centreX + radius) / HAZARD_ACTOR_CELL);
    const fromY = Math.floor((centreY - radius) / HAZARD_ACTOR_CELL);
    const toY = Math.floor((centreY + radius) / HAZARD_ACTOR_CELL);
    for (let x = fromX; x <= toX; x++) {
      for (let y = fromY; y <= toY; y++) {
        const key = hazardCellKey(x, y);
        const bucket = cells.get(key);
        if (bucket) bucket.push(doid);
        else cells.set(key, [doid]);
      }
    }
  }
  return cells;
};

export const hazardCandidateDoids = (session, colliders = [], now = Date.now()) => {
  const index = hazardVictimIndex(session, now);
  const candidates = new Set();
  for (const collider of colliders) {
    const bounds = hazardColliderBounds(collider);
    if (!bounds) return null; // Unknown shape: preserve correctness with the full scan.
    for (let x = Math.floor(bounds.minX / HAZARD_ACTOR_CELL);
      x <= Math.floor(bounds.maxX / HAZARD_ACTOR_CELL); x++) {
      for (let y = Math.floor(bounds.minY / HAZARD_ACTOR_CELL);
        y <= Math.floor(bounds.maxY / HAZARD_ACTOR_CELL); y++) {
        const bucket = index.cells.get(hazardCellKey(x, y));
        if (bucket) for (const doid of bucket) candidates.add(doid);
      }
    }
  }
  return candidates;
};

const segmentHitsCircle = (from, to, center, radius) => {
  if (!from || !to || !center) return false;
  const segmentX = to.x - from.x;
  const segmentY = to.y - from.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  const centerX = center.x - from.x;
  const centerY = center.y - from.y;
  const ratio =
    lengthSquared > 0
      ? Math.max(0, Math.min(1, (centerX * segmentX + centerY * segmentY) / lengthSquared))
      : 0;
  const dx = from.x + segmentX * ratio - center.x;
  const dy = from.y + segmentY * ratio - center.y;
  return dx * dx + dy * dy <= radius * radius;
};

/**
 * What a trap takes off you.
 *
 * Most of them charge a share of the bar — `DoPercentHealthDamage` with a
 * twelfth on nearly every trap in the game, a fifth for Thor's hammer, a
 * thirtieth for the tar pit — and the captures agree: 50 off a 420-point Ranger
 * is 11.9%.
 *
 * Six do not: the five Jurassic slicers and `FLAME_BURN`. For those this used
 * to fall back to `|DamageMod|`, which is 1 on every one of them, so a disk
 * that should carve you took a single point. The official is not doing that —
 * `FLAME_BURN` lands between 6 and 22 in one session — and the row says how:
 * each carries a `Weapon1` of its own, `EN_SLICER_TRAP_WEAPON` and
 * `EN_TRAP_FLAME_WEAPON`. So they are priced like any other actor's swing, the
 * trap's weapon against the victim's defence.
 */
const trapDamage = async (session, attackerDoid, attack, victimDoid, victim, weaponPower) => {
  /**
   * `Admiral's Luck` takes a quarter off whatever a trap does — the one
   * legendary that names a source of damage rather than a type of it, so it is
   * applied here rather than in `damageTurnedAside` beside the three shields.
   *
   * Only for the hero, whose weapons these are, and floored at one so a trap
   * that goes off is still felt.
   */
  const weapons = weaponsForHero(session, victimDoid);
  const luck = legendaryTrapShield(weapons);
  const spared = (damage) => (luck ? Math.max(1, Math.round(damage * (1 - luck))) : damage);

  if (attack?.DoPercentHealthDamage) {
    const shield = legendaryShieldFor(weapons, attack.AttackType);
    const damage = spared(
      Math.max(
        1,
        Math.round(
          victim.maxHitPoints *
            Math.max(0, attack.PercentHealthDamageValue ?? 0) *
            (1 - shield)
        )
      )
    );
    return { damage, neutral: damage, effectiveness: 0 };
  }
  const priced = await priceHit(
    session,
    { attacker: attackerDoid, attackee: victimDoid },
    attack,
    weaponPower
  );
  /**
   * `||` cannot tell "could not price it" from "priced it at nothing".
   *
   * Zero is a real answer: it is what `priceHit` returns when the victim's
   * defence meets the hit, and the corpus sends it — 299 combat results carry a
   * damage of zero, across 39 attack types including plain monster swings like
   * EN_ARROW_SHOT and EN_MACE_CHOP. Flooring it back up contradicts that.
   *
   * Left alone because it is not worth a point of nothing. The percent-health
   * traps return above and never arrive here; the nine flat ones that do all
   * author DamageMod -1 against attackers with no offence stat, so one point of
   * the matching defence already zeroes them and the whole disagreement is 1
   * damage versus 0. None of the nine appears in any recording, so there is no
   * measurement to settle which the game did, and the cross-wired defence
   * columns above make this a bad place to guess.
   */
  const floor = Math.max(1, Math.round(Math.abs(attack?.DamageMod ?? -1)));
  return {
    damage: spared(priced.damage || floor),
    neutral: spared(priced.neutral || floor),
    effectiveness: priced.effectiveness,
  };
};

/** Publishes the authoritative result only after an area/projectile contact. */
const applyTrapHit = async (
  session,
  attackerDoid,
  attack,
  victimDoid = session.heroDoid,
  weaponPower
) => {
  const victim = session.actors?.get(victimDoid);
  const clid = session.objects?.get(victimDoid);
  if (!victim || victim.dead || !attack || !RECEIVE_FIELD_BY_CLID[clid]) return false;
  const { damage, neutral, effectiveness } = await trapDamage(
    session,
    attackerDoid,
    attack,
    victimDoid,
    victim,
    weaponPower
  );

  const reaction = encodeCombatResults({
    doid: attackerDoid,
    attackType: attack.Id,
    combatResults: [
      {
        attacker: attackerDoid,
        attackee: victimDoid,
        // CombatResult uses negative numbers for damage and positive numbers
        // for healing; authoritative HP state below keeps a positive magnitude.
        damage: -damage,
        attackType: attack.Id,
        targetActorDoid: 0,
        effectiveness,
        ...trapStaggerFor(session, attack, damage, victimDoid),
      },
    ],
  });
  applyDamage(session, victimDoid, damage, () =>
    session.send(receiveCombatResult(victimDoid, RECEIVE_FIELD_BY_CLID[clid], reaction))
  );

  /**
   * The mark a trap leaves.
   *
   * Four floor traps author one and none of them was leaving it: the tar pit's
   * `TAR_SLOW`, which is what makes a tar pit a tar pit — two seconds at a fifth
   * of your speed — and `FIRE_L1`/`FIRE_L5` off the two flame traps and the
   * burning ground.
   *
   * This ran on the hero's own swings and on placeables and simply was not
   * wired to floor traps. The capture is direct: a session in the Jurassic maps
   * generates fifteen `TAR_SLOW` buffs and every one of them names
   * `JURASSIC_DINO_TARPIT` as the attacker.
   */
  await applyTargetBuff(session, {
    attack,
    victimDoid,
    attackerDoid,
    damage: neutral,
  });

  /**
   * Named, because a doid is not something a person can act on.
   *
   * "trap 1437 hit hero for 6" says a trap somewhere did something; the report
   * that follows is then about a trap nobody can find. The constant and the
   * place are both already known here — the actor for its name, the hazard for
   * where it stands — and they turn the same line into somewhere to walk to.
   */
  const trap = session.trapNames?.get(attackerDoid) ?? session.actors?.get(attackerDoid);
  info(
    `[${session.id}] trap ${trap?.constant ?? attackerDoid}` +
      `${Number.isFinite(trap?.x) ? ` at ${Math.round(trap.x)},${Math.round(trap.y)}` : ""}` +
      ` (${attackerDoid}) hit ` +
      `${victimDoid === session.heroDoid ? "hero" : victim.constant ?? victimDoid} ` +
      `for ${damage} (${victim.hitPoints}/${victim.maxHitPoints}hp)`
  );
  return true;
};

/**
 * How far a turret's shot is allowed to reach, against what the data authors.
 *
 * `PROJ_ORB_FIREBALL` authors `Range` 1000 with `IgnoreWalls`, and the client
 * uses the same number — so this is a deliberate deviation, not a correction.
 * It is here because the statue is the one trap that tracks you: a nozzle
 * fires down its own corridor and stops at whatever it meets, while Loki turns
 * to face the player and then throws a fireball two-thirds of a screen through
 * the walls between them. Played back to back it reads as being shot at from
 * somewhere you cannot see, and the report has been consistent about it.
 *
 * Only the tracking launcher is shortened. Everything else keeps the authored
 * distance, because nothing about those has been reported and matching the game
 * is the default.
 *
 * If a measurement of how far the official's own fireballs actually reach turns
 * up later, this is the one line to delete.
 */
const TURRET_RANGE_FACTOR = (attack) =>
  attack?.Constant === "TRAP_LOKI_FIREBALL" ? 0.5 : 1;

/**
 * How far this trap's shot actually reaches, in one place.
 *
 * Shared with `withinReach`, because a statue deciding whether to bother with
 * you and the flight deciding where to stop have to agree: a turret that turns
 * to follow a player it cannot hit is the reported "they aggro from outside
 * their range", and one that stops tracking short of where its fireball still
 * lands is worse.
 */
export const trapProjectileReach = (attack, projectile) =>
  Math.max(1, (projectile?.Range ?? attack?.Range ?? 400) * TURRET_RANGE_FACTOR(attack));

const launchTrapProjectile = (session, attackerDoid, hazard) => {
  const { attack, projectile, position } = hazard ?? {};
  if (!attack || !projectile || !position) {
    warn(`trap ${attackerDoid}: cannot simulate projectile without authored data`);
    return false;
  }

  // A turret has turned to face the hero since it was placed; everything else
  // fires along the heading its tile authored. See startTurretAim.
  const radians = ((hazard.heading ?? position.heading ?? 0) * Math.PI) / 180;
  /**
   * From where the client draws it leaving, not from the mount.
   *
   * The timeline's `projectile` action carries the offset — Loki's is
   * `yOffset: -180`, a fireball out of the statue's raised hands — and reading
   * it is the difference between the drawn flame and the damaging one being
   * the same line. Resolved when the hazard is built; see `hazard.launch`.
   */
  const launch = hazard.launch ?? { xOffset: 0, yOffset: 0 };
  session.activeTrapProjectiles ??= [];
  session.activeTrapProjectiles.push({
    attackerDoid,
    attack,
    attackerTeam: hazard.team,
    position: {
      x: position.x + (launch.xOffset ?? 0),
      y: position.y + (launch.yOffset ?? 0),
    },
    direction: { x: Math.cos(radians), y: Math.sin(radians) },
    weaponPower: hazard.weaponPower,
    // Fired from inside its own mounting; see tickTrapProjectiles. Judged at
    // the muzzle, which is where the flight actually starts.
    speed: Math.max(1, projectile.ProjSpeed ?? 1),
    range: trapProjectileReach(attack, projectile),
    radius: Math.max(0, projectile.CollisionSize ?? 15),
    ignoreWalls: Object.hasOwn(projectile, "IgnoreWalls"),
    traveled: 0,
  });
  return true;
};

/**
 * Launches a projectile that exists only to carry something somewhere.
 *
 * The Vampire Hunter's traps are thrown this way: the attack itself has no
 * spawn action at all, only a `projectile`, and the Projectile row names what
 * appears where it lands — `PROJ_GARLIC.OnDeathNPC` is GARLIC_PLACEABLE_L3.
 * So the flight is the placement, and it ends wherever the throw ends: against
 * a wall, against whatever it hits, or at the end of its range.
 */
export const launchCarrierProjectile = (
  session,
  { attackerDoid, origin, headingDegrees, projectile, onDeath }
) => {
  if (!origin || !projectile) return false;
  const radians = (Number(headingDegrees ?? 0) * Math.PI) / 180;
  session.activeTrapProjectiles ??= [];
  session.activeTrapProjectiles.push({
    attackerDoid,
    attack: null,
    position: { x: origin.x, y: origin.y },
    direction: { x: Math.cos(radians), y: Math.sin(radians) },
    speed: Math.max(1, projectile.ProjSpeed ?? 500),
    range: Math.max(1, projectile.Range ?? 350),
    radius: Math.max(0, projectile.CollisionSize ?? 20),
    ignoreWalls: false,
    traveled: 0,
    ignoreDoid: attackerDoid,
    onDeath,
  });
  return true;
};

/**
 * Who each side's shots may land on, gathered once per projectile tick.
 *
 * A shot asks the side test of `reachablePosition` about every actor on the
 * floor, and on a floor of arrow traps nearly every answer is no — 69.5M of
 * 83.5M in the run measured at `eachTrapVictim`, the arrows being on the side
 * of the monsters they fly past. A side's answer does not change while
 * nothing happens: a team is set when an actor is made, and the actor Map
 * changes only when something is spawned, killed or leaves. So each side is
 * sorted out once, in the floor's order, and every shot of that side walks
 * only those, with everything else still asked live.
 *
 * Forgotten whenever a shot does something — lands a hit, which is awaited
 * and lets the rest of the server run, or ends with an `onDeath`, which puts
 * a thrown trap down — so the next shot sorts the floor afresh.
 */
const shotTargets = (session) => {
  const bySide = new Map();
  return {
    of: ({ attack, attackerTeam }) => {
      const side = attack ? `${attack.Team}|${attackerTeam}` : "";
      let doids = bySide.get(side);
      if (doids) return doids;
      doids = new Set();
      matchStateOf(session).actors?.forEach((actor, doid) => {
        if (actor && (!attack || teamAllowsHit(attack, attackerTeam, actor.team))) doids.add(doid);
      });
      bySide.set(side, doids);
      return doids;
    },
    forget: () => bySide.clear(),
  };
};

/**
 * Advances server-owned trap projectiles and resolves swept circle contacts.
 * The client runs the same GameMaster speed/range locally for visuals, but a
 * distributed trap has no owner callback that could propose its collision.
 */
export const tickTrapProjectiles = async (session, deltaSeconds) => {
  const active = session.activeTrapProjectiles ?? [];
  if (!active.length || !(deltaSeconds > 0)) return 0;

  const survivors = [];
  const targets = shotTargets(session);
  let hits = 0;

  for (const projectile of active) {
    const end = (at) => {
      if (!projectile.onDeath) return;
      projectile.onDeath(at);
      targets.forget();
    };
    const remaining = projectile.range - projectile.traveled;
    if (remaining <= 0) continue;

    const travel = Math.min(remaining, projectile.speed * deltaSeconds);
    const nextPosition = {
      x: projectile.position.x + projectile.direction.x * travel,
      y: projectile.position.y + projectile.direction.y * travel,
    };
    /**
     * A shot cannot be stopped by the wall it is mounted flush against.
     *
     * An aztec arrow trap firing along Y sits with geometry 5 units ahead and
     * nothing at all from 10 onwards, and its very first sweep clipped that lip
     * and killed it. So the muzzle is exempt: for the shot's own radius of
     * travel, a wall cannot stop it. That is bounded by construction — only the
     * radius, and only once.
     *
     * A shot mounted *inside* the wall used to be exempt as well, and for as
     * long as it stayed inside: a flag that only cleared when the bolt reached
     * open ground. It was added because ten of twelve
     * `NORDIC_CAVE_GARGOYLE_EMITTER_C` killed their arrow on the first tick and
     * went silent, and silent looked wrong.
     *
     * Silent was right. Splitting the official's own vertical gargoyles by
     * whether their muzzle sits in rock:
     *
     *   buried   11 emitters   135 shots    0 hits on the hero
     *   clear    10 emitters   144 shots   13 hits
     *
     * Not one hit in a hundred and thirty-five shots. The official's bolt dies
     * in the wall, which is also why nothing is drawn — the client builds its
     * projectile in the same rock and loses it there. The flag made ours fly on
     * through and land, so the report was an arrow you cannot see taking a
     * hundred and six health off you, on the tiles where the mount happens to
     * be buried and not on the ones where it is not.
     */
    const sweepFrom =
      projectile.traveled === 0
        ? {
            x: projectile.position.x + projectile.direction.x * projectile.radius,
            y: projectile.position.y + projectile.direction.y * projectile.radius,
          }
        : projectile.position;
    /**
     * Cleared *after* this tick is judged, not before it.
     *
     * The flag ends on the tick the shot reaches open ground — and that is the
     * one tick whose sweep still starts inside the wall it just left, so
     * clearing it first ran the line-of-sight test over the very segment the
     * flag exists to excuse. The ice caves' Y-firing gargoyle is mounted in
     * geometry that ends at 20 and its spear moves 12 a tick: the first tick
     * was excused, the second cleared the flag and then killed it, and it flew
     * 12 of an authored 800. That is the arrow reported as born and dying on
     * the spot.
     *
     * A shot that never leaves geometry keeps the flag and keeps going, which
     * is unchanged; one merely aimed at rock never had the flag to begin with
     * and still stops at the face.
     */
    const hitWall =
      !projectile.ignoreWalls &&
      !hasLineOfSight(session.navigation, sweepFrom, nextPosition, projectile.radius);
    if (hitWall) {
      end(projectile.position);
      continue;
    }

    /**
     * An arrow stops in whatever it reaches first, which need not be the
     * player. Testing only against the hero let every bolt fly through the
     * monsters between it and you.
     */
    /**
     * Not on whoever threw it. A carrier leaves the hero's own position, and
     * the first sweep of the flight therefore starts inside the hero's own
     * collision circle — so a thrown trap died instantly and landed at his
     * feet. Arrow traps never showed this because a zero-hit-point trap is not
     * tracked as an actor at all.
     */
    const struck = firstTrapVictim(
      session,
      {
        attack: projectile.attack,
        attackerTeam: projectile.attackerTeam,
        includeBodies: true,
        candidateDoids: targets.of(projectile),
      },
      (doid, actor, position) =>
        doid !== projectile.ignoreDoid &&
        // A wall to the client, so a shot that ignores walls ignores it.
        !(projectile.ignoreWalls && actor.attackable === false) &&
        segmentHitsCircle(
          projectile.position,
          nextPosition,
          collisionPointOf(actor, position, bodyCentre),
          projectile.radius + Math.max(0, actor.collisionRadius ?? 30)
        )
    );
    /**
     * A body stops the shot whether or not it is still standing.
     *
     * The client draws the bolt hitting the fallen player, so a server that
     * flew it through the corpse and hurt whoever was behind disagreed with
     * what everybody could see. The corpse takes nothing, which is why the
     * flight ends here rather than falling through to the damage below — and
     * so does what nothing may attack, which the client stops as a wall.
     */
    if (struck?.actor?.dead || struck?.actor?.attackable === false) {
      end(nextPosition);
      continue;
    }

    if (struck) {
      // A thrown trap carries no attack of its own: it is the delivery, and
      // what it leaves behind is the weapon.
      const landed = projectile.deal
        ? await projectile.deal(struck.doid)
        : projectile.attack &&
          (await applyTrapHit(
            session,
            projectile.attackerDoid,
            projectile.attack,
            struck.doid,
            projectile.weaponPower
          ));
      if (landed) hits++;
      targets.forget();
      end(struck.position ?? nextPosition);
      continue;
    }

    projectile.position = nextPosition;
    projectile.traveled += travel;
    if (projectile.traveled < projectile.range) survivors.push(projectile);
    else end(projectile.position);
  }

  session.activeTrapProjectiles = survivors;
  return hits;
};

/** Runs the authoritative projectile clock for one active dungeon session. */
export const startTrapProjectiles = (session) => {
  let previous = Date.now();
  const scope = session.floorScope;
  const tick = () => {
    const now = Date.now();
    const elapsed = (now - previous) / 1000;
    previous = now;
    const run = () => tickTrapProjectiles(session, elapsed);
    const operation = worldOf(session)?.withOutputBatch(run) ?? run();
    Promise.resolve(operation).catch((error) =>
      warn(`[${session.id}] trap projectiles: ${error.message}`)
    );
  };
  const timer = scope
    ? scope.interval(tick, config.projectileTickMs)
    : setInterval(tick, config.projectileTickMs);
  if (!scope) timer.unref?.();
  info(`[${session.id}] trap projectiles ticking every ${config.projectileTickMs}ms`);
  return () => {
    cancelScopedTimer(scope, timer, clearInterval);
    session.activeTrapProjectiles = [];
  };
};

/**
 * Whoever a set of world-space shapes is touching right now.
 *
 * Split out because a moving trap does not have one shape: its timeline gives
 * it a different one on each frame of the swing, and only the frame that is
 * playing should be able to catch anybody.
 */
export const hazardVictims = (session, colliders = [], hazard = null, now = Date.now()) => {
  const shape = { combatColliders: colliders };
  return trapVictims(
    session,
    {
      attack: hazard?.attack,
      attackerTeam: hazard?.team,
      candidateDoids: hazardCandidateDoids(session, colliders, now),
    },
    (doid, actor, position) => areaTrapHits(shape, position, actor)
  );
};

/**
 * Whether anything among `victims` sets a waiting trap off: anything the trap
 * may hurt — its side test and `IsAttackable` are already asked by
 * `hazardVictims` — that is not scenery.
 *
 * Scenery is still hit when one goes off (the official's team-6 bombs on node
 * 50069 land on props 7 times in 32 results, and on a monster 0 times) but
 * never makes it go off: a mine beside a barrel rack waits for something that
 * fights.
 */
export const setsOffTrap = (victims) => victims.some(({ actor }) => !isScenery(actor));

/**
 * Whether a bomb lying in wait is set off now: something `setsOffTrap` admits,
 * of a side the bomb may hurt, touching the circle its row's `AggroRadius`
 * draws round it — 60 on every mine, firebomb, garlic and nuke. What it then
 * hurts is its blast, the authored collider (140 for a mine, 120 for a
 * firebomb, 250 for the nuke), which is a different and larger question.
 *
 * One rule for every bomb, wherever it came from: one the map authors, one a
 * rival put down, one the hero threw. It used to be two — the map's at 60 and
 * a placed one at its blast — and the official keeps the first for both. Over
 * the official corpus, the hero coming within 60 plus their own 25.87 of an
 * armed bomb was followed by it going off within 1.5 s 26 times in 28;
 * coming inside its blast while still beyond 116, 15 times in 85, and the
 * hero stood in that band 78 s in all without one going off (the placed ones
 * alone: 1 in 31 entries, 59 s). Monsters set off the team-7 map mines the
 * same way: 11 went off with the hero 838 to 1340 away and a monster 62 to
 * 110 from them.
 */
export const bombTripped = (session, { position, npc, attack, team }, now = Date.now()) => {
  const radius = Math.max(0, Number(npc?.AggroRadius ?? 0));
  if (!(radius > 0) || !position) return false;
  const circle = { type: "circle", x: position.x, y: position.y, radius };
  return setsOffTrap(hazardVictims(session, [circle], { attack, team }, now));
};

/**
 * Publishes one trap hit against one victim.
 *
 * `weaponPower` is the trap's own `Weapon1`, which only the flat-damage traps
 * need — the slicers and the burning ground. Everything else charges a share of
 * the bar and does not care.
 */
export const dealTrapHit = (session, attackerDoid, attack, victimDoid, weaponPower) =>
  applyTrapHit(session, attackerDoid, attack, victimDoid, weaponPower);

/**
 * Triggered traps have no owner client that can propose their collisions.
 * Area traps resolve on activation; projectile traps only enqueue their
 * authoritative flight here and resolve later in tickTrapProjectiles.
 */
export const performTrapAttack = async (session, attackerDoid, hazard) => {
  const attack = hazard?.attack;
  const isProjectile = Boolean(attack?.Projectile);
  const caught = isProjectile
    ? []
    : trapVictims(session, { attack, attackerTeam: hazard?.team }, (doid, actor, position) =>
        areaTrapHits(hazard, position, actor)
      );
  /**
   * Whoever it caught, not whoever owns the timer.
   *
   * `targetActorDoid` is where the client plays an effect authored to play at
   * its target, and zero is not neutral: `PlayEffectTimelineAction` returns
   * without drawing anything when there is no target to place it on. The
   * corpus names one on 20852 of 25003 choreographies, so it is a field the
   * game uses rather than one it leaves empty.
   *
   * Asked as "did this catch *my* hero", it was only ever true for the member
   * whose context the trap fired in — so in a party a trap that caught the
   * other player named nobody and drew nothing, for everybody.
   */
  const struck = caught.find(({ doid }) => isPartyHero(session, doid));
  const aimedHero = isPartyHero(session, hazard?.targetActorDoid) &&
      !session.actors?.get(hazard.targetActorDoid)?.dead
    ? hazard.targetActorDoid
    : 0;

  session.send(
    npcAttackChoreography({
      doid: attackerDoid,
      attackType: attack?.Id,
      targetActorDoid: struck?.doid ?? aimedHero,
    })
  );

  if (isProjectile) {
    launchTrapProjectile(session, attackerDoid, hazard);
    return false;
  }

  let hits = 0;
  for (const { doid } of caught) {
    if (await applyTrapHit(session, attackerDoid, attack, doid, hazard?.weaponPower)) hits++;
  }
  return hits > 0;
};

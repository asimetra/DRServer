import {
  FRAMES_PER_SECOND,
  attackColliders,
  attackForConstant,
  heroById,
  loadGameMaster,
  npcForConstant,
  projectileForConstant,
  spawnLifetimeFor,
  spawnNpcActions,
  suicideDelayMs,
  weaponForConstant,
} from "../gamemaster.js";
import { heroLevel } from "../progression.js";
import { config } from "../config.js";
import { info, warn } from "../log.js";
import { CLID, TEAM } from "./opcodes.js";
import { isPlausiblePosition } from "./coordinates.js";
import { RULE, noteViolation } from "./security-events.js";
import { npcGenerate, objectDisable } from "./objects.js";
import { npcHeadingUpdate } from "./ai.js";
import {
  hitPointsUpdate,
  npcAttackChoreography,
  performPlaceableAttack,
  placeableVictims,
  stateUpdate,
} from "./combat.js";
import { hasLineOfSight, isPositionBlocked, nearestClearPosition } from "./navigation.js";
import { inFrontOf, worldColliders } from "./heading.js";

/**
 * Placeables — the actors an attack leaves standing on the floor.
 *
 * The Battle Chef's poison pot is the clearest case: its timeline's only real
 * action is a `spawnNpcForAttack` naming POISON_POULTRY_PLACEABLE_L3, and with
 * nothing on either side building it the pot charged 20 Mana and a ten-second
 * cooldown for nothing at all. The same silence covered the garlic, mine and
 * firebomb traps, the Ranger's decoy, the Iron Legion clones and every
 * consumable bomb.
 *
 * What one is, was read off the wire rather than guessed. A capture of the
 * Berserker's FISSURE against the official server (five uses, five spawns) says:
 *
 *   generate clid 27, parent = floor, team = 5 (PLAYERS), masterId = hero doid,
 *   level = the hero's level, hp from the Npc row, weapon from its Weapon1
 *   -> hitPoints 0 and its own ReceiveAttackChoreography
 *   -> ReceiveCombatResult per victim, attacker = the placeable's own doid
 *   -> state "dead", then OBJECT_DISABLE
 *
 * Two details there are worth stating plainly, because both invite the opposite
 * assumption:
 *
 * The team is the placer's, not the row's. POISON_POULTRY_PLACEABLE_L3 is
 * authored `CharType: ENEMY` — the same row serves enemy chefs — so reading the
 * table would have the pot poison the hero who threw it.
 *
 * The damage is the server's. These carry no owning client that could propose
 * their collisions, exactly as floor traps do not.
 */

/**
 * Where one goes, which is around the hero rather than in front of him.
 *
 * The angle comes under two names and only one was read. 93 of the game's 143
 * `spawnnpc` actions carry `headingOffsetAngle`; the other 31 carry
 * `angleOffset`, and they are exactly the ones that arrange things in a ring —
 * the Vampire Hunter's Garlic Nuke at 60, -60, 120, -120, 0 and 180, the Ghost
 * Samurai's three clones at 0, 90 and -90, and the frost dragon's sixteen.
 *
 * Reading one name left every member of those rings at the same angle, so six
 * garlic and three clones all landed on one spot in front of the caster instead
 * of surrounding him.
 */
const placeablePosition = (origin, heading, action) =>
  inFrontOf(
    origin,
    heading,
    Number(action.offset ?? 0),
    action.headingOffsetAngle ?? action.angleOffset
  );

/**
 * What a placeable hits with, and when.
 *
 * The data draws the line, not us. A row carries `Attack1` for what it does
 * while it stands there and `DeathAttack` for what it does when it goes, and
 * placeables divide cleanly along it:
 *
 *   POISON_POULTRY_PLACEABLE_L3  Attack1 POISON_POULTRY_TOUCH_L3   a cloud
 *   GARLIC/MINE/FIREBOMB         Attack1                            a trap
 *   FISSURE_SMASH_AXE            DeathAttack FISSURE_SMASH_AXE      one burst
 *   CONSUMABLE_*_BOMB            DeathAttack *_DEATH_ATTACK         a bang
 *
 * Which is what the capture was showing all along: FISSURE's hit points went to
 * zero and *then* its choreography played, because the thing it plays is its
 * death. Twenty-seven rows carry a DeathAttack, so this is authored behaviour
 * and not a special case for bombs.
 *
 * A row may have neither — the Ranger's decoy — and then it stands there and
 * does nothing, which is exactly what a decoy is for.
 */
const attacksOf = async (npc) => ({
  living: npc.Attack1 ? await attackForConstant(npc.Attack1) : null,
  death: npc.DeathAttack ? await attackForConstant(npc.DeathAttack) : null,
});

/**
 * The hero's level, which the capture shows a placeable generating at: 100
 * against a row whose Min_Level is 1. It is what the client scales the actor's
 * own numbers from, so a placeable is as strong as whoever placed it.
 */
const placerLevel = async (session) => {
  const avatar = session.dungeonAvatar;
  if (!avatar) return 1;
  const hero = await heroById(avatar.avatar_id);
  if (!hero) return 1;
  return Math.max(1, heroLevel(await loadGameMaster(), hero, Number(avatar.experience ?? 0)));
};

/**
 * One swing: the choreography that shows it working and the damage that is it
 * working, in that order because that is the order the captures send them.
 *
 * `always` is for a death attack, which is an explosion and plays whether or
 * not it caught anyone. A living attack does not: the captured clouds are
 * silent until something walks into them, and one of the two recorded never
 * animated at all because nothing did.
 */
const strike = async (session, doid, live, attack, { always = false } = {}) => {
  if (!attack) return 0;
  const shape = await attackColliders(attack.AttackTimeline);
  const colliders = worldColliders(live.position, live.heading, shape);
  const victims = placeableVictims(session, doid, colliders);
  if (!always && !victims.length) return 0;

  session.send(npcAttackChoreography({ doid, attackType: attack.Id, targetActorDoid: 0 }));

  /**
   * A fissure runs along the ground rather than landing on it.
   *
   * Its eight colliders sit on frames 3 to 17 at xOffsets 150 through 500 — a
   * crack travelling away from the hero, one shape at a time. Taking the union
   * of them and striking once hits everything on that line in the same
   * instant, which is both wrong and invisible: the whole point of the effect
   * is that it moves.
   *
   * The official strikes on the authored frames. A slow fissure, whose shapes
   * are on frames 3, 8, 11, 14, 17 and 20 — 125 to 833ms — landed its two
   * recorded hits 749 and 841ms after its choreography, which is frames 17 and
   * 20 and nothing else.
   *
   * The same beat a swinging trap uses, for the same reason.
   */
  const byFrame = new Map();
  for (const collider of colliders) {
    const at = Math.max(0, Number(collider.frame ?? 0)) * (1000 / FRAMES_PER_SECOND);
    byFrame.set(at, [...(byFrame.get(at) ?? []), collider]);
  }
  const beats = [...byFrame.entries()].sort(([a], [b]) => a - b);

  /**
   * Every beat waits for its own frame, the first one included.
   *
   * The first used to be subtracted out — `at - firstAt` — so whatever the
   * shape authored was discarded and the damage landed with the choreography.
   * For a placeable whose collider is on frame 2 that is 83ms and invisible;
   * for the consumable bombs, whose colliders are on frame 38, it is 1583ms,
   * and it is the whole of "the room dies the moment I throw it".
   *
   * The official's own demolition bomb says so plainly once the right lines are
   * read. Its full sequence, from the client's proposal:
   *
   *      0ms  -> propose CONSUMABLE_DEMOLITION_ATTACK
   *    149ms  <- generate CONSUMABLE_DEMOLITION_BOMB
   *    224ms  <- combat results on four crates and a crusher
   *    229ms  <- hitPoints 0, and CONSUMABLE_DEMOLITION_BOMB_DEATH_ATTACK
   *   1809ms  <- combat results on a BABY_YETI, an ICE_IMP, the crusher
   *
   * An earlier reading of this took the 224ms line for the explosion and
   * concluded the authored frame was not the wait. It is not the explosion —
   * those are scenery going down as the bomb lands. The explosion is the 1809,
   * and 229 + 1583 is 1812. The arithmetic closes to three milliseconds.
   *
   * The NPC path has always honoured this frame, through `impactFrame`.
   *
   * The beats are tracked so that leaving the floor can cancel them, and only
   * leaving the floor. A beat belongs to the strike rather than to the thing
   * that struck: a bomb is dead long before its own explosion connects, so
   * cancelling in `expirePlaceable` would throw away damage the blast has
   * already committed to. `clearDungeonPlaceables` clears them, because a floor
   * nobody is standing on has nothing left to hit.
   */
  live.beats ??= [];
  for (const [at, frameColliders] of beats) {
    const timer = setTimeout(() => {
      live.beats = live.beats?.filter((pending) => pending !== timer);
      if (!session.dungeonActive || session.floorDoid !== live.floorDoid) return;
      const caught = placeableVictims(session, doid, frameColliders);
      if (!caught.length) return;
      performPlaceableAttack(session, doid, {
        attack,
        victims: caught,
        weaponPower: live.weaponPower,
      }).catch((error) => warn(`[${session.id}] ${attack.Constant}: ${error.message}`));
    }, at);
    timer.unref?.();
    live.beats.push(timer);
  }

  /**
   * What it caught when it went off, which is a different question from what it
   * damages. Whether a trap is spent is settled by it performing at all; the
   * damage arrives on its own frame above and cannot be waited for here.
   */
  const hits = victims.length;
  if (hits) info(`[${session.id}] ${live.constant} ${attack.Constant} hit ${hits}`);

  /**
   * An attack may leave something of its own behind, and that is what makes
   * these differ from one another rather than being one effect in three
   * colours: BURNING_EXPLOSION spawns BURNING_FIRE_PLACEABLE, so a firebomb
   * sets the floor alight where it goes off, while the garlic and the mine
   * spawn nothing and simply explode.
   */
  for (const action of await spawnNpcActions(attack.AttackTimeline)) {
    setTimeout(() => {
      if (!session.dungeonActive || session.floorDoid !== live.floorDoid) return;
      spawnPlaceable(session, {
        action,
        origin: live.position,
        heading: live.heading,
        weaponPower: live.weaponPower,
      }).catch((error) =>
        warn(`[${session.id}] ${attack.Constant} spawn failed: ${error.message}`)
      );
    }, (Number(action.frame ?? 0) / FRAMES_PER_SECOND) * 1000).unref?.();
  }
  return hits;
};

/**
 * The end of one, which for half of them is the whole point: a bomb does
 * nothing until it goes off, its own attack being authored at DamageMod zero.
 */
const expirePlaceable = async (session, doid) => {
  const live = session.placeables?.get(doid);
  if (!live) return;
  clearInterval(live.ticker);
  clearTimeout(live.expiry);
  session.placeables.delete(doid);

  if (session.objects?.get(doid) !== CLID.DistributedNPCGameObject) return;
  // Hit points reaching zero is not death on its own: ActorGameObject
  // .determineState only runs enterDeadState for the string, so a placeable
  // that skipped it would stand there as a corpse until the floor ended.
  session.send(hitPointsUpdate(doid, CLID.DistributedNPCGameObject, 0));
  // Unless it already performed on arrival, which is what a fissure does.
  if (live.livingAttack) {
    await strike(session, doid, live, live.deathAttack, { always: true });
  }
  session.send(stateUpdate(doid, CLID.DistributedNPCGameObject, "dead"));
  session.send(objectDisable(doid));
  session.objects.delete(doid);
  session.actors?.delete(doid);
};

/**
 * A beat of a placeable that is still standing.
 *
 * Two kinds, and the row says which. `InstantAttack` marks the ones that keep
 * going — the poison clouds and the burning patch — and they hit again every
 * AttackTimer for as long as they live. The rest are traps: garlic, mines,
 * firebombs and the sticky mine arm themselves, wait, and go off once. The
 * captures are unambiguous about the difference; a garlic trap sat quiet for
 * fourteen seconds, exploded, and was dead a second later, while a cloud ticked
 * and outlived it.
 */
const tickPlaceable = async (session, doid) => {
  const live = session.placeables?.get(doid);
  if (!live || !session.dungeonActive || session.floorDoid !== live.floorDoid) return;
  /**
   * One beat at a time. A beat does real work behind `await` and the interval
   * does not wait for it, so two overlapping ticks made a firebomb detonate
   * twice and leave two fires burning on the same spot.
   */
  if (live.busy || live.spent) return;
  live.busy = true;
  try {
    const hits = await strike(session, doid, live, live.livingAttack);
    if (!hits) return;

    /**
     * Going off is what spends a trap, and its own timeline says so with a
     * `suicide` action — and says how long to wait, which is the pause the
     * client needs to play the blast. Killing it in the same millisecond as
     * the choreography meant the explosion was never seen.
     *
     * An aura has no suicide and goes on burning; stopping its beat after the
     * first hit made the fire and the poison cloud one-shot effects that were
     * over before they were seen.
     */
    if (live.suicideMs === null) return;

    live.spent = true;
    clearInterval(live.ticker);
    live.ticker = null;
    const timer = setTimeout(() => expireSafely(session, doid), live.suicideMs);
    timer.unref?.();
    live.expiry = timer;
  } finally {
    live.busy = false;
  }
};

const runSafely = (work, session, what) =>
  work.catch((error) => warn(`[${session.id}] placeable ${what} failed: ${error.message}`));

const tickSafely = (session, doid) =>
  runSafely(tickPlaceable(session, doid), session, "tick");

const expireSafely = (session, doid) =>
  runSafely(expirePlaceable(session, doid), session, "expiry");

/**
 * How long a timeline takes to play, at the 24 frames a second everything else
 * here is measured in.
 */
const timelineLengthMs = async (name) => {
  if (!name) return 0;
  const { timelines } = await loadGameMaster();
  const frames = Number(timelines.get(name)?.totalFrames ?? 0);
  return Math.max(0, Math.round((frames / FRAMES_PER_SECOND) * 1000));
};

/** Builds one placeable and starts its clock. */
export const spawnPlaceable = async (session, { action, origin, heading, weaponPower }) => {
  const npc = await npcForConstant(action.spawnname);
  if (!npc) {
    warn(`placeables: ${action.spawnname} names no GameMaster NPC`);
    return null;
  }

  let position = placeablePosition(origin, heading, action);
  if (isPositionBlocked(session.navigation, position)) {
    position =
      nearestClearPosition(session.navigation, position, 0, {
        reach: 300,
        reachableFrom: origin,
        towards: origin,
      }) ?? origin;
  }

  const { living: livingAttack, death: deathAttack } = await attacksOf(npc);
  const weapon = npc.Weapon1 && (await weaponForConstant(npc.Weapon1));
  const doid = session.allocateDoid(CLID.DistributedNPCGameObject);
  const hitPoints = npc.HP ?? 10;

  session.objects?.set(doid, CLID.DistributedNPCGameObject);
  /**
   * Registered as an actor so it is a thing on the floor rather than only a
   * picture of one, but never `isEnemy`: counting it would hold the floor open
   * until a cloud the player made expired.
   */
  session.actors?.set(doid, {
    hitPoints,
    maxHitPoints: hitPoints,
    constant: npc.Constant,
    isEnemy: false,
    position: { x: position.x, y: position.y },
    collisionRadius: Math.max(12, (npc.CollisionSize ?? 35) * (npc.Scale ?? 1)),
    heading,
    ai: null,
  });

  session.send(
    npcGenerate({
      doid,
      parent: session.floorDoid,
      npcType: npc.Id,
      level: await placerLevel(session),
      masterId: session.heroDoid,
      position,
      heading: 0,
      scale: npc.Scale ?? 1,
      hitPoints,
      weapons: weapon
        ? [{ type: weapon.Id, power: weapon.Power ?? 1, requiredlevel: 1, rarity: 1 }]
        : [],
      // Whoever placed it owns it. Not the row's CharType — see above.
      team: TEAM.PLAYERS,
      triggerState: 1,
    })
  );

  /**
   * Which way it points, which the generate does not settle.
   *
   * The generate above sends zero and the official's does too — 158 captured
   * generates of the things a hero puts down (both fissures, the mines, the
   * garlic, the firebombs, the poultry) carry heading 0 without exception,
   * whatever direction they ended up facing. The aim arrives right behind it as
   * a field update, 0 to 1ms later, before the position and long before the
   * choreography.
   *
   * It is the hero's own facing, exactly: across 22 captured fissures the field
   * matched the hero's heading at the moment of the throw 22 times and differed
   * none. Every value was a multiple of 45 because the hero walks in eight
   * directions, not because anything rounds it.
   *
   * Without this the client draws every crack pointing east while the damage
   * runs the way the hero swung, so the two disagree on screen. The colliders
   * were already aimed — `live.heading` below has carried the facing all along
   * — and this is that same angle, told to the client.
   */
  session.send(npcHeadingUpdate(doid, heading));

  /**
   * How long it stands there, which `timetolive` alone does not say.
   *
   * A fissure is authored at 0.03 and a slow fissure at 0.02, and taking those
   * literally puts an object on the floor for thirty milliseconds — generated
   * and disabled inside one frame, so the client never draws it. Which is
   * exactly the report: the swing plays, the crack in the ground never appears.
   *
   * The official keeps them for as long as they have something to show. Three
   * axe fissures in one capture lived 907, 919 and 920ms against a 19-frame
   * animation, which is 792; three slow ones lived 1400, 1402 and 1424 against
   * 30 frames, which is 1250. Both about a tenth of a second over their own
   * timeline and never under it — the animation, plus the time it takes to
   * notice it has finished.
   *
   * So the life is the longer of the two: what the timeline needs to play, and
   * what the action asked for. The clouds are unaffected, because ten authored
   * seconds is already longer than anything they animate.
   */
  const authoredMs = Math.max(0, Number(action.timetolive ?? 0) * 1000);
  const animationMs = Math.max(
    await timelineLengthMs(livingAttack?.AttackTimeline),
    await timelineLengthMs(deathAttack?.AttackTimeline)
  );
  const lifetimeMs = Math.max(authoredMs, animationMs);
  const beatMs = Math.max(100, Number(npc.AttackTimer ?? 1) * 1000);

  const live = {
    constant: npc.Constant,
    livingAttack,
    deathAttack,
    // Authored: true on the clouds and the burning patch, absent on every trap.
    repeats: Boolean(npc.InstantAttack),
    // Resolved once, so a beat can decide without awaiting mid-tick.
    suicideMs: await suicideDelayMs(livingAttack?.AttackTimeline),
    // The facing it was placed with: collider xOffsets run along it.
    heading,
    // The weapon that placed it prices its hits — see performPlaceableAttack.
    weaponPower,
    position,
    floorDoid: session.floorDoid,
    ticker: null,
    expiry: null,
  };
  session.placeables ??= new Map();
  session.placeables.set(doid, live);

  if (livingAttack) {
    /**
     * Everything checks the moment it lands, and what happens then depends on
     * whether anyone is there. An empty patch of floor leaves a trap standing
     * and armed; a trap thrown into somebody goes off.
     *
     * Checked synchronously. A delay lived here for a while on the reasoning
     * that the client needs to have drawn the thing before it is told to
     * animate it, but what actually made a bomb kill the room before its own
     * explosion was the damage ignoring its collider's authored frame — see
     * the beat scheduling in `strike`. With that honoured the pause earned
     * nothing, and play confirmed it: nothing changed between 80ms and 10ms
     * because neither is what the eye was seeing.
     */
    await tickSafely(session, doid);
    if (lifetimeMs > beatMs && session.placeables.has(doid)) {
      live.ticker = setInterval(() => tickSafely(session, doid), beatMs);
      live.ticker.unref?.();
    }
  }

  /**
   * A fissure performs the moment it lands, and so does a bomb.
   *
   * Both carry their damage on `DeathAttack` and neither has a living attack,
   * so this is where they announce themselves rather than on the way out.
   * Announcing a crack as the object is removed sends the choreography and the
   * disable in the same breath: the client draws the first pose and never the
   * run, which was exactly the report — it appears for an instant, then
   * nothing.
   *
   * What separates a crack from a bomb is not when they perform but when they
   * connect: the fissure's colliders run from frame 3, the bomb's sits on frame
   * 38, and `strike` waits for each. Announcing both at once is what the
   * captures show — measured from the generate, a choreography arrives at
   * +91ms for the axe fissure and +83ms for the slow one, which is the round
   * trip and not a pause anybody authored.
   */
  if (deathAttack && !livingAttack) {
    await strike(session, doid, live, deathAttack, { always: true });
  }

  live.expiry = setTimeout(() => expireSafely(session, doid), lifetimeMs);
  live.expiry.unref?.();

  info(
    `[${session.id}] placed ${npc.Constant} for ${lifetimeMs}ms` +
      (livingAttack ? ` (${livingAttack.Constant} every ${beatMs}ms)` : "") +
      (deathAttack ? ` (${deathAttack.Constant} on death)` : "") +
      (livingAttack || deathAttack ? "" : " (no attack)")
  );
  return doid;
};

/**
 * FLID for HeroGameObjectOwner.ProposeCreateNPC.
 *
 * A thrown trap is not the server's to place. ProjectileGameObject.destroy in
 * the client checks `isOwner` and the Projectile row's `OnDeathNPC`, and sends
 * this with the id and the point where its own flight ended:
 *
 *   send_ProposeCreateNPC(npcId, weaponSlot, x, y)   field 177
 *
 * So the client simulates the throw in its own Box2D world and reports where
 * the thing came to rest. Simulating it here as well produced exactly the
 * desync reported: the bomb still in the air on screen while the server had
 * already put the trap down, and projectiles stopping on monsters the client
 * had flown straight past.
 */
export const FLID_PROPOSE_CREATE_NPC = 177;

/** Places what the client's own projectile decided to leave, where it says. */
/**
 * How long a permit outlives the cast that issued it.
 *
 * Measured: across the official recordings every placement follows its cast by
 * between 92 and 1336 milliseconds, which is the throw and the flight. Five
 * seconds is generous by four times over and still far short of a floor.
 */
const PERMIT_MS = 5000;

/**
 * A one-use right to put one thing on the floor.
 *
 * `ProposeCreateNPC` used to take any known NPC id at any coordinate from any
 * slot — the client said "a mine appeared here" and this server made one. That
 * is an arbitrary spawn primitive: every trap and placeable in the game,
 * anywhere on the floor, for nothing.
 *
 * It is closed with a permit rather than with a guess, because the authored
 * data says exactly what a placement can be: exactly three projectiles in the
 * game name an `OnDeathNPC` — `PROJ_GARLIC`, `PROJ_MINES` and `PROJ_FIREBOMB` —
 * so those three placeables are the whole of what this field can honestly ask
 * for.
 *
 * An earlier version of this comment credited the official recordings with 32
 * such placements, matched to their casts and slots. They contain none: across
 * all 66 captures there is not one outbound field 177 and not one of those
 * three placeables ever generated. Nobody in them threw one.
 *
 * So the shape of the rule comes from the data and its bounds come from a
 * session played against this server with the same unmodified client — five
 * placements, three garlics, a mine and a firebomb, landing 17 to 209 units
 * from the hero against an authored `Range` of 350.
 */
export const notePlacementPermit = async (session, attack, weaponSlot) => {
  if (!attack?.Projectile) return false;
  const projectile = await projectileForConstant(attack.Projectile);
  if (!projectile?.OnDeathNPC) return false;

  const now = Date.now();
  /**
   * Pruned here rather than by a timer, on the packet that is already running.
   *
   * A permit that is never matched was never removed, so the list only grew and
   * `findIndex` walked all of it — a session that threw for an hour paid for
   * every throw it had ever made. Lazily dropping the dead ones bounds the list
   * at what one five-second window can hold.
   */
  session.placementPermits = (session.placementPermits ?? []).filter(
    (permit) => permit.expiresAt > now && permit.floorDoid === session.floorDoid
  );
  session.placementPermits.push({
    constant: projectile.OnDeathNPC,
    weaponSlot: Number(weaponSlot ?? 0),
    floorDoid: session.floorDoid,
    expiresAt: now + PERMIT_MS,
    /**
     * Where it was thrown from, and how far the throw carries.
     *
     * The permit proved what was thrown and out of which slot and said nothing
     * about where it landed, so one honest throw put a mine anywhere on the
     * map. The projectile's authored `Range` is the answer, and the origin is
     * fixed here rather than read at landing: the thing flies from where the
     * hero stood when the cast was accepted, so the hero walking away
     * afterwards does not move it.
     */
    origin: session.heroPosition ? { ...session.heroPosition } : null,
    maxDistance: Math.max(0, Number(projectile.Range ?? 0)),
  });
  return true;
};

/** A permit is for the floor it was issued on and does not outlive it. */
export const clearPlacementPermits = (session) => {
  session.placementPermits = [];
};

/**
 * How far past the projectile's own reach a landing is still allowed.
 *
 * The origin is this server's idea of where the hero stood, which arrives on
 * its own schedule — 208ms behind at the median. So the real throw point can be
 * a little away from the recorded one, and the slack covers that rather than
 * covering the throw.
 *
 * It is generous against what a throw actually does. In a session played
 * against this server the five placements landed 17, 179, 179, 182 and 209
 * units from the hero, against an authored `Range` of 350 on all three
 * projectiles — so the bound below is more than three times the widest throw
 * seen.
 */
const PLACEMENT_SLACK = 400;

/**
 * The one permit this placement is standing on.
 *
 * There were two searches: one for the origin the wall sweep measured from and
 * another for the record to consume, matched on different criteria. With two
 * live throws of the same thing from the same slot they could land on different
 * records — the mine placed against the near one while the sweep reported the
 * far one crossing a wall. Both a false positive and a false negative in the
 * telemetry meant to decide whether that sweep can ever be enforced.
 *
 * One lookup now, and the same record answers both questions.
 */
const matchPermit = (session, constant, weaponSlot, at) => {
  const permits = session.placementPermits ?? [];
  const now = Date.now();
  const index = permits.findIndex((permit) => {
    if (permit.constant !== constant) return false;
    if (permit.weaponSlot !== Number(weaponSlot ?? 0)) return false;
    if (permit.floorDoid !== session.floorDoid) return false;
    if (permit.expiresAt <= now) return false;
    // A permit issued before this server knew where the hero was bounds nothing;
    // that is our ignorance, and refusing on it deletes an honest throw.
    if (!permit.origin || !at) return true;
    const distance = Math.hypot(at.x - permit.origin.x, at.y - permit.origin.y);
    return distance <= permit.maxDistance + PLACEMENT_SLACK;
  });
  return index < 0 ? null : { index, permit: permits[index] };
};

/** Spends it, once. */
const spendPermit = (session, match) => {
  if (!match) return false;
  session.placementPermits.splice(match.index, 1);
  return true;
};

export const handleProposeCreateNPC = async (session, reader) => {
  const npcId = reader.u32();
  const weaponSlot = reader.u32();
  const x = reader.f32();
  const y = reader.f32();
  if (!session.floorDoid) return true;

  /**
   * The same rule the hero's own position gets, because this is the same claim
   * on a different field and it was going unread. A valid permit proves what
   * was thrown and from which slot; it says nothing about where it landed, so
   * one honest throw could put a mine at NaN, Infinity — or a million units
   * away — and this server would build it there.
   *
   * Worse here than for a hero: a placeable persists, it is a collider, and
   * everything that paths around it inherits the nonsense.
   */
  if (!isPlausiblePosition({ x, y })) {
    noteViolation(session, RULE.implausibleCoordinate, `ProposeCreateNPC at ${x}, ${y}`);
    return true;
  }

  const gm = await loadGameMaster();
  const npc = gm.raw.Npc.find((row) => Number(row.Id) === Number(npcId));
  if (!npc) {
    warn(`[${session.id}] ProposeCreateNPC named unknown npc ${npcId}`);
    return true;
  }

  /**
   * Whether the throw could have got there.
   *
   * The range bound says the landing point is close enough to where the cast
   * was made; it says nothing about what is between them, so a trap can be put
   * on the far side of a thin wall while staying well inside 350 + 400.
   *
   * Counted rather than refused, and deliberately. Every other rule here was
   * sized against honest play before it was allowed to drop anything, and this
   * one cannot be: the recordings contain no placements at all, so the only
   * evidence is five throws made against this server. On top of that the sweep
   * reads the same static colliders that `wall-audit.js` shows disagreeing with
   * the game on 0.63% of hero positions — small, but not nothing, and a refused
   * mine is a visible bug.
   *
   * So it reports, the number accumulates, and it becomes a refusal when there
   * is something to size it with. One swept segment is about 65 microseconds;
   * no route search is involved.
   */
  const match = matchPermit(session, npc.Constant, weaponSlot, { x, y });
  const origin = match?.permit?.origin;
  if (origin && session.navigation && !hasLineOfSight(session.navigation, origin, { x, y }, 0)) {
    noteViolation(
      session,
      RULE.placementThroughWall,
      `${npc.Constant} landed past geometry between the throw and the spot`
    );
  }

  if (!spendPermit(session, match)) {
    noteViolation(
      session,
      RULE.placementWithoutThrow,
      `${npc.Constant} from slot ${weaponSlot} with no throw behind it`
    );
    if (config.placementMode === "enforce") return true;
  }

  await spawnPlaceable(session, {
    // Already a world point, so nothing is in front of anything.
    action: {
      spawnname: npc.Constant,
      offset: 0,
      headingOffsetAngle: 0,
      timetolive: await spawnLifetimeFor(npc.Constant),
    },
    origin: { x, y },
    heading: session.heroHeading,
    weaponPower: session.heroWeapons?.[weaponSlot]?.power,
  });
  info(`[${session.id}] client landed ${npc.Constant} at ${Math.round(x)},${Math.round(y)}`);
  return true;
};

/** An attack places what its own timeline says it places, on the frame it says. */
export const schedulePlaceables = async (session, attack, weaponSlot = 0) => {
  const weaponPower = session.heroWeapons?.[weaponSlot]?.power;
  const actions = await spawnNpcActions(attack?.AttackTimeline);
  if (!actions.length || !session.floorDoid || !session.heroPosition) return false;

  const floorDoid = session.floorDoid;
  const origin = { ...session.heroPosition };
  const heading = session.heroHeading;

  for (const action of actions) {
    const timer = setTimeout(
      () => {
        session.placeableSpawnTimers?.delete(timer);
        if (!session.dungeonActive || session.floorDoid !== floorDoid) return;
        spawnPlaceable(session, { action, origin, heading, weaponPower }).catch((error) =>
          warn(`[${session.id}] placeable spawn failed: ${error.message}`)
        );
      },
      (Number(action.frame ?? 0) / FRAMES_PER_SECOND) * 1000
    );
    timer.unref?.();
    session.placeableSpawnTimers ??= new Set();
    session.placeableSpawnTimers.add(timer);
  }
  return true;
};

/** Clears pending spawns and everything still standing, on teardown. */
export const clearDungeonPlaceables = (session) => {
  for (const timer of session.placeableSpawnTimers ?? []) clearTimeout(timer);
  session.placeableSpawnTimers?.clear();
  for (const live of session.placeables?.values() ?? []) {
    clearInterval(live.ticker);
    for (const beat of live.beats ?? []) clearTimeout(beat);
    live.beats = [];
    clearTimeout(live.expiry);
  }
  session.placeables?.clear();
};

import { FRAMES_PER_SECOND } from "../gamemaster.js";
import { npcHeadingUpdate } from "./ai.js";
import {
  dealTrapHit,
  hazardVictims,
  hitPointsUpdate,
  npcAttackChoreography,
  performTrapAttack,
  stateUpdate,
  trapProjectileReach,
} from "./combat.js";
import { objectDisable } from "./objects.js";
import { CLID } from "./opcodes.js";

/**
 * What a raised trap does while it is up.
 *
 * The captures divide floor traps into three kinds, and the division is sharp
 * enough to read off the field counts alone — a twelve minute session:
 *
 *   trap                     field 141   field 143    field 144
 *   CASTLE_ARENA_TRAP_SPIKES      1313           0           20
 *   NORDIC_CAVE_TRAP_MACE          310         155           10
 *   CASTLE_ARENA_TRAP_CRUSHER      180          90            1
 *   NORDIC_CAVE_GARGOYLE_EMITTER     0          62            0
 *
 * 141 is the on/off state, 143 an attack animation, 144 a damage result.
 *
 * A **sustained** trap is its own effect and never animates: the spike bed gets
 * a state and nothing else, because NPCView swaps between an "off" and an "on"
 * body renderer for exactly this — the spikes rising *is* the state changing.
 * It is simply a place you cannot stand, and it hurts again every AttackTimer.
 *
 * A **choreographed** trap moves, and gets one animation per activation — 310
 * state changes to 155 animations and 180 to 90 are both exactly two to one, an
 * on and an off per swing. Its damage belongs to the frames of that swing and
 * it does not repeat: the mace's own timeline is 2.9 seconds and its trigger
 * holds it up for 3.5.
 *
 * A **launcher** never changes state at all; it stays mounted and its animation
 * is the shot.
 *
 * Sending an animation on a repeating timer, as this used to, is wrong for all
 * three. ActorGameObject.ReceiveAttackChoreography calls
 * enterAttackChoreographyState, which restarts the animation from frame zero —
 * so a crusher was told to begin its slam again every second, over the top of
 * the slam it was already playing.
 */

/** How often a standing trap re-tests contact. Fine enough that walking in registers. */
const CONTACT_TICK_MS = 100;

const frameMs = (frame) => (Number(frame ?? 0) / FRAMES_PER_SECOND) * 1000;

/**
 * The trap's shapes grouped into the moments they are dangerous.
 *
 * A spike bed authors one collider on frame 0 and a cave mace six across two
 * swings, so this is also what tells the two kinds apart: a hazard is
 * choreographed when it has a shape that arrives later than the first instant.
 */
const beatsOf = (hazard) => {
  const byFrame = new Map();
  for (const collider of hazard?.combatColliders ?? []) {
    const at = frameMs(collider.frame);
    byFrame.set(at, [...(byFrame.get(at) ?? []), collider]);
  }
  return [...byFrame.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, colliders]) => ({ at, colliders }));
};

/**
 * Who a trap can hurt.
 *
 * A trap that rises out of the floor hurts the player and nobody else. Across a
 * whole session every one of 25 `TRAP_SPIKES` results named the hero, while the
 * mace, the blade, the flame jet, the arrows and Thor's hammer all cut through
 * imps, knights and yetis freely. Monsters walk over a spike bed and are only
 * shoved aside by it, which they are anyway — a raised trap is a navigation
 * obstacle.
 *
 * The line is the layer, and it is exactly the one already carried for drawing:
 * every hero-only trap in the capture is `background`, every trap that hurts
 * monsters is `sorted`. Which is the same thing said twice — a trap drawn
 * *under* the hero is one coming out of the ground.
 */
const strike = (session, doid, hazard, colliders) => {
  for (const victim of hazardVictims(session, colliders, hazard)) {
    if (hazard.heroOnly && victim.doid !== session.heroDoid) continue;
    dealTrapHit(session, doid, hazard.attack, victim.doid, hazard.weaponPower);
  }
};

const announce = (session, doid, hazard) =>
  session.send(
    npcAttackChoreography({ doid, attackType: hazard?.attack?.Id, targetActorDoid: 0 })
  );

const remember = (session, targetId, stop) => {
  session.hazardBeats ??= new Map();
  session.hazardBeats.set(targetId, stop);
};

/**
 * A moving trap: announce the swing once, then hurt whoever each shape of it
 * touches as that shape comes round.
 *
 * Every authored frame lands on its own — there is no cooldown inside a swing.
 * The capture shows the same victim taking a cave mace at 2508ms and 2667ms of
 * one animation, 159ms apart, and a flame jet at 0, 500 and 1016ms, which are
 * its three authored frames exactly.
 */
const playSwing = (session, targetId, doid, hazard, beats) => {
  const timers = [];
  announce(session, doid, hazard);

  for (const { at, colliders } of beats) {
    const timer = setTimeout(() => {
      if (session.dungeonActive) strike(session, doid, hazard, colliders);
    }, at);
    timer.unref?.();
    timers.push(timer);
  }
  remember(session, targetId, () => timers.forEach(clearTimeout));
};

/**
 * A bomb that has gone off is gone.
 *
 * The official closes one in three messages — `hitPoints` to zero, `state` to
 * "dead", then the disable — and this server used to arrive at the same place
 * by accident: mines stood close enough together that the first to fire killed
 * the rest, and dying through `applyDamage` tore them down properly.
 *
 * Giving trap damage a notion of sides stopped that, correctly: a mine may not
 * hit another mine. But it also removed the only thing that was ending their
 * lives, so a bomb detonated, fell out of its own hazard loop, and stayed on
 * the floor for ever — the reported "the bombs explode and the animation does
 * not go away".
 *
 * Hit points reaching zero is not death on its own; `ActorGameObject
 * .determineState` runs `enterDeadState` for the string and nothing else, so
 * all three messages are needed and in this order.
 *
 * And not at once. The official lets the explosion play first — 23 recorded
 * mines put a median of 1150ms between the choreography and the death, and
 * then disable in the same millisecond as it. That 1150ms is the timeline:
 * `TM_TRAP_TRIPMINE` is 25 frames at 24 a second, which is 1042ms of fire and
 * smoke after the bang. Sending all three immediately took the object away
 * before the client could draw any of it — the bomb vanished without exploding,
 * which is the same report from the other side.
 */
const retireSpentBomb = (session, targetId, doid, hazard) => {
  if (session.objects?.get(doid) !== CLID.DistributedNPCGameObject) return;

  const finish = () => {
    if (session.objects?.get(doid) !== CLID.DistributedNPCGameObject) return;
    session.send(hitPointsUpdate(doid, CLID.DistributedNPCGameObject, 0));
    session.send(stateUpdate(doid, CLID.DistributedNPCGameObject, "dead"));
    session.send(objectDisable(doid));
    session.objects.delete(doid);
    session.actors?.delete(doid);
  };

  const showing = frameMs(hazard?.timelineFrames ?? 0);
  if (!(showing > 0)) return finish();
  const timer = setTimeout(finish, showing);
  timer.unref?.();
  remember(session, `${targetId}:spent`, () => clearTimeout(timer));
};

/**
 * A trap that is simply there: a place you cannot stand.
 *
 * Contact is tested continuously and `AttackTimer` bounds how often the *same*
 * victim can be caught. Beating on the timer instead — striking only once a
 * second and only at those instants — costs nothing while you stand still, and
 * everything on the way in: walking onto a raised spike bed did nothing for up
 * to a second, which is what "it doesn't hurt when you first touch it" is.
 *
 * Both readings match the capture, whose twenty spike hits are one second
 * apart, because that is what standing in one looks like either way. Only the
 * moment of entry tells them apart, and there the report does.
 *
 * This is not how a moving trap works: there each authored frame lands on its
 * own with no cooldown at all, which the capture *can* separate — a mace hits
 * the same victim twice 159ms apart.
 */
/**
 * Who is standing close enough to set a bomb off — not who its blast reaches.
 *
 * Measured on the mine's own body rather than on its explosion; see the note in
 * `touch`. Everything the blast catches is still worked out from the authored
 * collider once it has gone off.
 */
const nearEnoughToTrip = (session, hazard) => {
  const trip = Math.max(0, Number(hazard?.npc?.AggroRadius ?? 0));
  if (!(trip > 0) || !hazard.position) return [];
  return hazardVictims(session, [{ type: "circle", x: hazard.position.x, y: hazard.position.y, radius: trip }], hazard);
};

const holdZone = (session, targetId, doid, hazard, colliders) => {
  const cooldownMs = Math.max(0, Number(hazard?.npc?.AttackTimer ?? 0) * 1000);
  const lastHitAt = new Map();

  /**
   * A sustained trap announces itself every time it bites.
   *
   * It is the one thing this held path never did, and it is what "the flames
   * were there when the map loaded and then went, but walking over them still
   * burns me" is made of: the trigger state draws the trap switched on, the
   * animation is played from the choreography, and with no second choreography
   * the client has one activation to show for the whole floor while `touch`
   * goes on landing hits.
   *
   * The corpus prices it at one announcement per bite — `TRAP_FLAME_JET` sends
   * 151 choreographies against 142 results and `FLAME_BURN` 94 against 90, both
   * within a twentieth of parity. Launchers sit far above it, 5.93 for the ice
   * arrows and 3.12 for a cave mace, because those fire whether or not anything
   * is standing there; a held trap only speaks when it has caught something.
   *
   * Not the hero-only ones. A spike bed shows itself by changing its trigger
   * state, and the corpus sends it no choreography at all — `TRAP_SPIKES`
   * results name the hero 25 times out of 25 and never accompany one. The only
   * spike that does announce, `CASTLE_ARENA_TRAP_SPIKES_E`, does it on a flat
   * four-second metronome whether or not anyone is standing there, which is a
   * third shape this does not try to be.
   *
   * Once per biting tick rather than once per victim, so a trap that catches
   * three monsters at once still plays one animation.
   */
  const touch = () => {
    const now = Date.now();
    let bit = false;
    if (hazard.spent) return;
    /**
     * A bomb does not go off while the floor is still being laid.
     *
     * `stockFloor` puts monsters on the markers a tile authors, and a mine's
     * blast reaches 140 units — so a knight placed near one set it off on the
     * first contact tick, and nine mines on a temple floor detonated together
     * before the player had moved. The client's own log ends on nine
     * `suicide` timeline actions seven milliseconds apart, which is the last
     * thing it wrote before going down.
     *
     * A trap that hurts on contact is different: it is *supposed* to catch what
     * is standing in it. Only the one-shot bombs wait.
     */
    if (hazard.contactBomb && !session.floorSettled) return;
    /**
     * A bomb is tripped by being stepped near, and hurts much further than that.
     *
     * Its timeline authors one shape — a circle of 140 for `TM_TRAP_TRIPMINE`,
     * 120 for the firebomb — and that is the blast. Using it to decide when the
     * thing goes off as well makes the mine notice you from the far edge of its
     * own explosion, so it detonates before the player is anywhere near it and
     * catches them in the tail of a blast they never reached.
     *
     * The row says how close is close enough: `AggroRadius` is 60 on all three
     * placeables, against a blast more than twice that. So the trip is 60 and
     * the damage is still the authored shape — you have to walk onto it, and
     * then it hurts as far as it always did.
     */
    /**
     * The trip decides *whether*; the blast decides *who*. A bomb set off by a
     * hero standing at its edge still catches everything inside the authored
     * circle, which is what makes standing next to one with a monster
     * dangerous for both.
     */
    if (hazard.contactBomb && !nearEnoughToTrip(session, hazard).length) return;
    for (const victim of hazardVictims(session, colliders, hazard)) {
      if (hazard.heroOnly && victim.doid !== session.heroDoid) continue;
      if (now - (lastHitAt.get(victim.doid) ?? -Infinity) < cooldownMs) continue;
      lastHitAt.set(victim.doid, now);
      if (!bit && !hazard.heroOnly) {
        bit = true;
        announce(session, doid, hazard);
      }
      dealTrapHit(session, doid, hazard.attack, victim.doid, hazard.weaponPower);
      /**
       * A mine is spent by going off. The corpus fires each of its 23 recorded
       * instances exactly once and never switches one on or off, which is what
       * a bomb lying on the floor does: it waits, it detonates, it is gone.
       */
      if (hazard.contactBomb) {
        hazard.spent = true;
        stopHazardBeat(session, targetId);
        retireSpentBomb(session, targetId, doid, hazard);
      }
    }
  };

  /**
   * Not on the instant it rises.
   *
   * Standing on a spike bed as it comes up costs the official a beat: across 88
   * recorded first hits the earliest is 60ms after the switch-on, the commonest
   * is 100ms and the median 266ms — never zero. Testing contact immediately put
   * ours at zero, which is the "these went off later on the real server"
   * report, and it is also the difference between being able to step off
   * something you can see rising and not.
   *
   * One tick of latency is the whole cost, and 100ms is what the mode says it
   * should be.
   */
  const timer = setInterval(() => {
    if (!session.dungeonActive) return stopHazardBeat(session, targetId);
    touch();
  }, CONTACT_TICK_MS);
  timer.unref?.();
  remember(session, targetId, () => clearInterval(timer));
};

/**
 * Whether this trap's shape moves across a swing rather than sitting still.
 * Only a moving one announces an animation, and only that one is ordered
 * against its trigger state — see applyTargetState.
 */
export const isChoreographed = (hazard) => {
  const beats = beatsOf(hazard);
  return beats.length > 0 && beats.at(-1).at > 0;
};

export const stopHazardBeat = (session, targetId) => {
  const stop = session.hazardBeats?.get(targetId);
  if (!stop) return;
  stop();
  session.hazardBeats.delete(targetId);
};

/** Stops every raised trap; dungeon teardown calls it. */
export const clearHazardBeats = (session) => {
  for (const stop of session.hazardBeats?.values() ?? []) stop();
  session.hazardBeats?.clear();
  for (const stop of session.turretAims?.values() ?? []) stop();
  session.turretAims?.clear();
};

/**
 * What a barrel does when it breaks.
 *
 * `DeathAttack` is authored on every exploding barrel in every theme, and it is
 * the same shape as a trap's swing: a choreography, then damage on the frames
 * the timeline names. The captures agree — `EN_EXPLODING_BARREL_DEATH_ARENA`
 * lands 148 results at 1216-1254 ms after its animation, against an authored
 * frame 29, which is 1208 ms. So the bang is a beat late, and it has to be, or
 * the barrel kills what is standing beside it before it has visibly gone off.
 *
 * Unlike a trap this plays once and is not held: nothing is registered against
 * a target id, because the thing that owned it is gone.
 */
export const playDeathAttack = async (
  session,
  doid,
  attack,
  position,
  colliders,
  { npc, weaponPower } = {}
) => {
  if (!attack || !colliders?.length) return false;
  /**
   * The barrel's own weapon, and it matters more here than anywhere.
   *
   * `computeDamage` falls back to `session.weaponPower` when it is given none,
   * which is the *hero's* — so a barrel left to itself exploded with the
   * strength of whoever broke it. The official charges 3, from an attack with
   * `DamageMod` -3, no percent-health line, and a barrel whose weapon is
   * `Power` 1 and whose `MELEE_ATK` is 0: 140 results against monsters at -3
   * and -6, and 8 against the hero at -3. It is a scenery pop, not a weapon.
   */
  const hazard = {
    attack,
    npc,
    weaponPower,
    position,
    heroOnly: false,
    combatColliders: colliders,
  };
  session.send(npcAttackChoreography({ doid, attackType: attack.Id, targetActorDoid: 0 }));

  for (const { at, colliders: frame } of beatsOf(hazard)) {
    const timer = setTimeout(() => {
      if (session.dungeonActive) strike(session, doid, hazard, frame);
    }, at);
    timer.unref?.();
  }
  return true;
};

/**
 * A trap that turns to face the hero before it fires.
 *
 * Loki's statue is the only one. Across the captures it is the sole prop that
 * changes heading under its own steam — 92 updates over two doids in half a
 * minute, where every other prop sends exactly one per doid at generation and
 * never moves again. And it is aiming, not merely turning: against the hero's
 * position at the time, the heading it sends is off by a median 3.8 degrees and
 * a p90 of 7.4, which is the hero moving between the server's sample and the
 * next one rather than any spread of its own.
 *
 * The cadence is the hero's, not a metronome: the median gap between a statue's
 * headings is 251 ms and the longest is over five seconds, which is what
 * "re-aim when the target has actually moved" looks like. So this checks on a
 * quarter-second and sends only when the answer changed.
 */
const AIM_TICK_MS = 250;
const AIM_DEADZONE_DEGREES = 1;

const isTurret = (hazard) => hazard?.attack?.Constant === "TRAP_LOKI_FIREBALL";

const bearing = (from, to) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

/**
 * Whether the hero is close enough for this statue to have any business with
 * them.
 *
 * A turret fires on its own `AttackTimer` and turns to follow whatever it can
 * see, and this server was doing both at any distance: 166 heading updates per
 * statue against the official's 17. Every statue on the floor tracked the
 * player from across it, which is what "they aggro from outside their range"
 * describes — the statue is plainly aiming at you from somewhere its fireball
 * could never reach.
 *
 * Bounded by the shot's own reach, so nothing that could have landed is lost:
 * a statue that cannot hit you does not turn towards you and does not fire.
 * What the player takes is unchanged; what they see is not.
 */
const withinReach = (hazard, hero) => {
  if (!hazard?.attack) return true;
  const reach = trapProjectileReach(hazard.attack, hazard.projectile);
  const from = muzzleOf(hazard);
  return Math.hypot(hero.x - from.x, hero.y - from.y) <= reach;
};

/** Where this hazard's shot leaves from — its mount plus the timeline's offset. */
const muzzleOf = (hazard) => ({
  x: hazard.position.x + (hazard.launch?.xOffset ?? 0),
  y: hazard.position.y + (hazard.launch?.yOffset ?? 0),
});

/** The heading a tracking turret should carry in its initial generate. */
export const initialTurretHeading = ({ attack, projectile, position, launch, hero }) => {
  const hazard = { attack, projectile, position, launch };
  if (!position || !hero || !isTurret(hazard) || !withinReach(hazard, hero)) return null;
  return bearing(muzzleOf(hazard), hero);
};

const turned = (from, to) => Math.abs((((to - from) % 360) + 540) % 360 - 180);

/**
 * Turns a statue to face the hero, and tells the client before anything else.
 *
 * Exported because the shot has to be able to ask for it. `launchTrapProjectile`
 * simulates the fireball along `hazard.heading`, and the client draws it along
 * whatever heading it last received — so the two only agree if the aim reaches
 * the client and the simulation in the same breath.
 *
 * They were not agreeing. The official sends a heading immediately before 71 of
 * its 84 recorded shots; ours managed 40 of 838, because the aim ran on its own
 * quarter-second timer while the statue fired every four seconds. In between,
 * the hero moves. That is the flame passing beside a player who takes the
 * damage anyway — one direction drawn, another one hit.
 */
export const aimTurret = (session, targetId) => {
  const doid = session.triggerableDoids?.get(targetId);
  const hazard = session.triggerableHazards?.get(targetId);
  if (doid === undefined || !hazard?.position || !isTurret(hazard)) return false;
  const hero = session.heroPosition;
  if (!hero) return false;
  if (!withinReach(hazard, hero)) return false;

  // Aimed from where the shot leaves, not from the mount: the client draws the
  // fireball out of the statue's hands, so a line drawn from its feet is
  // parallel to the flame rather than the same as it. See projectileLaunch.
  const heading = bearing(muzzleOf(hazard), hero);
  const current = hazard.heading ?? hazard.position.heading ?? 0;
  // Already pointing there: the client has the right angle and needs no word.
  if (turned(current, heading) < AIM_DEADZONE_DEGREES) return false;

  hazard.heading = heading;
  session.send(npcHeadingUpdate(doid, heading));
  return true;
};

export const startTurretAim = (session, targetId) => {
  const doid = session.triggerableDoids?.get(targetId);
  const hazard = session.triggerableHazards?.get(targetId);
  if (doid === undefined || !hazard?.position || !isTurret(hazard)) return false;

  const aim = () => {
    if (!session.dungeonActive) return stopTurretAim(session, targetId);
    aimTurret(session, targetId);
  };

  const timer = setInterval(aim, AIM_TICK_MS);
  timer.unref?.();
  session.turretAims ??= new Map();
  session.turretAims.set(targetId, () => clearInterval(timer));
  aim();
  return true;
};

export const stopTurretAim = (session, targetId) => {
  session.turretAims?.get(targetId)?.();
  session.turretAims?.delete(targetId);
};

/**
 * A trap switches on.
 *
 * A launcher fires and is done — it has no state to hold, and its shot is
 * simulated rather than resolved on contact. Everything else starts running.
 */
export const raiseHazard = (session, targetId) => {
  const doid = session.triggerableDoids?.get(targetId);
  if (doid === undefined) return false;
  const hazard = session.triggerableHazards?.get(targetId);
  if (!hazard) return false;

  if (hazard.attack?.Projectile) {
    /**
     * Aim first, then shoot.
     *
     * The client draws the fireball along the heading it holds when the
     * choreography arrives, and this server simulates it along
     * `hazard.heading`. Sending the aim in the same breath as the shot is what
     * keeps those the same line — see aimTurret.
     */
    const reaches = () =>
      !isTurret(hazard) || !session.heroPosition || withinReach(hazard, session.heroPosition);

    if (reaches()) {
      aimTurret(session, targetId);
      performTrapAttack(session, doid, hazard);
    }
    /**
     * A launcher with a timer keeps firing on it.
     *
     * Most launchers author `AttackTimer` 0 and shoot once for each time they
     * are switched on, which is what a gargoyle or an arrow trap does. Loki's
     * statue authors 4, and the corpus holds it to within thirty milliseconds
     * over eighty-four shots — every statue on its own phase, so two raised
     * together stay together.
     *
     * Without this it fired once and fell silent, because nothing switches a
     * statue back on: four of the six in the temple capture are sent no trigger
     * state at all. That is the whole of "Loki is still broken".
     */
    const beatMs = Math.round(Number(hazard.npc?.AttackTimer ?? 0) * 1000);
    if (beatMs > 0 && !session.hazardBeats?.has(targetId)) {
      const timer = setInterval(() => {
        if (!session.dungeonActive) return stopHazardBeat(session, targetId);
        // A statue that cannot reach the hero stays quiet; see withinReach.
        if (!reaches()) return;
        aimTurret(session, targetId);
        performTrapAttack(session, doid, hazard);
      }, beatMs);
      timer.unref?.();
      remember(session, targetId, () => clearInterval(timer));
    }
    return true;
  }
  if (session.hazardBeats?.has(targetId)) return true;

  const beats = beatsOf(hazard);
  if (!beats.length) return false;

  /**
   * A bomb waits to be stepped on.
   *
   * `playSwing` announces the moment a trap is raised, which is right for a
   * mace — the swing *is* the activation. A mine lying on the floor is armed
   * from the moment the floor is built and must not go off until something
   * touches it, so it takes the held path however many frames its explosion
   * authors. Sending it down the swing path detonated all nine on the temple's
   * second floor as the player walked in.
   */
  if (hazard.contactBomb) {
    holdZone(session, targetId, doid, hazard, beats.flatMap(({ colliders }) => colliders));
  } else if (beats.at(-1).at > 0) {
    playSwing(session, targetId, doid, hazard, beats);
  } else {
    holdZone(session, targetId, doid, hazard, beats[0].colliders);
  }
  return true;
};

/**
 * What kind of hazard a GameMaster row describes.
 *
 * Four decisions, each read off the same two rows — the NPC and its attack —
 * and each one measured rather than assumed. They live here rather than inside
 * the floor builder so that tools/trap-census.js can ask the same question of
 * every trap in the game without reimplementing it; an oracle that restates the
 * rule it is checking cannot catch the rule being wrong.
 */
export const classifyHazard = ({ npc, attack, projectile }) => {
  /**
   * A hazard that is terrain rather than a trap: always live, never switched.
   *
   * The tar pit is the only one. Both recorded pits are never sent a trigger
   * state and one of them hurts the hero forty times about a second apart,
   * while every other silent hazard in the captures is harmless — 218 cave
   * spike beds, 23 dino spears, 17 dino spike beds, all quiet. A pool of tar
   * has no raised and lowered state to send, so it receives none and simply
   * is where it is.
   *
   * Named by its attack because that is the row the evidence is about. One
   * NPC uses `TRAP_TARPIT`, and it is authored unlike any other hazard: three
   * percent of the bar rather than twelve, and a `TAR_SLOW` on whoever stands
   * in it. If a second trap ever turns up doing this, the set is the wrong
   * shape and the discriminator should come from the data instead.
   */
  const alwaysLive = attack?.Constant === "TRAP_TARPIT";
  /**
   * A patch of something harmful left on the ground, which burns whatever
   * stands in it without anything having to switch it on.
   *
   * Eight rows say this and they are one idea, not a grab-bag: burning fire,
   * the three poison poultry clouds, the dragon's meteor and ground flames,
   * and the two specter flames. All `CharType ENEMY` with `IsMover` 0,
   * `InstantAttack`, an aggro radius of 60 and a `sorted` layer. They are
   * actors rather than traps — the engine's own AI gate is
   * `CharType === "ENEMY" && IsMover`, and being stationary is exactly what
   * dropped them out of it, so nothing ever gave them a reason to attack.
   *
   * The captures separate them from the trap next to them by the same field.
   * `BURNING_FIRE_PLACEABLE` is an ENEMY: 24 of its 26 doids are never sent a
   * trigger state and seven of those hurt the hero anyway. Its twin
   * `BURNING_FIRE_PLACEABLE_ALL` is a BEAST — same asset, same attack, same
   * layer, same timer, one column apart — and its two unstated doids hurt
   * nobody, while its wired ones cycle a second on and a second off, 105 of
   * each. So one is live by being there and the other waits to be switched,
   * and the data says which is which.
   *
   * Armed on arrival, but still switchable: no recorded doid of either kind
   * has a first state of `off`, and the ones that are wired should keep
   * toggling, so this only adds the arming.
   */
  /**
   * A hero's placeable, authored into a map as content.
   *
   * `BEAST` is the placeable family — mines, fire patches, bombs — and nine
   * mines and seven fire patches sit on the temple's second floor. Reading only
   * `ENEMY` here put them in the toggling class, which arms them as the world is
   * built: the report was "there is a swarm of traps on the ground and they all
   * play an explosion the moment I walk in, then they are gone".
   *
   * `InstantAttack` separates the two halves, and the corpus keeps the same
   * line. A fire patch has it and is switched on exactly once — eleven of them
   * take a single trigger packet, shape "1" — then burns whatever stands in it.
   * A mine does not have it, is sent no trigger state at all across 23
   * instances, and fires once.
   */
  const burnsOnContact =
    npc?.CharType === "ENEMY" && !npc.IsMover && Boolean(npc.InstantAttack) && Boolean(attack);

  /**
   * A bomb lying on the floor: a mine, a firebomb, a death bomb.
   *
   * `BEAST` is the placeable family, and `InstantAttack` splits it in two. A
   * fire patch has it, is wired to a switch, and the corpus generates it at
   * trigger state 0 and turns it on once — so it is an ordinary toggling hazard
   * and must stay one. A mine does not have it, is sent no trigger state at all
   * across 23 recorded instances, and fires exactly once.
   *
   * Only the second half belongs here. Treating the whole family as one armed
   * the triggered fire patches at build and stopped their switch reaching them.
   */
  const contactBomb =
    npc?.CharType === "BEAST" && !npc.IsMover && Boolean(attack) && !npc.InstantAttack;
  /**
   * Loki's statue is the launcher that does toggle.
   *
   * The rule above is right for a nozzle — an arrow trap and a gargoyle
   * emitter are sent no state at all in any capture, and toggling one makes
   * the launcher itself blink. A statue is not a nozzle: across the corpus its
   * fourteen doids take 26 switch-ons and 21 switch-offs.
   *
   * Those rides on `remoteTriggerState`, field 141, and not on `state` — an
   * earlier reading of this called them states and it was wrong. Field 138 is
   * sent to a Loki statue exactly zero times in 84 recorded shots. The two
   * fields are not interchangeable: the client derives `isAttackable` from the
   * trigger and its death picture from the state, so a statue switched off with
   * a state would be a statue that had died.
   *
   * The cadence is its own `AttackTimer`, 4, and it keeps it to within 30ms
   * over 84 shots — every statue on its own phase, so two raised together stay
   * together and two raised 1.59s apart hold that gap. A heading update lands
   * in the same millisecond as each shot, which is the statue aiming; see
   * startTurretAim.
   *
   * Named by its attack because that is what the evidence is about, and
   * because the other statue that shoots — `AZTECH_STATUE`, 26 doids — is
   * sent no state either. If a second launcher turns up toggling, this wants
   * a column rather than a name.
   */
  const togglingLauncher = attack?.Constant === "TRAP_LOKI_FIREBALL";
  const togglesRenderer = Boolean(
    attack && (!projectile || togglingLauncher) && !alwaysLive && !contactBomb
  );

  /**
   * A fire is not there until it is lit.
   *
   * Every other placeable rests armed: a mine lying on the floor *is* its own
   * on-state, and the official generates 66 of them switched on against 4 off.
   * A fire has nothing to draw until it burns, and the official generates all
   * 28 of them switched off — `FIREBOMB_PLACEABLE_ALL` 8 of 8 and
   * `BURNING_FIRE_PLACEABLE_ALL` 20 of 20, with not one counter-example in
   * either direction across the corpus.
   *
   * `Element` is what separates them, and nothing else does: `MINE_PLACEABLE_ALL`
   * and `FIREBOMB_PLACEABLE_ALL` agree on CharType, IsMover, InstantAttack and
   * AttackTimer, and differ on their damage numbers, their art and this.
   *
   * The client says the same thing from the other side. `ActorRenderer` asks
   * for `<asset>_off` while the trigger is down, and `db_fx_library.swf` holds
   * no class ending in `_off` at all — an unlit fire is *meant* to draw
   * nothing, which is only coherent if it starts unlit.
   */
  const restsUnlit = npc?.CharType === "BEAST" && npc?.Element === "FIRE";

  return {
    alwaysLive,
    burnsOnContact,
    togglingLauncher,
    togglesRenderer,
    contactBomb,
    restsUnlit,
  };
};

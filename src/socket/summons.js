/**
 * What an enemy's attack calls onto the floor.
 *
 * A timeline's `spawnnpc` actions are the server's — the client builds nothing
 * for them (see `spawnNpcActions`). The hero's side has been built for a long
 * time in placeables.js; an enemy's had nothing, so the Ghost Samurai played
 * Iron Legion and no clone came, and Papa Yeti called for babies that never
 * arrived. Those are the two bosses' hardest-hitting company: the official's
 * clones land 16-31 a swing where the samurai himself lands 3-12.
 *
 * Everything here was read off the official captures:
 *
 *   - When: the action's own frame at 24fps and the cast's play speed. Iron
 *     Legion authors frames 58/64/68, 2417/2667/2833ms; the clones arrive at
 *     2493/2749/2917. The imp's frame 10 is 417ms, measured p50 417 over 147.
 *   - Only while the caster lives. Papa Yeti died 909ms into his cast and the
 *     frame-25 pair of babies (1042ms) never came — 6 of 8. Twelve imp casts
 *     whose caster died inside 500ms produced nothing.
 *   - Where: from the caster as it stands at that frame, by the same reading
 *     of `offset` and `headingOffsetAngle ?? angleOffset` the hero's side uses.
 *     The enemy Iron Legion spells its distance `headingOffset`, which that
 *     reading does not see, and the official agrees: its three clones came up
 *     on the samurai's own x, following him as he was shoved along y, not 150
 *     units out. Yeti pairs authored on one frame share one spot.
 *   - What: the caster's level, the enemies' side, full row rewards on a kill,
 *     and hunting at once — a clone swung 174ms after it appeared.
 *   - How long: `timetolive`, then `expireActor`.
 *
 * What walks is an ordinary enemy once it exists, and goes through the same
 * `spawnNpc` as the floor's own. What stands — a dragon's flames, a rival's
 * mines and garlic, a berserker's axe — is a placeable on the enemies' side,
 * built by placeables.js with the caster as its owner. No recording has any of
 * those casters, so that half follows the hero side's measured rule rather
 * than a measurement of its own.
 *
 * A death attack calls from where its caster fell: the heavy red specter
 * leaves an exploding flame as it dies, and by the flame's frame there is no
 * specter left to ask.
 */
import { npcForConstant, spawnNpcActions } from "../gamemaster.js";
import { warn } from "../log.js";
import { expireActor } from "./combat.js";
import { isPositionBlocked, nearestClearPosition } from "./navigation.js";
import { TEAM } from "./opcodes.js";
import { placeablePosition, spawnPlaceable, timelineDelayMs } from "./placeables.js";

/** A timer on the floor's clock, so a floor change takes every pending one with it. */
const later = (session, run, delay) => {
  if (session.combatClock?.setTimeout) return session.combatClock.setTimeout(run, delay);
  const scope = session.floorScope;
  const timer = scope ? scope.timeout(run, delay) : setTimeout(run, delay);
  if (!scope) timer.unref?.();
  return timer;
};

/** Pushed out of a wall, never out of the caster: that is where the clones stand. */
const clearOf = (session, npc, desired, origin) => {
  const radius = Math.max(12, Number(npc.CollisionSize ?? 0) * Number(npc.Scale ?? 1));
  if (!isPositionBlocked(session.navigation, desired, radius)) return desired;
  return (
    nearestClearPosition(session.navigation, desired, radius, {
      reach: 300,
      reachableFrom: origin,
      towards: origin,
    }) ?? desired
  );
};

const summonOne = async (session, { casterDoid, fallen, floorDoid, npc, action, spawn }) => {
  if (!session.dungeonActive || session.floorDoid !== floorDoid) return null;
  const living = session.actors?.get(casterDoid);
  const caster = fallen ?? (living && !living.dead ? living : null);
  if (!caster?.position) return null;

  const heading = Number(caster.heading) || 0;
  if (!npc.IsMover) {
    return spawnPlaceable(session, {
      action,
      origin: caster.position,
      heading,
      owner: { team: caster.team, masterDoid: casterDoid, level: caster.level },
    });
  }
  const position = clearOf(
    session,
    npc,
    placeablePosition(caster.position, heading, action),
    caster.position
  );
  const doid = await spawn(npc.Constant, position, { level: caster.level, heading });
  const lifetimeMs = Math.max(0, Number(action.timetolive ?? 0) * 1000);
  if (doid && lifetimeMs) later(session, () => expireActor(session, doid), lifetimeMs);
  return doid;
};

/**
 * Schedules everything `attack` calls up, from `casterDoid`.
 *
 * `spawn(constant, position, { level, heading })` builds a walking one and
 * returns its doid; the floor supplies it (see dungeon.js), because building
 * an enemy needs the floor's own context. `dying` is for a death attack, whose
 * caster is taken as it stands now rather than asked after at each frame.
 * Returns how many were scheduled.
 */
export const scheduleSummons = async (
  session,
  { casterDoid, attack, playSpeed = 1, spawn, dying = false }
) => {
  const actions = await spawnNpcActions(attack?.AttackTimeline);
  const caster = session.actors?.get(casterDoid);
  // A hero's summons, and a pet's, are placeables and belong to placeables.js.
  if (!actions.length || !caster || caster.team === TEAM.PLAYERS) return 0;

  const fallen = dying && caster.position
    ? {
        position: { ...caster.position },
        heading: caster.heading,
        level: caster.level,
        team: caster.team,
      }
    : null;
  const floorDoid = session.floorDoid;
  let scheduled = 0;
  for (const action of actions) {
    const npc = await npcForConstant(action.spawnname);
    if (!npc) continue;
    const run = () =>
      summonOne(session, { casterDoid, fallen, floorDoid, npc, action, spawn }).catch((error) =>
        warn(`summons: ${attack.Constant} -> ${npc.Constant} failed: ${error.message}`)
      );
    later(session, run, timelineDelayMs(action.frame, playSpeed));
    scheduled += 1;
  }
  return scheduled;
};

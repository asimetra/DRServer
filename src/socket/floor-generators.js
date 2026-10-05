import { emitGeneratorRelease, emitSignal, initialTargetState } from "./triggers.js";
import { checkFloorCleared } from "./floorstate.js";
import { findCageReleasePath, isPositionBlocked, nearestClearPosition } from "./navigation.js";
import { info, warn } from "../log.js";
import { spawnBossReward } from "./drops.js";
import { spawnNpc } from "./npc-spawn.js";

/**
 * Generators: the doors and spawners that release monsters in waves or packs
 * — the pack door, the wave cadence, the next wave's draw, and
 * `buildGenerators`.
 */

/** A generator stop must wake its current wait, not merely set a later flag. */
const generatorSleep = (runtime, ms) => {
  if (runtime.stopped || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (runtime.cancelWait === finish) runtime.cancelWait = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    runtime.cancelWait = finish;
  });
};

/**
 * Waits for one of this generator's spawns to die, or for the generator to be
 * stopped. The door below is what asks.
 */
const generatorWaitForDeath = (runtime) => {
  if (runtime.stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      if (runtime.wakeDeath === finish) runtime.wakeDeath = null;
      if (runtime.cancelWait === finish) runtime.cancelWait = null;
      resolve();
    };
    runtime.wakeDeath = finish;
    runtime.cancelWait = finish;
  });
};

/**
 * A generator's door: open for one pack of `maxPopulation` at a time, and
 * reopened by a death.
 *
 * Measured on the official's Battleheim boss floor (socket-20261005-165901:
 * 14 cave generators, `maxPopulation` 2 to 10, `maxSpawns` 8 to 25,
 * `spawnInterval` 0.1): every generator releases a whole pack on its input —
 * ten at a tenth of a second — and every later pack starts a tenth of a
 * second after the *first* death among its own spawns since the previous
 * pack ended (26 of 28; the two others are a second generator at the same
 * mouth starting on its timer). Five dying at once open one pack, not five.
 * Nine of the first pack still alive do not hold the second back, and
 * nothing waits for the mouth to clear. So the population is not "how many
 * stand", it is the size of a pack, and a death is the signal for the next.
 *
 * This server refilled one for one — a death, a spawn — which turned a cave
 * that pours ten out into one that leaks them, and is why two caves authored
 * alike felt unlike. A jail with `maxPopulation` 1 is the same either way:
 * one out, one dead, one out.
 *
 * Deaths while the door is open are absorbed: the pack is already coming.
 */
export const createPackDoor = ({ maxPopulation, maxSpawns }) => {
  const pack = Math.max(1, Number(maxPopulation) || 1);
  const total = Math.max(1, Number(maxSpawns) || 1);
  let spawned = 0;
  let left = Math.min(pack, total);
  return {
    get open() {
      return left > 0 && spawned < total;
    },
    get exhausted() {
      return spawned >= total;
    },
    /** One out: the pack shrinks by one. */
    spawned() {
      spawned++;
      left = Math.max(0, left - 1);
    },
    /** One dead: reopens a closed door for the next pack; true when it did. */
    died() {
      if (left > 0 || spawned >= total) return false;
      left = Math.min(pack, total - spawned);
      return true;
    },
  };
};

/** Nearby spawns are one burst; a five-second jail spawn is intentionally not. */
const WAVE_JOIN_WINDOW_MS = 500;

/** A burst keeps its compact separation only through its initial approach. */
const WAVE_COORDINATION_MS = 8000;

/**
 * Builds a dungeon for a player: the objects the client expects the server to
 * own (see docs/private-server.md §4.3).
 *
 * Each placement kind gets one builder below. They all take the same context
 * and report how many objects they produced, so supporting a new kind is a
 * matter of writing a builder and listing it in BUILDERS.
 */

/** Nearest live party member to a world decision, with a solo fallback. */
export const nearestPartyHeroPosition = (session, origin = { x: 0, y: 0 }) => {
  const candidates = [];
  for (const doid of session.playerActors ?? [session.heroDoid]) {
    const actor = session.actors?.get(doid);
    const position = actor?.position ?? (doid === session.heroDoid ? session.heroPosition : null);
    if (!actor?.dead && position) {
      candidates.push({
        doid,
        position,
        distance: Math.hypot(position.x - origin.x, position.y - origin.y),
      });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || Number(a.doid) - Number(b.doid));
  return candidates[0]?.position ?? null;
};

/**
 * Reuses one tiny, in-memory group for the enemies emitted by a generator
 * burst. This is deliberately scoped to a single session and never reaches
 * the client; it lets local separation recognize nearby burst members without
 * creating a new global simulation system.
 */
const nextGeneratorWave = (runtime, now) => {
  if (!runtime.wave || now - runtime.wave.lastSpawnAt > WAVE_JOIN_WINDOW_MS) {
    runtime.waveSequence = (runtime.waveSequence ?? 0) + 1;
    runtime.wave = {
      id: `${runtime.placement.id}:${runtime.waveSequence}`,
      lastSpawnAt: now,
      nextMemberIndex: 0,
      expiresAt: now + WAVE_COORDINATION_MS,
    };
  }

  runtime.wave.lastSpawnAt = now;
  return { group: runtime.wave, index: runtime.wave.nextMemberIndex++ };
};

/**
 * Builds the exit animation for a generated enemy from the nearby cage shape.
 *
 * The actor itself remains at the tile's authored position, which preserves
 * the visual of a monster leaving a jail. Only the short release movement
 * ignores the enclosing trigger collider; regular navigation starts after the
 * actor reaches the computed mouth.
 */
export const generatorSpawn = (session, runtime, npc) => {
  /**
   * The body the client draws, not the authored number — the same product used
   * where this spawn is announced, and it was missing here alone.
   *
   * Everything that releases a monster reads this: cage-mouth selection, the
   * standability check at the authored origin and the later movement sweep all
   * ask whether a body of this size fits. 96 of the 109 NPC rows that author a
   * `CollisionSize` also author a `Scale` other than 1, so testing the unscaled
   * radius can choose a mouth the rendered actor cannot actually pass through.
   */
  const collisionRadius = Math.max(12, (npc.CollisionSize ?? 35) * (npc.Scale ?? 1));
  const { placement } = runtime;
  const { navigation } = session;
  /**
   * The player's whereabouts belong in the key. The exit is chosen as the way
   * out nearest to them, so a plan worked out for where they stood when the
   * first of a wave came through is the wrong way round for the rest once they
   * have moved — which is how a cage ends up releasing off to one side of
   * whoever opened it.
   *
   * Quantised to a tile so a moving player does not make every spawn redo the
   * search; a step of a whole tile is what it takes to change the answer.
   */
  const hero = nearestPartyHeroPosition(session, placement);
  const heroCell = hero ? `${Math.round(hero.x / 900)},${Math.round(hero.y / 900)}` : "none";
  const cacheKey = `${collisionRadius}:${navigation?.revision ?? 0}:${heroCell}`;
  runtime.releasePlans ??= new Map();
  let release = runtime.releasePlans.get(cacheKey);

  if (!release && navigation) {
    release = findCageReleasePath(navigation, placement, collisionRadius, hero);
    if (release) runtime.releasePlans.set(cacheKey, release);
  }

  /**
   * A generator standing in scenery is normal, not a fault. The boss jails are
   * authored with their spawn point inside the wall at the back of the cage —
   * the brute is meant to step out of it, not to stand there. Refusing produced
   * a cage that swung open ten times and released nobody.
   *
   * The release-path search only knows about cage doors, so when it finds
   * nothing and the point itself is solid, the way out is simply the nearest
   * clear ground.
   */
  if (!release && isPositionBlocked(navigation, placement, collisionRadius)) {
    // Reachable from where the hero is, so nobody is released into a pocket on
    // the wrong side of a wall.
    const hero = nearestPartyHeroPosition(session, placement);
    const clear = nearestClearPosition(navigation, placement, collisionRadius, {
      // Out of the wall towards the room, wherever the room happens to be.
      towards: hero,
      reachableFrom: hero,
    });
    if (!clear) {
      warn(`[${session.id}] generator ${placement.id} has no clear ground to release onto`);
      return null;
    }
    return { position: clear, ignoredColliders: null };
  }

  const wave = nextGeneratorWave(runtime, Date.now());
  let releaseState = null;
  let spawnPosition = placement;
  if (release) {
    /**
     * A real cage wave is created at its authored generator point and walks
     * through the mouth. The official tutorial creates all six members within
     * sixteen units of (4080,3690), at the authored 100ms cadence. Pre-placing
     * later members in a column outside the cage made that look like direct
     * spawning and erased the authored release animation.
     *
     * It is safe now because release movement owns the enclosing cage collider,
     * crowd separation shares the movement budget, and a stalled release still
     * has its bounded fallback. Static geometry is checked separately below.
     */
    releaseState = { ...release, startsAt: Date.now() };
  }

  /**
   * Whatever was chosen, it has to be somewhere the actor can stand.
   *
   * A spawn placed against geometry is not stuck in the sense of a broken plan —
   * its AI runs, it faces you, it swings when you are close — it simply cannot
   * walk out of the wall it is in. That is the one left behind at the edge of a
   * room fighting from where it was put.
   */
  if (isPositionBlocked(navigation, spawnPosition, collisionRadius, releaseState ?? undefined)) {
    const clear = nearestClearPosition(navigation, spawnPosition, collisionRadius, {
      towards: hero,
      reachableFrom: hero,
    });
    if (clear) {
      spawnPosition = clear;
      // This is the deliberate direct-spawn fallback: static geometry, not the
      // cage door, made the authored origin unusable.
      releaseState = null;
    }
  }
  return {
    position: spawnPosition,
    release: releaseState,
    wave,
  };
};

export const generatorCadenceFor = (placement) => ({
  intervalMs: Number.isFinite(placement?.spawnInterval)
    ? Math.max(0, Math.round(placement.spawnInterval * 1000))
    : 1000,
  maxPopulation: Math.max(1, Number(placement?.maxPopulation ?? 1)),
  maxSpawns: Math.max(
    1,
    Number.isFinite(placement?.maxSpawns)
      ? Number(placement.maxSpawns)
      : Number(placement?.maxPopulation ?? 1)
  ),
});

export const completeGenerator = (session, runtime) => {
  /**
   * A generator that has been switched off owes nothing more.
   *
   * Clearing used to require the full quota to have been attempted, which was
   * true until generators learned to stop when their input went low. After
   * that, one switched off part way through could never report itself clear —
   * and a gate waiting on that report never opened, however many of its
   * monsters were killed.
   */
  const owesMore = !runtime.stopped && runtime.attemptedSpawns < runtime.maxSpawns;
  if (runtime.completed || owesMore || runtime.alive > 0) {
    return;
  }

  runtime.completed = true;
  if (runtime.placement.clearsOnAllDead) emitSignal(session, runtime.placement.id, true);
  info(`[${session.id}] generator ${runtime.placement.id} cleared`);
  checkFloorCleared(session);
};

const spawnGeneratorWave = async (context, runtime) => {
  const { session } = context;
  const { placement, maxSpawns } = runtime;
  const { intervalMs, maxPopulation } = generatorCadenceFor(placement);

  const firstAttempt = runtime.attemptedSpawns;
  /**
   * The door (createPackDoor): a pack of `maxPopulation` on the input, the
   * next pack on a death. Kept on the runtime so `onDeath` can knock.
   */
  const door = createPackDoor({ maxPopulation, maxSpawns: maxSpawns - firstAttempt });
  runtime.door = door;
  while (!door.exhausted && runtime.attemptedSpawns < maxSpawns) {
    if (!door.open) {
      await generatorWaitForDeath(runtime);
      if (!context.isActive() || runtime.stopped) break;
      continue;
    }
    if (runtime.attemptedSpawns > firstAttempt && intervalMs > 0) {
      await generatorSleep(runtime, intervalMs);
    }
    if (!context.isActive() || runtime.stopped) break;

    /**
     * The door is held open while this one comes out, not pulsed.
     *
     * The window is a constant, not the generator's spawnInterval. Captures of
     * both floors say so: 5.41 seconds on floor one, 5.42, 5.08 and 5.07 on the
     * boss floor — while their intervals are 0.1 and 5 respectively. Tying it to
     * the interval gave floor one a hundred-millisecond door, which is the
     * "closes instantly" that left its jails full.
     */
    const doid = await spawnNpc(
      context,
      placement.spawnConstant,
      placement,
      placement.scale,
      {
        returnDoid: true,
        engaged: true,
        fromGenerator: true,
        resolveSpawn: (npc) => generatorSpawn(session, runtime, npc),
        onDeath: (deadDoid) => {
          runtime.alive = Math.max(0, runtime.alive - 1);
          // A death is the next pack's signal, when the door is shut.
          if (runtime.door?.died()) runtime.wakeDeath?.();
          // Breaking the chest is what pays the node out; the chest's own row
          // is blank on purpose.
          if (session.rewardGenerators?.has(placement.id)) {
            spawnBossReward(session, {
              floorDoid: session.floorDoid,
              origin: session.actors.get(deadDoid)?.position ?? placement,
              node: session.mapPage,
              random: session.random ?? Math.random,
            });
          }
        },
        /**
         * Cleared when the spawn is *gone*, not when it dies.
         *
         * A chest spends six seconds throwing its contents across the room
         * after it breaks, and the floor's whole ending hangs off this signal:
         * the recorded run puts COLLECT_TREASURE_GO 6.35s after the break —
         * which is `LOOT_SPAWN_A1` running out — and then the floor's own
         * gates three and seven seconds after that. Clearing on the death
         * started the chain underneath the shower it is meant to follow.
         *
         * Anything with nothing to play is taken away in the same breath as it
         * dies, so this is no slower for the generators that hold monsters.
         */
        onGone: () => completeGenerator(session, runtime),
      }
    );
    runtime.attemptedSpawns++;
    door.spawned();
    if (doid) {
      runtime.alive++;
      runtime.spawnedDoids.add(doid);

      /**
       * A release event for each one that comes out.
       *
       * Ordinary generators are pulse sources. An all-spawns-dead generator is
       * different: its persistent signal means "the wave is clear", so this
       * release only reaches a directly wired RESET_TIMER cage latch. Its AND
       * and NOT kill-gate branches remain low until completeGenerator publishes
       * the one real completion edge.
       */
      emitGeneratorRelease(session, placement);
    }
  }

  completeGenerator(session, runtime);
  info(
    `[${session.id}] generator ${placement.id} spawned ` +
      `${runtime.spawnedDoids.size}/${maxSpawns} ${placement.spawnConstant}`
  );
};

/** Registers authored waves and starts each one only when its input goes high. */
export const buildGenerators = async (context, placements) => {
  const { session } = context;
  session.generators = new Map();
  let built = 0;

  for (const placement of placements) {
    if (!context.isActive()) break;
    const { maxSpawns } = generatorCadenceFor(placement);
    const runtime = {
      placement,
      maxSpawns,
      attemptedSpawns: 0,
      alive: 0,
      started: false,
      completed: false,
      spawnedDoids: new Set(),
      spawnPromise: null,
      cancelWait: null,
    };
    session.generators.set(placement.id, runtime);

    const start = () => {
      if (!context.isActive() || runtime.spawnPromise) return runtime.spawnPromise;
      if (runtime.attemptedSpawns >= runtime.maxSpawns) return runtime.spawnPromise;
      runtime.stopped = false;
      runtime.completed = false;
      runtime.started = true;

      /**
       * Announce the first release before the asynchronous wave begins. A cage
       * behind RESET_TIMER opens for it immediately; an all-spawns-dead AND/NOT
       * branch deliberately does not, because spawning is not clearing.
       *
       * Ordinary reward generators remain pulse sources. The chest appearing
       * starts their closing countdown; the special all-dead type waits for its
       * own completion like its name says.
       */
      emitGeneratorRelease(session, placement);
      runtime.spawnPromise = spawnGeneratorWave(context, runtime).finally(() => {
        runtime.spawnPromise = null;
      });
      return runtime.spawnPromise;
    };

    /**
     * A generator runs while its input is high and stops when it drops. The
     * boss jails are fed by the trigger that means "the minotaur is alive", so
     * killing him has to close them — otherwise they keep sending brutes for
     * the rest of the floor.
     */
    session.generatorStops ??= new Map();
    session.generatorStops.set(placement.id, () => {
      if (runtime.stopped) return;
      runtime.stopped = true;
      runtime.cancelWait?.();
      runtime.cancelWait = null;
      runtime.wakeDeath = null;
      info(`[${session.id}] generator ${placement.id} stopped — input went low`);
    });
    session.generatorHandlers.set(placement.id, start);

    // Generators with no authored input are ordinary ambient waves.
    if (!(session.signalIncoming.get(placement.id)?.length)) start();
    /**
     * A generator whose input is already high at build time has to be started
     * here, because nothing will change afterwards to start it. The tutorial's
     * boss jails are exactly that: their brutes hang off an NPC_LIFE_TRIGGER
     * that rests on while the minotaur lives, so waiting for an edge means the
     * cages never open and the two of them never appear.
     */
    else if (initialTargetState(session, placement.id)) start();
    built++;
  }
  return built;
};

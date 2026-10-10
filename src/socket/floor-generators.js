import { emitGeneratorRelease, emitSignal, initialTargetState } from "./triggers.js";
import { checkFloorCleared } from "./floorstate.js";
import { findCageReleasePath, isPositionBlocked, nearestClearPosition } from "./navigation.js";
import { info, warn } from "../log.js";
import { spawnBossReward } from "./drops.js";
import { spawnNpc } from "./npc-spawn.js";

/**
 * Generators: the doors and spawners that release monsters in waves or packs
 * — the population door, the generator's clock, the next wave's draw, and
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
 * A generator's door: up to `maxPopulation` of its spawns standing at once, and
 * `maxSpawns` in all.
 *
 * Measured over every official capture in the recorded corpus (532 generator
 * mouths, 2681 spawns, authored floors and generated ones alike): none ever
 * stood more than its maxPopulation, and every one that refilled did so one
 * for one. The input releases a whole pack — the population — at the
 * generator's clock (generatorCadenceFor); each death makes room for one more.
 * The Battleheim boss's imp cave (socket-20261005-165901, population 10): ten
 * out in 0.75s; five die together and five come back; four, and four.
 *
 * For a while this was a pack door instead — the first death after a pack
 * reopening a whole new one — read off that same capture. Killed one at a
 * time, it stood six knights in a jail of two, nineteen imps in a cave of ten,
 * and spent its quota early: the jail stood empty for the rest of the wave.
 *
 * A pack that comes out all at once is this rule, not another: 763 of the
 * game's 904 generators (each id once, the test levels left out) author
 * maxSpawns no greater than maxPopulation, and pour everything out on their
 * input. `standing` is who of an earlier wave
 * still stands, for a generator its input switches on again.
 */
export const createPopulationDoor = ({ maxPopulation, maxSpawns, standing: already = 0 }) => {
  const most = Math.max(1, Number(maxPopulation) || 1);
  const total = Math.max(1, Number(maxSpawns) || 1);
  let spawned = 0;
  let standing = Math.max(0, Number(already) || 0);
  return {
    get open() {
      return standing < most && spawned < total;
    },
    get exhausted() {
      return spawned >= total;
    },
    get standing() {
      return standing;
    },
    /** One attempted; `stood` false for a spawn that never made it, which takes quota and no place. */
    spawned(stood = true) {
      spawned++;
      if (stood) standing++;
    },
    /** One dead: its place is free; true while there is more to give. */
    died() {
      standing = Math.max(0, standing - 1);
      return spawned < total;
    },
  };
};

/**
 * The official's clock beats about every 80ms: spawns of one generator with
 * no authored interval at all come out 80ms apart at the median (p10 70, p90
 * 100), over every official capture.
 */
export const GENERATOR_TICK_MS = 80;

/**
 * How long until the generator's clock next beats: `periodMs` after the last
 * one out, and every period after that. The official's 1 and 2 second
 * generators refill 0.3 to 2.2 seconds after a death — on their clock, not a
 * whole period after it (one 2s generator refilled 0.38s after a death, 1.98s
 * after its last). Longer clocks (3, 4, 5s) were never seen refilling; they are
 * taken to run the same way. A clock that has stepped backwards waits one
 * period rather than however far it stepped.
 */
export const generatorBeatWait = (lastAt, now, periodMs) => {
  if (!(periodMs > 0) || lastAt == null) return 0;
  const elapsed = now - lastAt;
  if (elapsed < 0) return periodMs;
  if (elapsed < periodMs) return periodMs - elapsed;
  return (periodMs - (elapsed % periodMs)) % periodMs;
};

/**
 * How long a refill waits once a death has made room: the death is seen on one
 * tick, and the generator acts on a beat after that. The official arena's
 * refills come 92 / 134 / 212ms (p10 / median / p90) after the death's own
 * frame — both frames the server's, so no link in it (socket-20261007-163805).
 */
export const generatorRefillWait = (lastAt, now, periodMs) =>
  GENERATOR_TICK_MS + generatorBeatWait(lastAt, now + GENERATOR_TICK_MS, periodMs);

/** Nearby spawns are one burst; a five-second jail spawn is intentionally not. */
const WAVE_JOIN_WINDOW_MS = 500;

/** A burst keeps its compact separation only through its initial approach. */
const WAVE_COORDINATION_MS = 8000;

/**
 * Builds a dungeon for a player: the objects the client expects the server to
 * own.
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
     * sixteen units of (4080,3690), a tick apart (its authored 0.1s is one).
     * Pre-placing
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

/**
 * A generator's clock (`periodMs`): its `spawnInterval` in whole seconds and
 * more, a tick under one. Over every official capture, the first packs of
 * generators authored 0, 0.1, 0.2, 0.3, 0.4, 0.5 and 0.6 all come out 80ms
 * apart at the median (1724 gaps); 1 and 2 at 1000 and 2000; the arena's
 * lions, authored 4, 4.08s apart. Taken at its word, a pack of eight at 0.3
 * took 2.1s here against 0.6s there: the pour of a cave became a trickle. An
 * interval the editor wrote as 0.9999999999999992 is a second.
 */
export const generatorCadenceFor = (placement) => ({
  periodMs: (() => {
    const interval = Number.isFinite(placement?.spawnInterval) ? placement.spawnInterval : 1;
    return interval >= 1 - 1e-6 ? Math.round(interval * 1000) : GENERATOR_TICK_MS;
  })(),
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
  const { periodMs, maxPopulation } = generatorCadenceFor(placement);

  const firstAttempt = runtime.attemptedSpawns;
  /**
   * The door (createPopulationDoor): up to `maxPopulation` standing, one more
   * for each death. Kept on the runtime so `onDeath` can knock; it starts from
   * whoever of an earlier wave still stands.
   */
  const door = createPopulationDoor({ maxPopulation, maxSpawns: maxSpawns - firstAttempt, standing: runtime.alive });
  runtime.door = door;
  /** When the last one came out: the generator's clock beats from there (generatorBeatWait). */
  let lastOutAt = null;
  /** Whether the door last opened on a death: a refill, which waits for the tick after it. */
  let refilling = false;
  while (!door.exhausted && runtime.attemptedSpawns < maxSpawns) {
    if (!door.open) {
      await generatorWaitForDeath(runtime);
      if (!context.isActive() || runtime.stopped) break;
      refilling = true;
      continue;
    }
    const wait = refilling ? generatorRefillWait(lastOutAt, Date.now(), periodMs) : generatorBeatWait(lastOutAt, Date.now(), periodMs);
    refilling = false;
    await generatorSleep(runtime, wait);
    if (!context.isActive() || runtime.stopped) break;
    lastOutAt = Date.now();

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
          // A death makes room for one more, on the generator's next beat.
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
    door.spawned(Boolean(doid));
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

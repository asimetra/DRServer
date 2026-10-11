/**
 * One deterministic run of the monster AI, written down tick by tick.
 *
 * The floor is the real one — laid out or loaded by the root's own
 * `floors.js`, populated by its own `buildFloorWorld`, with its traps on their
 * own timers — and the loop is the server's: `tickNpcAi` every 250 ms of a
 * clock the harness moves itself. The hero is scripted, because a player is
 * the one input the server does not own. What comes out of a tick is hashed:
 * every NPC's position, heading, state, hit points, engagement and target,
 * every frame sent, and how many randoms were drawn. Two roots that hash alike
 * on every tick of every run did the same thing; the first tick they do not
 * is where they parted.
 *
 * The worker side of `tools/ai-sim.js`: this is what runs inside the process
 * that holds one root. The orchestration — two roots, several workers, the
 * comparison — is the tool's.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createCensus } from "./ai-sim-census.js";
import { importFrom, installVirtualClock, realNow, seededRandom, seedFor } from "./equivalence-lib.js";

/** The nine tile libraries a run can be laid out from. */
export const LIBRARIES = [
  "castle/arena",
  "castle/catacombs",
  "castle/prison",
  "jungle/aztec",
  "jungle/dino",
  "jungle/tribal",
  "nordic/caves",
  "nordic/temple",
  "nordic/village",
];

/**
 * The map node a library is run on when none is named. A floor's role
 * markers — FODDER, BRUISER, MINIBOSS — resolve through the node's tier
 * (gamemaster.js, resolveSpawnConstant), so the node decides which monsters
 * stand on the tiles. test/helpers/floor.js uses 50002 for everything, which
 * fills every library with castle tier-one knights and a brute; a matrix
 * built that way never placed a yeti, a skeleton archer or a savage bow, and
 * had no kiter in it at all. Each library's first node of its own theme
 * places the theme's monsters, and the prison's 2-1 the halberd knight the
 * scenario floors are about.
 */
const THEME_NODES = {
  "castle/arena": 50003,
  "castle/catacombs": 50010,
  "castle/prison": 50070,
  "jungle/aztec": 50057,
  "jungle/dino": 50036,
  "jungle/tribal": 50015,
  "nordic/caves": 50008,
  "nordic/temple": 50044,
  "nordic/village": 50033,
};

export const HERO_SCRIPTS = ["loadsim", "walls", "walker", "brawler", "still", "script"];

/**
 * Worlds the library matrix does not reach, each a library floor (or an
 * authored one) with something added to it.
 *
 * The libraries on their theme nodes place chasers and kiters and nothing
 * else: counted over the whole --full matrix, not one tick ran a pet, a
 * teleporting specter, a stationary boss, a wild beast, an ally, a cage
 * release, a summon, a shove, a stagger or a stun. Each of those is a branch
 * of the loop a refactor can break without the digest noticing, so each is
 * put on a floor here:
 *
 *   pet          the hero's equipped pet, built by the floor as a player's is
 *                (`session.petSpawn`): DRAGON_PET is the ranged one that backs
 *                out to its fireball's MinRange, SHADOW_WOLF_PET a pet that
 *                teleports, WOLF_PET one the monsters may pick over the hero;
 *   cast         monsters spawned through the root's own `spawnNpc` on clear
 *                ground in a ring round the hero's spawn — specters, which
 *                teleport, and SHADOW_SPECTER, whose skeletons are summons;
 *                LION_WILD and RAPTOR_WILD, beasts that fight everyone; the
 *                battle chef, an ally that fights the monsters;
 *   wake         BOSS_GOLEM is built asleep (`nextAttackAt` infinite) until
 *                its arena's intro timeline wakes it, which a ring on a
 *                library floor has none of: the scenario wakes it instead;
 *   generators   every generator on the floor is started at the build, as
 *                its trigger would, so the tutorial's cages let their
 *                prisoners out through the release walk.
 *
 * `brawler` is the hero for the overrides: it walks and hits as `loadsim`
 * does, and every two seconds does one more thing to the monster it hits —
 * stuns it, shoves it, staggers it, slows it, in turn.
 */
export const SCENARIOS = {
  "pet-dragon": { library: "castle/catacombs", pet: "DRAGON_PET" },
  "pet-shadow-wolf": { library: "nordic/caves", pet: "SHADOW_WOLF_PET" },
  specters: {
    library: "castle/prison",
    cast: ["PURPLE_SPECTER", "PURPLE_SPECTER", "RED_SPECTER", "SHADOW_SPECTER"],
  },
  wild: { library: "jungle/dino", pet: "WOLF_PET", cast: ["LION_WILD", "RAPTOR_WILD", "RIVAL_BATTLE_CHEF"] },
  golem: { library: "castle/arena", cast: ["BOSS_GOLEM"], wake: true },
  cages: { floor: "tutorial", generators: true },
};

/** The heroes a scenario runs with: one that leaves monsters alive, one that keeps to the floor, the brawler. */
export const SCENARIO_HEROES = ["walker", "walls", "brawler"];

/** The server's own AI cadence. */
export const TICK_MS = 250;

/**
 * The scripted hero, in the load simulator's terms (tools/load-sim.js): about
 * 180 units a second at the nearest monster, stopping short of it, and a hit
 * once a second when within reach. `walls` keeps the same hero on the floor
 * through `moveWithNavigation`, which is how a player ends up somewhere a
 * monster cannot follow; `loadsim` walks through walls as the simulator does.
 * `walker` is `loadsim` without the hits: a monster it reaches stays alive,
 * which is the only way a kiter gets to spend its back-offs — the first
 * matrix ran 216,000 ticks of the other two without once reaching the
 * back-off's timer.
 */
const HERO_STEP = 45;
const HERO_STOP = 70;
const HERO_REACH = 160;
const HERO_HIT_EVERY = 4;
const HERO_HIT_DAMAGE = 25;
const HERO_RADIUS = 26;
/** Never downed: a run is about the monsters, not about the revive screen. */
const HERO_HIT_POINTS = 60000;
/** The brawler's extra blow: every this many ticks, the next of these on its victim. */
const BRAWL_EVERY = 8;
const BRAWLS = ["stun", "shove", "stagger", "slow"];
/** A shove the size and duration of a strong knockback (impact.js). */
const BRAWL_SHOVE = { distance: 150, durationMs: 400 };
/** How far round the hero's spawn a scenario's cast is put. */
const CAST_RING = 350;
const PET_LEVEL = 10;

const FLOOR_DOID = 1002;
const HERO_DOID = 1003;
const DEFAULT_MAP_NODE = 50002;

/** The modules a run needs, from one root. */
export const loadRoot = async (root) => {
  const [gamemaster, floors, navigation, dungeon, opcodes, ai, combat, npcSpawn, buffs, impact, hitPricing] =
    await Promise.all([
      importFrom(root, "src/gamemaster.js"),
      importFrom(root, "src/socket/floors.js"),
      importFrom(root, "src/socket/navigation.js"),
      importFrom(root, "src/socket/dungeon.js"),
      importFrom(root, "src/socket/opcodes.js"),
      importFrom(root, "src/socket/ai.js"),
      importFrom(root, "src/socket/combat.js"),
      importFrom(root, "src/socket/npc-spawn.js"),
      importFrom(root, "src/socket/buffs.js"),
      importFrom(root, "src/socket/impact.js"),
      importFrom(root, "src/socket/hit-pricing.js"),
    ]);
  await navigation.loadNavigationLibrary();
  await gamemaster.loadGameMaster();
  return { root, gamemaster, floors, navigation, dungeon, opcodes, ai, combat, npcSpawn, buffs, impact, hitPricing };
};

/**
 * The floors a run spec names. A library or an authored file is one floor; a
 * map node is every floor of the node's plan, laid out from the run's seed,
 * which is how the scenario floors are reached through their catalogue.
 */
const floorsOf = async (modules, spec) => {
  const { floors } = modules;
  if (spec.library) {
    const floor = await floors.buildFloor(`Resources/Levels/${spec.library}/tiles.json`, {
      tier: spec.tier ?? 10,
      tileCount: spec.tileCount ?? 24,
      seed: spec.seed,
    });
    const mapNodeId = spec.node ?? THEME_NODES[spec.library] ?? DEFAULT_MAP_NODE;
    return [{ floor, plan: { floors: [{ authored: spec.library }], tier: null, npcLevel: 1 }, index: 0, mapNodeId }];
  }
  if (spec.floor) {
    const floor = await floors.loadFloor(spec.floor);
    return [{ floor, plan: { floors: [{ authored: spec.floor }], tier: null, npcLevel: 1 }, index: 0, mapNodeId: spec.node ?? DEFAULT_MAP_NODE }];
  }
  const plan = await floors.floorPlanForMapNode(spec.node, { seed: spec.seed });
  if (!plan) throw new Error(`map node ${spec.node} is not in the game data`);
  const result = [];
  for (let index = 0; index < plan.floors.length; index++) {
    result.push({ floor: await floors.loadFloorAt(plan, index), plan, index, mapNodeId: spec.node });
  }
  return result;
};

/**
 * A session the way test/helpers/floor.js makes one, built with the root's
 * own modules so a base that spawns differently spawns differently here.
 */
const buildWorld = async (modules, { floor, plan, index, mapNodeId }, id, scenario = null) => {
  const { CLID } = modules.opcodes;
  const sent = [];
  const session = {
    id,
    dungeonActive: true,
    dungeonEpoch: 1,
    mapNodeId,
    heroDoid: HERO_DOID,
    floorDoid: FLOOR_DOID,
    floorIndex: index,
    floorCount: plan.floors.length,
    npcLevel: plan.npcLevel ?? 1,
    floorPlan: plan,
    heroPosition: { x: floor.spawn?.x ?? 0, y: floor.spawn?.y ?? 0 },
    heroSpawn: {
      doid: HERO_DOID,
      heroType: 101,
      skinType: 151,
      playerId: 1,
      screenName: "Sim",
      experiencePoints: 0,
      slotPoints: [0, 0, 0, 0],
      weapons: [],
      consumables: [],
      hitPoints: HERO_HIT_POINTS,
      manaPoints: 100,
      effectiveHitPoints: HERO_HIT_POINTS,
      collisionRadius: 22,
      constant: "RANGER",
    },
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    dungeonBusterPoints: 0,
    objects: new Map([[FLOOR_DOID, CLID.DistributedDungeonFloor]]),
    actors: new Map(),
    allocateDoid: (() => {
      let next = 1100;
      return (clid) => {
        const doid = next++;
        session.objects.set(doid, clid);
        return doid;
      };
    })(),
    send: (frame) => sent.push(frame),
    ...(scenario?.pet
      ? { petSpawn: { constant: scenario.pet, level: PET_LEVEL, ownerHeroDoid: HERO_DOID } }
      : {}),
  };
  await modules.dungeon.buildFloorWorld(session, { floor, floorDoid: FLOOR_DOID, isActive: () => true });
  if (scenario) await stageScenario(modules, session, scenario);
  /**
   * The AI loop is driven from here, a tick at a time; the player-side
   * timers are a connection's, not the floor's, and a scripted hero has no
   * connection to go idle on.
   */
  session.stopAi?.();
  session.stopAi = null;
  session.stopAfkWatch?.();
  session.stopAfkWatch = null;
  session.stopManaRegen?.();
  session.stopManaRegen = null;
  return { session, built: sent };
};

/**
 * What a scenario adds once the floor is built: its cast on clear ground in a
 * ring round the hero's spawn, the golem woken, the generators started.
 */
const stageScenario = async (modules, session, scenario) => {
  const spawn = session.heroPosition;
  const context = {
    session,
    floorDoid: FLOOR_DOID,
    heroDoid: HERO_DOID,
    mapNodeId: session.mapNodeId,
    gm: await modules.gamemaster.loadGameMaster(),
    isActive: () => true,
  };
  const cast = scenario.cast ?? [];
  for (const [index, constant] of cast.entries()) {
    const angle = (index / cast.length) * Math.PI * 2;
    const desired = { x: spawn.x + Math.cos(angle) * CAST_RING, y: spawn.y + Math.sin(angle) * CAST_RING };
    const at =
      modules.navigation.nearestClearPosition(session.navigation, desired, 40, { reach: CAST_RING, towards: spawn }) ??
      desired;
    const doid = await modules.npcSpawn.spawnNpc(context, constant, at, undefined, { returnDoid: true });
    if (!doid) throw new Error(`scenario: ${constant} was not spawned`);
    // Its arena's intro timeline is what wakes a stationary boss; a ring has none.
    const ai = session.actors.get(doid)?.ai;
    if (scenario.wake && ai) ai.nextAttackAt = 0;
  }
  if (scenario.generators) {
    for (const start of session.generatorHandlers?.values() ?? []) start();
  }
};

/**
 * The brawler's extra blow on its victim, the next in `BRAWLS`: through the
 * root's own buffs, `pushVictim` and `holdStaggered`, as a hero's hit would.
 */
const brawl = async (modules, session, target, tick) => {
  const kind = BRAWLS[Math.floor(tick / BRAWL_EVERY) % BRAWLS.length];
  if (kind === "stun" || kind === "slow") {
    await modules.buffs.grantBuff(session, kind === "stun" ? "STUN_L4" : "SLOW_L1", {
      affectedActor: target,
      attackerActor: HERO_DOID,
    });
  } else if (kind === "shove") {
    modules.impact.pushVictim(session, target, HERO_DOID, BRAWL_SHOVE.distance, BRAWL_SHOVE.durationMs);
  } else {
    modules.hitPricing.holdStaggered(session, target, { HitStunDur: 1 });
  }
};

/** The header of a frame: enough to say which update it was. */
const describeFrame = (frame) => {
  if (frame.length < 4) return `op? len${frame.length}`;
  const op = frame.readUInt16LE(2);
  if ((op === 134 || op === 135) && frame.length >= 18) {
    return `generate clid${frame.readUInt16LE(12)} doid${frame.readUInt32LE(14)}`;
  }
  if (op === 124 && frame.length >= 10) return `field doid${frame.readUInt32LE(4)} f${frame.readUInt16LE(8)} len${frame.length}`;
  if ((op === 125 || op === 126) && frame.length >= 8) return `disable doid${frame.readUInt32LE(4)}`;
  return `op${op} len${frame.length}`;
};

const nearestEnemy = (session, from) => {
  let nearest = null;
  let distance = Infinity;
  for (const [doid, actor] of session.actors) {
    if (!actor.isEnemy || actor.dead || !(actor.hitPoints > 0) || !actor.position) continue;
    const d = Math.hypot(actor.position.x - from.x, actor.position.y - from.y);
    if (d < distance) {
      distance = d;
      nearest = doid;
    }
  }
  return { doid: nearest, distance };
};

/**
 * Where the hero goes this tick and whether he swings. A script file names
 * waypoints: `{ "waypoints": [{ "at": 0, "x": 1350, "y": 630, "hit": true }] }`,
 * each taken up at its tick and walked to at the hero's pace, through walls
 * unless the file says `"walls": true`.
 */
const heroStep = (modules, session, hero, kind, script, tick) => {
  const position = hero.position;
  let aim = null;
  let hits = false;
  let onFloor = kind === "walls";
  const { doid: target, distance } = nearestEnemy(session, position);
  if (kind === "loadsim" || kind === "walls" || kind === "walker" || kind === "brawler") {
    if (target !== null && distance > HERO_STOP) aim = session.actors.get(target).position;
    hits = kind !== "walker" && target !== null && distance <= HERO_REACH;
  } else if (kind === "script" && script) {
    const leg = script.waypoints.filter((point) => point.at <= tick).at(-1);
    if (leg) {
      aim = { x: leg.x, y: leg.y };
      hits = Boolean(leg.hit) && target !== null && distance <= HERO_REACH;
      onFloor = Boolean(script.walls);
    }
  }
  if (aim) {
    const dx = aim.x - position.x;
    const dy = aim.y - position.y;
    const length = Math.hypot(dx, dy);
    const stopAt = kind === "script" ? 0 : HERO_STOP;
    const step = Math.min(HERO_STEP, Math.max(0, length - stopAt));
    if (step > 0 && length > 0) {
      const wanted = { x: (dx / length) * step, y: (dy / length) * step };
      const next = onFloor
        ? modules.navigation.moveWithNavigation(session.navigation, position, wanted, HERO_RADIUS)
        : { x: position.x + wanted.x, y: position.y + wanted.y };
      position.x = next.x;
      position.y = next.y;
    }
  }
  session.heroPosition.x = position.x;
  session.heroPosition.y = position.y;
  if (hits && tick % HERO_HIT_EVERY === HERO_HIT_EVERY - 1) {
    modules.combat.applyDamage(session, target, HERO_HIT_DAMAGE);
  }
  return kind === "brawler" && hits && tick % BRAWL_EVERY === BRAWL_EVERY - 1 ? target : null;
};

/** What a tick leaves behind, as lines; the hash is of these and the frames. */
const stateLines = (session) => {
  const lines = [];
  for (const [doid, actor] of [...session.actors].sort((a, b) => a[0] - b[0])) {
    if (!actor.ai || !actor.position) continue;
    const ai = actor.ai;
    lines.push(
      `${doid} ${actor.constant ?? "?"} ${actor.position.x.toFixed(3)},${actor.position.y.toFixed(3)} ` +
        `h${(actor.heading ?? 0).toFixed(3)} ${ai.state ?? "-"} hp${actor.hitPoints} ` +
        `${ai.engaged ? "engaged" : "idle"} tgt${ai.targetDoid ?? "-"}${actor.dead ? " dead" : ""}`
    );
  }
  return lines;
};

const digestOf = (lines, frames, counts) => {
  const hash = createHash("sha1");
  for (const line of lines) hash.update(line).update("\n");
  for (const frame of frames) hash.update(frame);
  hash.update(`${counts.join(",")}`);
  return hash.digest("hex").slice(0, 16);
};

/**
 * Runs one spec on one root and reports through `emit`, a line at a time:
 *
 *   R <run> <label>                      the run starts
 *   B <run> <hash> <frames> <actors>     what the build sent
 *   T <run> <tick> <hash> <frames> <random> <sessionRandom>
 *   D <run> <tick> <json>                the whole state, when asked for a tick
 *   S <run> <json>                       what its monsters did, counted, when the spec asks (`stats`)
 *   E <run> <ticks> <ms> <timerFailures> the run ends
 *
 * `detail` names ticks whose full state is wanted, for explaining a difference.
 */
export const runSpec = async (modules, spec, emit, { detail = new Set() } = {}) => {
  const script = spec.script ? JSON.parse(readFileSync(path.resolve(spec.script), "utf8")) : null;
  const clock = installVirtualClock();
  const realRandom = Math.random;
  try {
    const mathRandom = seededRandom(seedFor("math", spec.id));
    Math.random = mathRandom;
    const floors = await floorsOf(modules, spec);
    for (const entry of floors) {
      const run = floors.length > 1 ? `${spec.id}/f${entry.index + 1}` : spec.id;
      const started = realNow();
      const sessionRandom = seededRandom(seedFor("session", run));
      const { session, built } = await buildWorld(modules, entry, run, spec.scenario ? SCENARIOS[spec.scenario] : null);
      session.random = sessionRandom;
      emit(`R ${run} ${spec.label}`);
      emit(`B ${run} ${digestOf(stateLines(session), built, [built.length])} ${built.length} ${session.actors.size}`);
      const hero = session.actors.get(HERO_DOID);
      if (!hero) throw new Error(`${run}: the build put no hero on the floor`);
      const frames = [];
      session.send = (frame) => frames.push(frame);
      const census = spec.stats ? createCensus() : null;
      for (let tick = 0; tick < spec.ticks; tick++) {
        frames.length = 0;
        const randomBefore = mathRandom.calls;
        const sessionBefore = sessionRandom.calls;
        await clock.advance(clock.now + TICK_MS);
        hero.hitPoints = HERO_HIT_POINTS;
        hero.dead = false;
        const brawled = heroStep(modules, session, hero, spec.hero, script, tick);
        if (brawled !== null && session.actors.get(brawled)) await brawl(modules, session, brawled, tick);
        await modules.ai.tickNpcAi(session, clock.now, TICK_MS / 1000);
        await clock.flush();
        census?.tick(session, frames);
        const lines = stateLines(session);
        const counts = [mathRandom.calls - randomBefore, sessionRandom.calls - sessionBefore];
        emit(`T ${run} ${tick} ${digestOf(lines, frames, counts)} ${frames.length} ${counts[0]} ${counts[1]}`);
        if (detail.has(tick)) {
          const state = {
            hero: { x: hero.position.x, y: hero.position.y },
            frames: frames.map(describeFrame),
            random: counts,
            actors: lines,
          };
          emit(`D ${run} ${tick} ${JSON.stringify(state)}`);
        }
      }
      session.runScope?.dispose?.();
      if (census) emit(`S ${run} ${JSON.stringify(census.result())}`);
      emit(`E ${run} ${spec.ticks} ${realNow() - started} ${clock.failures}`);
    }
  } finally {
    Math.random = realRandom;
    clock.uninstall();
  }
};

/** The worker entry: every spec in the file, on the root, to stdout. */
export const runWorker = async ({ root, runsFile, detail }) => {
  const specs = JSON.parse(readFileSync(runsFile, "utf8"));
  const modules = await loadRoot(root);
  const wanted = new Set((detail ?? "").split(",").filter(Boolean).map(Number));
  const out = [];
  const emit = (line) => {
    out.push(line);
    if (out.length >= 512) {
      process.stdout.write(`${out.join("\n")}\n`);
      out.length = 0;
    }
  };
  for (const spec of specs) await runSpec(modules, spec, emit, { detail: wanted });
  if (out.length) process.stdout.write(`${out.join("\n")}\n`);
};

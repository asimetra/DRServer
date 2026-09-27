import test from "node:test";
import assert from "node:assert/strict";

import { attackForConstant } from "../src/gamemaster.js";
import {
  applyDamage,
  expireActor,
  killAllEnemies,
  performNpcAttack,
  placeableVictims,
} from "../src/socket/combat.js";
import { checkFloorCleared } from "../src/socket/floorstate.js";
import { clearBuffsOn } from "../src/socket/buffs.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";
import { scheduleSummons } from "../src/socket/summons.js";
import { HERO_DOID, buildFloor, readFrame, readNpc } from "./helpers/floor.js";

/**
 * What an enemy's attack calls onto the floor, against the official captures.
 *
 * The Ghost Samurai (node 50014, 2026-09-26) played Iron Legion 1.1s after he
 * appeared and three ENEMY_GHOST_SAMURAI_CLONE came up 2493, 2749 and 2917ms
 * later on his own x, level 13 and 568 hit points each. Papa Yeti (node 50009)
 * called eight babies and died 909ms in; six came. On this server neither boss
 * called anything, which is most of why both fights were easy.
 */

const CASTER = 20;

/** A floor with one caster on it, and a clock that runs when asked. */
const makeSession = ({ team = TEAM.ENEMIES, heading = -170.6, level = 13 } = {}) => {
  const timers = [];
  const sent = [];
  const session = {
    dungeonActive: true,
    floorDoid: 1,
    objects: new Map([[CASTER, CLID.DistributedNPCGameObject]]),
    actors: new Map([
      [CASTER, { position: { x: 4016, y: 3768 }, heading, level, team, hitPoints: 1990 }],
    ]),
    combatClock: {
      setTimeout: (run, delay) => {
        timers.push({ run, delay });
        return timers.length;
      },
    },
    send: (frame) => sent.push(frame),
  };
  const spawned = [];
  const spawn = async (constant, position, options) => {
    spawned.push({ constant, position, ...options });
    return 500 + spawned.length;
  };
  /** Runs every timer due by `until`, earliest first, including ones they add. */
  const runUntil = async (until) => {
    for (;;) {
      const due = timers
        .filter((timer) => !timer.ran && timer.delay <= until)
        .sort((a, b) => a.delay - b.delay)[0];
      if (!due) return;
      due.ran = true;
      await due.run();
    }
  };
  return { session, spawn, spawned, timers, runUntil, sent };
};

const cast = async (setup, attackName, playSpeed = 1) =>
  scheduleSummons(setup.session, {
    casterDoid: CASTER,
    attack: await attackForConstant(attackName),
    playSpeed,
    spawn: setup.spawn,
  });

test("Iron Legion calls three clones on its own frames, where the samurai stands", async () => {
  const setup = makeSession();
  assert.equal(await cast(setup, "EN_DBUSTER_IRON_LEGION"), 3);
  assert.deepEqual(
    setup.timers.map((timer) => Math.round(timer.delay)),
    [2417, 2667, 2833],
    "frames 58, 64 and 68 at 24fps; the official's arrived 2493, 2749 and 2917"
  );

  await setup.runUntil(3000);
  assert.deepEqual(
    setup.spawned.map(({ constant, position, level }) => [constant, position.x, position.y, level]),
    Array(3).fill(["ENEMY_GHOST_SAMURAI_CLONE", 4016, 3768, 13]),
    "its distance is spelled headingOffset, which the reading does not see — on the caster, as captured"
  );
});

test("the clock follows the cast's speed", async () => {
  const setup = makeSession();
  await cast(setup, "EN_DBUSTER_IRON_LEGION", 0.5);
  assert.deepEqual(setup.timers.map((timer) => Math.round(timer.delay)), [4833, 5333, 5667]);
});

test("each one is placed from where the caster is at its own frame", async () => {
  const setup = makeSession({ heading: 0 });
  await cast(setup, "EN_DBUSTER_IRON_LEGION");
  await setup.runUntil(2500);
  setup.session.actors.get(CASTER).position = { x: 4016, y: 3790 };
  await setup.runUntil(3000);
  assert.deepEqual(
    setup.spawned.map(({ position }) => position.y),
    [3768, 3790, 3790],
    "the official's clones followed the samurai as he was shoved along y"
  );
});

/**
 * The pairs are measured: the official's frame-15 and frame-20 babies each
 * shared one spot. The distance is the authored `offset` read the hero's way;
 * the one recorded yeti was backing off through his cast, so it does not pin
 * the distance down.
 */
test("Papa Yeti's babies come a pair to a frame, at his authored offset", async () => {
  const setup = makeSession({ heading: 0, level: 8 });
  assert.equal(await cast(setup, "EN_YETI_SPAWN_BABIES"), 8);
  await setup.runUntil(2000);
  assert.equal(setup.spawned.length, 8);
  for (const baby of setup.spawned) {
    assert.equal(baby.constant, "BABY_YETI");
    assert.equal(baby.level, 8);
    assert.equal(Math.round(baby.position.x), 4016 + 150);
    assert.equal(Math.round(baby.position.y), 3768);
  }
});

test("a caster that dies before a frame calls nothing on it", async () => {
  const setup = makeSession({ heading: 0, level: 8 });
  await cast(setup, "EN_YETI_SPAWN_BABIES");
  await setup.runUntil(900);
  setup.session.actors.get(CASTER).dead = true;
  await setup.runUntil(2000);
  assert.equal(setup.spawned.length, 6, "the official's yeti died 909ms in and six of eight came");
});

test("a floor that has moved on takes its pending summons with it", async () => {
  const setup = makeSession();
  await cast(setup, "EN_DBUSTER_IRON_LEGION");
  setup.session.floorDoid = 2;
  await setup.runUntil(3000);
  assert.equal(setup.spawned.length, 0);
});

test("a hero's side is placeables.js's, and nothing is called here for it", async () => {
  const setup = makeSession({ team: TEAM.PLAYERS });
  assert.equal(await cast(setup, "EN_DBUSTER_IRON_LEGION"), 0);
});


test("what an enemy leaves standing is not built by this", async () => {
  const setup = makeSession();
  assert.equal(await cast(setup, "EN_FIRE_DRAGON_LINE"), 0, "DRAGON_GROUND_FLAME does not walk");
});

test("timetolive ends one without paying for it", async () => {
  const setup = makeSession();
  let spawnedDoid = null;
  let paid = 0;
  let gone = 0;
  const { session } = setup;
  const spawn = async () => {
    spawnedDoid = 600;
    session.objects.set(spawnedDoid, CLID.DistributedNPCGameObject);
    session.actors.set(spawnedDoid, {
      hitPoints: 568,
      onDeath: () => (paid += 1),
      onGone: () => (gone += 1),
    });
    return spawnedDoid;
  };
  await scheduleSummons(session, {
    casterDoid: CASTER,
    attack: await attackForConstant("EN_SHAMAN_IMP_SPAWN"),
    spawn,
  });
  await setup.runUntil(1000);
  assert.equal(spawnedDoid, 600);
  await setup.runUntil(10_000 + 1000);

  const frames = setup.sent.map(readFrame);
  assert.deepEqual(
    frames.map((frame) => (frame.kind === "field" ? `field ${frame.field}` : frame.kind)),
    ["field 136", "field 138", "disable"],
    "hitPoints 0, state dead, disable — 43 of 43 official imps left alone"
  );
  assert.equal(frames[0].body.readUInt32LE(8), 0);
  assert.equal(paid, 0, "no death hook, so no experience and no gold");
  assert.equal(gone, 1);
  assert.equal(session.actors.has(600), false);
  assert.equal(expireActor(session, 600), false, "and it goes once");
});

test("an enemy's attack asks the floor for its summons", async () => {
  const calls = [];
  const setup = makeSession();
  const heroDoid = 10;
  setup.session.heroDoid = heroDoid;
  setup.session.objects.set(heroDoid, CLID.HeroGameObject);
  setup.session.actors.set(heroDoid, { hitPoints: 100, position: { x: 3900, y: 3768 } });
  setup.session.summon = (casterDoid, attack, playSpeed) =>
    calls.push([casterDoid, attack.Constant, playSpeed]);
  const attack = await attackForConstant("EN_DBUSTER_IRON_LEGION");
  await performNpcAttack(setup.session, CASTER, { attackType: attack.Id }, heroDoid);
  assert.deepEqual(calls, [[CASTER, "EN_DBUSTER_IRON_LEGION", 1]]);
});

/**
 * The whole path on the real boss floor: the floor's own `spawnNpc`, so the
 * clone is generated as the official's was — the enemies' side, the caster's
 * level, its health priced at that level, and already hunting.
 */
test("on the Dark Barrows boss floor the clones arrive as the official's did", async () => {
  const world = await buildFloor("castle/catacombs/db_floor_CATACOMBS_GHOST_SAMURAI_RIVAL_BATTLE.json", {
    npcLevel: 13,
  });
  const { session } = world;
  const wire = [];
  session.send = (frame) => wire.push(readFrame(frame));
  const pending = [];
  session.combatClock = { setTimeout: (run, delay) => pending.push({ run, delay }) };
  session.actors.set(CASTER, {
    position: { ...session.heroPosition },
    heading: 0,
    level: 13,
    team: TEAM.ENEMIES,
    hitPoints: 1990,
  });

  await session.summon(CASTER, await attackForConstant("EN_DBUSTER_IRON_LEGION"), 1);
  for (const { run } of pending.splice(0)) await run();
  const lifetimes = pending.map((timer) => timer.delay);

  const clones = wire
    .filter((frame) => frame.kind === "generate" && frame.clid === CLID.DistributedNPCGameObject)
    .map((frame) => ({ doid: frame.doid, ...readNpc(frame.body) }))
    .filter((npc) => world.gm.raw.Npc.find((row) => row.Id === npc.type)?.Constant === "ENEMY_GHOST_SAMURAI_CLONE");
  assert.equal(clones.length, 3);
  for (const clone of clones) {
    assert.equal(clone.team, TEAM.ENEMIES);
    assert.equal(clone.level, 13);
    assert.equal(clone.hitPoints, 568, "the official's clones read 568 at level 13");
    const actor = session.actors.get(clone.doid);
    assert.equal(actor.isEnemy, true, "an enemy: pets hunt it and the hero's bombs catch it");
    assert.equal(actor.holdsFloor, false, "but not the floor's stock, so it does not hold the floor");
    assert.equal(actor.ai?.engaged, true, "a clone swung 174ms after it appeared");
  }
  assert.deepEqual(lifetimes, [30_000, 30_000, 30_000], "timetolive 30");

  // Something of the hero's going off on top of one: the placeables' victims.
  const [first] = clones;
  const onClone = session.actors.get(first.doid).position;
  const blast = [{ type: "circle", x: onClone.x, y: onClone.y, radius: 40, frame: 0 }];
  assert.ok(
    placeableVictims(session, 9999, blast).some((victim) => victim.doid === first.doid),
    "a hero's bomb going off on a clone hits it"
  );

  // No stocked enemy left and three clones standing: the floor is not held.
  for (const actor of session.actors.values()) {
    if (actor.holdsFloor) actor.dead = true;
  }
  session.areaDoid = 77;
  session.generators = new Map();
  session.enemiesSeen = 1;
  assert.equal(checkFloorCleared(session), true, "the clones do not hold the floor open");

  assert.equal(killAllEnemies(session), 3, "FLOOR_KILL_ALL_NPCS takes the clones with the rest");
});

/**
 * A real floor with a clock that runs when asked. Everything placeables.js and
 * summons.js schedule goes on the floor's scope, so a fake scope is the whole
 * of the clock.
 */
const bossFloor = async () => {
  const world = await buildFloor("castle/catacombs/db_floor_CATACOMBS_GHOST_SAMURAI_RIVAL_BATTLE.json", {
    npcLevel: 13,
  });
  const { session } = world;
  const wire = [];
  session.send = (frame) => wire.push(readFrame(frame));
  const pending = [];
  let handle = 0;
  session.floorScope = {
    timeout: (run, delay) => (pending.push({ id: ++handle, run, delay }), handle),
    interval: (run, delay) => (pending.push({ id: ++handle, run, delay, every: true }), handle),
    cancel: (id) => {
      const at = pending.findIndex((timer) => timer.id === id);
      if (at >= 0) pending.splice(at, 1);
      return true;
    },
  };
  /** Runs one-shot timers due by `until` (and those they add); intervals once each. */
  const runUntil = async (until) => {
    const ranIntervals = new Set();
    for (;;) {
      const due = pending
        .filter((timer) => timer.delay <= until && !ranIntervals.has(timer.id))
        .sort((a, b) => a.delay - b.delay)[0];
      if (!due) return;
      if (due.every) ranIntervals.add(due.id);
      else pending.splice(pending.indexOf(due), 1);
      await due.run();
    }
  };
  const generated = (constant) =>
    wire
      .filter((frame) => frame.kind === "generate" && frame.clid === CLID.DistributedNPCGameObject)
      .map((frame) => ({ doid: frame.doid, ...readNpc(frame.body) }))
      .filter((npc) => world.gm.raw.Npc.find((row) => row.Id === npc.type)?.Constant === constant);
  const resultsOn = (doid) =>
    wire.filter((frame) => frame.kind === "field" && frame.doid === doid && [144, 160].includes(frame.field));
  return { world, session, wire, runUntil, generated, resultsOn };
};

const placeCaster = (session, position, constant) => {
  session.objects.set(CASTER, CLID.DistributedNPCGameObject);
  session.actors.set(CASTER, {
    position,
    heading: 0,
    level: 13,
    team: TEAM.ENEMIES,
    hitPoints: 5000,
    maxHitPoints: 5000,
    constant,
    isEnemy: true,
  });
};

/**
 * `IsAttackable 0` is nobody's target. Infinite's ice bomb is one: a death
 * spawn of the enemies' side, standing there to go off. Giving summons
 * `isEnemy` made it huntable along with them, until targeting asked the row.
 */
test("an Infinite ice bomb is not caught by a hero's bomb", async () => {
  const floor = await bossFloor();
  const { session, world } = floor;
  clearBuffsOn(session, HERO_DOID);
  const modifier = world.gm.raw.DungeonModifier.find((row) => row.Constant === "INFINITE_ICE_BOMBS");
  session.infiniteActiveModifiers = [{ ...modifier, NPCDeathSpawnChance: 1 }];
  session.random = () => 0;

  // A summoned baby, killed where it stands: its death spawns the bomb through
  // the floor's own spawn path.
  const hero = session.actors.get(HERO_DOID);
  placeCaster(session, { ...hero.position }, "PAPA_YETI");
  session.actors.get(CASTER).heading = 0;
  await session.summon(CASTER, await attackForConstant("EN_YETI_SPAWN_BABIES"), 1);
  await floor.runUntil(500);
  const [baby] = floor.generated("BABY_YETI");
  applyDamage(session, baby.doid, 1_000_000);
  // The death spawn is started, not awaited, by the death hook.
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));

  const [bomb] = floor.generated("ICE_BOMB");
  assert.ok(bomb, "the modifier's bomb is built");
  const actor = session.actors.get(bomb.doid);
  assert.equal(actor.attackable, false);
  const blast = [{ type: "circle", x: actor.position.x, y: actor.position.y, radius: 60 }];
  assert.equal(
    placeableVictims(session, 9999, blast).some((victim) => victim.doid === bomb.doid),
    false,
    "a hero's bomb going off on it does not catch it"
  );
});

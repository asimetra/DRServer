import assert from "node:assert/strict";
import test from "node:test";

import {
  attackForConstant,
  projectileForConstant,
  weaponForConstant,
} from "../src/gamemaster.js";
import { loadFloor } from "../src/socket/floors.js";
import { createNavigationState } from "../src/socket/navigation.js";
import { npcGenerate } from "../src/socket/objects.js";
import {
  npcAttackChoreography,
  performTrapAttack,
  tickTrapProjectiles,
} from "../src/socket/combat.js";
import {
  emitGeneratorRelease,
  emitSignal,
  initialTargetState,
  setTargets,
  trackTriggers,
  updateProximityTriggers,
} from "../src/socket/triggers.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

const readUpdateHead = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  const doid = reader.u32();
  const fieldId = reader.u16();
  return { reader, doid, fieldId };
};

/**
 * Trap damage is priced through the game master, so it lands a microtask later.
 * setImmediate is never mocked here, which makes it the drain.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A sustained trap tests contact on a 100ms tick and no longer fires on the
 * instant it rises — the official's earliest recorded hit is 60ms after the
 * switch-on and its commonest 100ms. Tests that raise one have to wait for it.
 */
const contactTick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 180));
  // The hit itself is priced through the game master, so let it land too.
  for (let drain = 0; drain < 4; drain += 1) await settle();
};

const readI32 = (reader) => {
  const value = reader.buf.readInt32LE(reader.pos);
  reader.pos += 4;
  return value;
};

test("tutorial arrow traps retain their authored wall transforms and cadence", async () => {
  const floor = await loadFloor("tutorial");
  const arrows = floor.placements.triggerable.filter((placement) =>
    placement.constant.startsWith("CASTLE_ARENA_TRAP_ARROW_")
  );

  assert.equal(arrows.length, 3);
  assert.deepEqual(
    arrows.map(({ constant, heading, scale, flip }) => ({
      constant,
      heading,
      scale,
      flip,
    })),
    [
      { constant: "CASTLE_ARENA_TRAP_ARROW_F", heading: 270, scale: undefined, flip: 0 },
      { constant: "CASTLE_ARENA_TRAP_ARROW_B", heading: 90, scale: 1.1, flip: 0 },
      { constant: "CASTLE_ARENA_TRAP_ARROW_B", heading: 90, scale: 1.1, flip: 0 },
    ]
  );

  const arrowIds = new Set(arrows.map((arrow) => arrow.id));
  const timers = floor.placements.trigger.filter((trigger) =>
    (floor.wiring.get(trigger.id) ?? []).some((target) => arrowIds.has(target))
  );
  assert.deepEqual(
    timers.map(({ constant, startDelay, intervalTime }) => ({
      constant,
      startDelay,
      intervalTime: Math.round(intervalTime * 10) / 10,
    })),
    [
      { constant: "AUTO_TIMER_TRIGGER", startDelay: 0.5, intervalTime: 0.7 },
      { constant: "AUTO_TIMER_TRIGGER", startDelay: 0.30000000000000016, intervalTime: 0.7 },
      { constant: "AUTO_TIMER_TRIGGER", startDelay: 0.8, intervalTime: 0.7 },
    ]
  );
});

test("NPC generate carries heading, scale, flip, and its native weapon", async () => {
  const weapon = await weaponForConstant("EN_TRAP_SHOOT_WEAPON");
  assert.ok(weapon);

  const frame = npcGenerate({
    doid: 9001,
    parent: 8001,
    npcType: 2000502,
    masterId: 7001,
    position: { x: 5205, y: 3690 },
    heading: 90,
    scale: 1.1,
    flip: 1,
    hitPoints: 0,
    team: TEAM.ENVIRONMENT,
    triggerState: 0,
    weapons: [{ type: weapon.Id, power: weapon.Power, requiredlevel: 1, rarity: 1 }],
  });
  const reader = new PacketReader(frame.subarray(2));

  assert.equal(reader.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(reader.u32(), 8001);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u16(), CLID.DistributedNPCGameObject);
  assert.equal(reader.u32(), 9001);
  assert.equal(reader.u32(), 2000502);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.f32(), 5205);
  assert.equal(reader.f32(), 3690);
  assert.equal(reader.f32(), 90);
  assert.ok(Math.abs(reader.f32() - 1.1) < 1e-6);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.u32(), 0);

  assert.equal(reader.u32(), 27045);
  assert.equal(reader.u16(), 1);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.u8(), 1);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u32(), 0);

  // Three remaining fixed-length WeaponDetails entries.
  reader.pos += 3 * 20;
  assert.equal(reader.utf(), "");
  assert.equal(reader.u8(), TEAM.ENVIRONMENT);
  assert.equal(reader.u8(), 20);
  assert.equal(reader.u8(), 0);
  assert.equal(reader.u32(), 7001);
  assert.equal(reader.eof(), true);
});

test("arrow trap activation attacks without toggling its renderer", async () => {
  const attack = await attackForConstant("TRAP_ARROWS");
  const projectile = await projectileForConstant(attack?.Projectile);
  assert.ok(attack);

  const sent = [];
  const session = {
    triggerableDoids: new Map([["arrow", 9001]]),
    triggerableAttacks: new Map([["arrow", attack.Id]]),
    triggerableStatefulAttacks: new Set(),
    triggerableHazards: new Map([
      ["arrow", { attack, projectile, position: { x: 0, y: 0, heading: 90 } }],
    ]),
    send: (frame) => sent.push(frame),
  };

  setTargets(session, { targets: ["arrow"] }, true);
  assert.equal(sent.length, 1);

  const choreography = readUpdateHead(sent[0]);
  assert.equal(choreography.doid, 9001);
  assert.equal(choreography.fieldId, 143);
  assert.equal(choreography.reader.u8(), 0);
  assert.equal(choreography.reader.u8(), 0);
  assert.equal(choreography.reader.u32(), 922000);
  assert.equal(choreography.reader.u32(), 0);
  assert.equal(choreography.reader.u8(), 0);
  assert.equal(choreography.reader.f32(), 1);
  assert.equal(choreography.reader.f32(), 1);
  assert.equal(choreography.reader.u16(), 0);
  assert.equal(choreography.reader.eof(), true);

  sent.length = 0;
  setTargets(session, { targets: ["arrow"] }, false);
  assert.equal(sent.length, 0);
});

/**
 * A spike bed is its own animation: NPCView swaps between an "off" and an "on"
 * body renderer on the trigger state, so the rising *is* the state change and
 * there is nothing to choreograph. The captures agree flatly — 1313 state
 * updates on `CASTLE_ARENA_TRAP_SPIKES` and not one choreography.
 */
test("spike trap activation toggles its renderer and nothing else", async () => {
  const attack = await attackForConstant("TRAP_SPIKES");
  assert.ok(attack);

  const sent = [];
  const session = {
    id: 22,
    dungeonActive: true,
    triggerableDoids: new Map([["spikes", 9101]]),
    triggerableAttacks: new Map([["spikes", attack.Id]]),
    triggerableStatefulAttacks: new Set(["spikes"]),
    triggerableHazards: new Map([["spikes", { attack, combatColliders: [] }]]),
    send: (frame) => sent.push(frame),
  };

  setTargets(session, { targets: ["spikes"] }, true);
  assert.equal(sent.length, 1);
  const visible = readUpdateHead(sent[0]);
  assert.equal(visible.doid, 9101);
  assert.equal(visible.fieldId, 141);
  assert.equal(visible.reader.u8(), 1);

  sent.length = 0;
  setTargets(session, { targets: ["spikes"] }, false);
  assert.equal(sent.length, 1);
  const hidden = readUpdateHead(sent[0]);
  assert.equal(hidden.doid, 9101);
  assert.equal(hidden.fieldId, 141);
  assert.equal(hidden.reader.u8(), 0);
});

test("an active trap collider deals its authored percent-health damage", async () => {
  const attack = await attackForConstant("TRAP_SPIKES");
  const floor = await loadFloor("tutorial");
  const placement = floor.placements.triggerable.find(
    ({ constant }) => constant === "CASTLE_ARENA_TRAP_SPIKES_E"
  );
  assert.ok(attack);
  assert.ok(placement);
  assert.deepEqual(placement?.combatColliders, [
    {
      type: "rectangle",
      x: 3150,
      y: 4230,
      halfWidth: 180,
      halfHeight: 30,
      angle: 0,
    },
  ]);

  const sent = [];
  const heroDoid = 7001;
  const session = {
    id: 23,
    // A sustained trap now tests contact on its interval, which stops itself
    // when the dungeon is not running.
    dungeonActive: true,
    heroDoid,
    heroPosition: { x: 3150, y: 4230 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [9101, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 200, maxHitPoints: 200, constant: "BERSERKER" }],
    ]),
    triggerableDoids: new Map([["spikes", 9101]]),
    triggerableAttacks: new Map([["spikes", attack.Id]]),
    triggerableStatefulAttacks: new Set(["spikes"]),
    triggerableHazards: new Map([
      ["spikes", {
        attack,
        position: placement,
        combatColliders: placement.combatColliders,
        // As the spawn path marks it: a trap that comes out of the floor hurts
        // the hero and nobody else. It is also what keeps it silent — a held
        // trap that catches monsters announces every bite, while a spike bed
        // shows itself by changing state. See holdZone.
        heroOnly: true,
      }],
    ]),
    send: (frame) => sent.push(frame),
  };

  setTargets(session, { targets: ["spikes"] }, true);
  await contactTick();
  assert.equal(session.actors.get(heroDoid).hitPoints, 176);
  /**
   * The trigger state, the health it left, and then the result explaining it.
   * No choreography — a spike bed does not animate, it changes state — and the
   * health goes first, which is the order the official server publishes in:
   * hit points immediately before the result, 1181 times against one.
   */
  assert.equal(sent.length, 3);
  assert.equal(readUpdateHead(sent[0]).fieldId, 141);

  const health = readUpdateHead(sent[1]);
  assert.equal(health.doid, heroDoid);
  assert.equal(health.fieldId, 151);
  assert.equal(health.reader.u16(), 176);

  const reaction = readUpdateHead(sent[2]);
  assert.equal(reaction.doid, heroDoid);
  assert.equal(reaction.fieldId, 160);
  assert.equal(reaction.reader.u32(), 9101);
  assert.equal(reaction.reader.u32(), heroDoid);
  assert.equal(readI32(reaction.reader), -24);
  assert.equal(reaction.reader.u8(), 0);
  assert.equal(reaction.reader.u8(), 0);
  assert.equal(reaction.reader.u32(), attack.Id);
  assert.equal(reaction.reader.u32(), 0);
  assert.equal(reaction.reader.u8(), 0);
  assert.equal(reaction.reader.u8(), 1);
  assert.equal(reaction.reader.u8(), 1);
  assert.equal(reaction.reader.u8(), 0);
  assert.equal(reaction.reader.u8(), 0);
  assert.equal(reaction.reader.u8(), 0);
  assert.equal(readI32(reaction.reader), 0);
  assert.equal(reaction.reader.f32(), 1);
  assert.equal(reaction.reader.u8(), 0);
  assert.equal(reaction.reader.eof(), true);

  assert.equal(reaction.reader.eof(), true);
});

test("an active floor trap cannot hit outside its authored combat collider", async () => {
  const attack = await attackForConstant("TRAP_SPIKES");
  const floor = await loadFloor("tutorial");
  const placement = floor.placements.triggerable.find(
    ({ constant }) => constant === "CASTLE_ARENA_TRAP_SPIKES_E"
  );
  assert.ok(attack);
  assert.ok(placement);
  const heroDoid = 7001;
  const sent = [];
  const session = {
    id: 24,
    heroDoid,
    // Still inside TRAP_SPIKES' 400-unit attack range, but outside this asset's
    // authored 30-unit half-height plus the hero's 22-unit collider.
    heroPosition: { x: 3150, y: 4330 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [9101, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, {
        hitPoints: 200,
        maxHitPoints: 200,
        collisionRadius: 22,
        constant: "BERSERKER",
      }],
    ]),
    triggerableDoids: new Map([["spikes", 9101]]),
    triggerableAttacks: new Map([["spikes", attack.Id]]),
    triggerableStatefulAttacks: new Set(["spikes"]),
    triggerableHazards: new Map([
      ["spikes", {
        attack,
        position: placement,
        combatColliders: placement.combatColliders,
        // As the spawn path marks it: a trap that comes out of the floor hurts
        // the hero and nobody else. It is also what keeps it silent — a held
        // trap that catches monsters announces every bite, while a spike bed
        // shows itself by changing state. See holdZone.
        heroOnly: true,
      }],
    ]),
    send: (frame) => sent.push(frame),
  };

  setTargets(session, { targets: ["spikes"] }, true);
  await settle();

  assert.equal(session.actors.get(heroDoid).hitPoints, 200);
  assert.equal(sent.length, 1, "the renderer state, and nothing else to report");
  assert.equal(readUpdateHead(sent[0]).fieldId, 141);
});

test("arrow traps deal damage when the moving projectile reaches the hero", async () => {
  const attack = await attackForConstant("TRAP_ARROWS");
  const projectile = await projectileForConstant(attack?.Projectile);
  assert.ok(attack);
  assert.equal(projectile?.Range, 800);
  assert.equal(projectile?.CollisionSize, 15);

  const attackerDoid = 9101;
  const heroDoid = 7001;
  const hazard = {
    attack,
    projectile,
    position: { x: 1000, y: 1000, heading: 90 },
  };
  const fireAt = async (heroPosition) => {
    const sent = [];
    const session = {
      id: 24,
      heroDoid,
      heroPosition,
      objects: new Map([
        [heroDoid, CLID.HeroGameObject],
        [attackerDoid, CLID.DistributedNPCGameObject],
      ]),
      actors: new Map([
        [heroDoid, {
          hitPoints: 120,
          maxHitPoints: 120,
          collisionRadius: 22,
          constant: "RANGER",
        }],
      ]),
      send: (frame) => sent.push(frame),
    };
    const hitImmediately = await performTrapAttack(session, attackerDoid, hazard);
    return { session, sent, hitImmediately };
  };

  const inFront = await fireAt({ x: 1000, y: 1700 });
  assert.equal(inFront.hitImmediately, false);
  assert.equal(inFront.session.actors.get(heroDoid).hitPoints, 120);
  assert.equal(inFront.sent.length, 1);
  assert.equal(await tickTrapProjectiles(inFront.session, 0.9), 0);
  assert.equal(inFront.session.actors.get(heroDoid).hitPoints, 120);
  assert.equal(await tickTrapProjectiles(inFront.session, 0.05), 1);
  assert.equal(inFront.session.actors.get(heroDoid).hitPoints, 106);
  assert.equal(inFront.sent.length, 3);

  const behind = await fireAt({ x: 1000, y: 900 });
  assert.equal(await tickTrapProjectiles(behind.session, 1.2), 0);
  assert.equal(behind.session.actors.get(heroDoid).hitPoints, 120);
  assert.equal(behind.sent.length, 1);

  const beside = await fireAt({ x: 1100, y: 1200 });
  assert.equal(await tickTrapProjectiles(beside.session, 1.2), 0);
  assert.equal(beside.session.actors.get(heroDoid).hitPoints, 120);
  assert.equal(beside.sent.length, 1);

  const entersLate = await fireAt({ x: 1100, y: 1300 });
  assert.equal(await tickTrapProjectiles(entersLate.session, 0.4), 0);
  entersLate.session.heroPosition = { x: 1000, y: 1300 };
  assert.equal(await tickTrapProjectiles(entersLate.session, 0.05), 1);
  assert.equal(entersLate.session.actors.get(heroDoid).hitPoints, 106);

  const leavesBeforeArrival = await fireAt({ x: 1000, y: 1700 });
  assert.equal(await tickTrapProjectiles(leavesBeforeArrival.session, 0.4), 0);
  leavesBeforeArrival.session.heroPosition = { x: 1100, y: 1700 };
  assert.equal(await tickTrapProjectiles(leavesBeforeArrival.session, 0.8), 0);
  assert.equal(leavesBeforeArrival.session.actors.get(heroDoid).hitPoints, 120);
});

test("trap projectiles stop at authored walls before reaching the hero", async () => {
  const floor = await loadFloor("tutorial");
  const placement = floor.placements.triggerable.find(
    ({ constant }) => constant === "CASTLE_ARENA_TRAP_ARROW_F"
  );
  const attack = await attackForConstant("TRAP_ARROWS");
  const projectile = await projectileForConstant(attack.Projectile);
  const attackerDoid = 9101;
  const heroDoid = 7001;
  const sent = [];
  const session = {
    id: 25,
    heroDoid,
    // The south wall is roughly 680 units down-range; this point is behind it
    // but still inside PROJ_ARROW's authored 800-unit range.
    heroPosition: { x: placement.x, y: placement.y - 750 },
    navigation: createNavigationState(floor.navigation),
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [attackerDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, {
        hitPoints: 120,
        maxHitPoints: 120,
        collisionRadius: 22,
        constant: "RANGER",
      }],
    ]),
    send: (frame) => sent.push(frame),
  };

  await performTrapAttack(session, attackerDoid, { attack, projectile, position: placement });
  assert.equal(await tickTrapProjectiles(session, 1.2), 0);
  assert.equal(session.actors.get(heroDoid).hitPoints, 120);
  assert.equal(session.activeTrapProjectiles.length, 0);
  assert.equal(sent.length, 1);
});

test("standalone NPC choreography follows the generated client schema", () => {
  const frame = npcAttackChoreography({ doid: 42, attackType: 922000 });
  const { reader, doid, fieldId } = readUpdateHead(frame);

  assert.equal(doid, 42);
  assert.equal(fieldId, 143);
  assert.equal(reader.u8(), 0);
  assert.equal(reader.u8(), 0);
  assert.equal(reader.u32(), 922000);
  assert.equal(reader.u32(), 0);
  assert.equal(reader.u8(), 0);
  assert.equal(reader.f32(), 1);
  assert.equal(reader.f32(), 1);
  assert.equal(reader.u16(), 0);
  assert.equal(reader.eof(), true);
});

test("one-shot proximity signal opens a NOT-gated jail through a reset gate", () => {
  const sent = [];
  const floor = {
    placements: {
      trigger: [
        { id: "button-zone", constant: "PROXIMITY_TRIGGER", x: 10, y: 20, radius: 5, triggerOnce: true },
      ],
      generator: [{ id: "wave" }],
      logicGate: [
        { id: "hold", constant: "RESET_TIMER_GATE", resetTime: 5 },
        { id: "invert", constant: "NOT_GATE" },
      ],
    },
    wiring: new Map([
      ["button-zone", ["wave", "button"]],
      ["wave", ["hold"]],
      ["hold", ["invert"]],
      ["invert", ["jail"]],
    ]),
  };
  const session = {
    id: 99,
    send: (frame) => sent.push(frame),
    triggerableDoids: new Map([
      ["button", 100],
      ["jail", 101],
    ]),
    triggerableAttacks: new Map(),
  };

  trackTriggers(session, floor);
  assert.equal(initialTargetState(session, "button"), false);
  assert.equal(initialTargetState(session, "jail"), true);
  session.generatorHandlers.set("wave", () => {
    emitSignal(session, "wave", true);
    emitSignal(session, "wave", false);
  });

  updateProximityTriggers(session, { x: 10, y: 20 });
  assert.deepEqual(
    sent.map((frame) => {
      const update = readUpdateHead(frame);
      return [update.doid, update.fieldId, update.reader.u8()];
    }),
    [
      [101, 141, 0],
      [100, 141, 1],
    ]
  );

  sent.length = 0;
  updateProximityTriggers(session, { x: 100, y: 100 });
  updateProximityTriggers(session, { x: 10, y: 20 });
  assert.equal(sent.length, 0);
  for (const timer of session.logicGateTimers.values()) clearTimeout(timer);
});

test("an all-spawns-dead generator holds a kill barrier until its wave clears", async () => {
  const { completeGenerator } = await import("../src/socket/dungeon.js");
  const sent = [];
  const floor = {
    placements: {
      trigger: [],
      generator: [{ id: "wave", clearsOnAllDead: true }],
      logicGate: [{ id: "invert", constant: "NOT_GATE" }],
      triggerable: [{ id: "spikes", constant: "NORDIC_TEMPLE_TRAP_SPIKE" }],
    },
    wiring: new Map([
      ["wave", ["invert"]],
      ["invert", ["spikes"]],
    ]),
  };
  const session = {
    id: 99,
    send: (frame) => sent.push(frame),
    actors: new Map(),
    generators: new Map(),
    triggerableDoids: new Map([["spikes", 2447]]),
    triggerableAttacks: new Map(),
  };

  trackTriggers(session, floor);
  assert.equal(initialTargetState(session, "spikes"), true, "the barrier starts raised");

  const placement = floor.placements.generator[0];
  for (let spawn = 0; spawn < 4; spawn += 1) {
    emitGeneratorRelease(session, placement);
  }
  assert.equal(session.signalValues.get("wave"), false, "releasing mobs is not completion");
  assert.equal(sent.length, 0, "no transient off/on hole reaches the spike colliders");

  const runtime = {
    placement,
    maxSpawns: 4,
    attemptedSpawns: 4,
    alive: 0,
    completed: false,
    stopped: false,
    spawnedDoids: new Set(),
  };
  session.generators.set("wave", runtime);
  completeGenerator(session, runtime);

  assert.equal(runtime.completed, true);
  assert.equal(session.signalValues.get("wave"), true, "all dead is the one completion edge");
  assert.equal(sent.length, 1, "the barrier changes only once");
  const update = readUpdateHead(sent[0]);
  assert.equal(update.doid, 2447);
  assert.equal(update.fieldId, 141);
  assert.equal(update.reader.u8(), 0, "and only then do the spikes lower");
});

test("an all-dead generator still pulses a directly wired reset cage", () => {
  const floor = {
    placements: {
      trigger: [],
      generator: [{ id: "wave", clearsOnAllDead: true }],
      logicGate: [{ id: "hold", constant: "RESET_TIMER_GATE", resetTime: 5 }],
      triggerable: [{ id: "cage", constant: "NORDIC_TEMPLE_CAGE_GATE" }],
    },
    wiring: new Map([
      ["wave", ["hold"]],
      ["hold", ["cage"]],
    ]),
  };
  const sent = [];
  const session = {
    id: 100,
    send: (frame) => sent.push(frame),
    triggerableDoids: new Map([["cage", 2500]]),
    triggerableAttacks: new Map(),
  };

  trackTriggers(session, floor);
  emitGeneratorRelease(session, floor.placements.generator[0]);

  assert.equal(session.signalValues.get("wave"), false, "the completion level stays low");
  assert.equal(sent.length, 1, "but the reset gate still receives the release edge");
  const update = readUpdateHead(sent[0]);
  assert.equal(update.doid, 2500);
  assert.equal(update.reader.u8(), 1);
  for (const timer of session.logicGateTimers.values()) clearTimeout(timer);
});

test("two completed generators satisfy AND then open the inverted exit gate", () => {
  const sent = [];
  const floor = {
    placements: {
      trigger: [],
      generator: [{ id: "left" }, { id: "right" }],
      logicGate: [
        { id: "both", constant: "AND_GATE" },
        { id: "invert", constant: "NOT_GATE" },
      ],
    },
    wiring: new Map([
      ["left", ["both"]],
      ["right", ["both"]],
      ["both", ["invert"]],
      ["invert", ["exit"]],
    ]),
  };
  const session = {
    send: (frame) => sent.push(frame),
    triggerableDoids: new Map([["exit", 500]]),
    triggerableAttacks: new Map(),
  };

  trackTriggers(session, floor);
  assert.equal(initialTargetState(session, "exit"), true);
  emitSignal(session, "left", true);
  assert.equal(sent.length, 0);
  emitSignal(session, "right", true);

  const opened = readUpdateHead(sent.at(-1));
  assert.equal(opened.doid, 500);
  assert.equal(opened.fieldId, 141);
  assert.equal(opened.reader.u8(), 0);
});

/**
 * Spikes that are already up.
 *
 * Firing once as they rose meant walking onto a raised bed cost nothing. The
 * beat is `CASTLE_ARENA_TRAP_SPIKES.AttackTimer`, which is 1 — the same column
 * the poison cloud ticks on.
 */
test("a raised trap keeps hitting whoever walks into it", async (t) => {
  const { setTargets, clearHazardBeats } = await import("../src/socket/triggers.js");
  t.mock.timers.enable({ apis: ["setInterval"] });

  const heroDoid = 10;
  const trapDoid = 20;
  const sent = [];
  const session = {
    id: 1,
    heroDoid,
    dungeonActive: true,
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [trapDoid, CLID.DistributedNPCGameObject],
    ]),
    // A trap resolves contact against the hero's streamed position.
    heroPosition: { x: 9000, y: 9000 },
    actors: new Map([
      [heroDoid, { hitPoints: 200, maxHitPoints: 200, collisionRadius: 22 }],
    ]),
    triggerableDoids: new Map([["spikes", trapDoid]]),
    triggerableAttacks: new Map([["spikes", 922010]]),
    triggerableStatefulAttacks: new Set(["spikes"]),
    triggerableHazards: new Map([
      [
        "spikes",
        {
          attack: { Id: 922010, PercentHealthDamageValue: 0.12, Range: 400 },
          npc: { AttackTimer: 1 },
          position: { x: 100, y: 100 },
          combatColliders: [{ type: "circle", x: 100, y: 100, radius: 60 }],
        },
      ],
    ]),
    send: (frame) => sent.push(frame),
  };

  setTargets(session, { targets: ["spikes"] }, true);
  const afterRise = session.actors.get(heroDoid).hitPoints;
  assert.equal(afterRise, 200, "nobody was standing there when they rose");

  // The hero walks on while they are up.
  session.heroPosition = { x: 100, y: 100 };
  t.mock.timers.tick(1000);
  await settle();
  assert.ok(
    session.actors.get(heroDoid).hitPoints < 200,
    "and the raised bed hits on its own beat"
  );

  // Lowering them stops it.
  const hurt = session.actors.get(heroDoid).hitPoints;
  setTargets(session, { targets: ["spikes"] }, false);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(session.actors.get(heroDoid).hitPoints, hurt, "lowered spikes are harmless");

  clearHazardBeats(session);
});

/**
 * A launcher stays on the wall.
 *
 * Field 141 drives a stateful trap's renderer as well as its choreography, so a
 * spike bed has to receive it and a launcher must not — toggling one makes the
 * launcher itself blink in and out, which is what the Nordic caves were doing.
 *
 * The test is whether the attack throws something, not what the attack is
 * called: naming TRAP_ARROWS covered Arena's arrows and missed 21 sibling props
 * across the prison, the Jurassic maps, the villages, the temples and the ice
 * caves.
 */
test("a trap that shoots is classified by its projectile, not by its name", async () => {
  const { attackForConstant, npcForConstant, projectileForConstant } = await import(
    "../src/gamemaster.js"
  );

  const toggles = async (constant) => {
    const npc = await npcForConstant(constant);
    const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
    const projectile = attack?.Projectile
      ? await projectileForConstant(attack.Projectile)
      : null;
    return Boolean(attack && !projectile);
  };

  // Launchers: mounted, and their timeline is the only thing that cycles.
  assert.equal(await toggles("CASTLE_ARENA_TRAP_ARROW_A"), false, "TRAP_ARROWS");
  assert.equal(await toggles("NORDIC_CAVE_GARGOYLE_EMITTER_A"), false, "TRAP_ICEARROWS");
  assert.equal(await toggles("NORDIC_TEMPLE_TRAP_STATUE_LOKI"), false, "a thrown fireball");

  // The effect itself: these appear and disappear, and must keep field 141.
  assert.equal(await toggles("CASTLE_ARENA_TRAP_SPIKES"), true);
  assert.equal(await toggles("NORDIC_CAVE_SPIKETRAP"), true, "the ice bed, same as the metal one");
  assert.equal(await toggles("CASTLE_ARENA_TRAP_FLAMEJET_A"), true);
  assert.equal(await toggles("NORDIC_CAVE_TRAP_MACE"), true, "a swinging chain is its own effect");
});

/**
 * Which layer a trap draws on comes from the tile that placed it, not from the
 * row it instantiates. The two disagree in the data, and a capture says which
 * one the wire follows: an ice-caves session generated `NORDIC_CAVE_SMASH_BOX`
 * 72 times at layer 20 and once at 10, against a row that says `sorted` for all
 * of them and a tile library holding exactly one `background` placement.
 */
test("a placement's layer outranks the row's default", async () => {
  const { npcForConstant } = await import("../src/gamemaster.js");
  const { layerFor } = await import("../src/socket/objects.js");

  const smashBox = await npcForConstant("NORDIC_CAVE_SMASH_BOX");
  assert.equal(smashBox.DefaultLayer, "sorted");
  assert.equal(layerFor(smashBox, undefined), 20, "the row when the tile is silent");
  assert.equal(layerFor(smashBox, "background"), 10, "the tile when it speaks");

  // Wall traps are the reason this matters: authored above the hero so the
  // emitter is not drawn behind the flame coming out of it.
  assert.equal(layerFor(await npcForConstant("NORDIC_TEMPLE_TRAP_EMITTER_C"), "foreground"), 30);

  // Doobers have no layer column at all, so the tile is the only source.
  assert.equal(layerFor(null, "foreground"), 30);
  assert.equal(layerFor(null, undefined), 20);
});

/** Every layer name the tile libraries use has to resolve, or it silently sorts. */
test("every layer name authored on a server-owned placement is understood", async () => {
  const { loadFloor } = await import("../src/socket/floors.js");
  const { layerFor } = await import("../src/socket/objects.js");

  const floor = await loadFloor("arena_gauntlet");
  const placements = Object.values(floor.placements).flat();
  const named = placements.filter((placement) => placement.layer);
  assert.ok(named.length, "the arena places something off the default layer");

  for (const placement of named) {
    assert.notEqual(
      layerFor(null, placement.layer),
      20,
      `"${placement.layer}" fell through to sorted`
    );
  }
});

/**
 * A rectangle with no size touches nothing.
 *
 * worldColliders read `width`/`height` off timeline colliders. Nothing in the
 * game authors those: all 148 rectangles carry `halfWidth`/`halfHeight`, so
 * every one of the 57 attacks with a rectangular timeline — every mace, blade,
 * crusher and slicer, and most hero combos — resolved to a zero-sized shape.
 */
test("a timeline's rectangle keeps its authored size", async () => {
  const { worldColliders } = await import("../src/socket/heading.js");
  const { attackColliders } = await import("../src/gamemaster.js");

  const [slam] = worldColliders(
    { x: 1000, y: 2000 },
    0,
    await attackColliders("TM_TRAP_CRUSHER")
  );
  assert.equal(slam.type, "rectangle");
  assert.equal(slam.halfWidth, 150, "300 units across, not zero");
  assert.equal(slam.halfHeight, 25);
  // yOffset runs across the facing, so at heading 0 it moves in y.
  assert.equal(slam.y, 1980);
});

/**
 * The moving traps have no shape in library_server — only navigation
 * collisions — so asking it alone gave a mace an empty damage zone and it swung
 * through everyone. Its shape is the frames of its own swing instead.
 */
test("a swinging mace takes its damage shape from its timeline", async () => {
  const { worldColliders } = await import("../src/socket/heading.js");
  const { attackColliders } = await import("../src/gamemaster.js");

  const arc = worldColliders(
    { x: 0, y: 0 },
    0,
    await attackColliders("TM_TRAP_CAVE_SWINGING_MACE")
  );
  assert.equal(arc.length, 6, "two swings of three frames each");
  assert.ok(
    arc.every(({ halfWidth }) => halfWidth > 0),
    "and every one of them can catch something"
  );
  // The head travels from one side to the other and back.
  assert.deepEqual(
    arc.map(({ x }) => x),
    [-80, 0, 80, 80, 0, -80]
  );
});


/**
 * A moving trap damages where its head *is*, when it gets there — and every
 * frame of the swing lands on its own.
 *
 * The animation is announced once: ActorGameObject.ReceiveAttackChoreography
 * restarts the swing from frame zero, so a per-second beat told the mace to
 * begin again mid-swing. The captured ratios settle it — 310 state changes to
 * 155 choreographies on NORDIC_CAVE_TRAP_MACE, 180 to 90 on the arena crusher,
 * both exactly one animation per on/off pair.
 *
 * There is no cooldown inside a swing. The capture shows one victim taking a
 * cave mace at 2508ms and 2667ms of a single animation — 159ms apart, which is
 * its frames 59 and 64 — and a flame jet at 0, 500 and 1016ms, its three
 * authored frames exactly.
 */
test("every frame of a swing lands, and the swing is announced once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { attackColliders, attackForConstant, npcForConstant } = await import(
    "../src/gamemaster.js"
  );
  const { worldColliders } = await import("../src/socket/heading.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_CAVE_TRAP_MACE");
  const attack = await attackForConstant(npc.Attack1);

  const maceDoid = 9200;
  const heroDoid = 7001;
  const at = { x: 500, y: 500 };
  const sent = [];
  const session = {
    id: 25,
    dungeonActive: true,
    heroDoid,
    // Between the first two shapes of the swing, so both reach: they sit at
    // x 420 and 500, each 40 wide, against a hero 22 across.
    heroPosition: { x: 460, y: 500 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [maceDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, constant: "RANGER" }],
    ]),
    triggerableDoids: new Map([["mace", maceDoid]]),
    triggerableHazards: new Map([
      [
        "mace",
        {
          attack,
          npc,
          position: at,
          combatColliders: worldColliders(at, 0, await attackColliders(attack.AttackTimeline)),
        },
      ],
    ]),
    send: (frame) => sent.push(frame),
  };

  const choreographies = () =>
    sent.filter((frame) => readUpdateHead(frame).fieldId === 143).length;
  const hp = () => session.actors.get(heroDoid).hitPoints;

  assert.equal(raiseHazard(session, "mace"), true);
  await settle();
  assert.equal(hp(), 4000, "the head has not swung yet");
  assert.equal(choreographies(), 1, "the swing is announced as it starts");

  // Frame 13 of 24 is 542ms in.
  t.mock.timers.tick(541);
  await settle();
  assert.equal(hp(), 4000, "still not there");

  t.mock.timers.tick(1);
  await settle();
  const afterFirst = hp();
  assert.ok(afterFirst < 4000, "the head arrives and connects");

  // Frame 18 is 208ms later, and it lands too — no cooldown inside a swing.
  t.mock.timers.tick(209);
  await settle();
  assert.ok(hp() < afterFirst, "the next frame of the same swing lands as well");
  assert.equal(choreographies(), 1, "and the animation is not restarted mid-swing");

  clearHazardBeats(session);
});

/**
 * The report was that a ground trap only hurt you if you stood on it as it came
 * up — walking into a bed of spikes already out cost nothing, and coming at it
 * from below never worked at all.
 *
 * Both are the same fault. An actor's body is not where it stands: every actor
 * in library_server carries it as a circle 22 units *above* its position, and
 * testing the raw position put every damage zone that far too low. The hero
 * here is 70 units below the trap, which its 34-unit circle cannot reach from
 * the feet but reaches comfortably from the body.
 */
test("a raised trap catches a hero who walks into it from below", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });

  const { attackForConstant, npcForConstant } = await import("../src/gamemaster.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_CAVE_SPIKETRAP");
  const attack = await attackForConstant(npc.Attack1);
  assert.equal(npc.AttackTimer, 1, "and hurts again every second it is stood in");

  const spikeDoid = 9300;
  const heroDoid = 7001;
  const session = {
    id: 26,
    dungeonActive: true,
    heroDoid,
    heroPosition: { x: 1400, y: 1000 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [spikeDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, constant: "RANGER" }],
    ]),
    triggerableDoids: new Map([["spikes", spikeDoid]]),
    triggerableHazards: new Map([
      [
        "spikes",
        {
          attack,
          npc,
          position: { x: 1000, y: 1000 },
          combatColliders: [{ type: "circle", x: 1000, y: 1000, radius: 34, frame: 0 }],
        },
      ],
    ]),
    send: () => {},
  };
  const hp = () => session.actors.get(heroDoid).hitPoints;

  raiseHazard(session, "spikes");
  t.mock.timers.tick(100);
  await settle();
  assert.equal(hp(), 4000, "nobody is in it yet");

  // 70 below: out of reach of the feet, within reach of the body.
  session.heroPosition = { x: 1000, y: 1070 };
  t.mock.timers.tick(100);
  await settle();
  const afterEntry = hp();
  assert.ok(afterEntry < 4000, "and walking in from below costs you at once");

  t.mock.timers.tick(500);
  await settle();
  assert.equal(hp(), afterEntry, "not once every tick, though");

  t.mock.timers.tick(500);
  await settle();
  assert.ok(hp() < afterEntry, "once a second, which is the row's AttackTimer");

  clearHazardBeats(session);
});

/**
 * A trap that comes out of the floor hurts the player and nobody else. Every
 * one of 25 recorded TRAP_SPIKES results named the hero, while the mace, blade,
 * flame jet, arrows and Thor's hammer all cut through imps, knights and yetis.
 * The layer is the line: hero-only traps are `background`, the rest `sorted`.
 */
test("a ground trap spares the monsters standing in it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const { attackForConstant, npcForConstant } = await import("../src/gamemaster.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_CAVE_SPIKETRAP");
  const attack = await attackForConstant(npc.Attack1);
  const spikeDoid = 9400;
  const heroDoid = 7001;
  const impDoid = 8001;

  const runWith = async (heroOnly) => {
    const session = {
      id: 27,
      dungeonActive: true,
      heroDoid,
      heroPosition: { x: 1000, y: 1010 },
      objects: new Map([
        [heroDoid, CLID.HeroGameObject],
        [impDoid, CLID.DistributedNPCGameObject],
        [spikeDoid, CLID.DistributedNPCGameObject],
      ]),
      actors: new Map([
        [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, constant: "RANGER" }],
        [impDoid, {
          hitPoints: 400, maxHitPoints: 400, collisionRadius: 35,
          constant: "ICE_IMP", isEnemy: true, position: { x: 1000, y: 1010 },
        }],
      ]),
      triggerableDoids: new Map([["spikes", spikeDoid]]),
      triggerableHazards: new Map([
        ["spikes", {
          attack, npc, heroOnly,
          position: { x: 1000, y: 1000 },
          combatColliders: [{ type: "circle", x: 1000, y: 1000, radius: 34, frame: 0 }],
        }],
      ]),
      send: () => {},
    };
    raiseHazard(session, "spikes");
    // setInterval is mocked here, so advance its clock rather than the wall's.
    t.mock.timers.tick(100);
    for (let drain = 0; drain < 4; drain += 1) await settle();
    return session.actors;
  };

  const spared = await runWith(true);
  await settle();
  assert.ok(spared.get(heroDoid).hitPoints < 4000, "the hero is hurt");
  assert.equal(spared.get(impDoid).hitPoints, 400, "the imp standing beside him is not");

  // The same shape on a wall trap hurts both, which is the contrast.
  const both = await runWith(false);
  await settle();
  assert.ok(both.get(heroDoid).hitPoints < 4000);
  assert.ok(both.get(impDoid).hitPoints < 400, "a sorted trap cuts through monsters");
});

/**
 * "The flames were there when the map loaded and then went, but walking over
 * them still burns me."
 *
 * A held trap's picture is its animation, and the animation is played from the
 * choreography. This path never sent a second one, so the client had a single
 * activation to draw for the whole floor while contact went on landing hits.
 *
 * The corpus prices it at one announcement per bite: `TRAP_FLAME_JET` sends 151
 * choreographies against 142 results and `FLAME_BURN` 94 against 90. Hero-only
 * traps are excluded — 25 of 25 `TRAP_SPIKES` results name the hero and not one
 * carries a choreography, because a spike bed shows itself by changing state.
 */
test("a held trap that catches a monster announces every bite", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const { attackForConstant, npcForConstant } = await import("../src/gamemaster.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_CAVE_SPIKETRAP");
  const attack = await attackForConstant(npc.Attack1);
  const trapDoid = 9500;
  const impDoid = 8002;

  const runWith = async (heroOnly) => {
    const sent = [];
    const session = {
      id: 28,
      dungeonActive: true,
      heroDoid: 7001,
      heroPosition: { x: 5000, y: 5000 },
      objects: new Map([
        [impDoid, CLID.DistributedNPCGameObject],
        [trapDoid, CLID.DistributedNPCGameObject],
      ]),
      actors: new Map([
        [impDoid, {
          hitPoints: 400, maxHitPoints: 400, collisionRadius: 35,
          constant: "ICE_IMP", isEnemy: true, position: { x: 1000, y: 1010 },
        }],
      ]),
      triggerableDoids: new Map([["trap", trapDoid]]),
      triggerableHazards: new Map([
        ["trap", {
          attack, npc, heroOnly,
          position: { x: 1000, y: 1000 },
          combatColliders: [{ type: "circle", x: 1000, y: 1000, radius: 34, frame: 0 }],
        }],
      ]),
      send: (frame) => sent.push(frame),
    };
    raiseHazard(session, "trap");
    t.mock.timers.tick(100);
    for (let drain = 0; drain < 4; drain += 1) await settle();
    clearHazardBeats(session);
    return sent.filter((frame) => readUpdateHead(frame).fieldId === 143).length;
  };

  assert.ok(await runWith(false) > 0, "a trap that bites a monster plays its animation");
  assert.equal(await runWith(true), 0, "a hero-only spike bed still says nothing");
});

/**
 * Six traps charge a flat amount rather than a share of the bar: the five
 * Jurassic slicers and the burning ground. For those this used to fall back to
 * `|DamageMod|`, which is 1 on every one of them, so a disk that should carve
 * you took a single point — the reported "the disk traps hit for -1".
 *
 * The official is not doing that: `FLAME_BURN` lands between 6 and 22 in one
 * session. And the rows say how — each carries a `Weapon1` of its own, so they
 * are priced like any other actor's swing.
 */
test("a slicer is priced by its own weapon, not by DamageMod", async () => {
  const { attackForConstant, npcForConstant, weaponForConstant } = await import(
    "../src/gamemaster.js"
  );
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("JURASSIC_TRIBAL_TRAP_SLICER_A");
  const attack = await attackForConstant(npc.Attack1);
  assert.equal(attack.DoPercentHealthDamage, undefined, "a slicer charges a flat amount");
  assert.equal(Math.abs(attack.DamageMod), 1, "and its DamageMod alone would be one point");

  const weapon = await weaponForConstant(npc.Weapon1);
  assert.ok(weapon?.Power > 1, `${npc.Weapon1} carries the real number`);

  const trapDoid = 9500;
  const heroDoid = 7001;
  const session = {
    id: 41,
    dungeonActive: true,
    heroDoid,
    heroPosition: { x: 1000, y: 1022 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [trapDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, constant: "RANGER" }],
    ]),
    triggerableDoids: new Map([["slicer", trapDoid]]),
    triggerableHazards: new Map([
      [
        "slicer",
        {
          attack,
          npc,
          weaponPower: weapon.Power,
          position: { x: 1000, y: 1000 },
          combatColliders: [{ type: "circle", x: 1000, y: 1000, radius: 40, frame: 0 }],
        },
      ],
    ]),
    send: () => {},
  };

  raiseHazard(session, "slicer");
  await contactTick();
  await settle();
  clearHazardBeats(session);

  const taken = 4000 - session.actors.get(heroDoid).hitPoints;
  assert.ok(taken > 1, `a slicer took ${taken}, which is still the DamageMod fallback`);
});

/**
 * A shot mounted inside its wall dies in it; one mounted flush against it does
 * not.
 *
 * This asserted the opposite — that a bolt born in rock gets away — because ten
 * of twelve `NORDIC_CAVE_GARGOYLE_EMITTER_C` on a laid-out floor killed their
 * arrow on the first tick and going silent looked wrong.
 *
 * Silent was right, and the official says so once its own vertical gargoyles
 * are split by whether the muzzle sits in rock:
 *
 *   buried   11 emitters   135 shots    0 hits on the hero
 *   clear    10 emitters   144 shots   13 hits
 *
 * Not one hit in a hundred and thirty-five. Their bolt dies in the wall, which
 * is also why nothing is drawn there — the client builds its projectile in the
 * same rock and loses it. Carrying ours through was the reported arrow you
 * cannot see taking a hundred and six health off you, on the tiles where the
 * mount happens to be buried and not on the ones where it is not: of the two
 * the player named, `287.1328750945945` has 15 units of rock in front of its
 * muzzle and `347.1327714903060` has none.
 *
 * The muzzle exemption stays and is a different thing: an aztec arrow trap sits
 * flush with geometry 5 units ahead and nothing from 10 onwards, and without it
 * the first sweep clipped that lip. It is bounded by the shot's own radius, and
 * applies once.
 */
test("a shot buried in its wall dies there, and a flush one gets away", async () => {
  const { attackForConstant, projectileForConstant } = await import("../src/gamemaster.js");
  const { createNavigationState } = await import("../src/socket/navigation.js");

  const attack = await attackForConstant("TRAP_ICEARROWS");
  const projectile = await projectileForConstant(attack.Projectile);

  /**
   * Four tiles of floor, with one slab of wall laid across the middle of it.
   *
   * The floor has to reach past the wall or "clear of it" is off the map and
   * blocked for that reason instead — which is what the old shape of this test
   * did, and why both halves of it needed the exemption to pass at all.
   */
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 1800, maxY: 1800 },
    tileSize: 900,
    cellSize: 60,
    tiles: [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 0, y: 900 }, { x: 900, y: 900 }],
    staticColliders: [
      { type: "rectangle", x: 1000, y: 900, halfWidth: 300, halfHeight: 100, angle: 0 },
    ],
    triggerColliders: new Map(),
  });

  const fireFrom = async (y) => {
    const session = {
      id: 42,
      dungeonActive: true,
      heroDoid: 7001,
      navigation,
      objects: new Map(),
      actors: new Map(),
      send: () => {},
    };
    await performTrapAttack(session, 9600, {
      attack,
      projectile,
      position: { x: 1000, y, heading: 90 },
    });
    await tickTrapProjectiles(session, 0.02);
    return (session.activeTrapProjectiles ?? []).length;
  };

  // 800..1000 is the slab. Inside it the bolt is lost; below it it flies.
  assert.equal(await fireFrom(950), 0, "buried in the wall, it dies where the client loses it");
  assert.equal(await fireFrom(1100), 1, "clear of it, it flies as before");
});

/**
 * The mark a trap leaves.
 *
 * Four floor traps author a debuff and none of them was leaving it: the tar
 * pit's `TAR_SLOW` — two seconds at a fifth of your speed, which is the whole
 * of what a tar pit is — and `FIRE_L1`/`FIRE_L5` off the two flame traps and
 * the burning ground. The code ran it for the hero's own swings and for
 * placeables and was simply never wired to floor traps.
 *
 * The capture is direct: a Jurassic session generates fifteen `TAR_SLOW` buffs
 * and every one names `JURASSIC_DINO_TARPIT` as the attacker.
 */
test("a tar pit leaves the slow it authors", async () => {
  const { attackForConstant, npcForConstant } = await import("../src/gamemaster.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("JURASSIC_DINO_TARPIT");
  const attack = await attackForConstant(npc.Attack1);
  assert.equal(attack.TargetBuff1, "TAR_SLOW", "the pit authors a slow");

  const pitDoid = 9700;
  const heroDoid = 7001;
  const session = {
    id: 43,
    dungeonActive: true,
    heroDoid,
    floorDoid: 8000,
    dungeonZone: 10,
    heroPosition: { x: 1000, y: 1022 },
    allocateDoid: (() => { let next = 9800; return () => next++; })(),
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [pitDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, constant: "RANGER" }],
    ]),
    triggerableDoids: new Map([["pit", pitDoid]]),
    triggerableHazards: new Map([
      [
        "pit",
        {
          attack,
          npc,
          weaponPower: 1,
          position: { x: 1000, y: 1000 },
          combatColliders: [{ type: "circle", x: 1000, y: 1000, radius: 40, frame: 0 }],
        },
      ],
    ]),
    send: () => {},
  };

  raiseHazard(session, "pit");
  await contactTick();
  await settle();
  clearHazardBeats(session);

  const slows = [...(session.activeBuffs?.values() ?? [])].filter(
    (active) => active.buff?.Constant === "TAR_SLOW" && active.affectedActor === heroDoid
  );
  assert.equal(slows.length, 1, "standing in it should have slowed the hero");
  assert.equal(slows[0].buff.MOVEMENT, 0.2);
});

/**
 * A barrier with a broken half breaks in place.
 *
 * `PermCorpse` says so on nineteen rows and misses one — and the miss is the
 * only one anybody can hit. Of the 48 rows carrying an authored *off* state
 * without the column, 46 are traps and trigger-driven gates that can never be
 * killed. The two that can are `JURASSIC_AZTEC_EXIT_GATE_A`, reported as
 * vanishing where the arena's gate leaves its broken half standing, and
 * `HERO_DEFENSE_ORB`.
 *
 * An off state is authored collision for what the thing becomes once it gives
 * way, and the aztec gate carries four shapes of it. Nothing that dies and
 * disappears has any use for them.
 */
test("a smashable gate with an authored broken half stays in place", async () => {
  const { npcForConstant } = await import("../src/gamemaster.js");
  const { loadNavigationLibrary, navigationEntryFor } = await import(
    "../src/socket/navigation.js"
  );
  await loadNavigationLibrary();

  const gate = await npcForConstant("JURASSIC_AZTEC_EXIT_GATE_A");
  assert.equal(gate.IsAttackable, 1, "it is a gate you smash");
  assert.ok(!gate.PermCorpse, "and the column that would say so is empty");
  assert.equal(
    navigationEntryFor("JURASSIC_AZTEC_EXIT_GATE_A").navCollisions_off.length,
    4,
    "but its broken half is authored"
  );

  // The arena's gate, which behaves correctly, says it both ways.
  const arena = await npcForConstant("CASTLE_ARENA_GATE_B");
  assert.ok(arena.PermCorpse);
  assert.ok(navigationEntryFor("CASTLE_ARENA_GATE_B").navCollisions_off.length);

  // Nothing that can be killed is left out by reading both.
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  const missed = [...gm.npcByConstant.values()].filter(
    (row) =>
      row.IsAttackable &&
      !row.PermCorpse &&
      navigationEntryFor(row.Constant)?.navCollisions_off?.length
  );
  assert.deepEqual(
    missed.map(({ Constant }) => Constant).sort(),
    ["HERO_DEFENSE_ORB", "JURASSIC_AZTEC_EXIT_GATE_A"],
    "the column misses exactly these two"
  );
});

/**
 * A moving trap announces its swing before its state goes on.
 *
 * The official pairs them in the same millisecond and always in that order — a
 * cave mace reads `SWING, state->1 ... state->0, SWING, state->1` for the whole
 * session. A spike bed, which does not move, gets no animation at all.
 */
test("a swinging trap sends its animation before its trigger state", async () => {
  const { attackForConstant, npcForConstant, attackColliders } = await import(
    "../src/gamemaster.js"
  );
  const { worldColliders } = await import("../src/socket/heading.js");
  const { clearHazardBeats } = await import("../src/socket/hazards.js");

  const npc = await npcForConstant("NORDIC_CAVE_TRAP_MACE");
  const attack = await attackForConstant(npc.Attack1);
  const at = { x: 500, y: 500 };
  const sent = [];
  const session = {
    id: 44,
    dungeonActive: true,
    heroDoid: 7001,
    objects: new Map([[9900, CLID.DistributedNPCGameObject]]),
    actors: new Map(),
    triggerableDoids: new Map([["mace", 9900]]),
    triggerableAttacks: new Map([["mace", attack.Id]]),
    triggerableStatefulAttacks: new Set(["mace"]),
    triggerableHazards: new Map([
      [
        "mace",
        {
          attack,
          npc,
          position: at,
          combatColliders: worldColliders(at, 0, await attackColliders(attack.AttackTimeline)),
        },
      ],
    ]),
    send: (frame) => sent.push(frame),
  };

  setTargets(session, { targets: ["mace"] }, true);
  const fields = sent.map((frame) => readUpdateHead(frame).fieldId);
  assert.deepEqual(fields, [143, 141], "the swing, then the state");

  clearHazardBeats(session);
});

/**
 * The tar pit is terrain, not a trap.
 *
 * It is the only hazard the captures show damaging without ever receiving a
 * trigger state: both recorded pits are never sent one and one of them hurts
 * the hero forty times, while 218 silent cave spike beds and 23 silent dino
 * spears never hurt anybody. So it has to arrive armed, and it has to not be
 * offered a state it has no artwork for.
 */
test("a tar pit is armed on arrival and never sent a trigger state", async () => {
  const { attackForConstant, npcForConstant, attackColliders } = await import(
    "../src/gamemaster.js"
  );
  const { worldColliders } = await import("../src/socket/heading.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");

  const npc = await npcForConstant("JURASSIC_DINO_TARPIT");
  const attack = await attackForConstant(npc.Attack1);
  assert.equal(attack.PercentHealthDamageValue, 0.03, "three percent of the bar");
  assert.equal(attack.TargetBuff1, "TAR_SLOW");

  const at = { x: 600, y: 600 };
  const sent = [];
  const session = {
    id: 61,
    dungeonActive: true,
    heroDoid: 7001,
    heroPosition: { x: 600, y: 622 },
    objects: new Map([[9910, CLID.DistributedNPCGameObject], [7001, CLID.HeroGameObject]]),
    actors: new Map([
      [7001, { doid: 7001, constant: "HERO_WARRIOR", hitPoints: 900, maxHitPoints: 900, position: { x: 600, y: 622 } }],
    ]),
    triggerableDoids: new Map([["pit", 9910]]),
    triggerableAttacks: new Map([["pit", attack.Id]]),
    // Deliberately absent from triggerableStatefulAttacks: the official sends
    // this trap no trigger state at all.
    triggerableStatefulAttacks: new Set(),
    triggerableHazards: new Map([
      [
        "pit",
        {
          attack,
          npc,
          position: at,
          heroOnly: true,
          combatColliders: worldColliders(at, 0, await attackColliders(attack.AttackTimeline)),
        },
      ],
    ]),
    send: (frame) => sent.push(frame),
  };

  assert.equal(raiseHazard(session, "pit"), true, "a pit arms without being triggered");
  setTargets(session, { targets: ["pit"] }, true);
  const fields = sent.map((frame) => readUpdateHead(frame).fieldId);
  assert.ok(!fields.includes(141), `no trigger state, got ${fields.join(",")}`);

  clearHazardBeats(session);
});

/**
 * Loki's statue aims before it fires.
 *
 * It is the only prop in the captures that changes heading under its own steam
 * — 92 updates across two doids in half a minute, where every other prop sends
 * one at generation and never moves again — and the heading it sends is the
 * bearing to the hero, off by a median 3.8 degrees.
 */
test("a turret turns to the hero and fires where it points", async () => {
  const { attackForConstant, npcForConstant, projectileForConstant } = await import(
    "../src/gamemaster.js"
  );
  const { startTurretAim, stopTurretAim } = await import("../src/socket/hazards.js");

  const npc = await npcForConstant("NORDIC_TEMPLE_TRAP_STATUE_LOKI");
  const attack = await attackForConstant(npc.Attack1);
  const projectile = await projectileForConstant(attack.Projectile);

  const at = { x: 1000, y: 1000, heading: 0 };
  const hazard = { attack, npc, projectile, position: at };
  const sent = [];
  const session = {
    id: 71,
    dungeonActive: true,
    heroDoid: 7001,
    // Due north of the statue, which is +90 degrees in screen space.
    heroPosition: { x: 1000, y: 1400 },
    objects: new Map([[9920, CLID.DistributedNPCGameObject]]),
    actors: new Map(),
    triggerableDoids: new Map([["loki", 9920]]),
    triggerableAttacks: new Map([["loki", attack.Id]]),
    triggerableHazards: new Map([["loki", hazard]]),
    send: (frame) => sent.push(frame),
  };

  assert.equal(startTurretAim(session, "loki"), true);
  const aim = readUpdateHead(sent[0]);
  assert.equal(aim.doid, 9920);
  assert.equal(aim.fieldId, 133, "heading, not position");
  assert.ok(Math.abs(aim.reader.f32() - 90) < 0.01, "pointing at the hero");
  assert.ok(Math.abs(hazard.heading - 90) < 0.01, "and the shot will follow it");

  // The authored heading is still what an ordinary launcher uses.
  assert.equal(at.heading, 0);
  stopTurretAim(session, "loki");
});

/**
 * Dying inside a proximity trigger releases it.
 *
 * The hero broadcasts its position while down, so a trigger it died inside
 * would otherwise stay entered for as long as the body lies there, and whatever
 * hangs off it stays switched on.
 */
test("a dead hero leaves every proximity trigger", async () => {
  const { updateProximityTriggers } = await import("../src/socket/triggers.js");

  const hero = { doid: 7001, constant: "HERO_WARRIOR", position: { x: 500, y: 500 } };
  const states = [];
  const session = {
    id: 81,
    heroDoid: 7001,
    actors: new Map([[7001, hero]]),
    signalValues: new Map(),
    signalTargets: new Map(),
    triggers: [{ id: "prox", constant: "PROXIMITY_TRIGGER", x: 500, y: 500, radius: 150 }],
    send: () => {},
  };

  updateProximityTriggers(session, hero.position);
  states.push(session.signalValues.get("prox"));

  hero.dead = true;
  updateProximityTriggers(session, hero.position);
  states.push(session.signalValues.get("prox"));

  hero.dead = false;
  updateProximityTriggers(session, hero.position);
  states.push(session.signalValues.get("prox"));

  assert.deepEqual(states, [true, false, true], "entered, released on death, re-entered on revive");
});

/**
 * A layout places the same tile more than once, and a tile's object ids are
 * only unique inside its own definition. Without the instance prefix two copies
 * hand the floor the same id, and every map keyed by placement id keeps one of
 * them — which is one button in a row of five doing nothing.
 */
test("two copies of a tile do not share placement ids", async () => {
  const { buildFloor } = await import("../src/socket/floors.js");

  let checked = 0;
  for (const seed of [3, 11, 21, 34]) {
    const floor = await buildFloor("Resources/Levels/castle/arena/tiles.json", {
      tier: 10,
      tileCount: 25,
      seed,
    });
    const placements = [
      ...floor.placements.triggerable,
      ...floor.placements.trigger,
      ...floor.placements.logicGate,
      ...floor.placements.generator,
    ];
    const ids = new Set(placements.map((placement) => placement.id));
    assert.equal(ids.size, placements.length, `seed ${seed} reused a placement id`);

    // And the wiring still reaches them: every target named by a link exists.
    const known = new Set(placements.map((placement) => placement.id));
    for (const [, targets] of floor.wiring) {
      for (const target of targets) {
        if (known.has(target)) checked += 1;
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} wiring links resolved to a placement`);
});

/**
 * A shot is not stopped by the lip of its own mounting.
 *
 * A trap mounted flush against a wall launches from a clear point, but its
 * collision circle overlaps the mounting the moment it moves, and the first
 * sweep used to clip that and kill the shot. Laying out the aztec tiles, one
 * arrow trap firing along Y has geometry 5 units ahead and nothing at all from
 * 10 onwards, and it never fired.
 *
 * Asserted against the real library rather than a mock, because the thing being
 * tested is a few units wide and the navigation grid is 60 — a hand-built lip
 * lands in the same cell as the muzzle and proves nothing.
 */
test("a shot only dies at the muzzle when it is aimed into something solid", async () => {
  const { buildFloor } = await import("../src/socket/floors.js");
  const { npcForConstant } = await import("../src/gamemaster.js");
  const { performTrapAttack, tickTrapProjectiles } = await import("../src/socket/combat.js");
  const { createNavigationState, isPositionBlocked } = await import(
    "../src/socket/navigation.js"
  );

  let launchers = 0;
  for (const seed of [14, 34]) {
    const floor = await buildFloor("Resources/Levels/jungle/aztec/tiles.json", {
      tier: 10,
      tileCount: 25,
      seed,
    });
    const navigation = createNavigationState(floor.navigation);

    for (const placement of floor.placements.triggerable) {
      const npc = await npcForConstant(placement.constant);
      const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
      if (!attack?.Projectile) continue;
      const projectile = await projectileForConstant(attack.Projectile);
      const radius = Math.max(0, projectile.CollisionSize ?? 15);
      const heading = Number(placement.heading ?? npc.DefaultHeading ?? 0);
      const radians = (heading * Math.PI) / 180;

      const session = {
        id: 26,
        heroDoid: 7001,
        heroPosition: { x: -9999, y: -9999 },
        actors: new Map(),
        objects: new Map([[9101, CLID.DistributedNPCGameObject]]),
        navigation,
        send: () => {},
      };
      await performTrapAttack(session, 9101, {
        attack,
        projectile,
        position: { x: placement.x, y: placement.y, heading },
      });
      let ticks = 0;
      while (session.activeTrapProjectiles?.length && ticks < 40) {
        await tickTrapProjectiles(session, 0.05);
        ticks += 1;
      }

      // Where the shot's own body has cleared the mounting.
      const muzzle = {
        x: placement.x + Math.cos(radians) * radius,
        y: placement.y + Math.sin(radians) * radius,
      };
      const solid = isPositionBlocked(navigation, muzzle, radius);
      assert.equal(
        ticks <= 1,
        solid,
        `${placement.constant} h${heading} died at the muzzle=${ticks <= 1} but solid there=${solid}`
      );
      launchers += 1;
    }
  }
  assert.ok(launchers > 10, `only ${launchers} launchers checked`);
});

/**
 * An exploding barrel is scenery with a DeathAttack, and the column was only
 * honoured on the placeable path — so bombs went off and barrels did not. The
 * bang is a beat late, and has to be: the captures land 148
 * `EN_EXPLODING_BARREL_DEATH_ARENA` results at 1216-1254ms after the animation,
 * against an authored frame 29, which is 1208ms.
 */
test("a broken barrel goes off on its authored frame", async () => {
  const { attackForConstant, npcForConstant, attackColliders } = await import(
    "../src/gamemaster.js"
  );
  const { worldColliders } = await import("../src/socket/heading.js");
  const { playDeathAttack } = await import("../src/socket/hazards.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("CASTLE_ARENA_EXPLODING_BARREL");
  assert.ok(npc.DeathAttack, "the barrel authors one");
  const attack = await attackForConstant(npc.DeathAttack);
  const frames = [
    ...new Set(((await attackColliders(attack.AttackTimeline)) ?? []).map((c) => Number(c.frame ?? 0))),
  ];
  assert.deepEqual(frames, [29], "one burst, late in the timeline");

  const at = { x: 2000, y: 2000 };
  const sent = [];
  const hurt = [];
  const session = {
    id: 28,
    dungeonActive: true,
    heroDoid: 7001,
    heroPosition: { x: 2000, y: 2022 },
    objects: new Map([[9500, CLID.DistributedNPCGameObject], [7001, CLID.HeroGameObject]]),
    actors: new Map([
      [7001, { doid: 7001, constant: "RANGER", hitPoints: 900, maxHitPoints: 900 }],
    ]),
    send: (frame) => {
      const head = readUpdateHead(frame);
      sent.push(head.fieldId);
      if (head.fieldId === 151) hurt.push(true);
    },
  };

  const colliders = worldColliders(at, 0, await attackColliders(attack.AttackTimeline));
  assert.equal(await playDeathAttack(session, 9500, attack, at, colliders), true);

  // The choreography goes out at once; the damage does not.
  assert.deepEqual(sent, [143], "the bang is announced and nothing has been hurt yet");
  assert.equal(hurt.length, 0);
});

/**
 * A patch of fire on the ground burns whoever stands in it, with nothing
 * switching it on. `CharType` is what says so, and the captures split the two
 * rows by it: `BURNING_FIRE_PLACEABLE` is an ENEMY and 7 of its 24 never-stated
 * doids hurt the hero anyway; `BURNING_FIRE_PLACEABLE_ALL` is a BEAST with the
 * same asset, attack, layer and timer, and its unstated doids hurt nobody.
 */
test("a stationary burner is live and its twin waits to be switched", async () => {
  const { npcForConstant } = await import("../src/gamemaster.js");

  const live = await npcForConstant("BURNING_FIRE_PLACEABLE");
  const switched = await npcForConstant("BURNING_FIRE_PLACEABLE_ALL");

  // One column apart, and it is the one the engine's AI gate reads.
  assert.equal(live.CharType, "ENEMY");
  assert.equal(switched.CharType, "BEAST");
  for (const field of ["Attack1", "AssetClassName", "DefaultLayer", "AttackTimer", "IsMover"]) {
    assert.deepEqual(live[field], switched[field], `${field} differs`);
  }
  assert.equal(live.IsMover, 0, "it does not move, which is why it needs this");
  assert.ok(live.InstantAttack);

  // The rule is the family, not the row: eight say the same thing.
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  const family = [...gm.npcByConstant.values()].filter(
    (npc) => npc.CharType === "ENEMY" && !npc.IsMover && npc.InstantAttack && npc.Attack1
  );
  assert.equal(family.length, 8, family.map((npc) => npc.Constant).join(" "));
  assert.ok(
    family.every((npc) => npc.Aggro_AI_Type === "CHASE_AI" && npc.AggroRadius === 60),
    "and they are one idea rather than a grab-bag"
  );
});

/**
 * A barrel explodes with its own strength, not the strength of whoever broke
 * it. computeDamage falls back to session.weaponPower when given none, which is
 * the hero's — and the official charges 3: 140 results against monsters at -3
 * and -6, 8 against the hero at -3, from an attack with DamageMod -3, no
 * percent-health line, and a barrel whose weapon is Power 1.
 */
test("a barrel's bang is priced by the barrel", async () => {
  const { attackForConstant, npcForConstant, weaponForConstant, attackColliders } = await import(
    "../src/gamemaster.js"
  );
  const { worldColliders } = await import("../src/socket/heading.js");
  const { playDeathAttack } = await import("../src/socket/hazards.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("CASTLE_ARENA_EXPLODING_BARREL");
  const attack = await attackForConstant(npc.DeathAttack);
  assert.equal(attack.DoPercentHealthDamage, undefined, "flat, not a share of the bar");
  assert.equal(attack.DamageMod, -3);
  const weapon = await weaponForConstant(npc.Weapon1);
  assert.equal(weapon.Power, 1, "and the barrel is as strong as a barrel");

  const at = { x: 3000, y: 3000 };
  const session = {
    id: 29,
    dungeonActive: true,
    heroDoid: 7001,
    heroPosition: { x: 3000, y: 3022 },
    // Standing on it. A hero swinging something enormous, which is what used to
    // price the bang.
    weaponPower: 9000,
    objects: new Map([[9600, CLID.DistributedNPCGameObject], [7001, CLID.HeroGameObject]]),
    actors: new Map([
      [7001, { doid: 7001, constant: "RANGER", hitPoints: 5000, maxHitPoints: 5000 }],
      // The barrel itself, dead, as the floor would still have it.
      [9600, { doid: 9600, constant: npc.Constant, hitPoints: 0, maxHitPoints: 1, dead: true }],
    ]),
    send: () => {},
  };

  const colliders = worldColliders(at, 0, await attackColliders(attack.AttackTimeline));
  await playDeathAttack(session, 9600, attack, at, colliders, { npc, weaponPower: weapon.Power });
  // Its one collider is on frame 29, which is 1208ms.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (let drain = 0; drain < 4; drain += 1) await settle();

  const dealt = 5000 - session.actors.get(7001).hitPoints;
  assert.equal(dealt, 3, `a barrel stings rather than mauls; the official charges 3, took ${dealt}`);
});

/**
 * `DefaultLayer` on an NPC row is not a fallback for a placement that names no
 * layer — the official never reads it, and treating it as one puts two props
 * under the floor.
 *
 * Exactly two constants in the game's tile data can tell the rules apart:
 * `NORDIC_CAVE_EMITTER` and `CASTLE_ARENA_TRAP_SPIKES_A`, whose rows say
 * `background` while none of their placements names a layer. The corpus
 * generates them 73 times between them and every one arrives on layer 20.
 */
test("a placement with no layer is sorted, not the row's default", async () => {
  const { npcForConstant } = await import("../src/gamemaster.js");
  const { layerFor, LAYER_SORTED } = await import("../src/socket/objects.js");

  for (const constant of ["NORDIC_CAVE_EMITTER", "CASTLE_ARENA_TRAP_SPIKES_A"]) {
    const npc = await npcForConstant(constant);
    assert.equal(npc.DefaultLayer, "background", `${constant} is the discriminating case`);
    assert.equal(layerFor(npc, undefined), LAYER_SORTED, constant);
  }

  // A placement that does name one still wins, which is the rest of the corpus.
  const spikes = await npcForConstant("CASTLE_ARENA_TRAP_SPIKES_C");
  assert.equal(layerFor(spikes, "background"), 10);
  assert.equal(layerFor(spikes, "foreground"), 30);
});

/**
 * A flipped trap fires the way it faces.
 *
 * The mirroring belongs to `facingOf` in floors.js, which turns a flipped
 * object's `rotation` into `180 - rotation` and hands it over as the
 * placement's `heading`. Everything downstream reads that and must not mirror
 * it again — doing so put every flipped wall trap in the game back at zero,
 * drawn pointing left and shooting right.
 *
 * What this holds is that the three consumers agree: the actor's generate, the
 * shape its attack sweeps, and the direction its projectile flies. The last one
 * used to read a field nothing ever set, so every launcher fired due east.
 */
test("a trap's shot, sweep and sprite all read one heading", async () => {
  const { npcForConstant } = await import("../src/gamemaster.js");
  const { headingFor } = await import("../src/socket/dungeon.js");
  const { loadFloor } = await import("../src/socket/floors.js");

  const npc = await npcForConstant("NORDIC_TEMPLE_TRAP_EMITTER_A");
  assert.equal(npc.DefaultHeading ?? 0, 0);

  // floors.js has already mirrored a flipped placement; this must pass it on.
  assert.equal(headingFor(npc, { x: 0, y: 0, heading: 180, flip: 1 }), 180);
  assert.equal(headingFor(npc, { x: 0, y: 0, heading: undefined, flip: 0 }), 0);

  // And a rotation keeps its sign: CASTLE_ARENA_TRAP_ARROW_F is authored at
  // both -90 and 270, and the corpus carries both rather than normalising.
  const arrow = await npcForConstant("CASTLE_ARENA_TRAP_ARROW_F");
  assert.equal(headingFor(arrow, { x: 0, y: 0, heading: -90 }), -90);
  assert.equal(headingFor(arrow, { x: 0, y: 0, heading: 270 }), 270);

  /**
   * The temple authors 24 emitters unflipped and 24 flipped, and the corpus
   * generates them at heading 0 and heading 180. A real floor has to come out
   * on those two values and no others.
   */
  const floor = await loadFloor("tutorial");
  for (const placement of floor.placements.triggerable ?? []) {
    const row = await npcForConstant(placement.constant);
    if (!row) continue;
    assert.ok(Number.isFinite(headingFor(row, placement)), placement.constant);
  }
});

/**
 * Loki's statue keeps firing on its own timer.
 *
 * Most launchers author `AttackTimer` 0 and shoot once for each time they are
 * switched on; the statue authors 4 and is the only prop in the game that is
 * both a launcher and carries a beat. Nothing switches a statue back on — four
 * of the six in the temple capture are sent no trigger state at all — so
 * without a timer of its own it fired once and fell silent.
 */
test("a launcher with an AttackTimer keeps firing on it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const { attackForConstant, npcForConstant, projectileForConstant } = await import(
    "../src/gamemaster.js"
  );
  const { loadNavigationLibrary, createNavigationState } = await import(
    "../src/socket/navigation.js"
  );
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_TEMPLE_TRAP_STATUE_LOKI");
  const attack = await attackForConstant(npc.Attack1);
  const projectile = await projectileForConstant(attack.Projectile);
  assert.equal(npc.AttackTimer, 4, "the statue's authored beat");

  const statueDoid = 9600;
  const sent = [];
  const session = {
    id: 31,
    dungeonActive: true,
    heroDoid: 7001,
    // Within the fireball's reach, measured from the muzzle: a statue that
    // cannot hit the hero no longer tracks or fires at one. See withinReach.
    heroPosition: { x: 1000, y: 1300 },
    navigation: createNavigationState(null),
    objects: new Map([[statueDoid, CLID.DistributedNPCGameObject]]),
    actors: new Map(),
    triggerableDoids: new Map([["loki", statueDoid]]),
    triggerableHazards: new Map([
      ["loki", {
        attack, npc, projectile,
        heading: 0,
        position: { x: 1000, y: 1000 },
        combatColliders: [],
        weaponPower: 1,
      }],
    ]),
    send: (frame) => sent.push(frame),
  };

  raiseHazard(session, "loki");
  const shots = () => sent.filter((frame) => readUpdateHead(frame).fieldId === 143).length;
  const first = shots();
  assert.ok(first >= 1, "it fires when raised");

  t.mock.timers.tick(4000);
  assert.equal(shots(), first + 1, "one more on the beat");
  t.mock.timers.tick(4000);
  assert.equal(shots(), first + 2, "and it keeps going");

  clearHazardBeats(session);
  t.mock.timers.tick(8000);
  assert.equal(shots(), first + 2, "and stops with the dungeon");
});

/**
 * The room whose trigger sets off every barrel in it.
 *
 * `NPC_SUICIDE_TRIGGER` is typed `LETrigger` and is not a source: all fifteen
 * on a temple floor are wired *to* and none wires out, and each names an
 * exploding barrel by placement id. There are 169 across the nine libraries.
 */
test("a suicide trigger destroys the npc it names, once the floor stands", async () => {
  const { setTargets } = await import("../src/socket/triggers.js");

  const barrelDoid = 9700;
  const session = {
    id: 33,
    dungeonActive: true,
    heroDoid: 7001,
    objects: new Map([[barrelDoid, CLID.DistributedNPCGameObject]]),
    actors: new Map([
      [barrelDoid, { hitPoints: 1, maxHitPoints: 1, constant: "NORDIC_TEMPLE_EXPLODING_BARREL" }],
    ]),
    npcDoids: new Map([["barrel-1", barrelDoid]]),
    triggers: [{ id: "boom", constant: "NPC_SUICIDE_TRIGGER", npcId: "barrel-1" }],
    triggerableDoids: new Map(),
    triggerableHazards: new Map(),
    send: () => {},
  };

  /**
   * Not while the floor is still being built. A target with no resolvable
   * source rests on, so applying the opening state set off all fourteen barrels
   * on the temple's second floor as the player walked in — "there is an
   * explosion animation on entry and then they are gone".
   */
  setTargets(session, { targets: ["boom"] }, true);
  assert.equal(session.actors.get(barrelDoid).dead, undefined, "silent until the floor stands");

  session.floorSettled = true;
  setTargets(session, { targets: ["boom"] }, true);
  assert.ok(session.actors.get(barrelDoid).dead, "and then the barrel goes off");
});

/**
 * Nothing is announced about an object that has gone with its floor.
 *
 * `applyDamage`'s `announce` callback is what puts a CombatResult on the wire,
 * and it ran whatever else happened — including for a doid no longer tracked.
 * The client rejects those: `CombatResultAttackTimelineAction` looks the victim
 * up through `DistributedDungeonFloor.getActor` and warns "Tried to execute a
 * combat result on an actor that is not on the dungeon floor". One recorded
 * session carried that warning 171 times for a single doid.
 */
test("a hit on an object that is gone announces nothing", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");

  const doid = 9800;
  const announced = [];
  const session = {
    id: 61,
    dungeonActive: true,
    heroDoid: 7001,
    objects: new Map([[doid, CLID.DistributedNPCGameObject]]),
    actors: new Map([[doid, { hitPoints: 50, maxHitPoints: 50, constant: "BRUTE" }]]),
    send: () => {},
  };

  // While it is tracked, a hit lands and is announced.
  assert.equal(applyDamage(session, doid, 10, () => announced.push("live")), true);
  assert.equal(announced.length, 1);

  // Dead but still on the floor: no damage, but the result is still a result.
  session.actors.get(doid).dead = true;
  applyDamage(session, doid, 10, () => announced.push("dead"));
  assert.equal(announced.length, 2, "a dead actor still draws its number");

  // Gone with the floor: silence.
  session.objects.delete(doid);
  session.actors.delete(doid);
  applyDamage(session, doid, 10, () => announced.push("gone"));
  assert.equal(announced.length, 2, "nothing is said about what is not there");
});

test("a statue aims before it shoots, not on its own clock", async () => {
  /**
   * The flame that passes beside you and hurts anyway.
   *
   * `launchTrapProjectile` simulates the fireball along `hazard.heading`, and
   * the client draws it along the heading it last received. Those are the same
   * line only if the aim reaches it with the shot — and the aim used to run on
   * its own 250ms timer while the statue fired every four seconds, so the hero
   * had up to a quarter-second to move between the angle the client was told
   * and the angle that was simulated.
   *
   * The corpus is unambiguous about the order: the official sends a heading
   * immediately before 71 of its 84 recorded shots. This server managed 40 of
   * 838.
   */
  const { npcForConstant, attackForConstant, projectileForConstant, projectileLaunch } =
    await import("../src/gamemaster.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_TEMPLE_TRAP_STATUE_LOKI");
  const attack = await attackForConstant(npc.Attack1);
  const projectile = await projectileForConstant(attack.Projectile);

  const statueDoid = 9300;
  const heroDoid = 7002;
  const at = { x: 1000, y: 1000, heading: 0 };
  const sent = [];
  const session = {
    id: 26,
    dungeonActive: true,
    heroDoid,
    /**
     * Directly above the statue, so facing it is a quarter turn from heading 0,
     * and inside the fireball's reach *as measured from the muzzle* — which is
     * 180 units up, so the hero has to be nearer than the mount suggests.
     */
    heroPosition: { x: 1000, y: 1200 },
    objects: new Map([[statueDoid, CLID.DistributedNPCGameObject]]),
    actors: new Map(),
    triggerableDoids: new Map([["loki", statueDoid]]),
    triggerableHazards: new Map([
      [
        "loki",
        {
          attack,
          npc,
          projectile,
          position: at,
          launch: await projectileLaunch(attack.AttackTimeline),
          combatColliders: [],
        },
      ],
    ]),
    send: (frame) => sent.push(frame),
  };

  try {
    assert.equal(raiseHazard(session, "loki"), true);
    await settle();

    const fields = sent.map((frame) => readUpdateHead(frame).fieldId);
    const aimed = fields.indexOf(133);
    const shot = fields.indexOf(143);

    assert.notEqual(aimed, -1, "the statue tells the client where it is pointing");
    assert.notEqual(shot, -1, "and it shoots");
    assert.ok(aimed < shot, "the aim goes out before the shot it belongs to");

    /**
     * And it leaves from where the client draws it leaving.
     *
     * `TM_TRAP_LOKI_FIREBALL` carries `yOffset: -180` — the fireball comes out
     * of the statue's raised hands. Simulating from the mount put the damage on
     * a line 180 units from the flame, parallel to it: the reported "it goes
     * past me and I take the hit anyway".
     */
    const hazard = session.triggerableHazards.get("loki");
    assert.equal(hazard.launch.yOffset, -180, "the timeline says where the shot starts");

    const flying = session.activeTrapProjectiles ?? [];
    assert.equal(flying.length, 1, "one fireball in the air");
    assert.equal(flying[0].position.y, at.y - 180, "launched from the statue's hands");
    assert.equal(flying[0].position.x, at.x, "and directly above its centre");

    /**
     * And it does not reach across the whole floor. The data authors 1000 with
     * `IgnoreWalls`; the statue is the one trap that turns to follow you, and
     * being hit from two-thirds of a screen away through a wall reads as being
     * shot at from nowhere. Halved on purpose — see TURRET_RANGE_FACTOR.
     */
    assert.equal(flying[0].range, 500, "a tracking launcher reaches half the authored distance");

    // Aimed from that same point, so the flame and the damage are one line
    // that passes through the hero rather than two parallel ones.
    assert.equal(Math.round(hazard.heading), 90, "facing a hero due north of the muzzle");
    assert.ok(
      Math.abs(flying[0].direction.y - 1) < 1e-6 && Math.abs(flying[0].direction.x) < 1e-6,
      `it flies along the heading it announced, not ${JSON.stringify(flying[0].direction)}`
    );
  } finally {
    clearHazardBeats(session);
  }
});

test("a trap's blast does not take its neighbours with it", async () => {
  /**
   * Nine mines, gone before the player moved.
   *
   * `CombatGameObject.determineIfHitBasedOnTeam` is the client's whole rule —
   * a HOSTILE attack connects when the teams differ, a FRIENDLY one when they
   * match — and this server had no equivalent, so a trap hit everything
   * standing in it. `MINE_PLACEABLE_ALL` carries ten hit points and a blast
   * worth 52, and the temple lays nine of them together on team 7: the first to
   * go off killed the other eight inside three milliseconds, on every floor.
   *
   * The report was "there are no mines on the map", and it was exactly true.
   */
  const { npcForConstant, attackForConstant } = await import("../src/gamemaster.js");
  const { worldColliders } = await import("../src/socket/heading.js");
  const { attackColliders } = await import("../src/gamemaster.js");
  const { performTrapAttack } = await import("../src/socket/combat.js");
  const { TEAM } = await import("../src/socket/opcodes.js");

  const npc = await npcForConstant("MINE_PLACEABLE_ALL");
  const attack = await attackForConstant(npc.Attack1);
  assert.equal(attack.Team, "HOSTILE", "a mine's blast is hostile");

  const mineDoid = 9400;
  const neighbourDoid = 9401;
  const heroDoid = 7003;
  const at = { x: 800, y: 800 };
  const sent = [];
  const session = {
    id: 27,
    dungeonActive: true,
    heroDoid,
    heroPosition: { x: 820, y: 800 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [mineDoid, CLID.DistributedNPCGameObject],
      [neighbourDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, constant: "RANGER", team: TEAM.PLAYERS }],
      // Standing right next to it, on the same side.
      [neighbourDoid, {
        hitPoints: 10, maxHitPoints: 10, collisionRadius: 20,
        constant: "MINE_PLACEABLE_ALL", position: { x: 830, y: 800 }, team: TEAM.THIRD,
      }],
    ]),
    send: (frame) => sent.push(frame),
  };

  await performTrapAttack(session, mineDoid, {
    attack,
    npc,
    team: TEAM.THIRD,
    position: at,
    combatColliders: worldColliders(at, 0, await attackColliders(attack.AttackTimeline)),
  });

  assert.equal(
    session.actors.get(neighbourDoid).hitPoints,
    10,
    "the mine beside it is on the same team and is not touched"
  );
  assert.ok(
    session.actors.get(heroDoid).hitPoints < 4000,
    "and the hero, who is on another team, still takes it"
  );
});

test("a statue does not track a hero it cannot reach", async () => {
  /**
   * "They aggro from outside their range."
   *
   * A turret fires on its own `AttackTimer` and turns to follow the hero, and
   * this server did both at any distance — 166 heading updates per statue
   * against the official's 17. Every statue on the floor visibly aimed at the
   * player from across it, which reads as being targeted from somewhere the
   * fireball could never land.
   *
   * Bounded by the shot's own reach, so nothing that could have hit is lost.
   */
  const { npcForConstant, attackForConstant, projectileForConstant, projectileLaunch } =
    await import("../src/gamemaster.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_TEMPLE_TRAP_STATUE_LOKI");
  const attack = await attackForConstant(npc.Attack1);
  const projectile = await projectileForConstant(attack.Projectile);
  const statueDoid = 9500;
  const at = { x: 1000, y: 1000, heading: 0 };

  const build = (heroPosition) => {
    const sent = [];
    const session = {
      id: 28,
      dungeonActive: true,
      heroDoid: 7004,
      heroPosition,
      objects: new Map([[statueDoid, CLID.DistributedNPCGameObject]]),
      actors: new Map(),
      triggerableDoids: new Map([["loki", statueDoid]]),
      triggerableHazards: new Map([
        ["loki", { attack, npc, projectile, position: at, launch: { xOffset: 0, yOffset: -180 }, combatColliders: [] }],
      ]),
      send: (frame) => sent.push(frame),
    };
    return { session, sent };
  };

  // Far away: nothing is said and nothing is thrown.
  const far = build({ x: 5000, y: 5000 });
  raiseHazard(far.session, "loki");
  await settle();
  clearHazardBeats(far.session);
  assert.equal(far.sent.length, 0, "a statue out of reach says nothing at all");
  assert.equal((far.session.activeTrapProjectiles ?? []).length, 0, "and throws nothing");

  // Close enough that the fireball would land: it aims and fires as before.
  const near = build({ x: 1000, y: 1200 });
  raiseHazard(near.session, "loki");
  await settle();
  clearHazardBeats(near.session);
  assert.ok(near.sent.length > 0, "a statue in reach still works");
  assert.equal((near.session.activeTrapProjectiles ?? []).length, 1, "and throws one fireball");
});

test("a bomb that has gone off is taken off the floor", async () => {
  /**
   * "The bombs explode and the animation does not go away."
   *
   * This server used to end a mine's life by accident: mines stand close
   * together, a blast had no notion of sides, and the first to fire killed the
   * rest — dying through `applyDamage`, which tears an actor down properly.
   * Giving trap damage a team rule stopped that, correctly, and left nothing at
   * all ending them. The bomb detonated, fell out of its hazard loop, and stayed.
   *
   * The official closes one in three messages, in this order, and the corpus
   * shows every dying mine taking all three: hit points to zero, the state
   * string, then the disable. Zero on its own is a corpse standing up, because
   * `ActorGameObject.determineState` switches on the string.
   */
  const { npcForConstant, attackForConstant, attackColliders, attackTimelineFrames } =
    await import("../src/gamemaster.js");
  const { worldColliders } = await import("../src/socket/heading.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  const { TEAM } = await import("../src/socket/opcodes.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("MINE_PLACEABLE_ALL");
  const attack = await attackForConstant(npc.Attack1);

  const mineDoid = 9600;
  const heroDoid = 7005;
  const at = { x: 600, y: 600 };
  const sent = [];
  const session = {
    id: 29,
    dungeonActive: true,
    floorSettled: true,
    heroDoid,
    heroPosition: { x: 610, y: 600 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [mineDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, constant: "RANGER", team: TEAM.PLAYERS }],
    ]),
    triggerableDoids: new Map([["mine", mineDoid]]),
    triggerableHazards: new Map([
      [
        "mine",
        {
          attack, npc, team: TEAM.THIRD, contactBomb: true, position: at,
          // Its own animation is 25 frames at 24 a second; the corpse waits.
          timelineFrames: await attackTimelineFrames(attack.AttackTimeline),
          combatColliders: worldColliders(at, 0, await attackColliders(attack.AttackTimeline)),
        },
      ],
    ]),
    send: (frame) => sent.push(frame),
  };

  try {
    raiseHazard(session, "mine");
    await contactTick();

    /**
     * The bang lands first and the object is still there.
     *
     * The official puts a median of 1150ms between the two — its explosion is
     * 25 frames at 24 a second — and disables in the same millisecond as the
     * death. Doing all three at once took the mine away before the client could
     * draw any of it: the bomb vanished without exploding.
     */
    assert.ok(
      sent.some((frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
        readUpdateHead(frame).doid === mineDoid && readUpdateHead(frame).fieldId === 143),
      "the explosion is announced"
    );
    assert.ok(session.objects.has(mineDoid), "and the mine is still on the floor to show it");

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const opOf = (frame) => frame.readUInt16LE(2);
    const order = sent
      .filter((frame) => opOf(frame) === OP.CLIENT_OBJECT_UPDATE_FIELD)
      .map(readUpdateHead)
      .filter((head) => head.doid === mineDoid)
      .map((head) => head.fieldId);
    const disabled = sent.some(
      (frame) => opOf(frame) === OP.CLIENT_OBJECT_DISABLE_RESP && frame.readUInt32LE(4) === mineDoid
    );

    assert.ok(order.includes(136), "its hit points go to zero");
    assert.ok(order.includes(138), "and it is told it is dead");
    assert.ok(
      order.indexOf(136) < order.indexOf(138),
      "zero first, then the string that plays the death"
    );
    assert.ok(disabled, "and then it is disabled, which is what takes it off the screen");
    assert.ok(
      !session.objects.has(mineDoid),
      "and the server lets go of it, so nothing addresses it again"
    );
  } finally {
    clearHazardBeats(session);
  }
});

/**
 * A ground trap hurts everybody standing on it, not just whoever started it.
 *
 * `heroOnly` means "heroes, not monsters" — it is set from the trap's layer,
 * because a hazard drawn under the sorted plane is scenery to an NPC. It was
 * implemented as `victim.doid !== session.heroDoid`, which is the same thing
 * when there is one hero and quietly the wrong thing when there are two: the
 * timer belongs to whichever member's context raised it, so only that player
 * ever took damage.
 *
 * Reported from play — two in a dungeon, one hurt by the spikes and one walking
 * through them untouched.
 */
test("a ground trap hurts every hero standing in it, not only the timer's owner", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { npcForConstant, attackForConstant } = await import("../src/gamemaster.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  const { raiseHazard, clearHazardBeats } = await import("../src/socket/hazards.js");
  await loadNavigationLibrary();

  const npc = await npcForConstant("NORDIC_CAVE_SPIKETRAP");
  const attack = await attackForConstant(npc.Attack1);
  const spikeDoid = 9500;
  const hostHero = 7101;
  const peerHero = 7102;

  const session = {
    id: 28,
    dungeonActive: true,
    // The context that raised the trap belongs to the host, as it would if the
    // host stepped on it first.
    heroDoid: hostHero,
    heroPosition: { x: 1000, y: 1010 },
    // The shared world knows both heroes; this is what the filter should ask.
    playerActors: new Set([hostHero, peerHero]),
    objects: new Map([
      [hostHero, CLID.HeroGameObject],
      [peerHero, CLID.HeroGameObject],
      [spikeDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [hostHero, {
        hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22,
        constant: "RANGER", position: { x: 1000, y: 1010 },
      }],
      [peerHero, {
        hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22,
        constant: "RANGER", position: { x: 1000, y: 1010 },
      }],
    ]),
    triggerableDoids: new Map([["spikes", spikeDoid]]),
    triggerableHazards: new Map([
      ["spikes", {
        attack, npc, heroOnly: true,
        position: { x: 1000, y: 1000 },
        combatColliders: [{ type: "circle", x: 1000, y: 1000, radius: 34, frame: 0 }],
      }],
    ]),
    send: () => {},
  };

  raiseHazard(session, "spikes");
  t.mock.timers.tick(100);
  for (let drain = 0; drain < 4; drain += 1) await settle();
  await settle();
  clearHazardBeats(session);

  assert.ok(session.actors.get(hostHero).hitPoints < 4000, "the host is hurt");
  assert.ok(
    session.actors.get(peerHero).hitPoints < 4000,
    "and so is the other player standing in the same spikes"
  );
});

/**
 * The trap aims its effect at whoever it caught.
 *
 * `targetActorDoid` is where the client plays a "play at target" effect, and a
 * zero is not a neutral choice: `PlayEffectTimelineAction` returns without
 * playing anything when the target is missing. The official names one 20852
 * times out of 25003, so this is a field it uses rather than one it ignores.
 *
 * It was read as "did this catch *my* hero", which in a party is only true for
 * whichever member's context the timer belongs to — so a trap that caught the
 * other player named nobody and drew nothing, for everyone.
 */
test("a trap names the hero it caught, not the session's own", async () => {
  const { performTrapAttack } = await import("../src/socket/combat.js");
  const { npcForConstant, attackForConstant } = await import("../src/gamemaster.js");
  const { PacketReader } = await import("../src/socket/packet.js");

  const npc = await npcForConstant("NORDIC_CAVE_SPIKETRAP");
  const attack = await attackForConstant(npc.Attack1);
  const trapDoid = 9600;
  const hostHero = 7201;
  const peerHero = 7202;
  const sent = [];

  const session = {
    id: 30,
    dungeonActive: true,
    // The timer belongs to the host, but only the other player is standing in it.
    heroDoid: hostHero,
    playerActors: new Set([hostHero, peerHero]),
    objects: new Map([
      [hostHero, CLID.HeroGameObject],
      [peerHero, CLID.HeroGameObject],
      [trapDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [hostHero, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22,
                   constant: "RANGER", position: { x: 9000, y: 9000 } }],
      [peerHero, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22,
                   constant: "RANGER", position: { x: 1000, y: 1010 } }],
    ]),
    send: (frame) => sent.push(frame),
  };

  await performTrapAttack(session, trapDoid, {
    attack,
    npc,
    position: { x: 1000, y: 1000 },
    combatColliders: [{ type: "circle", x: 1000, y: 1000, radius: 34, frame: 0 }],
  });

  const choreography = sent.find((frame) => frame.readUInt16LE(8) === 143);
  assert.ok(choreography, "the trap animates");
  const reader = new PacketReader(choreography.subarray(2));
  reader.u16(); reader.u32(); reader.u16();   // opcode, doid, field
  reader.u8(); reader.u8(); reader.u32();     // weaponSlot, isConsumable, attackType
  assert.equal(reader.u32(), peerHero, "aimed at the player actually standing in it");
});

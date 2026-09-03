import assert from "node:assert/strict";
import test from "node:test";

import { buildFloorWorld } from "../src/socket/dungeon.js";
import { tickNpcAi } from "../src/socket/ai.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";

const fightingAi = (kind) => ({
  kind,
  state: "idle",
  engaged: false,
  aggroRadius: 600,
  disengageDistance: 1600,
  moveSpeed: 180,
  collisionRadius: 25,
  attackRange: 80,
  attackTimerMs: 1500,
  attackRandMs: 0,
  nextAttackAt: Number.POSITIVE_INFINITY,
  attackType: 920050,
  attacks: [
    {
      attackType: 920050,
      range: 80,
      minRange: 0,
      rechargeMs: 0,
      readyAt: 0,
      damage: 1,
      attackColliders: [],
    },
  ],
});

test("team-six enemies and a wild beast choose one another across the team boundary", async () => {
  const heroDoid = 10;
  const enemyDoid = 20;
  const beastDoid = 30;
  const staticTrapDoid = 40;
  const actors = new Map([
    [heroDoid, {
      hitPoints: 200,
      maxHitPoints: 200,
      collisionRadius: 25,
      position: { x: 1000, y: 0 },
      team: TEAM.PLAYERS,
    }],
    [enemyDoid, {
      hitPoints: 200,
      maxHitPoints: 200,
      collisionRadius: 25,
      constant: "LION",
      isEnemy: true,
      position: { x: 0, y: 0 },
      team: TEAM.ENEMIES,
      ai: fightingAi("enemy"),
    }],
    [beastDoid, {
      hitPoints: 200,
      maxHitPoints: 200,
      collisionRadius: 25,
      constant: "LION_WILD",
      isBeast: true,
      position: { x: 200, y: 0 },
      team: TEAM.THIRD,
      ai: fightingAi("beast"),
    }],
    [staticTrapDoid, {
      hitPoints: 10,
      maxHitPoints: 10,
      constant: "MINE_PLACEABLE_ALL",
      position: { x: 20, y: 0 },
      team: TEAM.THIRD,
    }],
  ]);
  const session = {
    id: 50,
    heroDoid,
    heroPosition: { x: 1000, y: 0 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [enemyDoid, CLID.DistributedNPCGameObject],
      [beastDoid, CLID.DistributedNPCGameObject],
      [staticTrapDoid, CLID.DistributedNPCGameObject],
    ]),
    actors,
    send: () => {},
  };

  await tickNpcAi(session, 1000, 0.25);

  assert.equal(actors.get(enemyDoid).ai.targetDoid, beastDoid);
  assert.equal(actors.get(beastDoid).ai.targetDoid, enemyDoid);
  assert.notEqual(
    actors.get(enemyDoid).ai.targetDoid,
    staticTrapDoid,
    "a team-seven trap is not a third-party creature"
  );
  assert.ok(actors.get(enemyDoid).position.x > 0);
  assert.ok(actors.get(beastDoid).position.x < 200);
});

test("a normal lion and a wild lion can damage one another", async () => {
  const heroDoid = 10;
  const enemyDoid = 20;
  const beastDoid = 30;
  const enemyAi = fightingAi("enemy");
  const beastAi = fightingAi("beast");
  enemyAi.nextAttackAt = 0;
  beastAi.nextAttackAt = 0;
  enemyAi.moveSpeed = 0;
  beastAi.moveSpeed = 0;
  const actors = new Map([
    [heroDoid, {
      hitPoints: 200,
      maxHitPoints: 200,
      collisionRadius: 25,
      position: { x: 1000, y: 0 },
      team: TEAM.PLAYERS,
    }],
    [enemyDoid, {
      hitPoints: 1000,
      maxHitPoints: 1000,
      collisionRadius: 25,
      constant: "LION",
      isEnemy: true,
      position: { x: 0, y: 0 },
      team: TEAM.ENEMIES,
      ai: enemyAi,
    }],
    [beastDoid, {
      hitPoints: 1000,
      maxHitPoints: 1000,
      collisionRadius: 25,
      constant: "LION_WILD",
      isBeast: true,
      position: { x: 60, y: 0 },
      team: TEAM.THIRD,
      ai: beastAi,
    }],
  ]);
  const session = {
    id: 52,
    heroDoid,
    heroPosition: { x: 1000, y: 0 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [enemyDoid, CLID.DistributedNPCGameObject],
      [beastDoid, CLID.DistributedNPCGameObject],
    ]),
    actors,
    send: () => {},
  };

  await tickNpcAi(session, 1000, 0.1);

  assert.ok(actors.get(enemyDoid).hitPoints < 1000, "the wild lion hit the normal lion");
  assert.ok(actors.get(beastDoid).hitPoints < 1000, "the normal lion hit the wild lion");
  assert.equal(actors.get(heroDoid).hitPoints, 200, "the distant hero was not chosen instead");
});

test("a moving BEAST placement is built as third-party AI, not an inert prop", async (t) => {
  let nextDoid = 1000;
  const sent = [];
  const session = {
    id: 51,
    dungeonActive: true,
    dungeonEpoch: 1,
    dungeonZone: 10,
    mapNodeId: 50082,
    floorDoid: 100,
    floorIndex: 0,
    floorCount: 1,
    npcLevel: 43,
    floorPlan: { npcLevel: 43, tier: null },
    heroDoid: 10,
    heroPosition: { x: 0, y: 0 },
    heroStats: new Map(),
    heroSpawn: {
      doid: 10,
      heroType: 101,
      skinType: 151,
      playerId: 1,
      screenName: "Test",
      experiencePoints: 0,
      slotPoints: [0, 0, 0, 0],
      weapons: [],
      consumables: [],
      hitPoints: 200,
      manaPoints: 100,
      effectiveHitPoints: 200,
      collisionRadius: 25,
      scale: 1,
      constant: "BERSERKER",
    },
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    dungeonBusterPoints: 0,
    objects: new Map([[100, CLID.DistributedDungeonFloor]]),
    actors: new Map(),
    doobers: new Map(),
    allocateDoid(clid) {
      const doid = nextDoid++;
      this.objects.set(doid, clid);
      return doid;
    },
    sent,
    send: (frame) => sent.push(frame),
  };
  const floor = {
    generated: false,
    spawn: { x: 0, y: 0 },
    navigation: null,
    wiring: new Map(),
    tiles: [],
    placements: {
      npc: [{ id: "wild", constant: "LION_WILD", x: 200, y: 0 }],
      collectable: [],
      generator: [],
      triggerable: [],
      trigger: [],
      logicGate: [],
    },
  };
  t.after(() => {
    session.stopAi?.();
    session.stopTrapProjectiles?.();
    session.stopManaRegen?.();
  });

  await buildFloorWorld(session, {
    floor,
    floorDoid: session.floorDoid,
    isActive: () => session.dungeonActive,
  });

  const wild = [...session.actors.values()].find((actor) => actor.constant === "LION_WILD");
  assert.ok(wild);
  assert.equal(wild.team, TEAM.THIRD);
  assert.equal(wild.isBeast, true);
  assert.equal(wild.isEnemy, false, "wild beasts do not gate floor completion");
  assert.equal(wild.ai.kind, "beast");
  assert.equal(wild.ai.aggroRadius, 600, "wild beasts keep their authored local awareness");
  assert.ok(wild.ai.attacks.length >= 2, "the full authored attack kit is available");
  assert.ok(wild.stats instanceof Map, "its levelled combat stats are ready");
});

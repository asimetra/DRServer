import assert from "node:assert/strict";
import test from "node:test";

import { applyDamage, performNpcAttack } from "../src/socket/combat.js";
import { tickNpcAi } from "../src/socket/ai.js";
import {
  cancelPetRespawn,
  spawnEquippedPet,
} from "../src/socket/dungeon.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { loadNavigationLibrary } from "../src/socket/navigation.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";
import {
  equippedPetSpawn,
  petSpawnPosition,
  scaledNpcWeaponPower,
} from "../src/pets.js";
import { experienceForLevel } from "../src/progression.js";
import { netAttackDamage } from "../src/combat-damage.js";
import { readFrame, readNpc } from "./helpers/floor.js";

const contextWithPet = async (level = 75, npcId = 3301) => {
  await loadNavigationLibrary();
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(102);
  const avatar = {
    id: 7001,
    avatar_id: hero.Id,
    experience: experienceForLevel(gm, hero, level),
  };
  const account = {
    id: 9001,
    account_pets: [
      { id: 81, npc_id: npcId, equipped_hero: avatar.id, is_new: 0 },
    ],
  };
  const petSpawn = equippedPetSpawn(gm, account, avatar, hero);
  const sent = [];
  let nextDoid = 8000;
  const session = {
    id: 9,
    accountId: account.id,
    dungeonActive: true,
    dungeonEpoch: 1,
    floorDoid: 1002,
    heroDoid: avatar.id,
    heroPosition: { x: 1000, y: 1000 },
    petSpawn,
    objects: new Map([
      [1002, CLID.DistributedDungeonFloor],
      [avatar.id, CLID.HeroGameObject],
    ]),
    actors: new Map([
      [
        avatar.id,
        {
          hitPoints: 500,
          maxHitPoints: 500,
          collisionRadius: 26,
          position: { x: 1000, y: 1000 },
          team: TEAM.PLAYERS,
        },
      ],
    ]),
    sent,
    send: (frame) => sent.push(frame),
    allocateDoid(clid) {
      const doid = nextDoid++;
      this.objects.set(doid, clid);
      return doid;
    },
  };
  const context = {
    session,
    floorDoid: session.floorDoid,
    heroDoid: session.heroDoid,
    mapNodeId: 50002,
    gm,
    isActive: () => session.dungeonActive,
  };
  return { gm, hero, avatar, account, session, context, petSpawn };
};

test("an equipped inventory pet inherits its hero's level and only valid pet rows spawn", async () => {
  const { gm, hero, avatar, account } = await contextWithPet(75);
  const spawn = equippedPetSpawn(gm, account, avatar, hero);
  assert.deepEqual(
    { constant: spawn.constant, level: spawn.level, owner: spawn.ownerHeroDoid },
    { constant: "WOLF_PET", level: 75, owner: avatar.id }
  );

  const weapon = gm.weaponsByConstant.get("EN_PET_WOLF_WEAPON");
  assert.equal(scaledNpcWeaponPower(weapon, 74), 164);
  assert.equal(scaledNpcWeaponPower(weapon, 75), 167);
  assert.equal(scaledNpcWeaponPower(weapon, 100), 255);

  const corrupt = { ...account, account_pets: [{ id: 82, npc_id: 3306, equipped_hero: avatar.id }] };
  assert.equal(
    equippedPetSpawn(gm, corrupt, avatar, hero),
    null,
    "temporary PET summons cannot be smuggled in through account inventory"
  );
});

test("an equipped pet is generated behind its owner with the official wire fields", async (t) => {
  const { session, context, avatar } = await contextWithPet(75);
  t.after(() => cancelPetRespawn(session));

  const doid = await spawnEquippedPet(context, session);
  assert.equal(session.petDoid, doid);
  const frame = session.sent.map(readFrame).find(
    (entry) => entry.kind === "generate" && entry.doid === doid
  );
  assert.ok(frame);
  const pet = readNpc(frame.body);
  assert.equal(frame.parent, session.floorDoid);
  assert.equal(pet.type, 3301);
  assert.equal(pet.level, 75);
  assert.deepEqual([pet.x, pet.y], [1000, 889]);
  assert.equal(pet.hitPoints, 850);
  assert.equal(pet.weapons[0].power, 167);
  assert.equal(pet.team, TEAM.PLAYERS);
  assert.equal(pet.layer, 20);
  assert.equal(pet.masterId, avatar.id);
  assert.equal(session.actors.get(doid).isPet, true);
  assert.equal(session.actors.get(doid).ai.kind, "pet");
  assert.deepEqual(session.actors.get(doid).ai.collects, {
    gold: true,
    xp: true,
    crowd: true,
  });

  applyDamage(session, doid, pet.hitPoints);
  assert.equal(session.actors.has(doid), false);
  assert.equal(session.petDoid, null);
  assert.ok(session.petRespawnTimer, "a persistent pet schedules its configured respawn");
});

test("pet health follows the owning hero's level instead of the dungeon tier", async () => {
  const observed = [];
  for (const level of [1, 50, 100]) {
    const { session, context } = await contextWithPet(level);
    const doid = await spawnEquippedPet(context, session);
    observed.push(session.actors.get(doid).maxHitPoints);
  }
  assert.deepEqual(observed, [110, 600, 1100]);
});

test("pet weapon power and attack damage grow with the owning hero's level", async () => {
  const powers = [];
  const damages = [];
  for (const level of [1, 100]) {
    const { gm, session, context } = await contextWithPet(level);
    const doid = await spawnEquippedPet(context, session);
    const actor = session.actors.get(doid);
    const bite = actor.ai.attacks.find((attack) => attack.attackType === 920380);
    const attack = gm.attacksById.get(bite.attackType);
    powers.push(bite.weaponPower);
    damages.push(Math.abs(netAttackDamage({
      gm,
      attack,
      weaponPower: bite.weaponPower,
      attacker: actor.stats,
      defender: new Map(),
    })));
  }
  assert.deepEqual(powers, [5, 255]);
  assert.ok(damages[1] > damages[0] * 10, `${damages[0]} -> ${damages[1]}`);
});

test("persistent pets keep their authored awareness and ranged standoff", async () => {
  for (const [npcId, expected] of [
    [3301, { aggro: 600, standoff: 0 }],
    [3302, { aggro: 600, standoff: 200 }],
    [3303, { aggro: 800, standoff: 0 }],
    [3311, { aggro: 300, standoff: 0 }],
    [3316, { aggro: 600, standoff: 200 }],
  ]) {
    const { session, context } = await contextWithPet(75, npcId);
    const doid = await spawnEquippedPet(context, session);
    const ai = session.actors.get(doid).ai;
    assert.equal(ai.aggroRadius, expected.aggro, `npc ${npcId} awareness`);
    assert.equal(ai.keepDistance, expected.standoff, `npc ${npcId} standoff`);
  }
});

test("a dragon ignores distant rooms and opens with its fireball from range", async (t) => {
  const { session, context } = await contextWithPet(75, 3302);
  t.after(() => {
    for (const stop of session.hazardBeats?.values?.() ?? []) stop();
  });
  const petDoid = await spawnEquippedPet(context, session);
  const pet = session.actors.get(petDoid);
  const enemyDoid = 9100;
  session.objects.set(enemyDoid, CLID.DistributedNPCGameObject);
  session.actors.set(enemyDoid, {
    hitPoints: 500,
    maxHitPoints: 500,
    collisionRadius: 25,
    constant: "BRUTE",
    isEnemy: true,
    position: { x: 1700, y: 889 },
    team: TEAM.ENEMIES,
  });

  session.sent.length = 0;
  await tickNpcAi(session, 1000, 0.25);
  assert.deepEqual(pet.position, { x: 1000, y: 889 });
  assert.equal(pet.ai.state, "idle");

  session.actors.get(enemyDoid).position = { x: 1500, y: 889 };
  await tickNpcAi(session, 2000, 0.25);
  assert.equal(Math.round(pet.position.x), 1100);
  assert.equal(pet.ai.state, "attack");
  assert.equal(
    Math.round(Math.hypot(
      pet.position.x - session.actors.get(enemyDoid).position.x,
      pet.position.y - session.actors.get(enemyDoid).position.y
    )),
    400
  );
  const choreography = session.sent.find(
    (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
      frame.readUInt32LE(4) === petDoid && frame.readUInt16LE(8) === 143
  );
  assert.ok(choreography);
  assert.equal(choreography.readUInt32LE(12), 910021, "the dragon chose DRAGON_FIREBALL");
});

test("a pet returns to its owner when idle and chooses an enemy instead of its owner", async (t) => {
  const { session, context } = await contextWithPet(75);
  t.after(() => {
    cancelPetRespawn(session);
    for (const stop of session.hazardBeats?.values?.() ?? []) stop();
  });
  const petDoid = await spawnEquippedPet(context, session);
  const pet = session.actors.get(petDoid);

  await tickNpcAi(session, 1000, 0.1);
  assert.equal(Math.round(pet.position.y), 900);
  assert.equal(pet.ai.state, "return");

  const enemyDoid = 9100;
  session.objects.set(enemyDoid, CLID.DistributedNPCGameObject);
  session.actors.set(enemyDoid, {
    hitPoints: 500,
    maxHitPoints: 500,
    collisionRadius: 25,
    constant: "BRUTE",
    isEnemy: true,
    position: { x: 1000, y: 840 },
    team: TEAM.ENEMIES,
  });
  session.sent.length = 0;
  await tickNpcAi(session, 3000, 0.1);

  assert.equal(pet.ai.state, "attack");
  const choreography = session.sent.find(
    (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
      frame.readUInt32LE(4) === petDoid && frame.readUInt16LE(8) === 143
  );
  assert.ok(choreography, "the pet announces an attack");
  const reader = new PacketReader(choreography.subarray(2));
  reader.u16();
  reader.u32();
  reader.u16();
  reader.u8();
  reader.u8();
  reader.u32();
  assert.equal(reader.u32(), enemyDoid, "the choreography targets the enemy");
});

test("a dead pet returns as a new object and plays its teleport-in timeline", async (t) => {
  const { gm, session, context } = await contextWithPet(75);
  const wolf = gm.npcByConstant.get("WOLF_PET");
  const originalDelay = wolf.RespawnT;
  wolf.RespawnT = 0.01;
  t.after(() => {
    wolf.RespawnT = originalDelay;
    cancelPetRespawn(session);
  });

  const first = await spawnEquippedPet(context, session);
  applyDamage(session, first, session.actors.get(first).hitPoints);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(session.petDoid);
  assert.notEqual(session.petDoid, first);
  assert.equal(session.actors.get(session.petDoid).hitPoints, 850);
  const teleport = session.sent.find(
    (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
      frame.readUInt32LE(4) === session.petDoid && frame.readUInt16LE(8) === 145
  );
  assert.ok(teleport, "the replacement pet is introduced with TELEPORT_IN");
});

test("an enemy may target a nearer pet without confusing it for the owner hero", async () => {
  const sent = [];
  const heroDoid = 10;
  const petDoid = 11;
  const enemyDoid = 20;
  const session = {
    id: 10,
    heroDoid,
    heroPosition: { x: 1000, y: 0 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [petDoid, CLID.DistributedNPCGameObject],
      [enemyDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 200, maxHitPoints: 200, position: { x: 1000, y: 0 } }],
      [petDoid, {
        hitPoints: 100,
        maxHitPoints: 100,
        collisionRadius: 25,
        isPet: true,
        position: { x: 55, y: 0 },
        team: TEAM.PLAYERS,
      }],
      [enemyDoid, {
        hitPoints: 100,
        maxHitPoints: 100,
        collisionRadius: 25,
        isEnemy: true,
        position: { x: 0, y: 0 },
        team: TEAM.ENEMIES,
        ai: {
          kind: "enemy",
          state: "idle",
          engaged: false,
          aggroRadius: 500,
          disengageDistance: 1000,
          moveSpeed: 0,
          attackRange: 80,
          attackTimerMs: 1500,
          attackRandMs: 0,
          nextAttackAt: 0,
          attackType: 920050,
          damage: 1,
          attackColliders: [],
        },
      }],
    ]),
    sent,
    send: (frame) => sent.push(frame),
  };

  await tickNpcAi(session, 1000, 0.1);
  assert.equal(session.actors.get(petDoid).hitPoints, 99);
  assert.equal(session.actors.get(heroDoid).hitPoints, 200);
});

test("a nearby hero keeps aggro even when the pet is slightly closer", async () => {
  const sent = [];
  const heroDoid = 10;
  const petDoid = 11;
  const enemyDoid = 20;
  const session = {
    id: 11,
    heroDoid,
    heroPosition: { x: 80, y: 0 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [petDoid, CLID.DistributedNPCGameObject],
      [enemyDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 200, maxHitPoints: 200, position: { x: 80, y: 0 } }],
      [petDoid, {
        hitPoints: 100,
        maxHitPoints: 100,
        collisionRadius: 25,
        isPet: true,
        position: { x: 55, y: 0 },
        team: TEAM.PLAYERS,
      }],
      [enemyDoid, {
        hitPoints: 100,
        maxHitPoints: 100,
        collisionRadius: 25,
        isEnemy: true,
        position: { x: 0, y: 0 },
        team: TEAM.ENEMIES,
        ai: {
          kind: "enemy",
          state: "idle",
          engaged: false,
          aggroRadius: 500,
          disengageDistance: 1000,
          moveSpeed: 0,
          attackRange: 80,
          attackTimerMs: 1500,
          attackRandMs: 0,
          nextAttackAt: 0,
          attackType: 920050,
          damage: 1,
          attackColliders: [],
        },
      }],
    ]),
    sent,
    send: (frame) => sent.push(frame),
  };

  await tickNpcAi(session, 1000, 0.1);
  assert.equal(session.actors.get(enemyDoid).ai.targetDoid, heroDoid);
  assert.equal(session.actors.get(heroDoid).hitPoints, 199);
  assert.equal(session.actors.get(petDoid).hitPoints, 100);
});

test("a hero-targeted melee arc may still catch a pet as collateral", async () => {
  const heroDoid = 10;
  const petDoid = 11;
  const enemyDoid = 20;
  const session = {
    id: 13,
    heroDoid,
    heroPosition: { x: 60, y: 0 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [petDoid, CLID.DistributedNPCGameObject],
      [enemyDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, {
        hitPoints: 200,
        maxHitPoints: 200,
        collisionRadius: 25,
        position: { x: 60, y: 0 },
        team: TEAM.PLAYERS,
      }],
      [petDoid, {
        hitPoints: 100,
        maxHitPoints: 100,
        collisionRadius: 25,
        isPet: true,
        position: { x: 75, y: 0 },
        team: TEAM.PLAYERS,
      }],
      [enemyDoid, {
        hitPoints: 100,
        maxHitPoints: 100,
        collisionRadius: 25,
        heading: 0,
        position: { x: 0, y: 0 },
        team: TEAM.ENEMIES,
      }],
    ]),
    send: () => {},
  };

  await performNpcAttack(session, enemyDoid, {
    attackType: 920050,
    weaponPower: 1,
    damage: 1,
    impactFrame: 0,
    attackColliders: [
      { type: "circlecollider", xOffset: 60, yOffset: 0, radius: 50, frame: 0 },
    ],
  }, heroDoid);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(session.actors.get(heroDoid).hitPoints < 200);
  assert.ok(session.actors.get(petDoid).hitPoints < 100);
  assert.equal(session.actors.get(enemyDoid).hitPoints, 100);
});

test("only two enemies may deliberately peel from the hero onto one pet", async () => {
  const heroDoid = 10;
  const petDoid = 11;
  const enemyDoids = [20, 21, 22];
  const objects = new Map([
    [heroDoid, CLID.HeroGameObject],
    [petDoid, CLID.DistributedNPCGameObject],
  ]);
  const actors = new Map([
    [heroDoid, { hitPoints: 200, maxHitPoints: 200, position: { x: 250, y: 0 } }],
    [petDoid, {
      hitPoints: 100,
      maxHitPoints: 100,
      collisionRadius: 25,
      isPet: true,
      position: { x: 55, y: 0 },
      team: TEAM.PLAYERS,
    }],
  ]);
  for (const [index, doid] of enemyDoids.entries()) {
    objects.set(doid, CLID.DistributedNPCGameObject);
    actors.set(doid, {
      hitPoints: 100,
      maxHitPoints: 100,
      collisionRadius: 25,
      isEnemy: true,
      position: { x: index * 5, y: 0 },
      team: TEAM.ENEMIES,
      ai: {
        kind: "enemy",
        state: "idle",
        engaged: false,
        aggroRadius: 500,
        disengageDistance: 1000,
        moveSpeed: 0,
        attackRange: 80,
        attackTimerMs: 1500,
        attackRandMs: 0,
        nextAttackAt: Number.POSITIVE_INFINITY,
        attackType: 920050,
        damage: 1,
        attackColliders: [],
      },
    });
  }
  const session = {
    id: 12,
    heroDoid,
    heroPosition: { x: 250, y: 0 },
    objects,
    actors,
    send: () => {},
  };

  await tickNpcAi(session, 1000, 0.1);
  assert.deepEqual(
    enemyDoids.map((doid) => actors.get(doid).ai.targetDoid),
    [petDoid, petDoid, heroDoid]
  );
});

test("the measured initial pet offset is stable", () => {
  assert.deepEqual(petSpawnPosition({ x: 40, y: 90 }), { x: 40, y: -21 });
});

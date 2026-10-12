import assert from "node:assert/strict";
import test from "node:test";

import { applyDamage, performNpcAttack } from "../src/socket/combat.js";
import { tickNpcAi } from "../src/socket/ai.js";
import {
  cancelPetRespawn,
  spawnEquippedPet,
} from "../src/socket/dungeon.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";
import {
  equippedPetSpawn,
  petSpawnPosition,
  scaledNpcWeaponPower,
} from "../src/pets.js";
import { netAttackDamage } from "../src/combat-damage.js";
import { readFrame, readNpc } from "./helpers/floor.js";
import { contextWithPet } from "./helpers/pets.js";

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

test("level 75 wolf damage matches the official resistant neutral and weak hits", async () => {
  const { session, context } = await contextWithPet(75);
  const petDoid = await spawnEquippedPet(context, session);
  const pet = session.actors.get(petDoid);
  const bite = pet.ai.attacks.find((attack) => attack.attackType === 920380);
  const observed = [];

  for (const [index, constant] of ["ICE_IMP", "CRAZED_YETI", "BABY_YETI"].entries()) {
    const targetDoid = 9200 + index;
    session.objects.set(targetDoid, CLID.DistributedNPCGameObject);
    session.actors.set(targetDoid, {
      hitPoints: 2000,
      maxHitPoints: 2000,
      collisionRadius: 25,
      constant,
      isEnemy: true,
      position: { x: 1060, y: 889 },
      team: TEAM.ENEMIES,
    });
    await performNpcAttack(
      session,
      petDoid,
      {
        ...pet.ai,
        ...bite,
        // This assertion isolates pet damage categories; timeline geometry is
        // covered by the AI and generated matrix suites.
        attackColliders: [{ type: "circleCollider", radius: 1000, xOffset: 0, frame: 0 }],
        projectile: null,
      },
      targetDoid
    );
    observed.push(2000 - session.actors.get(targetDoid).hitPoints);
  }

  assert.deepEqual(observed, [144, 288, 576]);
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

  /**
   * Within its aggro radius, and within its TetherDist (300) of its owner,
   * who has walked on towards it: a pet takes on nothing it would have to
   * leave its owner's side for.
   */
  session.actors.get(enemyDoid).position = { x: 1500, y: 889 };
  session.heroPosition = { x: 1300, y: 889 };
  session.actors.get(session.heroDoid).position = { x: 1300, y: 889 };
  await tickNpcAi(session, 2000, 0.25);
  // One step at it, and the fireball from there.
  assert.ok(pet.position.x > 1090 && pet.position.x <= 1100, `walked at the enemy: ${pet.position.x}`);
  assert.equal(pet.ai.state, "attack");
  assert.ok(
    Math.hypot(
      pet.position.x - session.actors.get(enemyDoid).position.x,
      pet.position.y - session.actors.get(enemyDoid).position.y
    ) <= 420
  );
  const choreography = session.sent.find(
    (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
      frame.readUInt32LE(4) === petDoid && frame.readUInt16LE(8) === 143
  );
  assert.ok(choreography);
  assert.equal(choreography.readUInt32LE(12), 910021, "the dragon chose DRAGON_FIREBALL");
});

test("a dragon backs out of the bite/fireball dead zone instead of idling", async (t) => {
  const { session, context } = await contextWithPet(75, 3302);
  t.after(() => {
    for (const stop of session.hazardBeats?.values?.() ?? []) stop();
  });
  const petDoid = await spawnEquippedPet(context, session);
  const pet = session.actors.get(petDoid);
  const enemyDoid = 9150;
  session.objects.set(enemyDoid, CLID.DistributedNPCGameObject);
  session.actors.set(enemyDoid, {
    hitPoints: 500,
    maxHitPoints: 500,
    collisionRadius: 25,
    constant: "BRUTE",
    isEnemy: true,
    position: { x: 1150, y: 889 },
    team: TEAM.ENEMIES,
  });

  session.sent.length = 0;
  await tickNpcAi(session, 1000, 0.25);

  assert.equal(Math.round(pet.position.x), 950);
  assert.equal(pet.ai.state, "attack");
  const choreography = session.sent.find(
    (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
      frame.readUInt32LE(4) === petDoid && frame.readUInt16LE(8) === 143
  );
  assert.ok(choreography);
  assert.equal(choreography.readUInt32LE(12), 910021);
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

/**
 * What the client would never let anybody hit is not a pet's to chase either.
 * Infinite's lightning orb is an ENEMY row authored `IsAttackable 0`.
 */
test("a pet leaves an unattackable enemy alone", async (t) => {
  const { session, context } = await contextWithPet(75);
  t.after(() => {
    cancelPetRespawn(session);
    for (const stop of session.hazardBeats?.values?.() ?? []) stop();
  });
  const petDoid = await spawnEquippedPet(context, session);
  const pet = session.actors.get(petDoid);

  const orbDoid = 9100;
  session.objects.set(orbDoid, CLID.DistributedNPCGameObject);
  session.actors.set(orbDoid, {
    hitPoints: 1,
    maxHitPoints: 1,
    collisionRadius: 25,
    constant: "LIGHTNING_ORB_SHOOTER",
    isEnemy: true,
    attackable: false,
    position: { x: 1000, y: 840 },
    team: TEAM.ENEMIES,
  });
  await tickNpcAi(session, 3000, 0.1);

  assert.notEqual(pet.ai.targetDoid, orbDoid);
  assert.notEqual(pet.ai.state, "attack");
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
          attackColliders: [{ type: "circleCollider", radius: 100, xOffset: 0, frame: 0 }],
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
          // A point 65 past the edge of the 25 body: at 90, on the hero's
          // body (50..110) and past the pet's (30..80).
          attackColliders: [{ type: "circleCollider", radius: 0, xOffset: 65, frame: 0 }],
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

/**
 * The enemy's pick, as the official makes it (npc-targeting.js
 * `enemyTarget`): the player, unless a pet is within reach of one of its
 * attacks and no player is; and once it has a target, that one, while it
 * lives, is on the floor and is within its DisengageDist.
 */
const HERO = 10;
const PET = 11;
const ENEMY = 20;
const pickSession = ({ hero, pet, enemies = [{ x: 0, y: 0 }], attackRange = 80, projectile = null }) => {
  const objects = new Map([[HERO, CLID.HeroGameObject], [PET, CLID.DistributedNPCGameObject]]);
  const actors = new Map([
    [HERO, { hitPoints: 200, maxHitPoints: 200, collisionRadius: 25, position: { ...hero }, team: TEAM.PLAYERS }],
    [PET, { hitPoints: 100, maxHitPoints: 100, collisionRadius: 25, isPet: true, position: { ...pet }, team: TEAM.PLAYERS }],
  ]);
  for (const [index, at] of enemies.entries()) {
    objects.set(ENEMY + index, CLID.DistributedNPCGameObject);
    actors.set(ENEMY + index, {
      hitPoints: 100,
      maxHitPoints: 100,
      collisionRadius: 25,
      isEnemy: true,
      position: { ...at },
      team: TEAM.ENEMIES,
      ai: {
        kind: "enemy", state: "idle", engaged: false, aggroRadius: 1000, disengageDistance: 1200,
        moveSpeed: 0, attackRange, projectile, attackTimerMs: 1500, attackRandMs: 0,
        nextAttackAt: Number.POSITIVE_INFINITY, attackType: 920050, damage: 1, attackColliders: [],
        targetTimerMs: 2000,
      },
    });
  }
  return { id: 12, heroDoid: HERO, heroPosition: actors.get(HERO).position, objects, actors, send: () => {} };
};
const targetsOf = (session) => [...session.actors.values()].filter((actor) => actor.isEnemy).map((actor) => actor.ai.targetDoid);
const moveHero = (session, to) => {
  session.heroPosition = { ...to };
  session.actors.get(HERO).position = session.heroPosition;
};

test("every enemy with a pet in its reach and no hero in it takes the pet: there is no cap", async () => {
  const session = pickSession({ hero: { x: 250, y: 0 }, pet: { x: 55, y: 0 }, enemies: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }] });
  await tickNpcAi(session, 1000, 0.1);
  assert.deepEqual(targetsOf(session), [PET, PET, PET]);
});

test("a pet merely nearer than the hero, out of reach, is not taken", async () => {
  // Reach 80 + 50: the pet at 200 is out of it, and 200 nearer than the hero.
  const session = pickSession({ hero: { x: 400, y: 0 }, pet: { x: 200, y: 0 } });
  await tickNpcAi(session, 1000, 0.1);
  assert.deepEqual(targetsOf(session), [HERO]);
});

test("a shooter with both in reach takes the hero", async () => {
  const session = pickSession({ hero: { x: 300, y: 0 }, pet: { x: 55, y: 0 }, attackRange: 600, projectile: { Constant: "ARROW" } });
  await tickNpcAi(session, 1000, 0.1);
  assert.deepEqual(targetsOf(session), [HERO]);
});

test("a monster on the pet keeps it when the hero walks nearer, past ChangeTargetT", async () => {
  const session = pickSession({ hero: { x: 400, y: 0 }, pet: { x: 55, y: 0 } });
  await tickNpcAi(session, 1000, 0.1);
  assert.deepEqual(targetsOf(session), [PET]);
  moveHero(session, { x: -45, y: 0 });
  for (let now = 1250; now <= 6000; now += 250) await tickNpcAi(session, now, 0.25);
  assert.deepEqual(targetsOf(session), [PET], "the hero, nearer and in reach, does not take it");
});

test("a monster drops a dead, hidden or far target and picks again", async () => {
  for (const lose of [
    (session) => { const pet = session.actors.get(PET); pet.dead = true; pet.hitPoints = 0; },
    (session) => { session.actors.get(PET).teleportHidden = true; },
    (session) => { session.actors.get(PET).position = { x: 1500, y: 0 }; },
  ]) {
    const session = pickSession({ hero: { x: 300, y: 0 }, pet: { x: 55, y: 0 } });
    await tickNpcAi(session, 1000, 0.1);
    assert.deepEqual(targetsOf(session), [PET]);
    lose(session);
    await tickNpcAi(session, 1250, 0.25);
    await tickNpcAi(session, 1500, 0.25);
    assert.deepEqual(targetsOf(session), [HERO], lose.toString());
  }
});

test("the measured initial pet offset is stable", () => {
  assert.deepEqual(petSpawnPosition({ x: 40, y: 90 }), { x: 40, y: -21 });
});

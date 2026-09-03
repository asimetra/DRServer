import assert from "node:assert/strict";
import test from "node:test";

import { spawnNpcActions } from "../src/gamemaster.js";
import { handleProposeAttackChoreography } from "../src/socket/buster.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import {
  clearDungeonPlaceables,
  schedulePlaceables,
  spawnPlaceable,
  timelineDelayMs,
} from "../src/socket/placeables.js";
import { tickNpcAi } from "../src/socket/ai.js";

/** The poison pot's own action, as authored on TM_COOKING_COOLDOWN_POISON. */
const POISON_ACTION = {
  spawnname: "POISON_POULTRY_PLACEABLE_L3",
  offset: 60,
  headingOffsetAngle: 0,
  timetolive: 10,
  frame: 14,
};

const sessionWith = (overrides = {}) => {
  let nextDoid = 900;
  const sent = [];
  return {
    id: 41,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    heroManaPoints: 200,
    dungeonBusterPoints: 0,
    dungeonAvatar: { avatar_id: 104, experience: 0 },
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => ++nextDoid,
    sent,
    send: (packet) => sent.push(packet),
    ...overrides,
  };
};

/**
 * A framed packet is a u16 byte length, then the opcode, then the body — so the
 * opcode is at 2 and the payload at 4.
 */
const opcodeOf = (packet) => packet.readUInt16LE(2);
const bodyOf = (packet) => new PacketReader(packet.subarray(4));
const framesOf = (session) =>
  session.sent.map((packet) => ({ opcode: opcodeOf(packet), reader: bodyOf(packet) }));

test("server-owned timeline actions follow choreography play speed", () => {
  assert.equal(Math.round(timelineDelayMs(6, 1)), 250);
  assert.equal(Math.round(timelineDelayMs(6, 2)), 125);
  assert.equal(Math.round(timelineDelayMs(6, 0.5)), 500);
});

test("both spellings of the spawn-npc action are read, and disabled ones are not", async () => {
  const poison = await spawnNpcActions("TM_COOKING_COOLDOWN_POISON");
  assert.equal(poison.length, 1);
  assert.equal(poison[0].spawnname, "POISON_POULTRY_PLACEABLE_L3");
  assert.equal(poison[0].frame, 14);
  assert.equal(poison[0].timetolive, 10);

  // TM_DBUSTER_IRON_LEGION places three clones on three different frames.
  const legion = await spawnNpcActions("TM_DBUSTER_IRON_LEGION");
  assert.equal(legion.length, 3);
  assert.deepEqual(
    legion.map((action) => action.frame),
    [58, 64, 68]
  );

  // TM_LOOT_SPAWN_A1's only spawn is "#spawnnpc" — commented out in the data.
  assert.deepEqual(await spawnNpcActions("TM_LOOT_SPAWN_A1"), []);
});

test("an Iron Legion clone is a levelled mobile summon with its full attack kit", async (t) => {
  const [action] = await spawnNpcActions("TM_DBUSTER_IRON_LEGION");
  const session = sessionWith({
    dungeonAvatar: { avatar_id: 106, experience: 10_000_000 },
  });
  session.actors.set(session.heroDoid, {
    hitPoints: 1000,
    maxHitPoints: 1000,
    collisionRadius: 26,
    position: { ...session.heroPosition },
    team: TEAM.PLAYERS,
  });

  const doid = await spawnPlaceable(session, {
    action,
    origin: session.heroPosition,
    heading: 0,
    weaponPower: 10,
  });
  t.after(() => {
    clearDungeonPlaceables(session);
    for (const stop of session.hazardBeats?.values?.() ?? []) stop();
  });

  const clone = session.actors.get(doid);
  assert.equal(clone.isPet, true);
  assert.equal(clone.masterId, session.heroDoid);
  assert.equal(clone.maxHitPoints, 1100);
  assert.equal(clone.ai.kind, "pet");
  assert.equal(clone.ai.attacks.length, 4);

  const generate = session.sent.find((packet) => {
    const body = packet.subarray(2);
    return body.readUInt16LE(0) === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP &&
      body.readUInt32LE(12) === doid;
  });
  const reader = bodyOf(generate);
  reader.u32(); // parent
  reader.u32(); // zone
  assert.equal(reader.u16(), CLID.DistributedNPCGameObject);
  assert.equal(reader.u32(), doid);
  assert.equal(reader.u32(), 3306);
  assert.equal(reader.u8(), 100);
  reader.f32(); reader.f32(); reader.f32(); reader.f32();
  reader.u8();
  assert.equal(reader.u32(), 1100);
  assert.equal(reader.u32(), 27051);
  assert.equal(reader.u16(), 306);

  const enemyDoid = 9900;
  session.objects.set(enemyDoid, CLID.DistributedNPCGameObject);
  session.actors.set(enemyDoid, {
    hitPoints: 5000,
    maxHitPoints: 5000,
    collisionRadius: 25,
    constant: "BRUTE",
    isEnemy: true,
    position: { x: clone.position.x + 200, y: clone.position.y },
    team: TEAM.ENEMIES,
  });
  const start = { ...clone.position };
  session.sent.length = 0;
  await tickNpcAi(session, 1000, 0.25);
  await tickNpcAi(session, 1250, 0.25);

  assert.ok(clone.position.x > start.x, "the clone pursued the enemy");
  assert.ok(
    session.sent.some(
      (packet) => packet.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
        packet.readUInt32LE(4) === doid && packet.readUInt16LE(8) === 143
    ),
    "the clone attacked after reaching it"
  );
});

test("the poison pot schedules its cloud instead of charging Mana for nothing", async () => {
  const session = sessionWith({ heroWeapons: [{ type: 15503 }] });
  const proposal = new PacketWriter()
    .u8(0)
    .u8(0)
    .u32(901701) // COOKING_COOLDOWN_POISON
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

  await handleProposeAttackChoreography(session, new PacketReader(proposal));

  assert.equal(session.heroManaPoints, 180, "the authored 20 Mana is spent");
  assert.equal(session.placeableSpawnTimers.size, 1, "and something is scheduled for it");
  clearDungeonPlaceables(session);
});

test("a placed cloud joins the hero's team, not the team its own row names", async () => {
  const session = sessionWith({ dungeonAvatar: { avatar_id: 104, experience: 875525 } });
  const doid = await spawnPlaceable(session, {
    action: POISON_ACTION,
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });

  const generate = session.sent.find(
    (packet) => opcodeOf(packet) === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP
  );
  assert.ok(generate, "the cloud is generated as a distributed object");

  const reader = bodyOf(generate);
  assert.equal(reader.u32(), session.floorDoid, "parented to the floor");
  reader.u32(); // zone
  assert.equal(reader.u16(), CLID.DistributedNPCGameObject);
  assert.equal(reader.u32(), doid);
  assert.equal(reader.u32(), 3523, "POISON_POULTRY_PLACEABLE_L3");
  // The hero's level, not the row's Min_Level of 1 — a placeable is as strong
  // as whoever placed it. A maxed chef gives the same 100 the capture shows;
  // the untrained one the other tests use generates at 1.
  assert.equal(reader.u8(), 100, "levelled to the chef that threw it");
  reader.f32(); // x
  reader.f32(); // y
  reader.f32(); // heading
  reader.f32(); // scale
  reader.u8(); // flip
  reader.u32(); // hitPoints
  for (let i = 0; i < 4; i++) {
    reader.u32();
    reader.u16();
    reader.u8();
    reader.u8();
    reader.u32();
    reader.u32();
    reader.u32();
  }
  reader.utf(); // state
  /**
   * The row is authored CharType ENEMY because enemy chefs place the same bird.
   * Taking the team from there would have the pot poison the hero who threw it.
   */
  assert.equal(reader.u8(), TEAM.PLAYERS, "the placer owns it");
  reader.u8(); // layer
  reader.u8(); // triggerState
  assert.equal(reader.u32(), session.heroDoid, "and is its master");

  clearDungeonPlaceables(session);
});

test("the cloud lands in front of the hero, by the authored offset and heading", async () => {
  const session = sessionWith();
  // Heading is degrees on the wire: ActorGameObject.getHeadingAsVector is
  // (heading + offset) * PI / 180, so 90 faces +y and the offset is 60.
  await spawnPlaceable(session, {
    action: POISON_ACTION,
    origin: { x: 1000, y: 1000 },
    heading: 90,
  });

  const placed = [...session.actors.values()].at(-1);
  assert.ok(Math.abs(placed.position.x - 1000) < 0.01, "no drift across the facing");
  assert.ok(Math.abs(placed.position.y - 1060) < 0.01, "sixty units in front");

  clearDungeonPlaceables(session);
});

test("the cloud damages what the hero fights and never the hero", async () => {
  const session = sessionWith();
  session.objects.set(500, CLID.HeroGameObject);
  session.actors.set(500, {
    hitPoints: 400,
    maxHitPoints: 400,
    collisionRadius: 30,
    position: { x: 1000, y: 1000 },
  });
  session.objects.set(700, CLID.DistributedNPCGameObject);
  session.actors.set(700, {
    hitPoints: 500,
    maxHitPoints: 500,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 30,
    position: { x: 1040, y: 1000 },
  });
  /**
   * A hundred and forty units out. Attack.Range says 200 and would have caught
   * this one, but Range is how close the AI stands to start a swing — the hit
   * shape is the timeline's collider, and TM_TRAP_50_RADIUS_HIT means fifty.
   */
  session.objects.set(701, CLID.DistributedNPCGameObject);
  session.actors.set(701, {
    hitPoints: 500,
    maxHitPoints: 500,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 30,
    position: { x: 1200, y: 1000 },
  });

  await spawnPlaceable(session, {
    action: POISON_ACTION,
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });

  // Damage lands on its collider's own authored frame rather than in the call
  // that placed the thing — see the beat scheduling in `strike`.
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(session.actors.get(500).hitPoints, 400, "the hero who placed it is untouched");
  assert.ok(session.actors.get(700).hitPoints < 500, "the knight beside it is not");
  assert.equal(session.actors.get(701).hitPoints, 500, "the cloud reaches fifty, not two hundred");

  clearDungeonPlaceables(session);
});

test("a cloud that has burned out dies rather than standing there as a corpse", async () => {
  const session = sessionWith();
  const doid = await spawnPlaceable(session, {
    action: { ...POISON_ACTION, timetolive: 0.01 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });
  assert.equal(session.objects.get(doid), CLID.DistributedNPCGameObject);

  await new Promise((resolve) => setTimeout(resolve, 400));

  const states = framesOf(session).filter(
    ({ opcode }) => opcode === OP.CLIENT_OBJECT_UPDATE_FIELD
  );
  const sawDeadState = states.some(({ reader }) => {
    if (reader.u32() !== doid) return false;
    if (reader.u16() !== 138) return false; // DistributedNPCGameObject::state
    return reader.utf() === "dead";
  });
  assert.ok(sawDeadState, "the client only runs enterDeadState for the string");
  assert.ok(
    session.sent.some((packet) => opcodeOf(packet) === OP.CLIENT_OBJECT_DISABLE_RESP),
    "and the object is taken away after it"
  );
  assert.equal(session.objects.get(doid), undefined);
  assert.equal(session.actors.get(doid), undefined);
});

test("teardown cancels a scheduled cloud that never got to land", async () => {
  const session = sessionWith();
  await schedulePlaceables(session, {
    AttackTimeline: "TM_COOKING_COOLDOWN_POISON",
  });
  assert.equal(session.placeableSpawnTimers.size, 1);

  clearDungeonPlaceables(session);
  assert.equal(session.placeableSpawnTimers.size, 0);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(session.actors.size, 0, "nothing lands after the dungeon is gone");
});

test("a thrown bomb places its bomb, which is the only thing that does damage", async () => {
  const session = sessionWith();
  // CONSUMABLE_POISON_BOMB_ATTACK is authored DamageMod 0 — the attack itself
  // is not the weapon, the bomb it leaves is.
  session.heroConsumables = [{ type: 70026, count: 2 }];
  session.dungeonAvatar = { avatar_id: 104, experience: 0 };
  session.dungeonAccount = { account_stackables: [{ stack_id: 70026, count: 2 }] };
  session.queueAccountSave = () => {};
  session.objects.set(700, CLID.DistributedNPCGameObject);
  session.actors.set(700, {
    hitPoints: 900,
    maxHitPoints: 900,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 30,
    // Within the death attack's authored 200 range of where the bomb lands.
    position: { x: 1060, y: 1000 },
  });

  const proposal = new PacketWriter()
    .u8(0) // powerup slot, not a weapon slot
    .u8(1) // isConsumableWeapon
    .u32(910530) // CONSUMABLE_POISON_BOMB_ATTACK
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

  await handleProposeAttackChoreography(session, new PacketReader(proposal));
  assert.equal(session.heroConsumables[0].count, 1, "the bomb is spent either way");
  assert.equal(session.placeableSpawnTimers.size, 1, "and one is scheduled");

  /**
   * Its authored life is a tenth of a second and its own animation is two, and
   * a placeable stands for the longer of the two — so the bang is on the way
   * out at about two seconds rather than at once.
   */
  await new Promise((resolve) => setTimeout(resolve, 3000));

  assert.ok(session.actors.get(700).hitPoints < 900, "the knight beside it is hurt");
  assert.ok(
    session.sent.some((packet) => opcodeOf(packet) === OP.CLIENT_OBJECT_DISABLE_RESP),
    "and the bomb is gone afterwards"
  );
  clearDungeonPlaceables(session);
});

test("a crack performs as it lands, and runs along the ground", async () => {
  const session = sessionWith();
  /**
   * The crack is authored as a 40-radius circle stepping out from 150 to 500
   * units in front, so it passes over this one and never touches the one
   * standing on top of it.
   */
  session.objects.set(700, CLID.DistributedNPCGameObject);
  session.actors.set(700, {
    hitPoints: 900,
    maxHitPoints: 900,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 30,
    position: { x: 1200, y: 1000 },
  });
  session.objects.set(701, CLID.DistributedNPCGameObject);
  session.actors.set(701, {
    hitPoints: 900,
    maxHitPoints: 900,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 30,
    position: { x: 1030, y: 1000 },
  });

  /**
   * FISSURE_SMASH_AXE carries no Attack1 at all, only DeathAttack — and having
   * nothing else to do is exactly why it performs on arrival rather than on the
   * way out. The captures time its choreography at 91ms after the generate and
   * its removal at 920, where a garlic cloud's arrives at 1272ms of a 1327ms
   * life. A placeable that can catch somebody has a reason to wait; one that
   * cannot has none.
   */
  const doid = await spawnPlaceable(session, {
    action: { spawnname: "FISSURE_SMASH_AXE", offset: 20, timetolive: 0.03, frame: 6 },
    // It lives as long as it animates — 19 frames, 792ms — not the 30ms
    // `timetolive` asks for. The official's three lived 907, 919 and 920.
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });
  // The official starts the death choreography on the next simulation turn,
  // 84-91ms after generate, rather than in the same packet burst.
  const immediate = session.sent.filter(
    (packet) => packet.length >= 10 && packet.readUInt16LE(8) === 143
  ).length;
  assert.equal(immediate, 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const choreographies = session.sent.filter(
    (packet) => packet.length >= 10 && packet.readUInt16LE(8) === 143
  ).length;
  assert.ok(choreographies >= 1, "it begins on the next server turn, not at expiry");

  // The damage is the part that waits: eight colliders on frames 3 to 17, each
  // striking on its own, so the last is 708ms behind the first.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(session.actors.get(700).hitPoints < 900, "the crack reaches the one it runs under");
  assert.equal(
    session.actors.get(701).hitPoints,
    900,
    "and not the one at the hero's feet — it starts 150 units out"
  );
  assert.equal(session.objects.get(doid), undefined);
});

test("the crack is drawn the way it is dealt", async () => {
  const session = sessionWith();
  // Along the facing, where the colliders run.
  knightAt(session, 700, 1000, 1200);
  // Where the crack would run if the client were left at heading zero.
  knightAt(session, 701, 1200, 1000);

  await spawnPlaceable(session, {
    action: { spawnname: "FISSURE_SMASH_AXE", offset: 20, timetolive: 0.03, frame: 6 },
    origin: { x: 1000, y: 1000 },
    heading: 90,
  });

  /**
   * The aim is a field update behind the generate, not a value in it: every one
   * of the 158 captured hero-placed generates says heading 0, and the official
   * corrects it 0 to 1ms later. Ours sent the generate and nothing after, so
   * the damage ran the way the hero swung while the picture always pointed
   * east.
   */
  const aimed = session.sent.filter(
    (packet) => packet.length >= 12 && packet.readUInt16LE(8) === 133
  );
  assert.equal(aimed.length, 1, "the client is told which way it points");
  assert.equal(aimed[0].readFloatLE(10), 90);

  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(session.actors.get(700).hitPoints < 900, "and that is the way it runs");
  assert.equal(session.actors.get(701).hitPoints, 900, "not the way it used to be drawn");
});

/** A knight standing on the spot a placeable will land. */
const knightAt = (session, doid, x, y) => {
  session.objects.set(doid, CLID.DistributedNPCGameObject);
  session.actors.set(doid, {
    hitPoints: 900,
    maxHitPoints: 900,
    constant: "KNIGHT_TUTORIAL",
    isEnemy: true,
    collisionRadius: 30,
    position: { x, y },
  });
};

test("a trap left on empty floor stands armed until something reaches it", async () => {
  const session = sessionWith();
  const doid = await spawnPlaceable(session, {
    action: { spawnname: "STICKY_MINE_PLACEABLE", offset: 40, timetolive: 60, frame: 6 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(
    session.objects.get(doid),
    CLID.DistributedNPCGameObject,
    "nobody came, so it is still waiting"
  );
  clearDungeonPlaceables(session);
});

test("a trap goes off once and is spent, rather than ticking like an aura", async () => {
  const session = sessionWith();
  knightAt(session, 700, 1040, 1000);

  // STICKY_MINE_PLACEABLE carries no InstantAttack. The captured garlic trap
  // sat quiet, exploded once and was dead a second later; ours used to explode
  // every second for the sixty seconds it was authored to stand.
  const doid = await spawnPlaceable(session, {
    action: { spawnname: "STICKY_MINE_PLACEABLE", offset: 40, timetolive: 60, frame: 6 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });

  /**
   * A throw that connects goes off as it lands, but its damage arrives on the
   * collider's authored frame — which is the whole distance between a bomb
   * that explodes and a bomb that has already killed the room.
   */
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(session.actors.get(700).hitPoints < 900, "it catches what it lands on");
  /**
   * Still there, briefly. TM_TRAP_TRIPMINE puts its `suicide` on frame 23,
   * which is the pause the client needs to play the blast — killing it in the
   * same millisecond as the choreography meant the explosion was never seen.
   */
  assert.equal(
    session.objects.get(doid),
    CLID.DistributedNPCGameObject,
    "and is still there while the blast plays"
  );

  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(session.objects.get(doid), undefined, "then it is spent");
  const before = session.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(session.sent.length, before, "with no second explosion after it");
  clearDungeonPlaceables(session);
});

test("an aura in an empty room animates for nobody", async () => {
  const session = sessionWith();
  // No knight anywhere: the captured cloud that landed away from the fight
  // played no choreography at all before it expired.
  await spawnPlaceable(session, {
    action: POISON_ACTION,
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });

  const choreographies = framesOf(session).filter(({ opcode, reader }) => {
    if (opcode !== OP.CLIENT_OBJECT_UPDATE_FIELD) return false;
    reader.u32();
    return reader.u16() === 143; // ReceiveAttackChoreography
  });
  assert.equal(choreographies.length, 0, "no swing is broadcast into an empty room");
  clearDungeonPlaceables(session);
});

test("an aura keeps hitting for as long as it stands", async () => {
  const session = sessionWith();
  knightAt(session, 700, 1060, 1000);

  await spawnPlaceable(session, {
    action: { ...POISON_ACTION, timetolive: 10 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });
  // The damage waits for its collider's authored frame; see `strike`.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterFirst = session.actors.get(700).hitPoints;
  assert.ok(afterFirst < 900, "the first beat lands");
  assert.ok(session.placeables.size > 0, "and it is still standing, unlike a trap");
  clearDungeonPlaceables(session);
});

test("a thrown trap is placed where the client's own projectile ended", async () => {
  const session = sessionWith({ heroWeapons: [{ type: 17501, power: 500 }] });
  const { handleProposeCreateNPC } = await import("../src/socket/placeables.js");

  /**
   * The throw is not the server's to simulate. ProjectileGameObject.destroy
   * checks isOwner and the Projectile row's OnDeathNPC and sends
   * ProposeCreateNPC(npcId, weaponSlot, x, y) — the client flies it in its own
   * Box2D world and reports where it came to rest. Simulating it here as well
   * put the trap down while the bomb was still in the air on screen.
   */
  const proposal = new PacketWriter()
    .u32(3503) // GARLIC_PLACEABLE_L3
    .u32(0) // weapon slot
    .f32(1620)
    .f32(1180)
    .body();

  await handleProposeCreateNPC(session, new PacketReader(proposal));

  const landed = [...session.actors.values()].find(
    (actor) => actor.constant === "GARLIC_PLACEABLE_L3"
  );
  assert.ok(landed, "the trap the client asked for is there");
  assert.ok(Math.abs(landed.position.x - 1620) < 1, "at the client's x");
  assert.ok(Math.abs(landed.position.y - 1180) < 1, "and its y, not the hero's");
  clearDungeonPlaceables(session);
});

test("the server no longer places a thrown trap of its own accord", async () => {
  const session = sessionWith({ heroWeapons: [{ type: 17501, power: 500 }] });
  const proposal = new PacketWriter()
    .u8(0)
    .u8(0)
    .u32(902103) // THROW_GARLIC — an animation and a projectile, no spawn action
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .body();

  await handleProposeAttackChoreography(session, new PacketReader(proposal));

  assert.equal(session.placeableSpawnTimers?.size ?? 0, 0, "nothing is scheduled");
  assert.equal(session.activeTrapProjectiles?.length ?? 0, 0, "and nothing is simulated");
  clearDungeonPlaceables(session);
});

test("a firebomb leaves fire that burns enemies and not the trap that made it", async () => {
  const session = sessionWith({ heroWeapons: [{ type: 17503, power: 500 }] });
  knightAt(session, 700, 1100, 1000);

  await spawnPlaceable(session, {
    action: { spawnname: "FIREBOMB_PLACEABLE_L3", offset: 40, timetolive: 60 },
    origin: { x: 1060, y: 1000 },
    heading: 0,
  });
  // It lands on the knight, so it goes off at once; the fire follows on frame 4.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const fire = [...session.actors.values()].find(
    (actor) => actor.constant === "BURNING_FIRE_PLACEABLE"
  );
  assert.ok(fire, "the blast sets the floor alight, which garlic and mines do not");
  assert.ok(session.actors.get(700).hitPoints < 900, "and the fire burns what stands in it");

  /**
   * Everything the player puts down shares TEAM.PLAYERS, and the fire was
   * finding two victims on its first beat: the knight and the firebomb that
   * made it.
   */
  const bomb = [...session.actors.entries()].find(
    ([, actor]) => actor.constant === "FIREBOMB_PLACEABLE_L3"
  );
  if (bomb) assert.equal(bomb[1].hitPoints, bomb[1].maxHitPoints, "its own fire spares it");
  clearDungeonPlaceables(session);
});

test("scenery neither springs a trap nor is spent on", async () => {
  const session = sessionWith();
  // A barrel is an actor with hit points, but it is not something that fights.
  session.objects.set(800, CLID.DistributedNPCGameObject);
  session.actors.set(800, {
    hitPoints: 40,
    maxHitPoints: 40,
    constant: "CASTLE_PRISON_SMASH_BARRELRACK",
    isEnemy: false,
    collisionRadius: 30,
    position: { x: 1040, y: 1000 },
  });

  const doid = await spawnPlaceable(session, {
    action: { spawnname: "STICKY_MINE_PLACEABLE", offset: 40, timetolive: 60, frame: 6 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });

  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(session.actors.get(800).hitPoints, 40, "the barrel is untouched");
  assert.equal(
    session.objects.get(doid),
    CLID.DistributedNPCGameObject,
    "and the mine is still waiting for something that fights"
  );
  clearDungeonPlaceables(session);
});

test("a hit leaves the debuff its attack names, once", async () => {
  const session = sessionWith();
  knightAt(session, 700, 1040, 1000);

  // GARLIC_EXPLOSION names STUN_L4, which is most of what a garlic trap is for.
  await spawnPlaceable(session, {
    action: { spawnname: "GARLIC_PLACEABLE_L3", offset: 40, timetolive: 60 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });

  // The damage waits for its collider's authored frame; see `strike`.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stuns = [...(session.activeBuffs?.values() ?? [])].filter(
    (active) => active.affectedActor === 700 && active.buff?.Constant === "STUN_L4"
  );
  assert.equal(stuns.length, 1, "the knight it caught is stunned");
  clearDungeonPlaceables(session);
});

test("an aura refreshes rather than stacking its burn", async () => {
  const session = sessionWith();
  knightAt(session, 700, 1060, 1000);
  session.actors.get(700).hitPoints = 900000;
  session.actors.get(700).maxHitPoints = 900000;

  await spawnPlaceable(session, {
    action: { spawnname: "BURNING_FIRE_PLACEABLE", offset: 60, timetolive: 10 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });
  // Three beats of a fire that ticks once a second.
  await new Promise((resolve) => setTimeout(resolve, 2400));

  const fires = [...(session.activeBuffs?.values() ?? [])].filter(
    (active) => active.affectedActor === 700 && active.buff?.Constant === "FIRE_L5"
  );
  assert.equal(fires.length, 1, "one burn, not one per tick");
  clearDungeonPlaceables(session);
});

test("a burn keeps taking hit points for as long as it is authored to run", async () => {
  const session = sessionWith();
  knightAt(session, 700, 1060, 1000);
  session.actors.get(700).hitPoints = 900000;
  session.actors.get(700).maxHitPoints = 900000;

  await spawnPlaceable(session, {
    action: { spawnname: "BURNING_FIRE_PLACEABLE", offset: 60, timetolive: 10 },
    origin: { x: 1000, y: 1000 },
    heading: 0,
  });

  // The damage waits for its collider's authored frame; see `strike`.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const afterHit = session.actors.get(700).hitPoints;
  assert.ok(afterHit < 900000, "the fire lands its blow");

  /**
   * FIRE_L5 runs five seconds, one tick a second, and the captured ticks carry
   * no CombatResult at all — the server publishes the new hit points and
   * nothing else, which is why an inert buff looked like the whole story.
   */
  await new Promise((resolve) => setTimeout(resolve, 2400));
  const burning = session.actors.get(700).hitPoints;
  assert.ok(burning < afterHit, "and goes on burning between the fire's own beats");

  clearDungeonPlaceables(session);
  const { clearDungeonBuffs } = await import("../src/socket/buffs.js");
  clearDungeonBuffs(session);
});

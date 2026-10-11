import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster, weaponForConstant } from "../src/gamemaster.js";
import { chooseNpcAttack, tickNpcAi } from "../src/socket/ai.js";
import { performNpcAttack } from "../src/socket/combat.js";
import { loadFloor } from "../src/socket/floors.js";
import {
  addNavigationObstacle,
  createNavigationState,
  isPositionBlocked,
  loadNavigationLibrary,
} from "../src/socket/navigation.js";
import { npcAttackChoices } from "../src/socket/npc-attacks.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";

/**
 * A contact attack's Range is the gap between the bodies, not the distance
 * between the feet. Official solo captures, player standing still: a halberd
 * knight (Range 140, body 42) swings from up to 200 feet-to-feet and never
 * from beyond 208; a sword knight (Range 80) from up to 137, never beyond 148;
 * and those swings land. See ai.js `attackReach` and npc-swings.js
 * `landNpcSwing` for the corpus.
 */

const HERO = 10;
const NPC = 20;
const HERO_RADIUS = 25.87;

const gm = await loadGameMaster();
await loadNavigationLibrary();

const rowFor = async (constant) => {
  const npc = gm.raw.Npc.find((row) => row.Constant === constant);
  const weapon = npc.Weapon1 ? await weaponForConstant(npc.Weapon1) : null;
  const attacks = await npcAttackChoices(npc, weapon, Number(weapon?.Power ?? 1));
  const collisionRadius = (npc.CollisionSize ?? 35) * (npc.Scale ?? 1);
  return { npc, attacks, collisionRadius, contact: collisionRadius + HERO_RADIUS };
};

const swingsFrom = (row, distance) =>
  chooseNpcAttack(
    { attacks: row.attacks, attackRange: Math.max(...row.attacks.map((a) => a.range)) },
    distance,
    row.contact,
    0,
    () => 0
  ) !== null;

test("a halberd swings from 200 feet-to-feet and not from 220", async () => {
  const row = await rowFor("KNIGHT_HALBERD");
  assert.equal(row.collisionRadius, 42);
  assert.equal(swingsFrom(row, 200), true, "Range 140 + bodies 68 = 208");
  assert.equal(swingsFrom(row, 220), false);
});

test("a sword swings from 140 and not from 160", async () => {
  const row = await rowFor("KNIGHT");
  assert.equal(swingsFrom(row, 140), true, "Range 80 + bodies 68 = 148");
  assert.equal(swingsFrom(row, 160), false);
});

test("a baby yeti's Range 65 is a gap too, not a floor under the bodies", async () => {
  const row = await rowFor("BABY_YETI");
  assert.equal(swingsFrom(row, 130), true, "official: 68 swings at a still player, p95 114, max 138");
  assert.equal(swingsFrom(row, 140), false);
});

test("a shot keeps its Range from the middle", async () => {
  const row = await rowFor("KNIGHT_MARKSMAN");
  assert.ok(row.attacks[0].projectile, "the marksman's arrow is a projectile");
  assert.equal(swingsFrom(row, 600), true);
  assert.equal(swingsFrom(row, 620), false, "Range 600 is not widened by the bodies");
});

const makeSession = async (constant, heroAt, { heading = 0 } = {}) => {
  const row = await rowFor(constant);
  const sent = [];
  const timers = [];
  const session = {
    id: 7,
    heroDoid: HERO,
    heroPosition: heroAt,
    dungeonActive: true,
    floorDoid: 55,
    random: () => 0,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [NPC, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [
        HERO,
        {
          hitPoints: 60_000,
          maxHitPoints: 60_000,
          position: heroAt,
          collisionRadius: HERO_RADIUS,
          constant: "RANGER",
          team: TEAM.PLAYERS,
        },
      ],
      [
        NPC,
        {
          hitPoints: 1000,
          maxHitPoints: 1000,
          position: { x: 0, y: 0 },
          heading,
          constant,
          level: 10,
          team: TEAM.ENEMIES,
          isEnemy: true,
          collisionRadius: row.collisionRadius,
          ai: {
            state: "idle",
            engaged: false,
            behavior: "CHASE_AI",
            aggroRadius: 1000,
            disengageDistance: 3000,
            // Standing still, so the distance the swing is judged at is the
            // distance the test placed the player at.
            moveSpeed: 0,
            collisionRadius: row.collisionRadius,
            attackRange: Math.max(...row.attacks.map((a) => a.range)),
            attacks: row.attacks,
            attackTimerMs: 1500,
            attackRandMs: 0,
            nextAttackAt: 0,
            ...row.attacks[0],
          },
        },
      ],
    ]),
    combatClock: {
      setTimeout: (run, delay) => (timers.push({ run, delay }), timers.length),
      clearTimeout: () => {},
    },
    send: (frame) => sent.push(frame),
    allocateDoid: () => 900,
  };
  const runTimers = async () => {
    for (const timer of timers.sort((a, b) => a.delay - b.delay)) await timer.run();
  };
  const choreographies = () =>
    sent.filter((frame) => frame.readUInt32LE(4) === NPC && frame.readUInt16LE(8) === 143).length;
  const hits = () =>
    sent.filter((frame) => frame.readUInt32LE(4) === HERO && frame.readUInt16LE(8) === 160).length;
  return { session, row, runTimers, choreographies, hits };
};

test("the AI tick swings a halberd at a player 200 away and walks at one 220 away", async () => {
  const near = await makeSession("KNIGHT_HALBERD", { x: 200, y: 0 });
  await tickNpcAi(near.session, 1000, 0.25);
  assert.equal(near.choreographies(), 1, "no swing at 200");
  assert.equal(near.session.actors.get(NPC).ai.state, "attack");

  const far = await makeSession("KNIGHT_HALBERD", { x: 220, y: 0 });
  await tickNpcAi(far.session, 1000, 0.25);
  assert.equal(far.choreographies(), 0, "swung at 220");
  assert.notEqual(far.session.actors.get(NPC).ai.state, "attack");
});

const landsAt = async (constant, distance, heading) => {
  const radians = (heading * Math.PI) / 180;
  const heroAt = { x: Math.cos(radians) * distance, y: Math.sin(radians) * distance };
  const world = await makeSession(constant, heroAt, { heading });
  const { row } = world;
  await performNpcAttack(
    world.session,
    NPC,
    { ...row.attacks[0], collisionRadius: row.collisionRadius, attackHeading: heading },
    HERO
  );
  await world.runTimers();
  return world.hits() > 0;
};

test("the halberd's thrust lands at 200 whichever way it faces, and not at 300", async () => {
  for (const heading of [0, 90, 180, 270]) {
    assert.equal(await landsAt("KNIGHT_HALBERD", 200, heading), true, `missed at 200 facing ${heading}`);
  }
  assert.equal(await landsAt("KNIGHT_HALBERD", 300, 0), false);
});

test("the sword lands at 140 whichever way it faces, and not at 160", async () => {
  for (const heading of [0, 90, 180, 270]) {
    assert.equal(await landsAt("KNIGHT", 140, heading), true, `missed at 140 facing ${heading}`);
  }
  // Circle r40 authored 45 in front of a 42 body: 42 + 45 + 40 + 25.87 = 152.87.
  assert.equal(await landsAt("KNIGHT", 160, 0), false);
});

test("the mace lands at 140 and the sword does not land behind the knight", async () => {
  assert.equal(await landsAt("BRUTE", 140, 0), true);
  const behind = await makeSession("KNIGHT", { x: -100, y: 0 }, { heading: 0 });
  await performNpcAttack(
    behind.session,
    NPC,
    { ...behind.row.attacks[0], collisionRadius: behind.row.collisionRadius, attackHeading: 0 },
    HERO
  );
  await behind.runTimers();
  assert.equal(behind.hits(), 0, "a sword swung east hit a player to the west");
});

test("a shape authored at the middle stays at the middle", async () => {
  // A stomp: r100 at xOffset 0 from a body of 42. The player 90 behind is
  // inside it; from the body's edge it would have started 42 ahead and missed.
  const world = await makeSession("KNIGHT", { x: -90, y: 0 }, { heading: 0 });
  const stomp = {
    ...world.row.attacks[0],
    collisionRadius: 42,
    attackHeading: 0,
    attackColliders: [{ type: "circleCollider", radius: 100, xOffset: 0, frame: 0 }],
  };
  await performNpcAttack(world.session, NPC, stomp, HERO);
  await world.runTimers();
  assert.equal(world.hits(), 1);
});

/**
 * A halberd walking at a hero who stands still on the scenario prison floor
 * (local-data/Resources/Levels/scenario-test/README.md), its props standing
 * but for those `smashed` names; where it is after `seconds`, and its swings.
 */
const prisonFloor = await loadFloor("scenario-test/db_floor_GAPS_CASTLE_PRISON.json");
const walkOnPrisonFloor = async (heroAt, from, { smashed = () => false, seconds = 45 } = {}) => {
  const navigation = createNavigationState(prisonFloor.navigation);
  for (const [index, placement] of prisonFloor.placements.npc.entries()) {
    if (!placement.navigationColliders?.length || smashed(placement)) continue;
    addNavigationObstacle(navigation, `prop-${index}`, placement.navigationColliders);
  }
  const world = await makeSession("KNIGHT_HALBERD", heroAt);
  const knight = world.session.actors.get(NPC);
  world.session.navigation = navigation;
  knight.position = { ...from };
  knight.ai.engaged = true;
  knight.ai.moveSpeed = Number(world.row.npc.BaseMove);
  const trail = [];
  for (let tick = 0; tick < seconds * 4; tick++) {
    await tickNpcAi(world.session, 1000 + tick * 250, 0.25);
    trail.push({ ...knight.position });
  }
  const end = trail.at(-1);
  return {
    knight,
    navigation,
    distance: Math.hypot(end.x - heroAt.x, end.y - heroAt.y),
    /** How far it strayed from where it ended over the last twenty seconds. */
    drift: Math.max(...trail.slice(-80).map((at) => Math.hypot(at.x - end.x, at.y - end.y))),
    swings: world.choreographies(),
  };
};

const NORTH_EAST_RACK = (placement) =>
  placement.constant === "CASTLE_PRISON_SMASH_BARRELRACK" && Math.hypot(placement.x - 217, placement.y - 671) < 10;

test("a halberd at a hero between the prison's barrel racks ends inside its reach and swings", async () => {
  // The capture of 2026-10-10: the hero at (167,684) in the slot three racks
  // leave once the north-east one is smashed, the knight coming from the east.
  for (const from of [{ x: 300.9, y: 641.1 }, { x: 346, y: 639 }]) {
    const walk = await walkOnPrisonFloor({ x: 167, y: 684 }, from, { smashed: NORTH_EAST_RACK });
    assert.ok(walk.distance <= 200, `from ${JSON.stringify(from)} it ended ${walk.distance.toFixed(1)} away`);
    assert.ok(walk.swings >= 1, `from ${JSON.stringify(from)} it never swung`);
  }
});

test("with all four racks standing it stands at them, and stays there", async () => {
  // No route to the hero at all for a body of 42: the straight walk from the
  // east ends against the racks, short of its reach, and does not pace there.
  for (const from of [{ x: 300.9, y: 641.1 }, { x: 346, y: 639 }]) {
    const walk = await walkOnPrisonFloor({ x: 167, y: 684 }, from);
    assert.equal(isPositionBlocked(walk.navigation, walk.knight.position, 42), false);
    assert.ok(walk.distance < 210, `from ${JSON.stringify(from)} it ended ${walk.distance.toFixed(1)} away`);
    assert.ok(walk.drift < 2, `from ${JSON.stringify(from)} it kept moving: ${walk.drift.toFixed(2)} u`);
    assert.equal(walk.knight.ai.state, "blocked");
  }
});

test("a halberd at a hero in the slot above the shut exit gate swings from within 140", async () => {
  // Spot B of the scenario floor: (750,2380), between WALL_C and the gate.
  for (const from of [{ x: 612, y: 2053 }, { x: 378, y: 2053 }]) {
    const walk = await walkOnPrisonFloor({ x: 750, y: 2380 }, from);
    assert.ok(walk.distance <= 140, `from ${JSON.stringify(from)} it ended ${walk.distance.toFixed(1)} away`);
    assert.ok(walk.swings >= 1, `from ${JSON.stringify(from)} it never swung`);
    assert.ok(walk.drift < 2, `from ${JSON.stringify(from)} it kept moving: ${walk.drift.toFixed(2)} u`);
  }
});

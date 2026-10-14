import assert from "node:assert/strict";
import test from "node:test";

import {
  attackColliders,
  attackForConstant,
  attackTimelineFrames,
  npcForConstant,
} from "../src/gamemaster.js";
import { clearBuffsOn } from "../src/socket/buffs.js";
import { classifyHazard, clearHazardBeats, raiseHazard } from "../src/socket/hazards.js";
import { worldColliders } from "../src/socket/heading.js";
import { CLID, TEAM } from "../src/socket/opcodes.js";
import { clearDungeonPlaceables, heroPlacer, spawnPlaceable } from "../src/socket/placeables.js";
import { HERO_DOID, buildFloor, readFrame, readNpc } from "./helpers/floor.js";

/**
 * A trap belongs to the side that placed it.
 *
 * Measured over ~450 trap damage results in 26 official files, and on the
 * rival floor (socket-20261014-000524, node 50069: 21 rival-placed traps, 30
 * map-placed ones): the placer's team for one an attack put down, the row's
 * team for one the map authors. It waits, goes off when a body not on its own
 * team comes within its row's AggroRadius (60), hurts whatever its blast
 * reaches (140 for a mine) that its attack's side test allows —
 * team-6 traps hurt the hero, pets and props and never a monster (0 of ~50),
 * a hero's hurts monsters and props and never a hero (0 of 212), a `*_ALL`
 * row on team 7 hurts everybody — and never goes off on scenery or on an
 * `IsAttackable` 0 body.
 */

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A bomb's damage waits for its collider's authored frame (frame 2, 83 ms). */
const blastLands = async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settle();
};

const RIVAL_FLOOR = "castle/catacombs/db_floor_CATACOMBS_VAMPIRE_HUNTER_RIVAL_BATTLE.json";
const MAP_TRAP = /^(MINE_PLACEABLE_L\d|FIREBOMB_PLACEABLE_L\d|GARLIC_NUKE_PLACEABLE)$/;

test("a waiting trap's kind is read off its row's shape, not its CharType", async () => {
  /**
   * The rival floor authors thirty of these and they are ENEMY rows; the
   * temple's are BEAST. All of them stand still, carry an attack and no
   * `InstantAttack`, and the official treats them alike: generated at trigger
   * 1, each going off once when the hero steps in — 7 of the 30 on node 50069,
   * the other 23 untouched for the floor's 131 s. Read by CharType, ours put
   * the ENEMY ones among the switched traps and played all thirty explosions
   * as the floor was built.
   */
  const rows = [
    ...[1, 2, 3, 4, 5, 6].flatMap((level) => [
      `MINE_PLACEABLE_L${level}`,
      `FIREBOMB_PLACEABLE_L${level}`,
      `GARLIC_PLACEABLE_L${level}`,
    ]),
    "GARLIC_NUKE_PLACEABLE",
    "STICKY_MINE_PLACEABLE",
    "MINE_PLACEABLE_ALL",
    "FIREBOMB_PLACEABLE_ALL",
  ];
  for (const constant of rows) {
    const npc = await npcForConstant(constant);
    const attack = await attackForConstant(npc.Attack1);
    const kind = classifyHazard({ npc, attack, projectile: null });
    assert.equal(kind.contactBomb, true, `${constant} (${npc.CharType}) waits to be stepped on`);
    assert.equal(kind.togglesRenderer, false, `${constant} is not a switched trap`);
  }
});

/** The rival floor as the server builds it, with its monsters asleep. */
const rivalFloor = async (t) => {
  const world = await buildFloor(RIVAL_FLOOR, { npcLevel: 13 });
  const { session } = world;
  session.stopAi?.();
  t.after(() => {
    clearHazardBeats(session);
    clearDungeonPlaceables(session);
    for (const stop of session.generatorStops?.values() ?? []) stop();
    session.stopTriggers?.();
    session.stopTrapProjectiles?.();
  });
  clearBuffsOn(session, HERO_DOID);
  const hero = session.actors.get(HERO_DOID);
  hero.hitPoints = hero.maxHitPoints = 60_000;
  return world;
};

const placeHero = (session, position) => {
  session.actors.get(HERO_DOID).position = { ...position };
  session.heroPosition = { ...position };
};

/** One of the floor's own monsters, moved to `position`. */
const borrowMonster = (session, position) => {
  const [doid, monster] = [...session.actors].find(
    ([, actor]) => actor.isEnemy && actor.attackable !== false && actor.team === TEAM.ENEMIES && actor.ai
  );
  monster.position = { ...position };
  return { doid, monster };
};

test("the rival floor's own traps wait, and go off once on the hero", async (t) => {
  const world = await rivalFloor(t);
  const { session, floor } = world;

  const traps = floor.placements.triggerable.filter((placement) => MAP_TRAP.test(placement.constant));
  assert.equal(traps.length, 30, "node 50069 authors thirty");
  const doids = new Set(traps.map((placement) => session.triggerableDoids.get(placement.id)));
  const built = world.frames.filter((frame) => doids.has(frame.doid) && frame.kind === "field" && frame.field === 143);
  assert.equal(built.length, 0, "nothing goes off while the floor is laid");
  for (const placement of traps) {
    assert.ok(session.hazardContactZones?.has(placement.id), `${placement.constant} is armed and waiting`);
  }

  const mine = traps.find((placement) => placement.constant === "MINE_PLACEABLE_L3");
  const mineDoid = session.triggerableDoids.get(mine.id);
  const touch = session.hazardContactZones.get(mine.id);
  const sent = [];
  session.send = (frame) => sent.push(readFrame(frame));
  let now = 1_000_000;

  // A monster on top of it: its own side does not set it off, nor is hurt by it.
  placeHero(session, { x: mine.x + 2000, y: mine.y });
  const { doid: monsterDoid, monster } = borrowMonster(session, { x: mine.x + 10, y: mine.y });
  const monsterHp = monster.hitPoints;
  touch((now += 100));
  await settle();
  assert.equal(sent.filter((frame) => frame.doid === mineDoid && frame.field === 143).length, 0, "a monster does not trip it");

  /**
   * The hero 100 out is inside the 140 the blast authors and does not set it
   * off; 70 out, touching the row's AggroRadius 60, does. Over the official
   * corpus a hero coming that close to an armed bomb set it off 26 times in 28,
   * and one inside the blast but beyond 116 only 15 times in 85.
   */
  placeHero(session, { x: mine.x - 100, y: mine.y });
  touch((now += 100));
  await settle();
  assert.equal(sent.filter((frame) => frame.doid === mineDoid && frame.field === 143).length, 0, "inside the blast is not near enough");

  const PET = 990_001;
  session.objects.set(PET, CLID.DistributedNPCGameObject);
  session.actors.set(PET, { hitPoints: 5000, maxHitPoints: 5000, collisionRadius: 20, isPet: true, attackable: true, team: TEAM.PLAYERS, position: { x: mine.x, y: mine.y + 120 } });
  placeHero(session, { x: mine.x - 70, y: mine.y });
  const heroHp = session.actors.get(HERO_DOID).hitPoints;
  touch((now += 100));
  // The blast lands on its collider's frame, 2 of 24 a second.
  await blastLands();
  assert.equal(sent.filter((frame) => frame.doid === mineDoid && frame.field === 143).length, 1, "the hero sets it off");
  assert.ok(session.actors.get(HERO_DOID).hitPoints < heroHp, "and takes the blast");
  assert.ok(session.actors.get(PET).hitPoints < 5000, "and so does a pet 120 out, inside the blast");
  assert.equal(monster.hitPoints, monsterHp, "while the monster standing on it does not");
  assert.equal(
    sent.filter((frame) => frame.doid === monsterDoid && [144, 160].includes(frame.field)).length,
    0,
    "not a single result names the monster"
  );

  touch((now += 1000));
  await settle();
  assert.equal(sent.filter((frame) => frame.doid === mineDoid && frame.field === 143).length, 1, "and it goes off once");
});

test("a team-7 floor bomb still goes off on a monster, and hurts everybody", async (t) => {
  /**
   * `MINE_PLACEABLE_ALL` is BEAST, team 7, so a monster is not on its side:
   * it springs on one and its blast takes the hero beside it as well — the
   * official's went off 11 times with the hero 838 to 1340 away and a monster
   * 62 to 110 from them. Scenery alone, or another bomb, does not spring it.
   */
  const npc = await npcForConstant("MINE_PLACEABLE_ALL");
  const attack = await attackForConstant(npc.Attack1);
  const kind = classifyHazard({ npc, attack, projectile: null });
  const at = { x: 600, y: 600 };
  const MINE = 9600;
  const MONSTER = 9601;
  const BARREL = 9602;
  const OTHER_MINE = 9603;
  const heroDoid = 7005;
  const sent = [];
  const session = {
    id: 31,
    dungeonActive: true,
    floorSettled: true,
    heroDoid,
    heroPosition: { x: 700, y: 600 },
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [MINE, CLID.DistributedNPCGameObject],
      [MONSTER, CLID.DistributedNPCGameObject],
      [BARREL, CLID.DistributedNPCGameObject],
      [OTHER_MINE, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 4000, maxHitPoints: 4000, collisionRadius: 22, team: TEAM.PLAYERS }],
      [BARREL, { hitPoints: 40, maxHitPoints: 40, collisionRadius: 30, isProp: true, attackable: true, team: TEAM.ENVIRONMENT, position: { x: 560, y: 600 } }],
      [OTHER_MINE, { hitPoints: 10, maxHitPoints: 10, collisionRadius: 20, attackable: false, team: TEAM.THIRD, position: { x: 620, y: 600 } }],
    ]),
    triggerableDoids: new Map([["mine", MINE]]),
    triggerableHazards: new Map([
      ["mine", {
        attack, npc, team: TEAM.THIRD, contactBomb: kind.contactBomb, position: at,
        timelineFrames: await attackTimelineFrames(attack.AttackTimeline),
        combatColliders: worldColliders(at, 0, await attackColliders(attack.AttackTimeline)),
      }],
    ]),
    send: (frame) => sent.push(readFrame(frame)),
  };
  t.after(() => clearHazardBeats(session));
  const goneOff = () => sent.filter((frame) => frame.doid === MINE && frame.field === 143).length;

  // The hero is out of reach; a barrel and another bomb are not reasons.
  session.heroPosition = { x: 900, y: 600 };
  raiseHazard(session, "mine");
  const touch = session.hazardContactZones.get("mine");
  touch(1_000);
  await settle();
  assert.equal(goneOff(), 0, "scenery and another bomb do not set it off");

  // A monster 100 out is in the blast and not near enough; at 80 its body
  // touches the 60 the row's AggroRadius draws.
  session.actors.set(MONSTER, { hitPoints: 900, maxHitPoints: 900, collisionRadius: 30, isEnemy: true, team: TEAM.ENEMIES, position: { x: 500, y: 600 } });
  session.heroPosition = { x: 700, y: 600 };
  touch(1_100);
  await settle();
  assert.equal(goneOff(), 0, "a monster in the blast but not near it waits");
  session.actors.get(MONSTER).position = { x: 520, y: 600 };
  touch(1_200);
  await blastLands();
  assert.equal(goneOff(), 1, "a monster sets it off");
  assert.ok(session.actors.get(MONSTER).hitPoints < 900, "and is hurt");
  assert.ok(session.actors.get(heroDoid).hitPoints < 4000, "and so is the hero standing in it");
  assert.ok(session.actors.get(BARREL).hitPoints < 40, "and the barrel it reaches");
  assert.equal(session.actors.get(OTHER_MINE).hitPoints, 10, "but never the other bomb");
});

/** A bare session for things a placer puts down. */
const placingSession = () => {
  let nextDoid = 900;
  const sent = [];
  const session = {
    id: 42,
    heroDoid: 500,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    dungeonAvatar: { avatar_id: 104, experience: 0 },
    objects: new Map([[500, CLID.HeroGameObject]]),
    actors: new Map([[500, { hitPoints: 400, maxHitPoints: 400, collisionRadius: 22, team: TEAM.PLAYERS, position: { x: 1000, y: 1000 } }]]),
    allocateDoid: () => ++nextDoid,
    sent,
    send: (frame) => sent.push(readFrame(frame)),
  };
  return session;
};

const MINE_ACTION = { spawnname: "MINE_PLACEABLE_L3", offset: 0, headingOffsetAngle: 0, timetolive: 60, delayattack: 1.5 };

test("a hero's trap has an owner like any other, and goes off on monsters only", async (t) => {
  const session = placingSession();
  const OTHER_HERO = 501;
  const MONSTER = 700;
  session.playerActors = new Set([500, OTHER_HERO]);
  session.objects.set(OTHER_HERO, CLID.HeroGameObject);
  session.actors.set(OTHER_HERO, { hitPoints: 400, maxHitPoints: 400, collisionRadius: 22, team: TEAM.PLAYERS, position: { x: 1300, y: 1000 } });
  t.after(() => clearDungeonPlaceables(session));

  const owner = await heroPlacer(session);
  assert.equal(owner.team, TEAM.PLAYERS);
  assert.equal(owner.masterDoid, 500);
  const doid = await spawnPlaceable(session, { action: { ...MINE_ACTION, delayattack: 0 }, origin: { x: 1300, y: 1000 }, heading: 0, weaponPower: 50, owner });
  const live = session.placeables.get(doid);
  assert.equal(live.owner.masterDoid, 500, "the hero is its master");
  assert.equal(session.actors.get(doid).masterId, 500, "and its actor says the same as its generate");

  // Another hero of the party standing on it: their own side's, so nothing.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(sent143(session, doid), 0, "a hero does not set off a hero's mine");
  assert.equal(session.actors.get(OTHER_HERO).hitPoints, 400);

  session.objects.set(MONSTER, CLID.DistributedNPCGameObject);
  // One in the blast but not near it, then one that is.
  session.objects.set(MONSTER + 1, CLID.DistributedNPCGameObject);
  session.actors.set(MONSTER + 1, { hitPoints: 900, maxHitPoints: 900, collisionRadius: 30, isEnemy: true, team: TEAM.ENEMIES, position: { x: 1420, y: 1000 } });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(sent143(session, doid), 0, "a monster 120 out is in the blast, not near enough to set it off");
  session.actors.set(MONSTER, { hitPoints: 900, maxHitPoints: 900, collisionRadius: 30, isEnemy: true, team: TEAM.ENEMIES, position: { x: 1370, y: 1000 } });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(sent143(session, doid), 1, "a monster 70 out does");
  assert.ok(session.actors.get(MONSTER).hitPoints < 900, "and is caught");
  assert.ok(session.actors.get(MONSTER + 1).hitPoints < 900, "and so is the one 120 out");
  assert.equal(session.actors.get(OTHER_HERO).hitPoints, 400, "while the hero on it is not");
});

const sent143 = (session, doid) =>
  session.sent.filter((frame) => frame.doid === doid && frame.kind === "field" && frame.field === 143).length;

test("a rival's trap names its master on the actor too, and expires quietly if nobody comes", async (t) => {
  const session = placingSession();
  const CASTER = 20;
  session.objects.set(CASTER, CLID.DistributedNPCGameObject);
  session.actors.set(CASTER, { hitPoints: 900, maxHitPoints: 900, collisionRadius: 30, isEnemy: true, team: TEAM.ENEMIES, position: { x: 2000, y: 1000 } });
  const pending = [];
  let clock = 0;
  session.floorScope = {
    timeout: (run, delay) => (pending.push({ run, at: clock + delay }), pending.length),
    interval: (run, delay) => (pending.push({ run, at: clock + delay, every: delay }), pending.length),
    cancel: () => true,
  };
  t.after(() => clearDungeonPlaceables(session));

  const doid = await spawnPlaceable(session, {
    action: { ...MINE_ACTION, timetolive: 61 },
    origin: { x: 2000, y: 1000 },
    heading: 0,
    owner: { team: TEAM.ENEMIES, masterDoid: CASTER, level: 13 },
  });
  assert.equal(session.actors.get(doid).masterId, CASTER);

  // A monster of its own side sits on it for the whole of its life.
  session.objects.set(701, CLID.DistributedNPCGameObject);
  session.actors.set(701, { hitPoints: 900, maxHitPoints: 900, collisionRadius: 30, isEnemy: true, team: TEAM.ENEMIES, position: { x: 2000, y: 1000 } });
  while (clock < 62_000) {
    const due = pending.filter((timer) => !timer.done && timer.at <= 62_000).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    clock = due.at;
    if (due.every) due.at += due.every; else due.done = true;
    if (!session.placeables.has(doid) && due.every) { due.done = true; continue; }
    await due.run();
    await settle();
  }
  assert.equal(sent143(session, doid), 0, "it never went off");
  assert.equal(session.actors.get(701).hitPoints, 900, "its own side's monster is never hurt");
  assert.ok(!session.objects.has(doid), "and at its timetolive it is gone");
});

test("the rival floor waits for its monsters, not for its traps", async (t) => {
  /**
   * The floor's triggerables are its machinery, never its stock. On node
   * 50069 the official left 23 of its 30 map traps untouched for the floor's
   * 131 s and the floor completed; ours counted every one of them as an enemy
   * still standing, so the floor could not be cleared while any was there.
   */
  const { floorHolds } = await import("../src/socket/floorstate.js");
  const world = await rivalFloor(t);
  const { session, floor } = world;
  const trapDoids = new Set(
    floor.placements.triggerable.map((placement) => session.triggerableDoids.get(placement.id)).filter(Boolean)
  );
  for (const doid of trapDoids) {
    const actor = session.actors.get(doid);
    if (actor) assert.notEqual(actor.holdsFloor, true, `${actor.constant} does not hold the floor`);
  }
  for (const [doid, actor] of session.actors) if (!trapDoids.has(doid) && actor.isEnemy) actor.dead = true;
  const holds = floorHolds(session);
  assert.ok(holds.enemies > 0, "the floor still knows what it was stocked with");
  assert.deepEqual(holds.alive.map(({ actor }) => actor.constant), [], "and with its stock down nothing holds it");
});

test("a map firebomb lights a fire of its own side, with itself as master", async (t) => {
  /**
   * `BURNING_EXPLOSION` spawns `BURNING_FIRE_PLACEABLE` on frame 4. On node
   * 50069 the official's map firebombs that went off lit 6 fires, every one
   * on team 6 with the firebomb as its master (and the rival's own firebombs'
   * fires name the rival). Ours ran a map bomb's blast on a path of its own
   * that never read the timeline's spawns, so a map firebomb lit nothing.
   */
  const world = await rivalFloor(t);
  const { session, floor, gm } = world;
  const bomb = floor.placements.triggerable.find((placement) => placement.constant === "FIREBOMB_PLACEABLE_L2");
  const bombDoid = session.triggerableDoids.get(bomb.id);
  const sent = [];
  session.send = (frame) => sent.push(readFrame(frame));
  placeHero(session, { x: bomb.x + 50, y: bomb.y });
  const heroHp = session.actors.get(HERO_DOID).hitPoints;
  session.hazardContactZones.get(bomb.id)(2_000_000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await settle();

  assert.equal(sent.filter((frame) => frame.doid === bombDoid && frame.field === 143).length, 1, "it goes off");
  assert.ok(session.actors.get(HERO_DOID).hitPoints < heroHp, "on the hero");
  const fireRow = gm.raw.Npc.find((row) => row.Constant === "BURNING_FIRE_PLACEABLE");
  const fires = sent
    .filter((frame) => frame.kind === "generate" && frame.clid === CLID.DistributedNPCGameObject)
    .map((frame) => readNpc(frame.body))
    .filter((npc) => npc.type === fireRow.Id);
  assert.equal(fires.length, 1, "and lights one fire");
  assert.equal(fires[0].team, TEAM.ENEMIES, "on its own side");
  assert.equal(fires[0].masterId, bombDoid, "with the firebomb as master");

  // A mine's blast spawns nothing.
  const mine = floor.placements.triggerable.find((placement) => placement.constant === "MINE_PLACEABLE_L3");
  sent.length = 0;
  placeHero(session, { x: mine.x + 50, y: mine.y });
  session.hazardContactZones.get(mine.id)(2_100_000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const lit = sent
    .filter((frame) => frame.kind === "generate" && frame.clid === CLID.DistributedNPCGameObject)
    .map((frame) => readNpc(frame.body))
    .filter((npc) => npc.type === fireRow.Id);
  assert.equal(lit.length, 0, "a mine lights nothing");
});

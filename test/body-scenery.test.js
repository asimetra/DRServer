import assert from "node:assert/strict";
import test from "node:test";

import { loadGameMaster } from "../src/gamemaster.js";
import { tickNpcAi } from "../src/socket/ai.js";
import { bodyBlocked, seesBody } from "../src/socket/body.js";
import { buildFloor } from "../src/socket/floors.js";
import { collisionPointOf, createNavigationState, isPositionBlocked, loadNavigationLibrary } from "../src/socket/navigation.js";
import { CLID } from "../src/socket/opcodes.js";
import { buildFloor as buildWorld } from "./helpers/floor.js";

/**
 * A monster meets the scenery at its body (body.js): the library's circle
 * above its feet, at the size it is drawn. The official's bodies touch the
 * walls on 13.4% of samples and overlap them on 0-2.3% a row; its feet,
 * 22 x Scale below, overlap them on 3-18%.
 */

const HERO = 10;
const MONSTER = 20;
const TICK = 0.25;
const rectangle = (x, y, halfWidth, halfHeight) => ({ type: "rectangle", x, y, halfWidth, halfHeight, angle: 0 });

/** A real row's monster, at its own scale and size, walking at a hero who stands still. */
const makeSession = async (navigation, constant, heroAt, monsterAt) => {
  const gm = await loadGameMaster();
  const row = gm.raw.Npc.find((npc) => npc.Constant === constant);
  const scale = Number(row.Scale ?? 1);
  const radius = 35 * scale;
  const heroPosition = { ...heroAt };
  const session = {
    id: 7,
    heroDoid: HERO,
    heroPosition,
    navigation,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [MONSTER, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [HERO, { hitPoints: 2000, maxHitPoints: 2000, constant: "BERSERKER", scale: 1.176, collisionRadius: 25.87, position: heroPosition }],
      [
        MONSTER,
        {
          hitPoints: 25,
          maxHitPoints: 25,
          constant,
          scale,
          collisionRadius: radius,
          position: { ...monsterAt },
          heading: 0,
          ai: {
            state: "idle",
            engaged: true,
            aggroRadius: 2000,
            disengageDistance: 4000,
            moveSpeed: 180,
            collisionRadius: radius,
            attackRange: 80,
            attackTimerMs: 1500,
            attackRandMs: 0,
            nextAttackAt: 0,
            attackType: 920050,
            damage: 1,
            attackColliders: [{ type: "circleCollider", radius: 1000, xOffset: 0, frame: 0 }],
            impactFrame: 0,
          },
        },
      ],
    ]),
    send: () => {},
  };
  const actor = session.actors.get(MONSTER);
  return { session, actor, radius, hero: session.actors.get(HERO) };
};

test("scaled rows carry their body at the scaled offset", async () => {
  await loadNavigationLibrary();
  const at = { x: 100, y: 100 };
  assert.deepEqual(collisionPointOf({ constant: "KNIGHT_HALBERD", scale: 1.2 }, at), { x: 100, y: 100 - 22 * 1.2 });
  assert.deepEqual(collisionPointOf({ constant: "BERSERKER", scale: 1.176 }, at), { x: 100, y: 100 - 22 * 1.176 });
  assert.deepEqual(collisionPointOf({ constant: "KNIGHT" }, at), { x: 100, y: 78 }, "one with no scale is at 1");

  // A spawned monster carries the scale it was generated at: its row's, for the floor's stock.
  const world = await buildWorld("castle/prison/tiles.json", { seed: 1 });
  const gm = await loadGameMaster();
  const monsters = [...world.session.actors.values()].filter((actor) => actor.ai && actor.isEnemy);
  assert.ok(monsters.some((actor) => actor.scale !== 1), "the floor has scaled monsters");
  for (const actor of monsters) {
    assert.equal(actor.scale, Number(gm.npcByConstant.get(actor.constant)?.Scale ?? 1), actor.constant);
  }
});

test("a knight sliding along a wall above it keeps its body clear of it", async () => {
  await loadNavigationLibrary();
  // The wall's bottom edge at y 300; the hero's body just clear of it, far east.
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
    cellSize: 30,
    staticColliders: [rectangle(500, 250, 500, 50)],
  });
  const { session, actor, radius } = await makeSession(navigation, "KNIGHT", { x: 900, y: 352 }, { x: 100, y: 372 });
  let along = 0;
  for (let tick = 0; tick < 24; tick++) {
    await tickNpcAi(session, 1000 + tick * 250, TICK);
    const body = collisionPointOf(actor, actor.position);
    assert.equal(isPositionBlocked(navigation, body, radius), false, `tick ${tick}: its body is in the wall at ${JSON.stringify(body)}`);
    if (isPositionBlocked(navigation, body, radius + 5)) along++;
  }
  // Before, its feet were what was kept clear, and its body, 26 above them,
  // went along the wall 26 into it.
  assert.ok(along >= 12, `it went along the wall, its body within 5 of it (${along} ticks)`);
});

test("along a wall below it the feet may overlap the wall; the body may not", async () => {
  await loadNavigationLibrary();
  // The wall's top edge at y 600; the hero leaning on it, his feet on its edge.
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
    cellSize: 30,
    staticColliders: [rectangle(500, 650, 500, 50)],
  });
  const { session, actor, radius } = await makeSession(navigation, "KNIGHT", { x: 900, y: 600 }, { x: 100, y: 500 });
  let feetIn = 0;
  for (let tick = 0; tick < 24; tick++) {
    await tickNpcAi(session, 1000 + tick * 250, TICK);
    assert.equal(bodyBlocked(navigation, actor, actor.position, radius), false, `tick ${tick}: its body is in the wall`);
    if (isPositionBlocked(navigation, actor.position, radius)) feetIn++;
  }
  assert.ok(feetIn >= 4, `its feet stood over the wall's edge as its body ran along it (${feetIn} ticks)`);
});

test("a hero on the aztec altar is reached and hit, never through its slab", async () => {
  await loadNavigationLibrary();
  const floor = await buildFloor("Resources/Levels/jungle/aztec/tiles.json", { tileCount: 14, seed: 42 });
  const navigation = createNavigationState(floor.navigation);
  const altar = navigation.colliders.find((collider) => collider.sourceConstant === "JURASSIC_AZTEC_GROUND_ALTAR" && collider.x === 2250 && collider.y === 1099);
  assert.ok(altar, "the altar is where the floor laid it");

  // His feet on the slab's north edge, his body clear north of it; a halberd south of it.
  const heroAt = { x: 2250, y: 1096 };
  const { session, actor, radius, hero } = await makeSession(navigation, "KNIGHT_HALBERD", heroAt, { x: 2250, y: 1190 });
  actor.ai.attackRange = 140;
  assert.equal(isPositionBlocked(navigation, heroAt, 0), true, "his feet are on the slab");
  assert.equal(bodyBlocked(navigation, hero, heroAt, 25), false, "his body is clear of it");
  assert.equal(bodyBlocked(navigation, actor, actor.position, radius), false);

  let hitPoints = hero.hitPoints;
  let hits = 0;
  for (let tick = 0; tick < 80; tick++) {
    const from = { ...actor.position };
    await tickNpcAi(session, 1000 + tick * 250, TICK);
    if (hero.hitPoints < hitPoints) {
      hits++;
      assert.ok(seesBody(navigation, actor, from, hero, heroAt) || seesBody(navigation, actor, actor.position, hero, heroAt), `hit through the slab from ${JSON.stringify(from)}`);
    }
    hitPoints = hero.hitPoints;
  }
  assert.ok(hits >= 1, `it never hit him; it ended at ${JSON.stringify(actor.position)} as ${actor.ai.state}`);
});

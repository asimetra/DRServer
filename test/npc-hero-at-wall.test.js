import assert from "node:assert/strict";
import test from "node:test";

import { tickNpcAi } from "../src/socket/ai.js";
import { buildFloor } from "../src/socket/floors.js";
import {
  collisionPointOf,
  createNavigationState,
  hasLineOfSight,
  isPositionBlocked,
  loadNavigationLibrary,
} from "../src/socket/navigation.js";
import { CLID } from "../src/socket/opcodes.js";

/**
 * A hero leaning on a wall below it could not be hit.
 *
 * The wire position is the feet; the body is 22 above them, and the client
 * keeps the body out of walls, not the feet. Leaning on a wall below, the feet
 * sit on the wall's top edge or a unit inside it, and the swing's sight line,
 * which ended at the feet, ended inside the wall. Played on the nordic caves
 * floor rebuilt below (tier 1, 14 tiles, seed 169884306), monsters stood within
 * 100 units of a hero leaning on its walls for 226 monster-seconds and hit 4
 * times. The positions here are from that capture.
 */

const HERO = 10;
const MONSTER = 20;
const contactShape = [{ type: "circleCollider", radius: 1000, xOffset: 0, frame: 0 }];

/** NORDIC_CAVE_WALL_D as that floor lays it: top edge at y 5339. */
const WALL = { type: "rectangle", x: 3199, y: 5369, halfWidth: 108, halfHeight: 30, angle: 0 };
/** The hero's feet as the client reported them, leaning on the wall's top. */
const LEANING_ON_TOP = { x: 3206.8, y: 5340 };

const realFloorNavigation = async () => {
  const floor = await buildFloor("Resources/Levels/nordic/caves/tiles.json", {
    tier: 1,
    tileCount: 14,
    seed: 169884306,
  });
  return createNavigationState(floor.navigation);
};

/** The same wall alone, across the whole width of a room: no way round it. */
const wallAcrossTheRoom = () =>
  createNavigationState({
    bounds: { minX: 3100, minY: 5150, maxX: 3300, maxY: 5600 },
    cellSize: 30,
    staticColliders: [WALL],
  });

const makeSession = (navigation, heroAt, monsterAt, { attackRange = 80 } = {}) => {
  const heroPosition = { ...heroAt };
  return {
    id: 7,
    heroDoid: HERO,
    heroPosition,
    navigation,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [MONSTER, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [HERO, { hitPoints: 200, maxHitPoints: 200, constant: "BERSERKER", position: heroPosition }],
      [
        MONSTER,
        {
          hitPoints: 25,
          maxHitPoints: 25,
          position: { ...monsterAt },
          heading: 0,
          ai: {
            state: "idle",
            engaged: true,
            aggroRadius: 450,
            disengageDistance: 1600,
            moveSpeed: 300,
            collisionRadius: 35,
            attackRange,
            attackTimerMs: 1500,
            attackRandMs: 0,
            nextAttackAt: 0,
            attackType: 920050,
            damage: 1,
            attackColliders: contactShape,
            impactFrame: 0,
          },
        },
      ],
    ]),
    send: () => {},
  };
};

const runTicks = async (session, count) => {
  for (let tick = 0; tick < count; tick++) await tickNpcAi(session, 1000 + tick * 100, 0.1);
  return session.actors.get(HERO).hitPoints;
};

test("a monster hits a hero leaning on the wall below him", async () => {
  await loadNavigationLibrary();
  const navigation = await realFloorNavigation();
  const monster = { x: 3157, y: 5304 };
  const body = collisionPointOf({ constant: "BERSERKER" }, LEANING_ON_TOP);

  // The geometry the bug needs: feet in the wall, body clear and in plain sight.
  assert.equal(isPositionBlocked(navigation, LEANING_ON_TOP, 0), true, "the feet are on the wall's edge");
  assert.equal(isPositionBlocked(navigation, body, 20), false, "the body is clear of it");
  assert.equal(hasLineOfSight(navigation, monster, body, 0), true);

  const session = makeSession(navigation, LEANING_ON_TOP, monster);
  assert.ok(await runTicks(session, 10) < 200, "it should have been hit within a second");
});

test("the same monster still hits a hero standing just clear of that wall", async () => {
  await loadNavigationLibrary();
  const navigation = await realFloorNavigation();
  const session = makeSession(navigation, { x: 3206.8, y: 5320 }, { x: 3157, y: 5284 });
  assert.ok(await runTicks(session, 10) < 200);
});

test("a hero leaning on a wall is not hit through it from below", async () => {
  await loadNavigationLibrary();
  const navigation = wallAcrossTheRoom();
  // Under the wall, in reach of a long swing, with no way round.
  const monster = { x: 3206.8, y: 5440 };
  assert.equal(isPositionBlocked(navigation, monster, 35), false);
  const session = makeSession(navigation, LEANING_ON_TOP, monster, { attackRange: 250 });

  assert.equal(await runTicks(session, 20), 200, "a swing went through the wall");
  assert.equal(session.actors.get(MONSTER).ai.state, "blocked");
});

test("a hero leaning on a wall from below is not hit through it from above", async () => {
  await loadNavigationLibrary();
  const navigation = wallAcrossTheRoom();
  // Body touching the wall's bottom edge at 5399: body centre 5421, feet 5443.
  const hero = { x: 3206.8, y: 5443 };
  const monster = { x: 3206.8, y: 5300 };
  assert.equal(isPositionBlocked(navigation, collisionPointOf({ constant: "BERSERKER" }, hero), 21), false);
  const session = makeSession(navigation, hero, monster, { attackRange: 250 });

  assert.equal(await runTicks(session, 20), 200, "a swing went through the wall");
  assert.equal(session.actors.get(MONSTER).ai.state, "blocked");
});

test("the long swing does land on the hero's own side of that wall", async () => {
  await loadNavigationLibrary();
  // The control for the two above: same room, same reach, same side.
  const session = makeSession(wallAcrossTheRoom(), LEANING_ON_TOP, { x: 3206.8, y: 5200 }, { attackRange: 250 });
  assert.ok(await runTicks(session, 10) < 200);
});

/**
 * The swing's sight line was asked every 16 units, so a board thinner than
 * that hid nothing whenever two samples fell either side of it. The tile
 * libraries hold thirteen such colliders: twelve 14-unit boards in the
 * castle's prison and catacombs, and the jungle aztec temple's altar slab,
 * 6.6 across, which a halberd knight swung through.
 */
test("a hero behind a board thinner than 16 units is not hit through it", async () => {
  await loadNavigationLibrary();
  // A castle board, 14 across, the whole width of the room: no way round.
  const navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 400, maxY: 500 },
    cellSize: 30,
    staticColliders: [{ type: "rectangle", x: 200, y: 200, halfWidth: 200, halfHeight: 7, angle: 0 }],
  });
  const monster = { x: 200, y: 250 };
  // It stands off at 253.5, from where the samples of the line to his body
  // lay at 207.5 and 192.2, and swung.
  const hero = { x: 200, y: 183.5 };
  assert.equal(isPositionBlocked(navigation, monster, 35), false);
  assert.equal(isPositionBlocked(navigation, collisionPointOf({ constant: "BERSERKER" }, hero), 22), false);
  const session = makeSession(navigation, hero, monster, { attackRange: 250 });

  assert.equal(await runTicks(session, 20), 200, "a swing went through the board");
  assert.equal(session.actors.get(MONSTER).ai.state, "blocked");
});

test("a hero on the aztec altar is not hit through its slab", async () => {
  await loadNavigationLibrary();
  const floor = await buildFloor("Resources/Levels/jungle/aztec/tiles.json", { tileCount: 14, seed: 42 });
  const navigation = createNavigationState(floor.navigation);
  const altar = navigation.colliders.find((collider) => collider.sourceConstant === "JURASSIC_AZTEC_GROUND_ALTAR" && collider.x === 2250 && collider.y === 1099);
  assert.ok(altar, "the altar is where the floor laid it");
  assert.equal(altar.halfHeight * 2 < 7, true, `the slab is ${altar.halfHeight * 2} across`);

  // The hero's feet at its north edge, his body north of it; a halberd knight's body south.
  const hero = { x: 2250, y: 1096.7 };
  const monster = { x: 2250, y: 1144.7 };
  const body = collisionPointOf({ constant: "BERSERKER" }, hero);
  assert.equal(isPositionBlocked(navigation, monster, 35), false);
  assert.equal(isPositionBlocked(navigation, hero, 0), true, "the feet are on the slab");
  // Every 16 units, the line to the body lies either side of the slab.
  const samples = Math.ceil(Math.hypot(body.x - monster.x, body.y - monster.y) / 16);
  for (let at = 1; at <= samples; at++) {
    const point = { x: monster.x + ((body.x - monster.x) * at) / samples, y: monster.y + ((body.y - monster.y) * at) / samples };
    assert.equal(isPositionBlocked(navigation, point, 0), false, `sample ${at} is in the slab`);
  }
  assert.equal(hasLineOfSight(navigation, monster, body, 0), false, "seen through the slab");

  // It may walk round the slab and swing from the hero's side, never through it.
  const session = makeSession(navigation, hero, monster);
  const knight = session.actors.get(MONSTER);
  const crossesSlab = (from, to) => {
    const along = (altar.y - from.y) / (to.y - from.y);
    const x = from.x + (to.x - from.x) * along;
    return along > 0 && along < 1 && Math.abs(x - altar.x) <= altar.halfWidth;
  };
  let hitPoints = 200;
  for (let tick = 0; tick < 40; tick++) {
    const from = { ...knight.position };
    await tickNpcAi(session, 1000 + tick * 100, 0.1);
    const now = session.actors.get(HERO).hitPoints;
    if (now < hitPoints) {
      assert.equal(crossesSlab(from, hero) && crossesSlab(from, body), false, `hit through the slab from ${JSON.stringify(from)} at tick ${tick}`);
    }
    hitPoints = now;
  }
});

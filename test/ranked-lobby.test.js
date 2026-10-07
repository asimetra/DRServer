import assert from "node:assert/strict";
import test from "node:test";

import { rankedSettings } from "../src/modes/ranked/settings.js";
import { RING_PILE, insideRing, ringMarkers, ringPiles, ringSpot } from "../src/modes/ranked/stock-client/ring.js";
import { applyDamage } from "../src/socket/combat.js";
import { loadFloorAt, quietFloor } from "../src/socket/floors.js";
import { addNavigationObstacle, createNavigationState, isPositionBlocked } from "../src/socket/navigation.js";
import { passesFilter } from "../src/socket/dungeon.js";
import { CLID } from "../src/socket/opcodes.js";

test("a quiet floor keeps where to stand and its gates, and nothing that fights, pays or ends it", () => {
  const gate = { constant: "CASTLE_ARENA_GATE_E" };
  const jail = { constant: "CASTLE_ARENA_TRAP_JAIL" };
  const spikes = { constant: "CASTLE_ARENA_TRAP_SPIKES" };
  const floor = {
    name: "castle/arena/lobby.json",
    placements: {
      heroSpawn: ["spawn"],
      npc: ["crate", "barrel", "minotaur"],
      collectable: ["gold"],
      triggerable: [gate, jail, spikes, { constant: "FLOOR_MESSAGE_TRIGGERABLE" }, { constant: "FLOOR_COMPLETION_IMMEDIATE" }],
      generator: ["wave"],
      trigger: ["plate"],
      logicGate: ["not"],
    },
    secrets: ["room"],
  };
  const quiet = quietFloor(floor);
  assert.deepEqual(quiet.placements, {
    heroSpawn: ["spawn"],
    npc: [],
    collectable: [],
    triggerable: [gate, jail, spikes],
    generator: [],
    trigger: [],
    logicGate: [],
  });
  assert.equal(quiet.harmless, true, "the spikes go where triggerables are built: they attack");
  assert.deepEqual(quiet.secrets, []);
  assert.equal(quiet.name, "castle/arena/lobby.json (quiet)");
});

test("the props filter lets crates and barrels through, and holds the minotaur back", () => {
  assert.equal(passesFilter({ CharType: "PROP" }, "props"), true);
  assert.equal(passesFilter({ CharType: "BOSS" }, "props"), false);
  assert.equal(passesFilter({ CharType: "BOSS" }, "all"), true);
});

test("a quiet floor can be given its NPCs and where heroes arrive", () => {
  const floor = {
    name: "lobby.json",
    placements: { heroSpawn: [{ kind: "heroSpawn", x: 1, y: 2 }], npc: ["crate"], triggerable: [] },
    spawn: { kind: "heroSpawn", x: 1, y: 2 },
    secrets: [],
  };
  const quiet = quietFloor(floor, { npc: ["pile"], spawn: { x: 10, y: 20 } });
  assert.deepEqual(quiet.placements.npc, ["pile"], "the given NPCs, none of the floor's own");
  assert.deepEqual(quiet.placements.heroSpawn, [{ kind: "heroSpawn", x: 10, y: 20 }]);
  assert.deepEqual(quiet.spawn, { x: 10, y: 20 }, "what heroes are put down at");
  assert.deepEqual(quietFloor(floor).spawn, floor.spawn, "and the floor's own when none is given");
});

/**
 * A pile's blocking box (library_server.json, CASTLE_ARENA_SMASH_SKULL): 102×68,
 * centred 1 left of and 6 above where it stands. A hero is 22 across on the
 * client (its nav circle) and 26 on the server (CollisionSize 22 × Scale 1.176).
 */
const box = ({ x, y }) => ({ left: x - 52, right: x + 50, top: y - 40, bottom: y + 28 });
const HERO = { client: 22, server: 26 };
const gapsAlong = (boxes, from, to) =>
  boxes.slice(1).map((next, i) => next[from] - boxes[i][to]);

test("the ring's sides are shut, and its way in is the middle of the top and of the bottom", () => {
  const ring = rankedSettings.ring;
  const piles = ringPiles(ring);
  const centre = (ring.x0 + ring.x1) / 2;
  for (const y of [ring.y0, ring.y1]) {
    const row = piles.filter((pile) => pile.y === y).sort((a, b) => a.x - b.x).map(box);
    const gaps = gapsAlong(row, "left", "right");
    const way = gaps.indexOf(Math.max(...gaps));
    assert.ok(gaps[way] >= 2 * HERO.server + 40, `a way in ${gaps[way]}px wide`);
    assert.ok(Math.abs((row[way].right + row[way + 1].left) / 2 - centre) <= 2, "in the middle");
    assert.ok(gaps.every((gap, i) => i === way || gap < 2 * HERO.client), "and nowhere else along the row");
  }
  for (const x of [ring.x0, ring.x1]) {
    const column = piles.filter((pile) => pile.x === x).sort((a, b) => a.y - b.y).map(box);
    assert.ok(gapsAlong(column, "top", "bottom").every((gap) => gap < 2 * HERO.client), "no hero through a side");
  }
  assert.deepEqual(
    ringMarkers(ring).map(({ constant, x, y }) => ({ constant, x, y })),
    piles.map((at) => ({ constant: RING_PILE, ...at }))
  );
  assert.deepEqual(ringPiles(null), [], "no ring, no piles");
});

/**
 * On the real lobby floor: the hero arrives outside the ring and clear of
 * everything that blocks — the piles, the pillar, the arena's shut south gate —
 * and can walk straight in through the bottom way.
 */
test("on the lobby floor the hero arrives outside the ring, clear, and can walk in", async () => {
  const { ring, lobbySpawn, lobbyFloor, lobbyTiles } = rankedSettings;
  const plan = {
    floors: [{ authored: lobbyFloor, retile: lobbyTiles, quiet: { npc: ringMarkers(ring), spawn: lobbySpawn } }],
  };
  const floor = await loadFloorAt(plan, 0);
  for (const { x, y, tileId } of lobbyTiles) {
    assert.equal(floor.tiles.find((tile) => tile.x === x && tile.y === y)?.tileId, tileId, `the forest at ${x},${y}`);
  }
  assert.deepEqual(floor.spawn, lobbySpawn);
  assert.equal(insideRing(ring, floor.spawn), false, "arriving is not queueing");

  assert.equal(floor.placements.npc.length, ringPiles(ring).length);
  assert.ok(floor.placements.npc.every((npc) => npc.constant === RING_PILE && npc.navigationColliders?.length));

  const navigation = createNavigationState(floor.navigation);
  for (const npc of floor.placements.npc) addNavigationObstacle(navigation, npc.id, npc.navigationColliders);
  // The hero's circle sits 22 above its feet (library_server.json, every hero).
  const blocked = ({ x, y }) => isPositionBlocked(navigation, { x, y: y - 22 }, HERO.server);
  assert.equal(blocked(floor.spawn), false, "nothing where the hero is put down");
  for (let y = floor.spawn.y; y > ring.y1 - 60; y -= 10) {
    assert.equal(blocked({ x: floor.spawn.x, y }), false, `up through the way in, at y ${y}`);
  }
  assert.ok(insideRing(ring, { x: floor.spawn.x, y: ring.y1 - 60 }), "and that is inside");
  // Where a fresh lobby puts somebody still in line (adapter.js, relobby).
  assert.ok(insideRing(ring, ringSpot(ring)));
  assert.equal(blocked(ringSpot(ring)), false, "clear of the piles and the pillar");
  // The forest is solid; the arena's own yard, half of it on the north tile, is not.
  assert.equal(blocked({ x: 4050, y: 3500 }), false, "the gate yard north of the ring");
  assert.equal(blocked({ x: 3150, y: 3150 }), true, "a forest tile");
  assert.equal(blocked({ x: 3740, y: 3900 }), false, "the way round the ring, west");
  assert.equal(blocked({ x: 4355, y: 3900 }), false, "and east");
});

test("a floor is retiled only with tiles its library has, where it has a tile", async () => {
  const { lobbyFloor } = rankedSettings;
  await assert.rejects(
    loadFloorAt({ floors: [{ authored: lobbyFloor, retile: [{ x: 2700, y: 2700, tileId: "no.such.tile" }] }] }, 0),
    /has no tile no\.such\.tile/
  );
  await assert.rejects(
    loadFloorAt({ floors: [{ authored: lobbyFloor, retile: [{ x: 1, y: 1, tileId: "73.1335468865665" }] }] }, 0),
    /no tile stands at 1,1/
  );
});

test("nothing on a harmless floor is hurt: the ring's piles stay standing", () => {
  const sent = [];
  const pile = { hitPoints: 1, maxHitPoints: 1, constant: RING_PILE };
  const session = {
    currentFloor: { harmless: true },
    objects: new Map([[700, CLID.DistributedNPCGameObject]]),
    actors: new Map([[700, pile]]),
    send: (frame) => sent.push(frame),
  };
  let announced = false;
  assert.equal(applyDamage(session, 700, 50, () => (announced = true)), false);
  assert.equal(pile.hitPoints, 1);
  assert.equal(pile.dead, undefined);
  assert.deepEqual([sent, announced], [[], false], "told nothing: no number, no stagger");
});

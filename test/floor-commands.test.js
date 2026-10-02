import assert from "node:assert/strict";
import test from "node:test";

import { buildFloor } from "./helpers/floor.js";
import { COMMAND_PREFIX, resetCommands, runCommand } from "../src/socket/commands.js";
import { registerBuiltinCommands } from "../src/socket/command-set.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { CLID } from "../src/socket/opcodes.js";
import { clearPresence, mirrorPresence } from "../src/socket/presence.js";
import { floorHolds } from "../src/socket/floorstate.js";

/**
 * The commands a player reads a floor with.
 *
 * They exist for the report that follows a fault. "A monster got stuck in the
 * jungle" names nothing anybody can go and look at; the node, the map, the
 * tile it happened on and what the floor was still waiting for do, and none of
 * them appear on any screen the game has. Every one of these only reads, and
 * only the floor its caller is standing on.
 */

const HERO = 500;
const BERSERKER = 101;

const onFloor = (overrides = {}) => ({
  id: 7,
  accountId: 900,
  dungeonAccount: { id: 900, name: "Simetra" },
  dungeonAvatar: { avatar_id: BERSERKER, experience: 0 },
  heroDoid: HERO,
  floorDoid: 400,
  areaDoid: 300,
  mapNodeId: 50020,
  mapPage: { Name: "Lava Golem", TotalEnemyXP: 950 },
  floorIndex: 1,
  floorCount: 3,
  heroPosition: { x: 2143, y: 1210 },
  currentFloor: {
    name: "jungle/tribal/db_floor_LAVA_GOLEM_BOSS_1.json",
    tiles: [
      { x: 0, y: 0, tileId: "117.1337883859372" },
      { x: 1800, y: 900, tileId: "LETile.345.1304631746580" },
    ],
  },
  revealedTiles: [],
  objects: new Map([[HERO, CLID.HeroGameObject]]),
  actors: new Map([[HERO, { hitPoints: 640, maxHitPoints: 880, position: { x: 2143, y: 1210 } }]]),
  ...overrides,
});

let said = [];
const run = async (session, line) => {
  said = [];
  const reply = (message) => said.push(message);
  reply.warn = (message) => said.push(message);
  await runCommand(session, `${COMMAND_PREFIX}${line}`, reply);
  return said.join("\n");
};

const enemy = (constant, x, y, more = {}) => ({
  constant,
  isEnemy: true,
  hitPoints: 40,
  maxHitPoints: 120,
  position: { x, y },
  ...more,
});

test.beforeEach(() => {
  resetCommands();
  registerBuiltinCommands();
  clearPresence();
});

// --- /where --------------------------------------------------------------------

test("where names the node, the floor, the map and the tile underfoot", async () => {
  const text = await run(onFloor(), "where");

  assert.match(text, /node 50020 Lava Golem/);
  assert.match(text, /floor 2 of 3/);
  assert.match(text, /map jungle\/tribal\/db_floor_LAVA_GOLEM_BOSS_1\.json/);
  assert.match(text, /tile LETile\.345\.1304631746580 at 1800, 900/);
  assert.match(text, /x 2143, y 1210/);
  assert.match(text, /343, 310 inside the tile/, "where in the tile, which is how its objects are authored");
  assert.equal(said.length, 1, "one chat entry, not one a line");
});

/**
 * A laid-out floor has no file to name. What reproduces it is the library it
 * was drawn from and the seed, and that is what its name already holds.
 */
test("where gives the seed of a floor that was laid out", async () => {
  const text = await run(
    onFloor({
      currentFloor: {
        name: "Resources/Levels/castle/arena/tiles.json#1329464621",
        generated: true,
        tiles: [{ x: 1800, y: 900, tileId: "215.1313623587301" }],
      },
    }),
    "where"
  );

  assert.match(text, /map castle\/arena\/tiles\.json seed 1329464621/);
  assert.match(text, /tile 215\.1313623587301/);
});

test("where finds a secret room's tile once it has been opened", async () => {
  const session = onFloor({
    heroPosition: { x: 3000, y: 100 },
    revealedTiles: [{ x: 2700, y: 0, tileId: "SECRET.1" }],
  });

  assert.match(await run(session, "where"), /tile SECRET\.1 at 2700, 0/);
});

test("where says so when there is no tile underfoot", async () => {
  const text = await run(onFloor({ heroPosition: { x: -50, y: 5000 } }), "where");

  assert.match(text, /no tile here/);
  assert.match(text, /x -50, y 5000/);
});

test("where still refuses outside a floor", async () => {
  assert.match(await run({ id: 7 }, "where"), /not on a floor/);
});

/**
 * On a floor the server really built, which is the only place the fixtures
 * above can be wrong about what a session holds.
 */
test("where and floor read a floor as it is actually built", async () => {
  const PRISON = "castle/prison/tiles.json";
  let world = null;
  for (let seed = 1; seed <= 40 && !world?.floor.secrets?.length; seed += 1) {
    world = await buildFloor(PRISON, { tier: 1, seed });
  }
  assert.ok(world.floor.secrets?.length, "a seed in 1..40 lays out a secret room");
  const { session, floor } = world;

  const [tile] = floor.tiles;
  session.heroPosition = { x: tile.x + 450, y: tile.y + 450 };
  const here = await run(session, "where");
  assert.ok(here.includes(`tile ${tile.tileId} at ${tile.x}, ${tile.y}`), here);
  assert.match(here, /map castle\/prison\/tiles\.json seed \d+/);
  assert.match(here, /450, 450 inside the tile/);

  // A secret room is no tile at all until its door is broken.
  const [room] = floor.secrets;
  session.heroPosition = { x: room.tile.x + 450, y: room.tile.y + 450 };
  assert.match(await run(session, "where"), /no tile here/);
  await session.revealSecretRoom(room.openedBy[0]);
  assert.ok((await run(session, "where")).includes(`tile ${room.tile.tileId}`));

  const { alive } = floorHolds(session);
  const report = await run(session, "floor");
  assert.match(report, /not cleared/);
  assert.ok(report.includes(`${alive.length} enem`), report);
});

/**
 * What a run has opened is the floor's and not the member's who built it, or
 * everybody but the host stands on "no tile" inside a secret room.
 */
test("where finds an opened secret room for every member of a party", async () => {
  const member = (id, heroDoid) => ({
    id,
    accountId: id,
    playerDoid: id,
    heroDoid,
    objects: new Map([[heroDoid, CLID.HeroGameObject]]),
    actors: new Map([[heroDoid, { hitPoints: 100, maxHitPoints: 100 }]]),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid: () => 100,
  });
  const host = member(41, 501);
  const guest = member(42, 502);
  const world = createMatchWorld({ id: 1, members: new Set([host, guest]) }, host);
  const building = world.contextFor(host);
  building.currentFloor = { name: "castle/prison/tiles.json#7", tiles: [{ x: 0, y: 0, tileId: "A" }] };
  building.revealedTiles = [{ x: 900, y: 0, tileId: "SECRET.1" }];

  const asking = world.contextFor(guest);
  guest.heroPosition = { x: 1000, y: 100 };

  assert.match(await run(asking, "where"), /tile SECRET\.1 at 900, 0/);
});

// --- /floor --------------------------------------------------------------------

test("floor says what is keeping it from being cleared", async () => {
  const session = onFloor({
    floorExits: [{ x: 0, y: 0 }],
    enemiesSeen: 9,
    generators: new Map([
      [11, { placement: { id: 11, spawnConstant: "SKELETON_GRUNT" }, maxSpawns: 8, attemptedSpawns: 3, alive: 2, started: true, completed: false }],
      [12, { placement: { id: 12, spawnConstant: "SKELETON_ARCHER", x: 1900, y: 1000 }, maxSpawns: 4, attemptedSpawns: 0, alive: 0, started: false, completed: false }],
      [13, { placement: { id: 13, spawnConstant: "IMP" }, maxSpawns: 2, attemptedSpawns: 2, alive: 0, started: true, completed: true }],
    ]),
  });
  session.actors.set(20, enemy("SKELETON_GRUNT", 2143, 1710, { ai: { state: "blocked" } }));
  session.actors.set(21, enemy("SKELETON_GRUNT", 100, 100));
  session.actors.set(22, { constant: "BARREL", isEnemy: false, hitPoints: 1, maxHitPoints: 1, position: { x: 2143, y: 1220 } });

  const text = await run(session, "floor");

  assert.match(text, /floor 2 of 3 — not cleared/);
  assert.match(text, /2 enemies alive, 9 seen/, "a barrel is not an enemy");
  assert.match(text, /nearest SKELETON_GRUNT, 500 away at 2143, 1710 on tile LETile\.345\.1304631746580, blocked/);
  assert.match(text, /2 generators unfinished: 1 running, 1 not started/);
  assert.match(text, /SKELETON_GRUNT 3 of 8 spawned, 2 alive/);
  assert.match(
    text,
    /nearest not started: SKELETON_ARCHER at 1900, 1000 on tile LETile\.345\.1304631746580, 4 to spawn/
  );
  assert.doesNotMatch(text, /IMP/, "a generator that has finished is not holding anything");
  assert.match(text, /clearing it opens the exit/);
  assert.equal(said.length, 1);
});

test("floor says how a last floor ends", async () => {
  const byKills = onFloor({ floorIndex: 2, floorExits: [], enemiesSeen: 1 });
  byKills.actors.set(20, enemy("LAVA_GOLEM", 0, 0));
  assert.match(await run(byKills, "floor"), /last floor: it ends when the last enemy falls/);

  // A chest to break or a switch to reach — see `authorsItsOwnEnding`.
  const byTrigger = onFloor({
    floorIndex: 2,
    floorExits: [],
    enemiesSeen: 1,
    triggerableNames: new Map([[5, "FLOOR_COMPLETION_IMMEDIATE"]]),
  });
  byTrigger.actors.set(20, enemy("LAVA_GOLEM", 0, 0));
  assert.match(await run(byTrigger, "floor"), /last floor: it ends by its own trigger/);
});

test("floor says when it is cleared, and when nothing has spawned to clear", async () => {
  const cleared = onFloor({ floorCleared: true, floorExits: [{ x: 0, y: 0 }], enemiesSeen: 4 });
  assert.match(await run(cleared, "floor"), /floor 2 of 3 — cleared/);

  const empty = onFloor({ floorExits: [{ x: 0, y: 0 }], enemiesSeen: 0 });
  assert.match(await run(empty, "floor"), /nothing has spawned yet/);
});

test("floor refuses outside a floor", async () => {
  assert.match(await run({ id: 7 }, "floor"), /not on a floor/);
});

// --- /near ---------------------------------------------------------------------

test("near lists what stands around the hero, closest first", async () => {
  const session = onFloor();
  session.actors.set(20, enemy("SKELETON_ARCHER", 2143, 1510, { ai: { state: "chase" } }));
  session.actors.set(21, enemy("SKELETON_GRUNT", 2243, 1210, { ai: { state: "blocked" } }));
  session.actors.set(22, { constant: "BARREL", isEnemy: false, hitPoints: 1, maxHitPoints: 1, position: { x: 2143, y: 1410 } });
  session.actors.set(23, enemy("FAR_AWAY", 9000, 9000));
  session.actors.set(24, enemy("CORPSE", 2143, 1211, { dead: true }));

  const text = await run(session, "near");
  const lines = text.split("\n");

  assert.match(lines[0], /SKELETON_GRUNT #21 · 100 away · 40\/120 · blocked/);
  assert.match(lines[1], /BARREL #22 · 200 away · 1\/1 · not an enemy/);
  assert.match(lines[2], /SKELETON_ARCHER #20 · 300 away · 40\/120 · chase/);
  assert.doesNotMatch(text, /FAR_AWAY|CORPSE/);
  assert.doesNotMatch(text, new RegExp(`#${HERO}\\b`), "the hero is not near itself");
  assert.equal(said.length, 1);
});

test("near takes a reach, and caps what it prints", async () => {
  const session = onFloor();
  for (let index = 0; index < 12; index++) {
    session.actors.set(100 + index, enemy("IMP", 2143 + 10 * (index + 1), 1210));
  }
  session.actors.set(23, enemy("FAR_AWAY", 2143, 4210));

  const capped = await run(session, "near");
  assert.equal(capped.split("\n").filter((text) => /IMP #/.test(text)).length, 8);
  assert.match(capped, /and 4 more/);

  assert.match(await run(session, "near 4000"), /and 5 more/, "a wider reach finds the far one too");
  assert.match(await run(session, "near x"), /reach must be a number/);
});

test("near says so when nothing is around", async () => {
  assert.match(await run(onFloor(), "near"), /nothing within 900/);
});

// --- /party --------------------------------------------------------------------

test("party lists who is on the run, with the hero each one brought", async () => {
  const text = await run(onFloor(), "party");

  assert.match(text, /Simetra \(you\) — BERSERKER lv \d+ · 640\/880/);
});

test("party lists every member, and says who is down", async () => {
  const member = (id, heroDoid, name, hitPoints) => ({
    id,
    accountId: id,
    playerDoid: id,
    heroDoid,
    dungeonAccount: { id, name },
    dungeonAvatar: { avatar_id: BERSERKER, experience: 0 },
    objects: new Map([[heroDoid, CLID.HeroGameObject]]),
    actors: new Map([[heroDoid, { hitPoints, maxHitPoints: 880, dead: hitPoints === 0 }]]),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid: () => 100,
  });
  const host = member(41, 501, "Simetra", 640);
  const guest = member(42, 502, "Orhan", 0);
  const world = createMatchWorld({ id: 1, members: new Set([host, guest]) }, host);
  world.contextFor(guest);
  world.objects.set(guest.heroDoid, CLID.HeroGameObject);
  world.actors.set(guest.heroDoid, guest.actors.get(guest.heroDoid));

  const text = await run(world.contextFor(host), "party");

  assert.match(text, /Simetra \(you\) — BERSERKER lv \d+ · 640\/880/);
  assert.match(text, /Orhan — BERSERKER lv \d+ · down/);
});

// --- /xp -----------------------------------------------------------------------

test("xp says what the run has paid and what a kill is worth", async () => {
  const session = onFloor({
    dungeonRewards: { gold: 0, gems: 0, xp: 132 },
    runXp: { weight: 411, unit: 2.5 },
  });

  const text = await run(session, "xp");

  assert.match(text, /132 xp this run/);
  assert.match(text, /node total 950/);
  assert.match(text, /weight 1 pays 2\.5, 3 pays 7\.5, 10 pays 25/);
});

test("xp says so while a run has no price", async () => {
  const session = onFloor({ dungeonRewards: { gold: 0, gems: 0, xp: 0 }, runXp: { weight: 0, unit: null } });

  assert.match(await run(session, "xp"), /kills are not priced yet/);
});

// --- /online -------------------------------------------------------------------

test("online counts who is connected and who is in a dungeon, without naming anybody", async () => {
  mirrorPresence(900, 50020);
  mirrorPresence(901, 50020);
  mirrorPresence(902, 50003);
  mirrorPresence(903, 0);

  const text = await run(onFloor(), "online");

  assert.match(text, /4 online, 3 in dungeons/);
  assert.match(text, /node 50020 ×2/);
  assert.match(text, /node 50003 ×1/);
  assert.doesNotMatch(text, /90[0-3]/, "account ids are not for the room");
});

test("every one of them is a player's command", async () => {
  const session = onFloor();
  for (const name of ["where", "floor", "near", "party", "xp", "online"]) {
    assert.doesNotMatch(await run(session, name), /needs |unknown command/, `${name} asks for no rank`);
  }
});

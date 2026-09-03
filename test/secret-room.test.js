import test from "node:test";
import assert from "node:assert/strict";
import { CLID } from "../src/socket/opcodes.js";
import { buildFloor, readFrame, FLOOR_DOID } from "./helpers/floor.js";
import { sealedRooms } from "../src/socket/secrets.js";
import { applyDamage } from "../src/socket/combat.js";
import { generateFloor, TILE_SIZE } from "../src/socket/tilegen.js";
import { readFile } from "node:fs/promises";

/**
 * A secret room is absent from the floor until its door is broken.
 *
 * The official does not merely wall one off, it withholds the tile: node 50088
 * opens with 8 tiles and no `SECRET_TILE`, and 60ms after the wall at
 * (4050, 6330) loses its last hit point the same floor is handed 9 tiles with
 * one, followed by the creates for everything inside. Ten of the twenty-two
 * secret rooms in the corpus arrive that way and every one of them within a
 * frame of a death. See src/socket/secrets.js.
 */

const PRISON = "castle/prison/tiles.json";

/**
 * The floor's tile list as the client reads it — see writeTile in objects.js.
 *
 * `byteList` prefixes the payload's *length in bytes*, not a count of entries,
 * so the list is walked to the end of that span rather than counted out.
 *
 * `start` is where the tiles field begins: a field update opens with op, doid
 * and field id, and a generate with op, parent, zone, clid and doid.
 */
const readTiles = (body, start) => {
  const end = start + 2 + body.readUInt16LE(start);
  let at = start + 2;
  const tiles = [];
  while (at < end) {
    const x = body.readInt32LE(at);
    const y = body.readInt32LE(at + 4);
    const length = body.readUInt16LE(at + 8);
    at += 10;
    tiles.push({ x, y, tileId: body.toString("utf8", at, at + length) });
    at += length;
  }
  return tiles;
};

const TILES_IN_UPDATE = 8;

/**
 * A laid-out prison floor that happens to hold a withheld room.
 *
 * Searched for rather than pinned to one seed, because the layout is the
 * generator's to change: a seed that holds a secret room today is a seed that
 * silently stops testing anything the day the tile weights move.
 */
const floorWithASecret = async () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const world = await buildFloor(PRISON, { tier: 1, seed });
    if (world.floor.secrets?.length) return world;
  }
  throw new Error("no seed in 1..40 laid out a withheld secret room");
};

test("a withheld room is not on the floor the client is given", async () => {
  const world = await floorWithASecret();
  const [room] = world.floor.secrets;

  /**
   * `floor.tiles` and not a captured frame: the floor object's generate is sent
   * by the caller, and this helper starts at `buildFloorWorld`. It is the same
   * list either way — both the generate and every later update are written from
   * it — and the reveal test below reads the real bytes.
   */
  assert.ok(world.floor.tiles.length > 0, "the floor has tiles");
  assert.ok(
    !world.floor.tiles.some((tile) => tile.x === room.tile.x && tile.y === room.tile.y),
    `the room at ${room.tile.x},${room.tile.y} was left on the floor`
  );
});

test("nothing inside a withheld room is generated with the floor", async () => {
  const world = await floorWithASecret();
  const [room] = world.floor.secrets;

  assert.ok(room.placements.npc.length > 0, "the room has something in it to withhold");
  for (const placement of room.placements.npc) {
    assert.ok(
      !world.npcs.some((npc) => npc.x === placement.x && npc.y === placement.y),
      `${placement.constant} at ${placement.x},${placement.y} was generated anyway`
    );
  }
});

test("breaking the door sends the room and everything standing in it", async () => {
  const world = await floorWithASecret();
  const [room] = world.floor.secrets;
  const [opener] = room.openedBy;

  const after = [];
  world.session.send = (frame) => after.push(frame);
  await world.session.revealSecretRoom(opener);
  const frames = after.map(readFrame);

  const update = frames.find((frame) => frame.kind === "field" && frame.field === 195);
  assert.ok(update, "the floor is handed a new tile list");
  assert.equal(update.doid, FLOOR_DOID);

  const tiles = readTiles(update.body, TILES_IN_UPDATE);
  assert.ok(
    tiles.some((tile) => tile.x === room.tile.x && tile.y === room.tile.y),
    "the new list holds the room"
  );
  /**
   * Whole, not a delta. `DistributedDungeonFloor.tiles` is a list field, and
   * the client dedupes by (x, y) — sending only the new tile would replace the
   * floor with a single room.
   */
  assert.equal(tiles.length, world.floor.tiles.length + 1);

  const generated = frames.filter(
    (frame) => frame.kind === "generate" && frame.clid === CLID.DistributedNPCGameObject
  );
  assert.equal(generated.length, room.placements.npc.length);
});

test("a room only opens once, however often its door reports dying", async () => {
  const world = await floorWithASecret();
  const [room] = world.floor.secrets;
  const [opener] = room.openedBy;

  await world.session.revealSecretRoom(opener);
  const after = [];
  world.session.send = (frame) => after.push(frame);
  await world.session.revealSecretRoom(opener);

  assert.equal(after.length, 0, "the second break sent something");
});

test("a room whose only wall is its own is left on the floor", () => {
  /**
   * Withholding it would take the wall with it and leave a room nothing in the
   * game could ever open. Three of the recorded rooms are this shape and all
   * three shipped with their floor.
   */
  const definitions = new Map([
    [
      "room",
      {
        id: "room",
        category: "SECRET_TILE",
        LEObjects: [{ type: "LENPC", id: 1, constant: "CASTLE_PRISON_WALL_SECRET", y: 30 }],
      },
    ],
    ["below", { id: "below", category: "BASIC_TILE", LEObjects: [] }],
  ]);
  const tiles = [
    { x: 0, y: 0, tileId: "room" },
    { x: 0, y: 900, tileId: "below" },
  ];

  assert.equal(sealedRooms(definitions, tiles).size, 0);
});

test("a wall along the room's back does not count as its door", () => {
  /**
   * The seal has to be standing in the doorway. A `WALL_SECRET` further down
   * the neighbour's tile is scenery, and treating it as a door hides a room
   * behind something that does not open it.
   */
  const definitions = new Map([
    ["room", { id: "room", category: "SECRET_TILE", LEObjects: [] }],
    [
      "below",
      {
        id: "below",
        category: "BASIC_TILE",
        LEObjects: [{ type: "LENPC", id: 7, constant: "CASTLE_PRISON_WALL_SECRET", y: 600 }],
      },
    ],
  ]);
  const tiles = [
    { x: 0, y: 0, tileId: "room" },
    { x: 0, y: 900, tileId: "below" },
  ];

  assert.equal(sealedRooms(definitions, tiles).size, 0);

  const inTheDoorway = new Map(definitions);
  inTheDoorway.set("below", {
    ...definitions.get("below"),
    LEObjects: [{ type: "LENPC", id: 7, constant: "CASTLE_PRISON_WALL_SECRET", y: 30 }],
  });
  assert.deepEqual([...sealedRooms(inTheDoorway, tiles).get(0).openedBy], ["1:7"]);
});

test("killing the wall itself opens the room", async () => {
  /**
   * The end to end path, and the one that can break silently. The id
   * `sealedRooms` writes down is built from the tile library, and the id the
   * death reports is the one `readPlacements` put on the placement — two
   * different files deriving the same string. Nothing else notices if they
   * stop agreeing; the room simply never opens, on a floor where it was never
   * visible to begin with.
   */
  const world = await floorWithASecret();
  const [room] = world.floor.secrets;
  const [opener] = room.openedBy;

  const wall = world.floor.placements.npc.find((placement) => placement.id === opener);
  assert.ok(wall, `no placement carries the opening id ${opener}`);

  const [doid, actor] = [...world.session.actors].find(
    ([, candidate]) => candidate.position?.x === wall.x && candidate.position?.y === wall.y
  ) ?? [];
  assert.ok(actor, `the wall at ${wall.x},${wall.y} was never generated`);

  const after = [];
  world.session.send = (frame) => after.push(frame);
  applyDamage(world.session, doid, actor.hitPoints);
  await new Promise((resolve) => setImmediate(resolve));

  const tiles = after
    .map(readFrame)
    .filter((frame) => frame.kind === "field" && frame.field === 195)
    .flatMap((frame) => readTiles(frame.body, TILES_IN_UPDATE));
  assert.ok(
    tiles.some((tile) => tile.x === room.tile.x && tile.y === room.tile.y),
    "breaking the wall did not reveal the room"
  );
});

test("the way out is never behind a secret room", async () => {
  /**
   * A secret room holds treasure, not the exit. If a floor's way out could sit
   * behind one, the room would stop being optional: the player would have to
   * find and break a wall that the floor never told them about to finish at
   * all, and a floor whose door they failed to spot would be unfinishable.
   *
   * The libraries make it structural rather than lucky — all 36 `SECRET_TILE`
   * definitions across the nine themes have exactly one opening, so a room is a
   * cul-de-sac and `seamFits` can only ever attach it by that one side. This
   * asserts the layout keeps it that way.
   *
   * Adjacency is not connection and is not checked: an `EXIT_TILE` may sit on
   * the far side of a secret room's wall, and does on three of the generated
   * test maps. The official places neighbours on all four sides too. What
   * matters is that nothing is reachable *through* the room.
   */
  const STEP = [
    [0, -TILE_SIZE],
    [TILE_SIZE, 0],
    [0, TILE_SIZE],
    [-TILE_SIZE, 0],
  ];
  const opposite = (direction) => (direction + 2) % 4;

  /**
   * Three themes that actually lay secret rooms down at this tile count — 75 of
   * them across the 150 floors, 63 on a floor that also has an exit. Picked by
   * counting rather than by taste: `jungle/aztec` was in this list first and
   * produced none in fifty seeds, so it asserted nothing at all.
   */
  for (const theme of ["castle/prison", "nordic/temple", "nordic/caves"]) {
    const library = JSON.parse(
      await readFile(`local-data/Resources/Levels/${theme}/tiles.json`, "utf8")
    );
    const definitions = new Map((library.LETiles ?? []).map((tile) => [tile.id, tile]));

    for (let seed = 1; seed <= 50; seed += 1) {
      const { tiles } = generateFloor(library, { tier: 1, tileCount: 24, seed });
      const at = new Map(tiles.map((tile) => [`${tile.x},${tile.y}`, tile]));
      const categoryOf = (tile) => definitions.get(tile?.tileId)?.category;

      const secrets = tiles.filter((tile) => categoryOf(tile) === "SECRET_TILE");
      if (!secrets.length) continue;

      for (const room of secrets) {
        const definition = definitions.get(room.tileId);
        const ways = STEP.filter(([dx, dy], direction) => {
          const neighbour = at.get(`${room.x + dx},${room.y + dy}`);
          const width = Number(definition.exits?.[direction]);
          return (
            neighbour &&
            width > 0 &&
            width === definitions.get(neighbour.tileId)?.exits?.[opposite(direction)]
          );
        });
        assert.ok(
          ways.length <= 1,
          `${theme} seed ${seed}: the room at ${room.x},${room.y} is a corridor, not a dead end`
        );
      }

      const exit = tiles.find((tile) => categoryOf(tile) === "EXIT_TILE");
      if (!exit) continue;

      // Walk the floor with every secret room still sealed.
      const start = tiles.find((tile) => categoryOf(tile) === "STARTING_TILE") ?? tiles[0];
      const shut = new Set(secrets.map((tile) => `${tile.x},${tile.y}`));
      const seen = new Set([`${start.x},${start.y}`]);
      const queue = [start];
      while (queue.length) {
        const tile = queue.shift();
        const definition = definitions.get(tile.tileId);
        STEP.forEach(([dx, dy], direction) => {
          const key = `${tile.x + dx},${tile.y + dy}`;
          const neighbour = at.get(key);
          if (!neighbour || seen.has(key) || shut.has(key)) return;
          const width = Number(definition?.exits?.[direction]);
          if (!(width > 0)) return;
          if (width !== definitions.get(neighbour.tileId)?.exits?.[opposite(direction)]) return;
          seen.add(key);
          queue.push(neighbour);
        });
      }

      assert.ok(
        seen.has(`${exit.x},${exit.y}`),
        `${theme} seed ${seed}: the exit can only be reached through a secret room`
      );
    }
  }
});

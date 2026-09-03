/**
 * Rooms the floor does not admit to having until something is broken open.
 *
 * A secret room is not merely shut, it is *absent*. The official does not send
 * its tile with the floor at all: in 118 recorded floor births carrying 22
 * secret rooms, 10 of the rooms reached the client only in a later `floorTiles`
 * update, and every one of those 10 arrived within a frame of a `hitPoints = 0`
 * — the wall in its doorway giving way. Nothing else in the capture appends a
 * tile to a live floor.
 *
 * One run reads end to end. Node 50088, a prison floor, opens with 8 tiles and
 * no `SECRET_TILE` among them. The wall at (4050, 6330) loses its last hit
 * point, and 60ms later the same floor object is handed a 9-tile list that now
 * holds a `SECRET_TILE` at (3600, 5400), followed immediately by the creates
 * for what stands inside it: another secret wall, an iron maiden, a torture
 * chair, a weapon table and four knights. The room and its contents come into
 * being together, when the door breaks.
 *
 * The other 12 ship with the floor, and the difference is who owns the seal.
 * A room shut by a `PROXIMITY_TRIGGER` wired through a `NOT_GATE` to a line of
 * `LETriggerable` wall segments is opened by the client, on its own, when the
 * player walks up to it — the server is not involved and has nothing to reveal,
 * so the tile has to be there already. A room shut by a `WALL_SECRET` *LENPC*
 * is opened by killing it, which only the server can know about.
 *
 * That split is the rule here. It is not clean across the whole sample — three
 * of the rooms sealed by a wall NPC did ship at floor start — but 22 rooms are
 * too few to separate that from a room whose wall was already broken, and the
 * player-visible behaviour the split produces is the one described: the door
 * breaks and the room appears.
 */

import { TILE_SIZE } from "./tilegen.js";

/**
 * How far down the north edge a wall has to sit to be standing in the doorway
 * rather than somewhere along the room's own back wall. Matches the constant
 * the layout rule uses to decide a tile may hold a secret room at all.
 */
const NORTH_DOORWAY = 150;

const isSecretWall = (object) =>
  object.type === "LENPC" && /WALL_SECRET/.test(object.constant ?? "");

/** Walls of this tile that shut the room to its north. */
const doorwayWalls = (definition) =>
  (definition?.LEObjects ?? []).filter(
    (object) => isSecretWall(object) && Number(object.y) < NORTH_DOORWAY
  );

/**
 * Which placed tiles are withheld, and what opens each one.
 *
 * Keyed by the tile's index in `tiles`, because that index is the instance
 * prefix every placement id carries — see `localId` in floors.js — so a dead
 * NPC's placement id is enough to find the room it was holding shut.
 */
export const sealedRooms = (definitionsById, tiles) => {
  const byPosition = new Map(tiles.map((tile, instance) => [`${tile.x},${tile.y}`, instance]));
  const sealed = new Map();

  for (const [instance, tile] of tiles.entries()) {
    const definition = definitionsById.get(tile.tileId);
    if (definition?.category !== "SECRET_TILE") continue;

    /**
     * Only a wall in the *neighbour* counts, and the reason is not a preference.
     * A room's own wall goes away with the room: withhold the tile and the one
     * thing that could have opened it is withheld too, leaving a room nobody in
     * the game can ever reach. So a room shut only by its own wall has to be on
     * the floor from the start — which is exactly where the three recorded
     * rooms of that shape were found.
     *
     * Its one opening faces south, so the tile below is the one holding the
     * door. Node 50088 is this case: the room at (3600, 5400) has no trigger of
     * its own, and the wall that was standing in front of it belonged to the
     * ordinary tile at (3600, 6300).
     */
    const below = byPosition.get(`${tile.x},${tile.y + TILE_SIZE}`);
    if (below === undefined) continue;

    const neighbour = definitionsById.get(tiles[below].tileId);
    const openedBy = doorwayWalls(neighbour).map((object) => `${below}:${object.id}`);
    if (openedBy.length) sealed.set(instance, { openedBy });
  }

  return sealed;
};

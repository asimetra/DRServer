/**
 * Something the server says to everybody.
 *
 * Only to players on a dungeon floor: the client builds its chat log there and
 * nowhere else, so a player in town has nothing a line could be written to. It
 * goes on the server's own warning voice (chat.js), so it reads as the server
 * and not as somebody who happened to be standing there.
 *
 * Each thread says it to the players it holds: the main thread to its own
 * connections, a match worker to the members of its dungeons (see
 * match-worker-pool.js).
 */
import { tellAsServer } from "./chat.js";

/** Writing more than a player may (chat.js) would only be cut short by the client. */
export const MAX_ANNOUNCEMENT_BYTES = 300;

const onFloor = (session) => Boolean(session?.playerDoid && session?.floorDoid);

/** Says `text` to every one of these connections that is on a floor; how many that was. */
export const announceTo = (connections, text) => {
  let heard = 0;
  for (const connection of connections) {
    if (connection.closed) continue;
    const listener = connection.world?.contextFor?.(connection) ?? connection;
    if (!onFloor(listener)) continue;
    tellAsServer(listener, text, { warn: true });
    heard += 1;
  }
  return heard;
};

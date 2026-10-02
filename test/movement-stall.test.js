import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { onConnection } from "../src/socket/index.js";
import { createNavigationState, loadNavigationLibrary } from "../src/socket/navigation.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketWriter } from "../src/socket/packet.js";
import { RULE } from "../src/socket/security-events.js";

/**
 * A connection that stalls is caught up with, not thrown out.
 *
 * The movement budget is a thousand units and refills at a thousand a second,
 * which is right for a client that is talking. A client whose connection
 * stalls is not: it walks on, says nothing for ten seconds, and then delivers
 * all of it at once. A thousand units of that were accepted and the rest
 * refused — and past a thousand units from where the server stopped, every
 * claim was read as a teleport. Three of those closed the socket, and all
 * three were in the same burst. A player on a bad connection was dropped from
 * the run for having walked.
 *
 * The server cannot put the hero back instead. The client reads its own hero's
 * position from its physics body every frame, so a position sent to it is
 * overwritten before it is drawn; only the server can move to meet the client.
 * So silence earns an allowance: what a hero could have walked while nothing
 * was heard from it. The burst then describes its own path, step by step, and
 * is accepted along it — corners and all. It is less than a talking client is
 * allowed over the same time, so staying silent buys nothing.
 *
 * What a bad connection cannot do is stand a hero on a tile the floor does not
 * have, or walk it across one. Those still count, and still close the socket.
 */

const HERO = 500;
const FLID_POSITION = 147;

const fakeSocket = () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.remoteAddress = "movement-test";
  socket.write = () => true;
  socket.pause = () => {};
  socket.resume = () => {};
  socket.destroy = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    socket.emit("close");
  };
  socket.end = socket.destroy;
  return socket;
};

const positionFrame = (x, y) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(HERO).u16(FLID_POSITION).f32(x).f32(y).frame();

const settle = async (session) => {
  for (let index = 0; index < 2000 && (session.draining || session.queue.length); index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const row = (count, y = 0) => Array.from({ length: count }, (_, index) => ({ x: index * 900, y }));

const heroOn = async (tiles, at) => {
  await loadNavigationLibrary();
  const socket = fakeSocket();
  const session = onConnection(socket);
  session.heroDoid = HERO;
  session.floorDoid = 400;
  session.dungeonActive = true;
  session.heroPosition = { ...at };
  session.heroPositionAt = Date.now();
  session.movementCredit = 1000;
  session.movementCreditAt = Date.now();
  session.navigation = createNavigationState({
    bounds: {
      minX: 0,
      minY: 0,
      maxX: Math.max(...tiles.map((tile) => tile.x)) + 900,
      maxY: Math.max(...tiles.map((tile) => tile.y)) + 900,
    },
    tileSize: 900,
    tiles,
  });
  session.objects.set(HERO, CLID.HeroGameObject);
  session.actors.set(HERO, { constant: "RANGER", position: { ...at } });
  session.floorExits = [];
  return { socket, session };
};

/** Sends claims as one chunk, the way a stalled connection delivers its backlog. */
const burst = async (socket, session, points) => {
  for (let at = 0; at < points.length; at += 100) {
    socket.emit(
      "data",
      Buffer.concat(points.slice(at, at + 100).map(([x, y]) => positionFrame(x, y)))
    );
    await settle(session);
  }
};

/** A path walked at a steady speed, one claim every 50ms. */
const along = (from, to, speed = 250) => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(1, Math.round(length / (speed / 20)));
  return Array.from({ length: steps }, (_, index) => [
    from[0] + ((to[0] - from[0]) * (index + 1)) / steps,
    from[1] + ((to[1] - from[1]) * (index + 1)) / steps,
  ]);
};

const rounded = ({ x, y }) => ({ x: Math.round(x), y: Math.round(y) });

test("ten seconds of walking delivered at once is accepted, and nobody is dropped", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { socket, session } = await heroOn(row(5), { x: 300, y: 450 });

  t.mock.timers.tick(10_000);
  await burst(socket, session, along([300, 450], [2800, 450]));

  assert.equal(socket.destroyed, false);
  assert.equal(session.terminationRequested ?? null, null);
  assert.deepEqual(rounded(session.heroPosition), { x: 2800, y: 450 }, "the server is where the player is");
  assert.equal(session.violations?.size ?? 0, 0, "and nothing about it was a violation");
});

test("a stalled walk around a corner is followed around the corner", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // A corridor east along the top, then south down the last column.
  const tiles = [...row(3), { x: 1800, y: 900 }, { x: 1800, y: 1800 }];
  const { socket, session } = await heroOn(tiles, { x: 300, y: 800 });

  t.mock.timers.tick(8400);
  await burst(socket, session, [...along([300, 800], [1900, 800]), ...along([1900, 800], [1900, 1300])]);

  assert.deepEqual(rounded(session.heroPosition), { x: 1900, y: 1300 });
  assert.equal(session.violations?.size ?? 0, 0);
  assert.equal(socket.destroyed, false);
});

/**
 * Six hundred units for every silent second, ten seconds of it at most: an
 * honest hero's best ten seconds are 577 a second. A talking client is allowed
 * a thousand, so silence is never the faster way to anywhere.
 */
test("silence earns less than talking does, and only so much of it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { socket, session } = await heroOn(row(12), { x: 100, y: 450 });

  // A minute of nothing, then a claim for the whole length of the floor.
  t.mock.timers.tick(60_000);
  await burst(socket, session, along([100, 450], [10_700, 450], 4000));

  const travelled = session.heroPosition.x - 100;
  assert.ok(travelled <= 7000, `at most the budget and ten seconds' allowance, not ${Math.round(travelled)}`);
  assert.ok(travelled >= 6800, "and all of that");
  assert.equal(socket.destroyed, false);
});

test("a client that keeps talking earns no allowance, however fast it claims to go", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { socket, session } = await heroOn(row(12), { x: 100, y: 450 });

  // Ten seconds at sixteen times walking speed, one claim every 50ms.
  for (const [x, y] of along([100, 450], [10_100, 450], 4000).slice(0, 200)) {
    t.mock.timers.tick(50);
    await burst(socket, session, [[x, y]]);
  }

  assert.ok(session.heroPosition.x - 100 <= 11_000, "bounded by the budget's own rate");
  assert.equal(session.movementStallCredit ?? 0, 0, "and by nothing else");
});

test("an allowance is spent, not kept", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { socket, session } = await heroOn(row(12), { x: 100, y: 450 });

  t.mock.timers.tick(10_000);
  await burst(socket, session, along([100, 450], [7100, 450], 4000));
  const after = session.heroPosition.x;
  assert.ok(after >= 6900, "the allowance was used");

  // Straight on, with no silence in between: only the ordinary budget is left.
  t.mock.timers.tick(50);
  await burst(socket, session, [[after + 900, 450]]);
  assert.equal(session.heroPosition.x, after, "and there is nothing left of it to jump with");
});

test("a teleport is refused however often it is tried, and closes nothing", async () => {
  const { socket, session } = await heroOn(row(3), { x: 100, y: 100 });
  session.floorExits = [{ x: 1900, y: 100, radius: 150 }];
  session.floorTransition = false;

  for (let attempt = 0; attempt < 5; attempt++) await burst(socket, session, [[1900, 100]]);

  assert.deepEqual(session.heroPosition, { x: 100, y: 100 }, "it goes nowhere");
  assert.equal(session.floorTransition, false, "and reaches no exit");
  assert.equal(socket.destroyed, false, "but a long step is something a bad connection makes too");
});

/**
 * Past the allowance the server is behind, and the first claim it can afford
 * again is a straight line from where it stopped to where the hero now is. If
 * the hero has turned a corner since, that line crosses a tile the floor does
 * not have. It is the server's gap and not the player's route, so it is not
 * counted — and not accepted either, since accepting it is the bridge the tile
 * rule exists to refuse.
 */
test("a catch-up line across a corner is refused without being counted", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const tiles = [...row(3), { x: 1800, y: 900 }, { x: 1800, y: 1800 }];
  const { socket, session } = await heroOn(tiles, { x: 300, y: 800 });

  // No silence first, so no allowance: only the first thousand units land.
  await burst(socket, session, [...along([300, 800], [1900, 800]), ...along([1900, 800], [1900, 1300])]);
  assert.equal(Math.round(session.heroPosition.x), 1300, "the budget runs out before the corner");

  for (const [x, y] of along([1900, 1300], [1900, 1700])) {
    t.mock.timers.tick(50);
    await burst(socket, session, [[x, y]]);
  }

  assert.equal(socket.destroyed, false);
  assert.equal(session.violations.get(RULE.movementSegmentOffTile)?.count ?? 0, 0);
  assert.equal(Math.round(session.heroPosition.x), 1300, "the bridge is still refused");
});

test("walking across a tile the floor does not have still closes the socket", async () => {
  // Two tiles that touch only at a corner: the straight line between them leaves the floor.
  const { socket, session } = await heroOn([{ x: 0, y: 0 }, { x: 900, y: 900 }], { x: 800, y: 880 });

  for (let attempt = 0; attempt < 3; attempt++) await burst(socket, session, [[920, 1000]]);

  assert.equal(socket.destroyed, true);
  assert.equal(session.terminationRequested.rule, RULE.movementSegmentOffTile);
});

test("standing on a tile the floor does not have still closes the socket", async () => {
  const { socket, session } = await heroOn(row(1), { x: 100, y: 100 });

  for (let attempt = 0; attempt < 3; attempt++) await burst(socket, session, [[1000, 100]]);

  assert.equal(socket.destroyed, true);
  assert.equal(session.terminationRequested.rule, RULE.movementEndpointOffTile);
});

/** Silence does not launder a walk across a missing tile either. */
test("an allowance does not carry a hero across a missing tile", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { socket, session } = await heroOn([{ x: 0, y: 0 }, { x: 900, y: 900 }], { x: 800, y: 880 });

  t.mock.timers.tick(10_000);
  for (let attempt = 0; attempt < 3; attempt++) await burst(socket, session, [[920, 1000]]);

  assert.equal(socket.destroyed, true);
  assert.equal(session.terminationRequested.rule, RULE.movementSegmentOffTile);
});

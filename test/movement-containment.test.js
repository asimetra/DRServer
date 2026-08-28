import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { onConnection } from "../src/socket/index.js";
import { createNavigationState, loadNavigationLibrary } from "../src/socket/navigation.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketWriter } from "../src/socket/packet.js";
import { RULE } from "../src/socket/security-events.js";

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

const positionFrame = (doid, x, y) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(147)
    .f32(x)
    .f32(y)
    .frame();

const settle = async (session) => {
  for (let index = 0; index < 100 && (session.draining || session.queue.length); index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test("off-tile claims are reported but never become gameplay position", async () => {
  await loadNavigationLibrary();
  const socket = fakeSocket();
  const session = onConnection(socket);
  session.heroDoid = 500;
  session.floorDoid = 400;
  session.dungeonActive = true;
  session.heroPosition = { x: 850, y: 100 };
  session.reportedHeroPosition = { ...session.heroPosition };
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2700, maxY: 900 },
    tileSize: 900,
    // Both endpoints below can be on real tiles, but the middle of the floor is absent.
    tiles: [
      { x: 0, y: 0 },
      { x: 1800, y: 0 },
    ],
  });
  session.objects.set(500, CLID.HeroGameObject);
  session.actors.set(500, {
    constant: "RANGER",
    position: { ...session.heroPosition },
  });
  // If a rejected claim reached checkFloorExit, this would advance the floor.
  session.floorExits = [{ x: 1850, y: 100, radius: 150 }];
  session.floorTransition = false;

  socket.emit("data", positionFrame(500, 1000, 100));
  await settle(session);
  assert.deepEqual(session.reportedHeroPosition, { x: 1000, y: 100 });
  assert.deepEqual(session.heroPosition, { x: 850, y: 100 }, "missing-tile endpoint is not accepted");
  assert.deepEqual(session.actors.get(500).position, { x: 850, y: 100 });
  assert.equal(session.violations.get(RULE.movementEndpointOffTile).count, 1);

  /**
   * Re-entering on a real exit tile is still measured from the last accepted
   * point, not from the rejected outside claim. The absent middle tile therefore
   * cannot be used as a bridge.
   */
  socket.emit("data", positionFrame(500, 1850, 100));
  await settle(session);
  assert.deepEqual(session.reportedHeroPosition, { x: 1850, y: 100 });
  assert.deepEqual(session.heroPosition, { x: 850, y: 100 });
  assert.equal(session.floorTransition, false, "a rejected exit coordinate has no consequence");
  assert.equal(session.violations.get(RULE.movementSegmentOffTile).count, 1);

  // Ordinary movement on the accepted tile still advances every authoritative copy.
  socket.emit("data", positionFrame(500, 800, 100));
  await settle(session);
  assert.deepEqual(session.heroPosition, { x: 800, y: 100 });
  assert.deepEqual(session.actors.get(500).position, { x: 800, y: 100 });
});

test("a locally deleted prop wall is visible to bounded server telemetry", async () => {
  await loadNavigationLibrary();
  const socket = fakeSocket();
  const session = onConnection(socket);
  session.heroDoid = 500;
  session.floorDoid = 400;
  session.dungeonActive = true;
  session.heroPosition = { x: 300, y: 100 };
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 900, maxY: 900 },
    tileSize: 900,
    tiles: [{ x: 0, y: 0 }],
    // The hero body is 22 units above its foot position, so centre this prop at y=78.
    staticColliders: [
      { type: "rectangle", x: 450, y: 78, halfWidth: 12, halfHeight: 100, angle: 0 },
    ],
  });
  session.objects.set(500, CLID.HeroGameObject);
  session.actors.set(500, {
    constant: "RANGER",
    position: { ...session.heroPosition },
  });

  socket.emit("data", positionFrame(500, 600, 100));
  await settle(session);

  assert.equal(
    session.violations.get(RULE.movementSegmentCrossedGeometry).count,
    1,
    "the server still owns the prop collider the modified client removed"
  );
  assert.deepEqual(
    session.heroPosition,
    { x: 600, y: 100 },
    "wall disagreement remains shadow-only until honest collider mismatches are repaired"
  );
});

test("a direct same-floor teleport cannot activate the exit", async () => {
  await loadNavigationLibrary();
  const socket = fakeSocket();
  const session = onConnection(socket);
  session.heroDoid = 500;
  session.floorDoid = 400;
  session.dungeonActive = true;
  session.heroPosition = { x: 100, y: 100 };
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2700, maxY: 900 },
    tileSize: 900,
    // A continuous floor: tile-containment alone would correctly allow this path.
    tiles: [
      { x: 0, y: 0 },
      { x: 900, y: 0 },
      { x: 1800, y: 0 },
    ],
  });
  session.objects.set(500, CLID.HeroGameObject);
  session.actors.set(500, {
    constant: "RANGER",
    position: { ...session.heroPosition },
  });
  session.floorExits = [{ x: 1900, y: 100, radius: 150 }];
  session.floorTransition = false;

  socket.emit("data", positionFrame(500, 1900, 100));
  await settle(session);

  assert.deepEqual(session.reportedHeroPosition, { x: 1900, y: 100 });
  assert.deepEqual(session.heroPosition, { x: 100, y: 100 }, "the teleport is not authoritative");
  assert.equal(session.floorTransition, false, "and the gate/exit consequence never runs");
  assert.equal(session.violations.get(RULE.movementStepTooLarge).count, 1);
  assert.equal(socket.destroyed, false, "one large step is survivable");

  // Repeating the same impossible claim is a session pattern, not an account verdict.
  socket.emit("data", positionFrame(500, 1900, 100));
  await settle(session);
  socket.emit("data", positionFrame(500, 1900, 100));
  await settle(session);
  assert.equal(socket.destroyed, true, "the third direct teleport closes this socket");
  assert.equal(session.terminationRequested.rule, RULE.movementStepTooLarge);
});

test("invented sub-1000 waypoints cannot compress a route into one packet burst", async () => {
  await loadNavigationLibrary();
  const socket = fakeSocket();
  const session = onConnection(socket);
  session.heroDoid = 500;
  session.floorDoid = 400;
  session.dungeonActive = true;
  session.heroPosition = { x: 100, y: 100 };
  session.movementCredit = 1000;
  session.movementCreditAt = Date.now();
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 2700, maxY: 900 },
    tileSize: 900,
    tiles: [
      { x: 0, y: 0 },
      { x: 900, y: 0 },
      { x: 1800, y: 0 },
    ],
  });
  session.objects.set(500, CLID.HeroGameObject);
  session.actors.set(500, {
    constant: "RANGER",
    position: { ...session.heroPosition },
  });
  session.floorExits = [{ x: 1700, y: 100, radius: 150 }];
  session.floorTransition = false;

  // Both individual steps are below the 1000-unit hard ceiling and stay on real tiles.
  socket.emit(
    "data",
    Buffer.concat([positionFrame(500, 900, 100), positionFrame(500, 1700, 100)])
  );
  await settle(session);

  assert.deepEqual(session.heroPosition, { x: 900, y: 100 }, "only the funded first step lands");
  assert.deepEqual(session.reportedHeroPosition, { x: 1700, y: 100 });
  assert.equal(session.floorTransition, false, "the compressed route never reaches the exit");
  assert.equal(session.violations.get(RULE.movementBudgetExceeded).count, 1);
});

test("repeated impossible tile claims end the session but create no account punishment", async () => {
  await loadNavigationLibrary();
  const socket = fakeSocket();
  const session = onConnection(socket);
  session.heroDoid = 500;
  session.floorDoid = 400;
  session.dungeonActive = true;
  session.heroPosition = { x: 100, y: 100 };
  session.navigation = createNavigationState({
    bounds: { minX: 0, minY: 0, maxX: 1800, maxY: 900 },
    tileSize: 900,
    tiles: [{ x: 0, y: 0 }],
  });
  session.objects.set(500, CLID.HeroGameObject);
  session.actors.set(500, {
    constant: "RANGER",
    position: { ...session.heroPosition },
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    socket.emit("data", positionFrame(500, 1000, 100));
    await settle(session);
  }

  assert.equal(socket.destroyed, true, "the third deterministic claim ends this socket");
  assert.equal(session.terminationRequested.rule, RULE.movementEndpointOffTile);
});

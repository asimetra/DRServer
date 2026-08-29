import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { config } from "../src/config.js";
import { onConnection } from "../src/socket/index.js";
import { PacketWriter } from "../src/socket/packet.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { attackForConstant } from "../src/gamemaster.js";
import { createMatchWorld } from "../src/socket/match-world.js";

/**
 * A socket, as far as the dispatcher is concerned. Nothing here needs a real
 * one, and using one would only make the test slower and less certain.
 */
const fakeSocket = () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.remoteAddress = "test";
  socket.written = [];
  socket.paused = false;
  socket.write = (frame) => {
    socket.written.push(frame);
    return true;
  };
  socket.pause = () => {
    socket.paused = true;
  };
  socket.resume = () => {
    socket.paused = false;
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  socket.end = socket.destroy;
  return socket;
};

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
};

const fieldUpdate = (doid, field, body) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(field).raw(body).frame();

/**
 * TCP delivers bytes in order and this server threw that away: a handler was
 * started and the data loop moved straight to the next packet, so everything
 * after the first `await` interleaved.
 *
 * Five proposals of a twenty-second cooldown arriving in one chunk all read
 * `isOffCooldown` before any of them wrote one. Handled one at a time the
 * server accepts one; concurrently it accepted all five, Mana and all.
 *
 * This has to go through the dispatcher. Calling the handler five times in a
 * row passes either way, which is exactly why the bug survived.
 */
test("packets in one chunk are handled in the order they arrived", async () => {
  const scroll = await attackForConstant("SPEED_BUFF_PULSE_COOLDOWN");
  const socket = fakeSocket();
  const session = onConnection(socket);

  // Dressed the way a dungeon leaves it, so the owner fields route.
  session.heroDoid = 500;
  session.floorDoid = 400;
  session.dungeonZone = 0;
  session.heroManaPoints = 1000;
  session.maxHeroManaPoints = 1000;
  session.dungeonBusterPoints = 0;
  session.heroWeapons = [{ type: 24001 }]; // HERO_SCROLL_SPEED grants the scroll
  session.objects.set(500, 3);
  session.allocateDoid = (() => {
    let next = 900;
    return () => ++next;
  })();

  const proposal = new PacketWriter()
    .u8(0).u8(0).u32(Number(scroll.Id)).u32(0).u8(0).f32(1).f32(1).u16(0)
    .body();

  // Five identical proposals of a twenty-second cooldown, one chunk, one read.
  socket.emit("data", Buffer.concat(Array.from({ length: 5 }, () => fieldUpdate(500, 172, proposal))));
  await settle();

  /**
   * Exactly one. All five used to read `isOffCooldown` before any of them wrote
   * one, so all five were accepted and all five were paid for — a twenty-second
   * cooldown bypassed by sending the proposals together.
   */
  assert.equal(session.heroManaPoints, 965, "one cast is paid for, not five");
  assert.equal(session.acceptedCasts?.length, 1, "and one cast is recorded");
});

test("an accepted owner choreography is relayed once to the remote hero on field 159", async () => {
  const ownerSocket = fakeSocket();
  const peerSocket = fakeSocket();
  const owner = onConnection(ownerSocket);
  const peer = onConnection(peerSocket);
  owner.accountId = 100;
  peer.accountId = 101;
  owner.heroDoid = 500;
  peer.heroDoid = 501;
  owner.heroManaPoints = 100;
  owner.heroWeapons = [{ type: 11001, power: 5 }];
  owner.objects.set(owner.heroDoid, CLID.HeroGameObject);
  owner.actors.set(owner.heroDoid, { hitPoints: 100, maxHitPoints: 100 });
  const world = createMatchWorld({ id: 1, members: new Set([owner, peer]) }, owner);
  world.contextFor(peer);
  world.objects.set(peer.heroDoid, CLID.HeroGameObject);
  world.actors.set(peer.heroDoid, { hitPoints: 100, maxHitPoints: 100 });

  const payload = new PacketWriter()
    .u8(0).u8(0).u32(900106).u32(0).u8(0).f32(1).f32(1).u16(0)
    .body();
  ownerSocket.emit("data", fieldUpdate(owner.heroDoid, 172, payload));
  await settle();

  const relays = peerSocket.written.filter(
    (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
      frame.readUInt32LE(4) === owner.heroDoid && frame.readUInt16LE(8) === 159
  );
  assert.equal(relays.length, 1);
  assert.deepEqual(relays[0].subarray(10), payload);
  assert.equal(
    ownerSocket.written.some((frame) =>
      frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD && frame.readUInt16LE(8) === 159
    ),
    false,
    "the owner already played its local choreography"
  );
  world.destroy();
});

test("an ally revive choreography followed by field 173 raises the downed hero", async () => {
  const ownerSocket = fakeSocket();
  const peerSocket = fakeSocket();
  const owner = onConnection(ownerSocket);
  const peer = onConnection(peerSocket);
  owner.accountId = 110;
  peer.accountId = 111;
  owner.heroDoid = 510;
  peer.heroDoid = 511;
  owner.objects.set(owner.heroDoid, CLID.HeroGameObject);
  owner.actors.set(owner.heroDoid, {
    hitPoints: 100,
    maxHitPoints: 100,
    position: { x: 0, y: 0 },
  });
  const world = createMatchWorld({ id: 2, members: new Set([owner, peer]) }, owner);
  world.contextFor(peer);
  world.objects.set(peer.heroDoid, CLID.HeroGameObject);
  world.actors.set(peer.heroDoid, {
    hitPoints: 0,
    maxHitPoints: 150,
    dead: true,
    position: { x: 50, y: 0 },
  });
  world.playerActors = new Set([owner.heroDoid, peer.heroDoid]);

  const choreography = new PacketWriter()
    .u8(0).u8(0).u32(910901).u32(peer.heroDoid)
    .u8(0).f32(1).f32(1).u16(0)
    .body();
  const propose = new PacketWriter().u32(peer.heroDoid).body();
  ownerSocket.emit(
    "data",
    Buffer.concat([
      fieldUpdate(owner.heroDoid, 172, choreography),
      fieldUpdate(owner.heroDoid, 173, propose),
    ])
  );
  await settle();

  assert.equal(world.actors.get(peer.heroDoid).dead, false);
  assert.equal(world.actors.get(peer.heroDoid).hitPoints, 150);
  assert.ok(
    peerSocket.written.some(
      (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
        frame.readUInt32LE(4) === peer.heroDoid && frame.readUInt16LE(8) === 157
    ),
    "the downed player's client is told to leave ActorReviveState"
  );

  // A new attempt cannot become a room-wide revive merely by naming the same
  // hero after the caller has moved outside the client's revive sensor.
  const target = world.actors.get(peer.heroDoid);
  target.hitPoints = 0;
  target.dead = true;
  target.position = { x: 500, y: 0 };
  ownerSocket.emit(
    "data",
    Buffer.concat([
      fieldUpdate(owner.heroDoid, 172, choreography),
      fieldUpdate(owner.heroDoid, 173, propose),
    ])
  );
  await settle();
  assert.equal(target.dead, true, "an out-of-range proposal leaves the ally down");
  assert.equal(target.hitPoints, 0);
  world.destroy();
});

/** The queue is bounded, and the bound is enforced rather than reported. */
test("a flood past the queue ceiling closes the connection", async () => {
  const socket = fakeSocket();
  onConnection(socket);

  const heartbeat = new PacketWriter(OP.CLIENT_HEART_BEAT).utf("1").frame();
  const flood = Buffer.concat(Array.from({ length: 400 }, () => heartbeat));
  socket.emit("data", flood);

  assert.equal(socket.destroyed, true, "past the ceiling the socket goes");
});

/** And a length that cannot be a frame ends it before anything is dispatched. */
test("a frame length below an opcode ends the connection", async () => {
  const socket = fakeSocket();
  onConnection(socket);

  socket.emit("data", Buffer.alloc(4096));
  assert.equal(socket.destroyed, true, "zeroes are not frames");
});

void config;

/**
 * Rejecting zero-length frames closed the 32768-frames-of-nothing case, but a
 * valid two-byte body carrying only an opcode is the same work by another
 * route: 64 KiB of them drained as 16384 packets, all materialised before
 * anything counted them, then dispatched and logged one by one.
 */
test("a flood of valid tiny frames is bounded before it is dispatched", async () => {
  const { drainFrames } = await import("../src/socket/packet.js");

  // length 2, opcode 0xFFFF — well formed, and nothing this server answers.
  const tiny = Buffer.alloc(4);
  tiny.writeUInt16LE(2, 0);
  tiny.writeUInt16LE(0xffff, 2);
  const chunk = Buffer.concat(Array.from({ length: 16_384 }, () => tiny));

  const { packets, rest, malformed } = drainFrames(chunk);
  assert.equal(malformed, false, "they are well formed, which is the point");
  assert.ok(packets.length <= 512, `one read yields at most 512, got ${packets.length}`);
  assert.ok(rest.length > 0, "and the remainder waits rather than being dropped");

  // Through the dispatcher the same flood closes the connection on the queue
  // ceiling rather than being handled sixteen thousand times.
  const socket = fakeSocket();
  onConnection(socket);
  socket.emit("data", chunk);
  await settle();
  assert.equal(socket.destroyed, true, "and a client that keeps it up is dropped");
});

/**
 * Two independent reasons to stop reading, and they used to cancel each other.
 * A full write buffer paused the socket; the packet queue then drained below its
 * low mark and resumed it before the writable `drain` ever arrived — so the
 * ordering queue silently switched off the slow-reader protection it was added
 * next to.
 */
test("a full write buffer keeps reading paused until it drains", async () => {
  const socket = fakeSocket();
  socket.write = () => {
    socket.written.push(1);
    return false; // the kernel buffer is full
  };
  const session = onConnection(socket);

  // A heartbeat draws a reply, so the write happens and comes back false.
  socket.emit("data", new PacketWriter(OP.CLIENT_HEART_BEAT).utf("1").frame());
  await settle();

  assert.equal(session.pausedForWrite, true, "the write reason is set");
  assert.equal(session.queue.length, 0, "and the queue is empty, which used to resume");
  assert.equal(socket.paused, true, "so reading stays stopped");

  // Only the writable drain lifts it.
  socket.emit("drain");
  assert.equal(socket.paused, false, "and then it runs again");
});

test("a slow multiplayer recipient is disconnected before its outbound buffer is unbounded", () => {
  const socket = fakeSocket();
  socket.writableLength = config.maxOutboundBufferBytes;
  const session = onConnection(socket);

  assert.equal(session.send(Buffer.alloc(1)), false);
  assert.equal(session.closed, true);
  assert.equal(socket.destroyed, true);
  assert.equal(socket.written.length, 0, "the frame is refused instead of buffered");
});

/** And the inverse: draining output does not resume a socket the queue holds. */
test("a writable drain does not resume while the queue is high", async () => {
  const socket = fakeSocket();
  const session = onConnection(socket);

  const heartbeat = new PacketWriter(OP.CLIENT_HEART_BEAT).utf("1").frame();
  session.queue.push(...Array.from({ length: 200 }, () => heartbeat.subarray(2)));
  session.pausedForQueue = true;
  session.pausedForWrite = true;
  socket.pause();

  socket.emit("drain");
  assert.equal(socket.paused, true, "the queue still holds it");
});

/**
 * A two-byte frame carrying a known opcode is well formed at the length prefix
 * and does not carry the payload that opcode requires. The reader threw, the
 * loop logged a full stack, and it carried on — 256 frames, 256 stacks.
 */
test("a truncated payload closes the connection once", async () => {
  const socket = fakeSocket();
  const session = onConnection(socket);

  // CLIENT_HEART_BEAT with no utf length behind it.
  const truncated = Buffer.alloc(4);
  truncated.writeUInt16LE(2, 0);
  truncated.writeUInt16LE(OP.CLIENT_HEART_BEAT, 2);
  socket.emit("data", Buffer.concat(Array.from({ length: 256 }, () => truncated)));
  await settle();

  assert.equal(socket.destroyed, true, "the stream is not readable, so it ends");
  assert.equal(session.queue.length, 0, "and nothing behind it is processed");
});

/** Nothing queued behind a logout runs after the socket is gone. */
test("logout clears what was queued behind it", async () => {
  const socket = fakeSocket();
  const session = onConnection(socket);

  const unknown = Buffer.alloc(4);
  unknown.writeUInt16LE(2, 0);
  unknown.writeUInt16LE(0xffff, 2);
  socket.emit(
    "data",
    Buffer.concat([
      new PacketWriter(OP.CLIENT_LOGOUT).u32(0).frame(),
      ...Array.from({ length: 10 }, () => unknown),
    ])
  );
  await settle();

  assert.equal(socket.destroyed, true, "the logout closed it");
  assert.equal(session.queue.length, 0, "and took the rest of the chunk with it");
  assert.equal(
    session.violations?.get("protocol.unknown_opcode")?.count ?? 0,
    0,
    "none of them were handled after the peer was gone"
  );
});

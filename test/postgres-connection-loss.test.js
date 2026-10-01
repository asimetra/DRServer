import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

/**
 * What a database restart looks like from here.
 *
 * `docker restart` on the database, an image update, the container running out
 * of memory: each closes every connection this server holds. node-postgres
 * reports that as an `error` event on the pool and on a checked-out client,
 * and an `error` event nobody listens for is thrown at the process — so
 * restarting the database stopped the game server too, with every dungeon in
 * it, and nothing brought it back.
 *
 * No real database: a few lines of the wire protocol are enough to hold a
 * connection open, answer the one query that takes the lock, and hang up.
 */
const message = (type, body = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const text = (value) => Buffer.concat([Buffer.from(value), Buffer.from([0])]);
const READY = message("Z", Buffer.from("I"));

/** One boolean column called `acquired`, and one row holding `answer`. */
const oneBoolean = (answer) => {
  const field = Buffer.alloc(18);
  field.writeInt32BE(16, 6); // type oid: bool
  field.writeInt16BE(1, 10); // type size
  field.writeInt32BE(-1, 12); // type modifier
  const columns = Buffer.alloc(2);
  columns.writeInt16BE(1, 0);
  const row = Buffer.alloc(7);
  row.writeInt16BE(1, 0);
  row.writeInt32BE(1, 2);
  row.write(answer ? "t" : "f", 6);
  return Buffer.concat([
    message("T", Buffer.concat([columns, text("acquired"), field])),
    message("D", row),
    message("C", text("SELECT 1")),
  ]);
};

const fakeDatabase = async () => {
  const sockets = new Set();
  const state = { grantsLock: true, lockQueries: 0 };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let started = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
        const length = buffer.readInt32BE(0);
        const sslRequest = buffer.readInt32BE(4) === 80877103;
        buffer = buffer.subarray(length);
        if (sslRequest) {
          socket.write("N");
          return;
        }
        started = true;
        socket.write(Buffer.concat([message("R", Buffer.alloc(4)), READY]));
      }
      while (buffer.length >= 5 && buffer.length >= buffer.readInt32BE(1) + 1) {
        const type = String.fromCharCode(buffer[0]);
        buffer = buffer.subarray(buffer.readInt32BE(1) + 1);
        // Sync ends an extended-protocol query: answer the whole of it at once.
        if (type === "S") {
          state.lockQueries += 1;
          socket.write(
            Buffer.concat([message("1"), message("2"), oneBoolean(state.grantsLock), READY])
          );
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    restart: () => {
      for (const socket of sockets) socket.destroy();
    },
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
};

// One database for the file: the storage module reads its address when it is
// first imported, and keeps it.
const database = await fakeDatabase();
process.env.ODS_STORAGE = "postgres";
process.env.ODS_DATABASE_URL = `postgres://ods:ods@127.0.0.1:${database.port}/open_dungeon`;
const storage = await import("../src/storage/postgres.js");

test.after(async () => {
  await storage.close();
  database.stop();
  delete process.env.ODS_STORAGE;
  delete process.env.ODS_DATABASE_URL;
});

test.beforeEach(() => {
  database.state.grantsLock = true;
  database.state.lockQueries = 0;
});

const until = async (condition, what, withinMs = 3000) => {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("a database restart is survived: the storage lock is taken again", async () => {
  const lost = [];
  const release = await storage.acquireServerProcessLock({
    onLost: (problem) => lost.push(problem),
    retryMs: 10,
    retryForMs: 2000,
  });
  assert.equal(database.state.lockQueries, 1);

  // Every connection closed under the server, the lock's among them.
  database.restart();
  await until(() => database.state.lockQueries >= 2, "the lock was asked for again");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(lost, [], "a lock taken back is not a lock lost");

  /* Lost again, and this time somebody else has it: the two servers must not
     both go on writing, so the one without the lock is told. */
  database.state.grantsLock = false;
  database.restart();
  await until(() => lost.length === 1, "the server was told its lock is gone");
  assert.match(lost[0].message, /already in use/);

  await release();
});

/**
 * A connection in the middle of a transaction is checked out of the pool, and
 * the pool only listens to the ones that are idle. Restarting the database
 * during a save was therefore still an `error` event with nobody to hear it.
 */
test("a database restart in the middle of a save fails the save, not the server", async () => {
  // The fake never answers BEGIN, so the save is still in flight when it drops.
  const save = storage.saveAccounts([{ id: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  database.restart();

  await assert.rejects(save, /Connection terminated|terminat/i);
  // An unheard `error` event would arrive on a later tick and fail this test.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("a lock given back while it was being retaken is not reported lost", async () => {
  const lost = [];
  const release = await storage.acquireServerProcessLock({
    onLost: (problem) => lost.push(problem),
    retryMs: 10,
    retryForMs: 2000,
  });
  // Somebody else holds it by the time it is asked for again...
  database.state.grantsLock = false;
  database.restart();
  // ...and the server is told to stop before that answer arrives.
  await release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(lost, [], "an ordinary stop is not turned into a failure");
});

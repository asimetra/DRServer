import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createGracefulShutdown, installProcessHandlers } from "../src/shutdown.js";

test("graceful shutdown closes listeners and waits for dungeon/account writes", async () => {
  const events = [];
  let releaseDungeonSave;
  const dungeonSave = new Promise((resolve) => {
    releaseDungeonSave = resolve;
  });
  const session = {
    id: 7,
    close(reason, options) {
      events.push(["session", reason, options.flush]);
      this.rewardSavePromise = dungeonSave.then(() => events.push(["dungeon saved"]));
    },
  };
  const server = {
    listening: true,
    close(callback) {
      events.push(["listener close"]);
      callback();
    },
  };
  const shutdown = createGracefulShutdown({
    servers: () => [server, null],
    sessions: () => [session],
    waitForWrites: async () => events.push(["writes drained"]),
    closeServices: async () => events.push(["services closed"]),
    releaseProcessLock: async () => events.push(["process lock released"]),
    closeStorage: async () => events.push(["storage closed"]),
  });

  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT");
  assert.equal(first, second, "a second signal started another shutdown");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 2), [
    ["listener close"],
    ["session", "server shutting down", true],
  ]);
  assert.equal(events.some(([event]) => event === "writes drained"), false);

  releaseDungeonSave();
  await first;
  assert.deepEqual(events.slice(-5), [
    ["dungeon saved"],
    ["services closed"],
    ["writes drained"],
    ["process lock released"],
    ["storage closed"],
  ]);
});

test("a failed write flush still releases the process lock and closes storage", async () => {
  const events = [];
  const failure = new Error("declarations stayed dirty");
  const shutdown = createGracefulShutdown({
    servers: () => [],
    sessions: () => [],
    closeServices: async () => events.push("services"),
    waitForWrites: async () => {
      events.push("flush");
      throw failure;
    },
    releaseProcessLock: async () => events.push("unlock"),
    closeStorage: async () => events.push("storage"),
  });

  await assert.rejects(shutdown("test failure"), failure);
  assert.deepEqual(events, ["services", "flush", "unlock", "storage"]);
});

test("process handlers route both signals through the idempotent shutdown", async () => {
  const processObject = new EventEmitter();
  processObject.exitCode = 0;
  const reasons = [];
  const dispose = installProcessHandlers({
    processObject,
    shutdown: async (reason) => reasons.push(reason),
  });

  processObject.emit("SIGTERM", "SIGTERM");
  processObject.emit("SIGINT", "SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ["SIGTERM", "SIGINT"]);

  dispose();
  assert.equal(processObject.listenerCount("unhandledRejection"), 0);
});

/**
 * `server.close()` waits for every connection to finish on its own. One client
 * that sent half a request and stopped held the whole shutdown open — the lock
 * unreleased, the storage unclosed — until the supervisor lost patience and
 * killed the process.
 */
test("a listener held open by a stalled connection is cut off after its grace", async () => {
  const events = [];
  const stalled = {
    listening: true,
    close() {
      events.push("close asked");
      // Never calls back: a connection is still open.
    },
    closeAllConnections() {
      events.push("connections cut");
    },
  };
  const shutdown = createGracefulShutdown({
    servers: () => [stalled],
    sessions: () => [],
    listenerGraceMs: 20,
    waitForWrites: async () => events.push("flush"),
    releaseProcessLock: async () => events.push("unlock"),
    closeStorage: async () => events.push("storage"),
  });

  await shutdown("SIGTERM");
  assert.deepEqual(events, ["close asked", "connections cut", "flush", "unlock", "storage"]);
});

const fakeProcess = () => {
  const processObject = new EventEmitter();
  processObject.exitCode = 0;
  processObject.exits = [];
  processObject.exit = (code) => processObject.exits.push(code);
  return processObject;
};

test("a terminal hanging up is a shutdown like any other", async () => {
  const processObject = fakeProcess();
  const reasons = [];
  const dispose = installProcessHandlers({
    processObject,
    drainMs: 0,
    sighupIgnored: false,
    shutdown: async (reason) => reasons.push(reason),
  });

  processObject.emit("SIGHUP", "SIGHUP");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reasons, ["SIGHUP"]);
  assert.deepEqual(processObject.exits, [0], "and the process ends once it is done");
  dispose();
});

test("a repeated signal joins the shutdown already running", async () => {
  const processObject = fakeProcess();
  const reasons = [];
  let finish;
  const running = new Promise((resolve) => {
    finish = resolve;
  });
  const dispose = installProcessHandlers({
    processObject,
    drainMs: 0,
    shutdown: (reason) => {
      reasons.push(reason);
      return running;
    },
  });

  processObject.emit("SIGTERM", "SIGTERM");
  processObject.emit("SIGTERM", "SIGTERM");
  assert.equal(processObject.listenerCount("SIGTERM"), 1, "the handler is still installed");
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reasons, ["SIGTERM", "SIGTERM"]);
  assert.deepEqual(processObject.exits, [0]);
  dispose();
});

test("a shutdown that does not finish is ended at the deadline", async () => {
  const processObject = fakeProcess();
  const dispose = installProcessHandlers({
    processObject,
    timeoutMs: 20,
    shutdown: () => new Promise(() => {}),
  });

  processObject.emit("SIGTERM", "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(processObject.exits, [1]);
  dispose();
});

test("an uncaught exception shuts the server down and exits non-zero", async () => {
  const processObject = fakeProcess();
  const reasons = [];
  let finishSaving;
  const saving = new Promise((resolve) => {
    finishSaving = resolve;
  });
  const dispose = installProcessHandlers({
    processObject,
    drainMs: 0,
    shutdown: (reason) => {
      reasons.push(reason);
      return saving;
    },
  });

  processObject.emit("uncaughtException", new Error("a timer nobody guarded"));
  /* A second one while the first is still being saved from — two transactions
     cut by one database restart. It used to end the process on the spot, and
     with it the flush the first had started. */
  processObject.emit("uncaughtException", new Error("and another"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(processObject.exits, [], "the shutdown under way is left to finish");

  finishSaving();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reasons, ["uncaught exception", "uncaught exception"]);
  assert.deepEqual(processObject.exits, [1], "a supervisor has to see this as a failure");
  assert.equal(processObject.exitCode, 1);
  dispose();
  assert.equal(processObject.listenerCount("uncaughtException"), 0);
});

/**
 * `nohup npm start &` over ssh is how a server is left running without a
 * supervisor, and it works by the hangup being ignored before the program
 * starts. A handler installed regardless stopped the server on the hangup it
 * had been started to survive.
 */
test("a hangup the server was started to ignore stays ignored", async () => {
  const processObject = fakeProcess();
  const reasons = [];
  const dispose = installProcessHandlers({
    processObject,
    sighupIgnored: true,
    shutdown: async (reason) => reasons.push(reason),
  });

  assert.equal(processObject.listenerCount("SIGHUP"), 0);
  assert.equal(processObject.listenerCount("SIGTERM"), 1, "the others are unaffected");
  dispose();
});

test("a finished shutdown lets the event loop empty before it insists", async () => {
  const processObject = fakeProcess();
  const dispose = installProcessHandlers({
    processObject,
    drainMs: 60,
    shutdown: async () => {},
  });

  processObject.emit("SIGTERM", "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(processObject.exitCode, 0, "the code is settled at once");
  assert.deepEqual(processObject.exits, [], "but nothing still being written is cut off");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(processObject.exits, [0], "and a socket left open cannot hold it for ever");
  dispose();
});

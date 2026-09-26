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

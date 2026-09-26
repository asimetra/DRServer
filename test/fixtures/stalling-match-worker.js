/**
 * A match worker that can be told to stop answering, or to write to disk
 * slowly, for tests of what the main thread does about a worker that is stuck
 * or behind. Everything else is the real worker.
 */
import fs from "node:fs/promises";
import { parentPort } from "node:worker_threads";

parentPort.on("message", (message) => {
  if (message?.t === "test.slowWrites") {
    // Every account write takes this long to land, as on a struggling disk.
    const rename = fs.rename.bind(fs);
    fs.rename = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, message.ms));
      return rename(...args);
    };
    return;
  }
  if (message?.t === "test.busy") {
    // Heavy but alive: busy in slices, letting the event loop run between them.
    const until = Date.now() + message.ms;
    const slice = () => {
      const end = Math.min(until, Date.now() + message.sliceMs);
      while (Date.now() < end) {
        // Working.
      }
      if (Date.now() < until) setImmediate(slice);
    };
    slice();
    return;
  }
  if (message?.t !== "test.stall") return;
  for (;;) {
    // Stuck in a loop, the way a bug in a dungeon timer would leave it.
  }
});

await import("../../src/socket/match-worker-thread.js");

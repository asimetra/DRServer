import assert from "node:assert/strict";
import test from "node:test";

import { LocalMatchExecutor } from "../src/socket/match-executor.js";

test("local execution passes straight through to the runtime", async () => {
  const calls = [];
  const executor = new LocalMatchExecutor({
    joinRuntime: async (...args) => {
      calls.push(["join", ...args]);
      return "joined";
    },
    leaveRuntime: (...args) => {
      calls.push(["leave", ...args]);
      return "left";
    },
  });
  const session = { id: 7, accountId: 1000000005 };
  const result = { match: { id: 41 } };
  const request = { mapNodeId: 50003 };
  const options = { onPlayerReady() {} };

  assert.equal(await executor.join(session, result, request, options), "joined");
  assert.equal(executor.leave(session, { notifyClient: true }), "left");
  assert.equal(executor.leave(session), "left");
  assert.deepEqual(calls, [
    ["join", session, result, request, options],
    ["leave", session, { notifyClient: true }],
    ["leave", session, {}],
  ]);
});

test("an executor without its runtime refuses to exist", () => {
  assert.throws(() => new LocalMatchExecutor({ joinRuntime: async () => {} }), /needs join and leave/);
});

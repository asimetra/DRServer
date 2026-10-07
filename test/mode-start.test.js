import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { startModes } from "../src/modes/index.js";

test("a mode that fails to start is that mode off; the rest start, and nothing throws", async (t) => {
  const was = config.ranked;
  // A ranked whose settings cannot even be read: its start throws.
  config.ranked = {
    get enabled() {
      throw new Error("unreadable settings");
    },
  };
  t.after(() => {
    config.ranked = was;
  });
  const stop = await startModes({ where: "local" });
  assert.equal(typeof stop, "function");
  await stop();
});

test("a mode registered is started with the rest; a together mode only on the seat; a name is taken once", async (t) => {
  const { registerMode, registeredModes } = await import("../src/modes/index.js");
  const started = [];
  registerMode({ name: "test-everywhere", start: async ({ where }) => (started.push(["everywhere", where]), async () => {}) });
  registerMode({ name: "test-seated", together: true, start: async ({ where }) => (started.push(["seated", where]), async () => {}) });
  assert.throws(() => registerMode({ name: "test-everywhere", start: async () => {} }), /already/);
  assert.throws(() => registerMode({ name: "Bad Name", start: async () => {} }), /name/);
  assert.ok(registeredModes().some((mode) => mode.name === "test-seated" && mode.together));

  await (await startModes({ where: "worker", workerIndex: 1 }))();
  assert.deepEqual(started, [["everywhere", "worker"]], "not the seat: the together mode stays off");
  started.length = 0;
  await (await startModes({ where: "worker", workerIndex: 0 }))();
  assert.deepEqual(started, [["everywhere", "worker"], ["seated", "worker"]], "on the seat, both");
});

test("together by its registration is together for the pool and admission, whatever its rules say", async () => {
  const { registerMode } = await import("../src/modes/index.js");
  const { isTogether } = await import("../src/modes/seat.js");
  registerMode({ name: "test-registered-together", together: true, start: async () => async () => {} });
  assert.equal(isTogether("test-registered-together"), true, "no rules installed for it, yet kept on the seat");
  assert.equal(isTogether("test-everywhere"), false);
  assert.equal(isTogether(null), false);
});

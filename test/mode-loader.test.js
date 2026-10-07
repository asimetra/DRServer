import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { config } from "../src/config.js";

test("a deployment's own mode, named in ODS_MODES, is imported and started on the thread that starts its modes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-loader-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "outside.mjs");
  fs.writeFileSync(
    file,
    `export const started = [];
     export default { name: "outside-mode", together: false, start: async ({ where }) => { started.push(where); return async () => {}; } };`
  );
  const broken = path.join(dir, "broken.mjs");
  fs.writeFileSync(broken, "throw new Error('does not load');");
  const was = config.modes;
  config.modes = [broken, file];
  t.after(() => {
    config.modes = was;
  });

  const { startModes, registeredModes } = await import("../src/modes/index.js");
  const stop = await startModes({ where: "worker", workerIndex: 3 });
  assert.ok(registeredModes().some((mode) => mode.name === "outside-mode"), "registered from its module");
  const { started } = await import(file);
  assert.deepEqual(started, ["worker"], "and started, a module that failed to load notwithstanding");
  await stop();
});

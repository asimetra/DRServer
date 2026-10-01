import assert from "node:assert/strict";
import test from "node:test";

import { start } from "../src/status.js";

const serving = async (t, options = {}) => {
  const server = start({ host: "127.0.0.1", port: 0, ...options });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

/**
 * The dashboard and the alert rules are written against metric names, and a
 * name that is renamed here would leave a panel empty and a rule that can never
 * fire — silently, which is the worst way for monitoring to break.
 */
test("everything the bundled dashboard and alert rules ask for is a metric the server gives", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { counters } = await import("../src/metrics.js");
  const base = await serving(t, {
    probes: { web: () => null },
    warnings: { disk: () => null },
    counters,
    describe: () => ({
      players: { online: 0, in_dungeon: 0 },
      game_sockets: 0,
      match_workers: [{ index: 0, alive: true, matches: 0, members: 0 }],
      data_dir: { free_bytes: 1, size_bytes: 2 },
    }),
  });
  const exported = new Set(
    [...(await (await fetch(`${base}/metrics`)).text()).matchAll(/^# TYPE (\S+)/gm)].map(([, name]) => name)
  );

  const monitoring = new URL("../monitoring/", import.meta.url);
  const asked = new Set();
  for (const file of ["alerts.yml", "grafana/dashboards/dr-server.json"]) {
    const text = await readFile(new URL(file, monitoring), "utf8");
    // A name pattern in a selector (`ods_.+_total`) is not a name.
    for (const [name] of text.matchAll(/\bods_[a-z0-9_]+\b(?![.+*])/g)) asked.add(name);
  }
  asked.delete("ods_prometheus"); // the data source's uid, not a metric
  assert.ok(asked.size >= 10, "the files were read");
  assert.deepEqual([...asked].filter((name) => !exported.has(name)), []);
});

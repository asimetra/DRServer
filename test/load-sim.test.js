import test from "node:test";
import assert from "node:assert/strict";

import {
  RPC_MIX,
  checkSlo,
  isLoopback,
  parseArgs,
  parseSlo,
  pickRpc,
  quantile,
  run,
  summarise,
} from "../tools/load-sim.js";

test("quantiles read the sorted sample, not the order it arrived in", () => {
  const values = [50, 10, 40, 20, 30];
  assert.equal(quantile(values, 0.5), 30);
  assert.equal(quantile(values, 0.99), 50);
  assert.equal(quantile([], 0.5), null);
  assert.deepEqual(summarise([3, 1, 2]), { n: 3, p50: 2, p95: 3, p99: 3, max: 3 });
});

test("an SLO is metric.stat, a comparison and a bound", () => {
  assert.deepEqual(
    parseSlo("heartbeat.p99<200, cpu.p95 < 90").map(({ metric, stat, op, bound }) => ({ metric, stat, op, bound })),
    [
      { metric: "heartbeat", stat: "p99", op: "<", bound: 200 },
      { metric: "cpu", stat: "p95", op: "<", bound: 90 },
    ]
  );
  assert.deepEqual(parseSlo(""), []);
});

test("an unreadable SLO refuses to run instead of quietly never failing", () => {
  assert.throws(() => parseSlo("heartbeat<200"), /unreadable SLO/);
  assert.throws(() => parseSlo("heartbeat.p99 <= 200"), /unreadable SLO/);
});

test("a metric with no samples fails its SLO rather than passing it", () => {
  const report = { metrics: { heartbeat: { p99: 150 }, npc: { p99: null } } };
  const [heartbeat, npc] = checkSlo(report, parseSlo("heartbeat.p99<200,npc.p99<400"));
  assert.equal(heartbeat.ok, true);
  assert.equal(npc.ok, false);
});

test("load is aimed at loopback unless the target is explicitly allowed", async () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("127.0.3.9"), true);
  assert.equal(isLoopback("localhost"), true);
  assert.equal(isLoopback("192.0.2.10"), false);
  await assert.rejects(
    run(parseArgs(["--host", "192.0.2.10", "--players", "1"])),
    /allow-remote-target/
  );
});

test("the RPC mix follows the client's own call frequencies", () => {
  const counts = new Map();
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 20000; i++) {
    const { route } = pickRpc(random);
    counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  const total = RPC_MIX.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of RPC_MIX) {
    const share = counts.get(entry.route) / 20000;
    assert.ok(Math.abs(share - entry.weight / total) < 0.02, `${entry.route} drawn ${share}`);
  }
});

test("defaults describe a modest local run", () => {
  const options = parseArgs([]);
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.scenario, "dungeon");
  assert.equal(options.fight, true);
  assert.ok(options.nodes.length > 0);
});

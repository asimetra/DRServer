import assert from "node:assert/strict";
import test from "node:test";

import { healthReport, start } from "../src/status.js";
import { configProblems, loadServerConfig } from "../src/config.js";
import { buildInfo } from "../src/build-info.js";

/**
 * Whether the server is well, asked from outside it.
 *
 * Nothing answered that. A supervisor could tell that the process existed and
 * a monitor that the web port accepted a connection, and neither is the same
 * thing: with the game socket closed, the storage unwritable, or every match
 * worker down, the process is running and nobody can play.
 */
const serving = async (t, options = {}) => {
  const server = start({ host: "127.0.0.1", port: 0, ...options });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

test("health is every check passing, and a failing one says which and why", async () => {
  assert.deepEqual(await healthReport({ web: () => null, storage: async () => null }), {
    ok: true,
    checks: { web: "ok", storage: "ok" },
  });

  assert.deepEqual(
    await healthReport({
      web: () => null,
      socket: () => "the game socket is not accepting connections",
      storage: async () => {
        throw new Error("EACCES");
      },
    }),
    {
      ok: false,
      checks: {
        web: "ok",
        socket: "the game socket is not accepting connections",
        storage: "check failed: EACCES",
      },
    }
  );
});

test("a check that never answers is a failed check, not a hung probe", async () => {
  const report = await healthReport({ storage: () => new Promise(() => {}) }, { timeoutMs: 30 });
  assert.equal(report.ok, false);
  assert.match(report.checks.storage, /did not answer within 30ms/);
});

test("the health route answers 200 when well and 503 when not", async (t) => {
  let storage = null;
  const base = await serving(t, { probes: { web: () => null, storage: () => storage } });

  const well = await fetch(`${base}/healthz`);
  assert.equal(well.status, 200);
  assert.deepEqual(await well.json(), { status: "ok", checks: { web: "ok", storage: "ok" } });

  storage = "data directory is not writable";
  const unwell = await fetch(`${base}/healthz`);
  assert.equal(unwell.status, 503, "what a supervisor or a load balancer reads");
  assert.deepEqual(await unwell.json(), {
    status: "failing",
    checks: { web: "ok", storage: "data directory is not writable" },
  });
});

test("liveness is only that the process answers", async (t) => {
  const base = await serving(t, { probes: { storage: () => "the database is away" } });

  const alive = await fetch(`${base}/livez`);
  assert.equal(alive.status, 200, "unwell is not the same as dead: restarting would not help");
  assert.deepEqual(await alive.json(), { status: "ok" });
});

test("the status route says what is running and how it is doing", async (t) => {
  const base = await serving(t, {
    probes: { web: () => null },
    describe: () => ({ players: { online: 3, in_dungeon: 2 }, storage: "file" }),
  });

  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.version, buildInfo().version);
  assert.equal(status.node, process.version);
  assert.ok(Number.isInteger(status.uptime_seconds) && status.uptime_seconds >= 0);
  assert.match(status.started_at, /^\d{4}-\d\d-\d\dT/);
  assert.ok(status.memory.rss_mb > 0 && status.memory.heap_used_mb > 0);
  assert.ok(status.event_loop_delay.p99_ms >= 0 && status.event_loop_delay.p99_ms < 500);
  assert.ok(status.event_loop_delay.max_ms >= status.event_loop_delay.mean_ms);
  assert.deepEqual(status.players, { online: 3, in_dungeon: 2 });
  assert.equal(status.storage, "file");
  assert.deepEqual(status.health, { status: "ok", checks: { web: "ok" } });
});

test("anything else on the status port is simply not there", async (t) => {
  const base = await serving(t);
  assert.equal((await fetch(`${base}/internal/v1/accounts/1`)).status, 404);
  assert.equal((await fetch(`${base}/healthz`, { method: "POST" })).status, 404);
});

test("the build says which version and, in a checkout, which commit", () => {
  const { version, commit } = buildInfo();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.ok(commit === null || /^[0-9a-f]{7,40}$/.test(commit), String(commit));
});

/**
 * Its own port, bound to loopback, rather than a path on the players' port
 * guarded by where the request came from. Behind a tunnel every player arrives
 * from 127.0.0.1, and an address check would have handed them the lot.
 */
test("the status listener is on by default, on loopback, and off when its port is 0", () => {
  const defaults = loadServerConfig({});
  assert.equal(defaults.statusHost, "127.0.0.1");
  assert.equal(defaults.statusPort, 8082);
  assert.equal(loadServerConfig({ ODS_STATUS_PORT: "0" }).statusPort, 0);
  assert.deepEqual(configProblems({ ODS_STATUS_PORT: "0" }).refusals, []);
  assert.match(configProblems({ ODS_STATUS_PORT: "x" }).refusals[0], /ODS_STATUS_PORT/);
});

test("the status listener is not bound past loopback without being told to", () => {
  assert.match(
    configProblems({ ODS_STATUS_HOST: "0.0.0.0" }).refusals[0],
    /ODS_STATUS_HOST.*no authentication.*ODS_ALLOW_REMOTE_STATUS=1/
  );
  assert.deepEqual(
    configProblems({ ODS_STATUS_HOST: "0.0.0.0", ODS_ALLOW_REMOTE_STATUS: "1" }).refusals,
    []
  );
  assert.deepEqual(configProblems({ ODS_STATUS_HOST: "::1" }).refusals, []);
});

// --- Warnings, the roster, counters, and who may ask -------------------------

/**
 * Not everything worth knowing is a failure. A disk at three per cent, a match
 * worker down with the others carrying on, a token about to run out: the server
 * is well, and somebody should still be told before it is not.
 */
test("a warning is reported without failing the check", async (t) => {
  let disk = "disk: 3% free";
  const server = start({
    host: "127.0.0.1",
    port: 0,
    probes: { web: () => null },
    warnings: { disk: () => disk, workers: () => null },
  });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const warned = await fetch(`${base}/healthz`);
  assert.equal(warned.status, 200, "a warning is not an outage");
  assert.deepEqual(await warned.json(), {
    status: "ok",
    checks: { web: "ok" },
    warnings: { disk: "disk: 3% free" },
  });

  disk = null;
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: "ok", checks: { web: "ok" } });
});

test("the roster and the counters are there for whoever runs the server", async (t) => {
  const base = await serving(t, {
    probes: { web: () => null },
    players: () => [{ account_id: 1000000005, name: "Old Hand", map_node: 50150 }],
    counters: () => ({ saves_failed: 0, sockets_refused: 2 }),
  });

  assert.deepEqual(await (await fetch(`${base}/players`)).json(), {
    players: [{ account_id: 1000000005, name: "Old Hand", map_node: 50150 }],
  });
  assert.deepEqual((await (await fetch(`${base}/status`)).json()).counters, {
    saves_failed: 0,
    sockets_refused: 2,
  });
});

/**
 * Watching from another machine. With a token set, the token is the access
 * rule: what names accounts or says how the server is built needs it, a
 * supervisor that can only read a status code still gets one, and the reason a
 * check failed — a path, a database address — is not handed to a stranger.
 */
test("with a status token, details need it and a bare verdict does not", async (t) => {
  const token = "s".repeat(40);
  const base = await serving(t, {
    token,
    probes: { storage: () => "the database does not answer: connect ECONNREFUSED 10.0.0.5:5432" },
    players: () => [{ account_id: 7 }],
  });
  const withToken = { headers: { "X-Status-Token": token } };

  assert.equal((await fetch(`${base}/livez`)).status, 200);

  const bare = await fetch(`${base}/healthz`);
  assert.equal(bare.status, 503, "the code is still there for a supervisor");
  assert.deepEqual(await bare.json(), { status: "failing" });

  const detailed = await fetch(`${base}/healthz`, withToken);
  assert.match((await detailed.json()).checks.storage, /10\.0\.0\.5/);

  for (const path of ["/status", "/players"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    assert.equal((await fetch(`${base}${path}`, { headers: { "X-Status-Token": "t".repeat(40) } })).status, 401);
    assert.equal((await fetch(`${base}${path}`, withToken)).status, 200, path);
    assert.equal(
      (await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })).status,
      200,
      "the form an uptime monitor sends"
    );
  }
});

test("a status token is long enough to be one, and makes a remote bind a decision", () => {
  assert.match(configProblems({ ODS_STATUS_TOKEN: "short" }).refusals[0], /ODS_STATUS_TOKEN must be at least 32/);
  assert.deepEqual(
    configProblems({ ODS_STATUS_HOST: "0.0.0.0", ODS_STATUS_TOKEN: "s".repeat(32) }).refusals,
    [],
    "with a token, the token is the access control"
  );
  assert.equal(loadServerConfig({ ODS_STATUS_TOKEN: "s".repeat(32) }).statusToken, "s".repeat(32));
});

/**
 * A server nobody is polling still has a log. When a check starts failing, or
 * a warning appears, that is written once — and once more when it clears —
 * rather than on every look.
 */
test("a change in health is written down once, when it happens", async () => {
  const { createHealthWatch } = await import("../src/status.js");
  const lines = [];
  const log = {
    error: (line) => lines.push(["error", line]),
    warn: (line) => lines.push(["warn", line]),
    info: (line) => lines.push(["info", line]),
  };
  let storage = null;
  let disk = null;
  const watch = createHealthWatch({
    probes: { storage: () => storage },
    warnings: { disk: () => disk },
    log,
  });

  await watch.look();
  assert.deepEqual(lines, [], "well, and nothing to say about it");

  storage = "the database does not answer";
  disk = "3% free";
  await watch.look();
  await watch.look();
  assert.deepEqual(lines, [
    ["error", "health: storage is failing — the database does not answer"],
    ["warn", "health: warning from disk — 3% free"],
  ]);

  storage = null;
  disk = "2% free";
  await watch.look();
  assert.deepEqual(
    lines.slice(2),
    [["info", "health: storage is ok again"]],
    "a warning that is still there is not repeated because its wording moved"
  );

  disk = null;
  await watch.look();
  assert.deepEqual(lines.slice(3), [["info", "health: disk warning cleared"]]);
});

// --- The same, for a monitoring system -----------------------------------------

test("the metrics route gives the numbers in the format a monitoring system collects", async (t) => {
  const base = await serving(t, {
    probes: { web: () => null, storage: () => "the database does not answer" },
    warnings: { disk: () => "3% free", tokens: () => null },
    describe: () => ({
      players: { online: 3, in_dungeon: 2 },
      game_sockets: 4,
      match_workers: [{ index: 0, alive: true, matches: 1, members: 2 }],
    }),
    counters: () => ({ saves_failed: 5, sockets_refused: 0 }),
  });

  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/plain; version=0\.0\.4/);
  const text = await response.text();

  for (const line of [
    /^ods_health_ok 0$/m,
    /^ods_health_check\{check="web"\} 1$/m,
    /^ods_health_check\{check="storage"\} 0$/m,
    /^ods_health_warning\{warning="disk"\} 1$/m,
    /^ods_health_warning\{warning="tokens"\} 0$/m,
    /^ods_players_online 3$/m,
    /^ods_players_in_dungeon 2$/m,
    /^ods_game_sockets 4$/m,
    /^ods_match_worker_alive\{worker="0"\} 1$/m,
    /^ods_saves_failed_total 5$/m,
    /^ods_sockets_refused_total 0$/m,
    /^ods_build_info\{version="[^"]+",commit="[^"]*",node="v[^"]+"\} 1$/m,
    /^ods_start_time_seconds \d+(\.\d+)?$/m,
    /^ods_memory_rss_bytes \d+$/m,
    /^ods_event_loop_delay_p99_seconds \d+(\.\d+)?$/m,
  ]) {
    assert.match(text, line);
  }
});

test("metrics name accounts' worth of nothing, and still need the token when there is one", async (t) => {
  const token = "s".repeat(40);
  const base = await serving(t, { token, probes: { web: () => null } });

  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const allowed = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(allowed.status, 200, "the form a scraper is configured with");
});

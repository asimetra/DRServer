import { createHash, timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { buildInfo } from "./build-info.js";
import { listen } from "./http.js";
import * as serverLog from "./log.js";
import { prometheusText } from "./prometheus-text.js";

/**
 * Whether the server is well, and what it is doing, for whoever is watching it.
 *
 * A supervisor could tell that the process existed and a monitor that the web
 * port accepted a connection. Neither is the question. With the game socket
 * closed, the storage unwritable or every match worker down, the process runs
 * and nobody can play — and the only place that showed was a player saying so.
 *
 * Five routes, each for a different asker:
 *
 *   /livez    the process answers. Fails only when restarting would help.
 *   /healthz  every check passes. 503 names the ones that do not, so a
 *             supervisor can act on the code and a person can read the body.
 *             Warnings ride along without changing the code.
 *   /status   what is running — version, uptime, players, memory, how late the
 *             event loop is running, how often things have gone wrong — with
 *             the health report alongside.
 *   /players  who is connected.
 *   /metrics  the same numbers as /status, in the format a monitoring system
 *             collects. History, graphs and alerts are that system's work.
 *
 * It has a listener of its own, bound to loopback, rather than paths on the
 * players' port guarded by where a request came from. Behind a tunnel every
 * player arrives from 127.0.0.1, and an address check would let all of them
 * in. Without a token nothing here needs a credential, so nothing here may be
 * reachable by anybody the operator did not choose: the bind address is the
 * access rule. With a token, the token is.
 */

const json = (body, status = 200) => ({
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

/** How long one check may take before it counts as failed. */
const CHECK_TIMEOUT_MS = 2_000;

/** One provider's answer: a sentence, or null. Never a throw, never a hang. */
const ask = async (provider, timeoutMs, onThrow) => {
  let timer;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(provider),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(`did not answer within ${timeoutMs}ms`), timeoutMs);
      }),
    ]);
    return answer ? String(answer) : null;
  } catch (problem) {
    return onThrow(problem);
  } finally {
    clearTimeout(timer);
  }
};

const askAll = async (providers, timeoutMs, onThrow) => {
  const names = Object.keys(providers);
  const answers = await Promise.all(names.map((name) => ask(providers[name], timeoutMs, onThrow)));
  return names.map((name, index) => [name, answers[index]]);
};

/**
 * Runs every probe, and every warning.
 *
 * A probe returns nothing when all is well and a sentence when it is not; one
 * that throws or never answers has failed as well, and the report must not
 * hang with it — a health check that hangs reads as healthy to anything with a
 * longer timeout than patience. A warning is a sentence too, about something
 * that is not a failure yet; it never changes `ok`.
 */
export const healthReport = async (probes, { warnings = {}, timeoutMs = CHECK_TIMEOUT_MS } = {}) => {
  const [checked, warned] = await Promise.all([
    askAll(probes, timeoutMs, (problem) => `check failed: ${problem?.message ?? problem}`),
    // A warning that cannot be evaluated is not itself worth a warning.
    askAll(warnings, timeoutMs, () => null),
  ]);
  const raised = warned.filter(([, text]) => text);
  return {
    ok: checked.every(([, problem]) => !problem),
    checks: Object.fromEntries(checked.map(([name, problem]) => [name, problem ?? "ok"])),
    ...(raised.length ? { warnings: Object.fromEntries(raised) } : {}),
  };
};

const asBody = ({ ok, checks, warnings }) => ({
  status: ok ? "ok" : "failing",
  checks,
  ...(warnings ? { warnings } : {}),
});

const megabytes = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/**
 * How late the event loop is running, measured for as long as anybody asks.
 *
 * The monitor times a timer set to fire every `resolution` milliseconds, so an
 * idle loop reads as the resolution itself; what is wanted is how much *later*
 * than that it fired. Every dungeon runs on this loop, and a loop running
 * 200 ms behind is lag. Started on first use and measured over a minute at a
 * time; zero before the first sample, rather than the histogram's sentinels.
 */
const DELAY_RESOLUTION_MS = 20;
const DELAY_WINDOW_MS = 60_000;
let delay = null;

export const eventLoopDelay = () => {
  if (!delay) {
    delay = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
    delay.enable();
    const window = setInterval(() => delay.reset(), DELAY_WINDOW_MS);
    window.unref?.();
  }
  const lateness = (nanoseconds) =>
    delay.count ? Math.max(0, Math.round((nanoseconds / 1e6 - DELAY_RESOLUTION_MS) * 10) / 10) : 0;
  return {
    mean_ms: lateness(delay.mean),
    p99_ms: lateness(delay.percentile(99)),
    max_ms: lateness(delay.max),
    window_seconds: DELAY_WINDOW_MS / 1000,
  };
};

/**
 * Writes a change in health down once, when it happens.
 *
 * A server nobody is polling still has a log, and "the storage stopped being
 * writable at 03:12" belongs in it. Said when a check starts failing or a
 * warning appears, and once more when it ends — not on every look, and not
 * again because the wording of a standing warning moved by a percentage point.
 */
export const createHealthWatch = ({ probes = {}, warnings = {}, log = serverLog } = {}) => {
  const failing = new Set();
  const warned = new Set();
  let timer = null;

  const look = async () => {
    const report = await healthReport(probes, { warnings });
    for (const [name, result] of Object.entries(report.checks)) {
      if (result !== "ok" && !failing.has(name)) {
        failing.add(name);
        log.error(`health: ${name} is failing — ${result}`);
      } else if (result === "ok" && failing.delete(name)) {
        log.info(`health: ${name} is ok again`);
      }
    }
    const raised = report.warnings ?? {};
    for (const [name, text] of Object.entries(raised)) {
      if (!warned.has(name)) {
        warned.add(name);
        log.warn(`health: warning from ${name} — ${text}`);
      }
    }
    for (const name of [...warned]) {
      if (!(name in raised)) {
        warned.delete(name);
        log.info(`health: ${name} warning cleared`);
      }
    }
    return report;
  };

  return {
    look,
    start: (everyMs = 30_000) => {
      timer ??= setInterval(() => void look().catch(() => undefined), everyMs);
      timer.unref?.();
    },
    stop: () => {
      clearInterval(timer);
      timer = null;
    },
  };
};

const digest = (text) => createHash("sha256").update(String(text)).digest();

/**
 * `probes` are the checks and `warnings` what is worth saying short of one;
 * `describe`, `players` and `counters` add what only the caller knows to what
 * any process can say about itself.
 *
 * `token`, when there is one, is what a caller presents to be told anything
 * that names an account or describes the deployment. Without it they still get
 * the verdict — a supervisor that can only read a status code needs no secret —
 * but not the reason, which may hold a path or a database address.
 */
export const start = ({
  host,
  port,
  probes = {},
  warnings = {},
  describe = () => ({}),
  players = () => [],
  counters = () => ({}),
  token = "",
  onReady,
} = {}) => {
  const startedAt = new Date();
  eventLoopDelay();

  const expected = token ? digest(token) : null;
  const presented = (request) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(request.headers?.authorization ?? ""))?.[1];
    return request.headers?.["x-status-token"] ?? bearer ?? "";
  };
  // Compared as digests, so neither the length nor the content shows in the timing.
  const allowed = (request) => !expected || timingSafeEqual(digest(presented(request)), expected);
  const refusal = () => json({ error: "a status token is required" }, 401);

  const readHealth = async (request) => {
    const report = await healthReport(probes, { warnings });
    const code = report.ok ? 200 : 503;
    return allowed(request)
      ? json(asBody(report), code)
      : json({ status: report.ok ? "ok" : "failing" }, code);
  };

  const readStatus = async (request) => {
    if (!allowed(request)) return refusal();
    const memory = process.memoryUsage();
    return json({
      ...buildInfo(),
      node: process.version,
      started_at: startedAt.toISOString(),
      uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      memory: { rss_mb: megabytes(memory.rss), heap_used_mb: megabytes(memory.heapUsed) },
      event_loop_delay: eventLoopDelay(),
      ...(await describe()),
      counters: counters(),
      health: asBody(await healthReport(probes, { warnings })),
    });
  };

  const readPlayers = async (request) =>
    allowed(request) ? json({ players: await players() }) : refusal();

  /**
   * What a monitoring system collects. Everything here is a number that is
   * already true somewhere else in this file; nothing is counted for its own
   * sake. A warning or a check is 1 or 0 under its name, so a rule can be
   * written about one of them without parsing a sentence.
   */
  const readMetrics = async (request) => {
    if (!allowed(request)) return refusal();
    const [report, described] = await Promise.all([healthReport(probes, { warnings }), describe()]);
    const memory = process.memoryUsage();
    const loop = eventLoopDelay();
    const { version, commit } = buildInfo();
    const workers = described.match_workers ?? [];
    const perWorker = (field) =>
      workers.map((worker) => ({ labels: { worker: worker.index }, value: Number(worker[field]) }));
    const gauge = (name, help, value) => ({ name, help, type: "gauge", value });

    const body = prometheusText([
      {
        name: "ods_build_info",
        help: "The build that is running; always 1.",
        type: "gauge",
        samples: [{ labels: { version, commit: commit ?? "", node: process.version }, value: 1 }],
      },
      gauge("ods_start_time_seconds", "When this server started, in seconds since the epoch.", startedAt.getTime() / 1000),
      gauge("ods_health_ok", "1 when every health check passes.", report.ok ? 1 : 0),
      {
        name: "ods_health_check",
        help: "1 when the named health check passes.",
        type: "gauge",
        samples: Object.entries(report.checks).map(([check, result]) => ({
          labels: { check },
          value: result === "ok" ? 1 : 0,
        })),
      },
      {
        name: "ods_health_warning",
        help: "1 while the named warning is raised.",
        type: "gauge",
        samples: Object.keys(warnings).map((warning) => ({
          labels: { warning },
          value: report.warnings && warning in report.warnings ? 1 : 0,
        })),
      },
      gauge("ods_players_online", "Players connected.", described.players?.online),
      gauge("ods_players_in_dungeon", "Players in a dungeon rather than in town.", described.players?.in_dungeon),
      gauge("ods_game_sockets", "Game socket sessions open, logged in or not.", described.game_sockets),
      { name: "ods_match_worker_alive", help: "1 when the match worker is running.", type: "gauge", samples: workers.map((worker) => ({ labels: { worker: worker.index }, value: worker.alive ? 1 : 0 })) },
      { name: "ods_match_worker_matches", help: "Matches on the worker.", type: "gauge", samples: perWorker("matches") },
      { name: "ods_match_worker_players", help: "Players on the worker.", type: "gauge", samples: perWorker("members") },
      gauge("ods_memory_rss_bytes", "Resident memory of the server process.", memory.rss),
      gauge("ods_memory_heap_used_bytes", "JavaScript heap in use.", memory.heapUsed),
      gauge("ods_event_loop_delay_mean_seconds", "How late timers fired, mean over the last minute.", loop.mean_ms / 1000),
      gauge("ods_event_loop_delay_p99_seconds", "How late timers fired, 99th percentile over the last minute.", loop.p99_ms / 1000),
      gauge("ods_event_loop_delay_max_seconds", "How late timers fired, worst over the last minute.", loop.max_ms / 1000),
      gauge("ods_data_dir_free_bytes", "Free space on the filesystem holding the data directory.", described.data_dir?.free_bytes),
      gauge("ods_data_dir_size_bytes", "Size of the filesystem holding the data directory.", described.data_dir?.size_bytes),
      ...Object.entries(counters()).map(([name, total]) => ({
        name: `ods_${name}_total`,
        help: `Total since the server started: ${name.replace(/_/g, " ")}.`,
        type: "counter",
        value: total,
      })),
    ]);
    return {
      status: 200,
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
      body,
    };
  };

  return listen({
    routeTable: [
      { method: "GET", pattern: "/livez", handler: () => json({ status: "ok" }) },
      { method: "GET", pattern: "/healthz", handler: readHealth },
      { method: "GET", pattern: "/status", handler: readStatus },
      { method: "GET", pattern: "/players", handler: readPlayers },
      { method: "GET", pattern: "/metrics", handler: readMetrics },
    ],
    host,
    port,
    // Asked every few seconds by a machine: neither counted nor written down.
    rateLimited: false,
    quiet: true,
    onReady,
  });
};

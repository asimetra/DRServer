/**
 * A synthetic population, for finding out how many players this server holds.
 *
 *   node tools/load-sim.js --players 500 --dungeons 200 --pid <server pid>
 *   node tools/load-sim.js --scenario churn --players 200 --stay 20
 *   node tools/load-sim.js --scenario lobby --players 2000 --source-ips 40
 *   node tools/load-sim.js --players 300 --rpc --slow-readers 0.05
 *   node tools/load-sim.js --players 500 --slo "heartbeat.p99<200,npc.p95<400"
 *
 * One process drives every player, so a few hundred of them cost this tool
 * very little. What it measures is the server, from where a player stands:
 *
 *   heartbeat   the round trip of the client's own heartbeat. The server echoes
 *               it from the same loop that runs everything else, so this is how
 *               long a player waits behind whatever the server is busy with.
 *   npc         the gap between one monster's position updates. The AI runs on
 *               a 250 ms turn; a gap much wider than that is a monster the
 *               player sees stutter. Judge it by p95: a monster standing still
 *               to swing sends nothing, so the tail is partly behaviour.
 *   entry       from asking for a dungeon to the hero arriving in it, over the
 *               whole run, ramp included.
 *   rpc         HTTP round trips, per method, and their failures.
 *
 * With `--pid` it also samples that process's CPU and memory from /proc (Linux).
 *
 * Scenarios:
 *
 *   dungeon  (default) players spread over `--dungeons` matches. Each walks to
 *            the nearest monster, swings once a second, and starts another run
 *            when one ends — a floor stays busy the way a played one does.
 *   churn    every player enters, stays `--stay` seconds, leaves, and enters
 *            again; with `--reconnect` it hangs up and logs in afresh instead.
 *            This is the build/teardown and account load/save path.
 *   lobby    connected and idle in town: heartbeats only. Connection and
 *            presence capacity, nothing else.
 *
 * The players walk in straight lines and do not respect walls, so a server
 * enforcing movement will expel some of them; run it with
 * `ODS_MOVEMENT_MODE=audit` to keep the rules running without that. Auth is
 * either off on the server (`ODS_AUTH=0`) or satisfied by signing a token per
 * player with `--token-secret-file` or `ODS_TOKEN_SECRET`.
 *
 * Aimed at loopback by default, and only there. A load generator pointed at
 * somebody else's server is an attack, so another host needs
 * `--allow-remote-target`, which is for a machine you run yourself.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { PacketWriter, drainFrames } from "../src/socket/packet.js";
import { OP, DC_HASH } from "../src/socket/opcodes.js";
import { FLID } from "../src/socket/matchmaker.js";
import { decodeGenerate } from "./wire.js";

/** One node per theme and difficulty band, so a run exercises every biome's traps. */
export const DEFAULT_NODES = [
  50003, 50004, 50006, 50008, 50010, 50012, 50015, 50018, 50021,
  50024, 50027, 50030, 50036, 50037, 50044, 50047, 50057, 50060,
];

/**
 * The swing a hero makes: its first equipped weapon's `Attack1`, read off the
 * GameMaster the way the client would. A fixed id was an NPC's attack, which a
 * server auditing casts reports on every hit, so the load was measured with the
 * cast rules complaining instead of passing.
 */
let attacksForWeapon = null;
const basicAttackFor = async (weaponDetails = []) => {
  attacksForWeapon ??= import("../src/gamemaster.js")
    .then(({ loadGameMaster }) => loadGameMaster())
    .then((gm) => {
      const items = new Map((gm.raw.WeaponItem ?? []).map((item) => [Number(item.Id), item]));
      return (type) => gm.attacksByConstant?.get(items.get(Number(type))?.Attack1)?.Id ?? null;
    })
    .catch(() => () => null);
  const attackOf = await attacksForWeapon;
  for (const [slot, weapon] of weaponDetails.entries()) {
    const attack = attackOf(Array.isArray(weapon) ? weapon[0] : weapon?.type);
    if (attack) return { slot, attack };
  }
  return null;
};

/**
 * What the real client calls over HTTP, and how often, per player-minute —
 * measured on the official server's recordings (4.6 calls a minute in all).
 * Only reads: a load test has no business buying things.
 */
export const RPC_MIX = [
  { route: "/rpc/championsboard/getAllMapnodeScores", weight: 0.84, params: (id) => [id, [], []] },
  { route: "/rpc/leaderboard/getFriendRecord", weight: 0.59, params: (id, token) => [id, token] },
  { route: "/api/dbAccountInfo/accountdetails", weight: 0.55, get: true },
  { route: "/rpc/friendrequests/DRFriendRequestPending", weight: 0.45, params: (id, token) => [id, token] },
  { route: "/rpc/store/GetAllGifts", weight: 0.45, params: (id, token) => [id, token] },
  { route: "/rpc/store/AskAboutDailyReward", weight: 0.16, params: (id, token) => [id, token] },
  { route: "/rpc/storeGetWebServerTimestamp/getWebServerTimestamp", weight: 0.19, params: () => [] },
];

const HERO_POSITION = 147;
const NPC_POSITION = 132;
const PROPOSE_COMBAT_RESULTS = 171;
const PROPOSE_ATTACK_CHOREOGRAPHY = 172;
const REQUEST_HERO = 184;
const REQUEST_ENTRY = 185;
const DUNGEON_ENDING = 216;

export const parseArgs = (argv) => {
  const value = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  const flag = (name) => argv.includes(`--${name}`);
  const number = (name, fallback) => Number(value(name, fallback));
  return {
    scenario: value("scenario", "dungeon"),
    host: value("host", "127.0.0.1"),
    port: number("port", 7198),
    httpPort: number("http-port", 8080),
    pid: value("pid", null) === null ? null : Number(value("pid")),
    players: number("players", 100),
    dungeons: number("dungeons", 40),
    ramp: number("ramp", 25),
    settle: number("settle", 15),
    hold: number("hold", 60),
    stay: number("stay", 20),
    fight: !flag("no-fight"),
    reconnect: flag("reconnect"),
    rpc: flag("rpc"),
    rpcPerMinute: number("rpc-per-minute", 4.6),
    slowReaders: number("slow-readers", 0),
    sourceIps: number("source-ips", 1),
    firstAccount: number("first-account", 1000100000),
    nodes: value("nodes", null)?.split(",").map(Number) ?? DEFAULT_NODES,
    tokenSecret: readSecret(value("token-secret-file", null)),
    slo: value("slo", ""),
    json: flag("json"),
    allowRemote: flag("allow-remote-target"),
  };
};

const readSecret = (file) => {
  if (file) return fs.readFileSync(file, "utf8").trim();
  return process.env.ODS_TOKEN_SECRET ?? process.env.DR_TOKEN_SECRET ?? "";
};

export const isLoopback = (host) =>
  host === "localhost" || host === "::1" || /^127\./.test(String(host));

export const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

/**
 * Sorted once, and the maximum read off the end: `Math.max(...values)` spreads
 * the whole array onto the stack, and a restart storm collects enough samples
 * to overflow it.
 */
export const summarise = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null);
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length ? sorted.at(-1) : null };
};

/**
 * `heartbeat.p99<200,npc.p99<400,entry.p95<3000,cpu.p95<90` — each a metric, a
 * statistic, `<` or `>`, and a bound. Anything unreadable is refused rather
 * than skipped, because a threshold that silently stops applying is a CI job
 * that stops failing.
 */
export const parseSlo = (text) =>
  String(text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^([a-z]+)\.([a-z0-9]+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/i.exec(part);
      if (!match) throw new Error(`unreadable SLO "${part}"`);
      return { metric: match[1], stat: match[2], op: match[3], bound: Number(match[4]), text: part };
    });

export const checkSlo = (report, rules) =>
  rules.map((rule) => {
    const actual = report.metrics[rule.metric]?.[rule.stat];
    const ok =
      actual !== null &&
      actual !== undefined &&
      (rule.op === "<" ? actual < rule.bound : actual > rule.bound);
    return { ...rule, actual, ok };
  });

/** Picks from the RPC mix in proportion to how often the client makes each call. */
export const pickRpc = (random = Math.random) => {
  const total = RPC_MIX.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of RPC_MIX) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return RPC_MIX.at(-1);
};

const field = (doid, id) => new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(id);

class Metrics {
  constructor() {
    this.measuring = false;
    this.heartbeat = [];
    this.npc = [];
    this.entry = [];
    this.rpc = new Map();
    this.rpcFailures = new Map();
    this.counts = { entries: 0, heroes: 0, runsEnded: 0, hits: 0, closed: 0, slowClosed: 0, logouts: 0 };
    this.errors = new Map();
  }
  bump(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}

class Player {
  constructor(index, options, metrics) {
    this.options = options;
    this.metrics = metrics;
    this.account = options.firstAccount + index;
    this.dungeon = index % Math.max(1, options.dungeons);
    this.node = options.nodes[this.dungeon % options.nodes.length];
    this.group = `load-${this.dungeon}`;
    this.localAddress =
      options.sourceIps > 1 && isLoopback(options.host)
        ? `127.0.${Math.floor(index % options.sourceIps / 250)}.${2 + (index % options.sourceIps) % 250}`
        : undefined;
    this.slow = index < Math.round(options.players * options.slowReaders);
    this.token = options.tokenSecret ? null : "load";
    this.npcs = new Map();
    this.timers = [];
  }

  async tokenFor() {
    if (this.token) return this.token;
    const { issueToken } = await import("../src/auth.js");
    const expiry = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    this.token = issueToken(this.account, { secret: this.options.tokenSecret, expiry, generation: 0 });
    return this.token;
  }

  async connect() {
    const token = await this.tokenFor();
    this.buffer = Buffer.alloc(0);
    this.player = this.hero = this.mm = null;
    this.entered = false;
    this.socket = net.createConnection({
      host: this.options.host,
      port: this.options.port,
      localAddress: this.localAddress,
    });
    this.socket.setNoDelay(true);
    this.socket.on("connect", () => {
      this.send(
        new PacketWriter(OP.CLIENT_LOGIN_DUNGEONBUSTER)
          .utf(token).utf("development").u32(DC_HASH).u32(4).u32(this.account).u32(3).u32(0)
          .frame()
      );
      this.heartbeat();
    });
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("error", (error) => this.metrics.bump(this.metrics.errors, error.code ?? error.message));
    this.socket.on("close", () => {
      this.metrics.counts.closed += 1;
      if (this.slow) this.metrics.counts.slowClosed += 1;
      this.clearTimers();
    });
    this.every(2000, () => this.heartbeat());
    if (this.options.scenario !== "lobby") this.every(250, () => this.tick());
    if (this.options.rpc) this.scheduleRpc();
  }

  every(ms, work) {
    this.timers.push(setInterval(work, ms));
  }

  clearTimers() {
    for (const timer of this.timers) clearInterval(timer);
    clearTimeout(this.rpcTimer);
    clearTimeout(this.stayTimer);
    this.timers = [];
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.socket?.destroy();
  }

  send(frame) {
    if (this.socket && !this.socket.destroyed) this.socket.write(frame);
  }

  heartbeat() {
    this.send(new PacketWriter(OP.CLIENT_HEART_BEAT).utf(String(Date.now())).frame());
  }

  enter() {
    this.metrics.counts.entries += 1;
    this.hero = null;
    this.npcs.clear();
    this.askedAt = Date.now();
    this.send(
      field(this.mm, FLID.ClientRequestEntry)
        .utf("{}").u32(0).u32(this.node).u32(0).u32(0).u8(0).utf(this.group)
        .frame()
    );
  }

  leave() {
    this.hero = null;
    this.send(field(this.mm, FLID.RequestExit).u32(0).frame());
  }

  /** Walks to the nearest monster at about 180 units a second and swings once a second. */
  tick() {
    if (!this.hero || !this.position) return;
    this.turn = (this.turn ?? 0) + 1;
    let target = null;
    let distance = Infinity;
    for (const [doid, npc] of this.npcs) {
      const d = Math.hypot(npc.x - this.position.x, npc.y - this.position.y);
      if (d < distance) {
        target = doid;
        distance = d;
      }
    }
    if (target !== null && distance > 70) {
      const npc = this.npcs.get(target);
      const step = Math.min(45, distance - 70);
      this.position = {
        x: this.position.x + ((npc.x - this.position.x) / distance) * step,
        y: this.position.y + ((npc.y - this.position.y) / distance) * step,
      };
    }
    this.send(field(this.hero, HERO_POSITION).f32(this.position.x).f32(this.position.y).frame());
    const swing = this.swing;
    if (!this.options.fight || !swing || this.turn % 4 || target === null || distance > 160) return;

    this.send(
      field(this.hero, PROPOSE_ATTACK_CHOREOGRAPHY)
        .u8(swing.slot).u8(0).u32(swing.attack).u32(0).u8(0).f32(1).f32(1).u16(0)
        .frame()
    );
    const result = new PacketWriter()
      .u32(this.hero).u32(target).i32(0)
      .u8(swing.slot).u8(0).u32(swing.attack).u32(target)
      .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
      .body();
    this.send(field(this.hero, PROPOSE_COMBAT_RESULTS).u16(result.length).raw(result).frame());
    this.metrics.counts.hits += 1;
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { packets, rest } = drainFrames(this.buffer);
    this.buffer = rest;
    for (const body of packets) this.packet(body);
  }

  packet(body) {
    const now = Date.now();
    const op = body.readUInt16LE(0);
    if (op === OP.CLIENT_HEART_BEAT) {
      const sent = Number(body.subarray(4, 4 + body.readUInt16LE(2)).toString());
      if (this.metrics.measuring && !this.slow && Number.isFinite(sent)) {
        this.metrics.heartbeat.push(now - sent);
      }
      return;
    }
    if (op === OP.CLIENT_LOGOUT_RESP) {
      this.metrics.counts.logouts += 1;
      return;
    }
    if (op === 134 || op === 135 || op === 136) return this.generate(body, now);
    if (op === 125 || op === 126) {
      this.npcs.delete(body.readUInt32LE(2));
      return;
    }
    if (op !== OP.CLIENT_OBJECT_UPDATE_FIELD || body.length < 8) return;

    const doid = body.readUInt32LE(2);
    const id = body.readUInt16LE(6);
    if (id === NPC_POSITION && body.length >= 16) {
      const npc = this.npcs.get(doid);
      if (!npc) return;
      if (this.metrics.measuring && !this.slow && now - npc.at < 3000) this.metrics.npc.push(now - npc.at);
      npc.x = body.readFloatLE(8);
      npc.y = body.readFloatLE(12);
      npc.at = now;
      return;
    }
    if (id === DUNGEON_ENDING && this.hero) {
      this.metrics.counts.runsEnded += 1;
      setTimeout(() => this.leave(), 1500);
      return;
    }
    if (doid === this.mm && id === FLID.ClientExitComplete && !this.stopped) {
      setTimeout(() => this.enter(), 500);
    }
  }

  generate(body, now) {
    const object = decodeGenerate(body);
    const fields = object.fields ?? {};
    switch (object.class) {
      case "MatchMaker":
        this.mm = object.doid;
        if (this.options.scenario !== "lobby" && !this.entered) {
          this.entered = true;
          this.enter();
        }
        return;
      case "PlayerGameObjectOwner":
        this.player = object.doid;
        return;
      case "DistributedDungionArea":
        if (this.player) this.send(field(this.player, REQUEST_ENTRY).frame());
        return;
      case "DistributedDungeonFloor":
        this.npcs.clear();
        if (this.player) this.send(field(this.player, REQUEST_HERO).frame());
        return;
      case "HeroGameObjectOwner":
        this.hero = object.doid;
        if (fields.position) this.position = { x: fields.position[0], y: fields.position[1] };
        basicAttackFor(fields.weaponDetails).then((swing) => {
          this.swing = swing;
          if (!swing) this.metrics.bump(this.metrics.errors, "no weapon attack (GameMaster missing?)");
        });
        this.metrics.counts.heroes += 1;
        // Every entry counts, the ramp's included: a login storm is exactly
        // when the wait for a dungeon is worth knowing.
        if (this.askedAt) {
          this.metrics.entry.push(now - this.askedAt);
          this.askedAt = null;
        }
        // A reader that stops reading once it is in, which is what a stalled or
        // hostile client looks like from here.
        if (this.slow) this.socket.pause();
        if (this.options.scenario === "churn") this.scheduleLeave();
        return;
      case "DistributedNPCGameObject":
        if (fields.position) this.npcs.set(object.doid, { x: fields.position[0], y: fields.position[1], at: now });
        return;
      default:
    }
  }

  scheduleLeave() {
    clearTimeout(this.stayTimer);
    this.stayTimer = setTimeout(() => {
      if (this.stopped) return;
      if (!this.options.reconnect) return this.leave();
      this.socket.destroy();
      setTimeout(() => !this.stopped && this.connect(), 500);
    }, this.options.stay * 1000);
  }

  scheduleRpc() {
    const meanMs = 60_000 / Math.max(0.01, this.options.rpcPerMinute);
    this.rpcTimer = setTimeout(async () => {
      if (this.stopped) return;
      await this.callRpc(pickRpc());
      this.scheduleRpc();
    }, -Math.log(1 - Math.random()) * meanMs);
  }

  async callRpc(entry) {
    const token = await this.tokenFor();
    const body = entry.get
      ? null
      : JSON.stringify({ jsonrpc: "2.0", id: 1, method: entry.route.split("/").at(-1), params: entry.params(this.account, token) });
    const started = Date.now();
    const status = await new Promise((resolve) => {
      const request = http.request(
        {
          host: this.options.host,
          port: this.options.httpPort,
          path: entry.route,
          method: entry.get ? "GET" : "POST",
          localAddress: this.localAddress,
          headers: {
            "Content-Type": "application/json",
            "X-Account-Id": String(this.account),
            "X-Validation-Token": token,
          },
          timeout: 30_000,
        },
        (response) => {
          let text = "";
          response.on("data", (part) => (text += part));
          response.on("end", () =>
            resolve(response.statusCode === 200 && !/"error":\{/.test(text) ? 200 : response.statusCode === 200 ? "rpc-error" : response.statusCode)
          );
        }
      );
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.on("error", (error) => resolve(error.message === "timeout" ? "timeout" : error.code ?? "error"));
      if (body) request.end(body);
      else request.end();
    });
    if (!this.metrics.measuring) return;
    const name = entry.route.split("/").at(-1);
    if (status === 200) {
      if (!this.metrics.rpc.has(name)) this.metrics.rpc.set(name, []);
      this.metrics.rpc.get(name).push(Date.now() - started);
    } else {
      this.metrics.bump(this.metrics.rpcFailures, `${name} ${status}`);
    }
  }
}

const TICKS_PER_SECOND = 100;

const readProcess = (pid) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  return {
    cpu: (Number(stat[11]) + Number(stat[12])) / TICKS_PER_SECOND,
    rssMb: Number(/VmRSS:\s+(\d+)/.exec(status)[1]) / 1024,
    at: Date.now(),
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const run = async (options) => {
  if (!isLoopback(options.host) && !options.allowRemote) {
    throw new Error(`refusing to load ${options.host}: pass --allow-remote-target for a server you run`);
  }
  const rules = parseSlo(options.slo);
  const metrics = new Metrics();
  const samples = [];
  let last = options.pid ? readProcess(options.pid) : null;
  const sampler = options.pid
    ? setInterval(() => {
        const now = readProcess(options.pid);
        samples.push({
          cpuPct: (100 * (now.cpu - last.cpu)) / ((now.at - last.at) / 1000),
          rssMb: now.rssMb,
          measuring: metrics.measuring,
        });
        last = now;
      }, 1000)
    : null;

  const players = [];
  for (let index = 0; index < options.players; index++) {
    const player = new Player(index, options, metrics);
    players.push(player);
    await player.connect();
    if ((index + 1) % Math.max(1, options.ramp) === 0) await sleep(1000);
  }
  await sleep(options.settle * 1000);
  metrics.measuring = true;
  const startedAt = Date.now();
  await sleep(options.hold * 1000);
  metrics.measuring = false;
  const heldFor = (Date.now() - startedAt) / 1000;
  clearInterval(sampler);
  for (const player of players) player.stop();

  const steady = samples.filter((sample) => sample.measuring);
  const report = {
    scenario: options.scenario,
    players: options.players,
    dungeons: options.scenario === "lobby" ? 0 : options.dungeons,
    heldSeconds: heldFor,
    metrics: {
      heartbeat: summarise(metrics.heartbeat),
      npc: summarise(metrics.npc),
      entry: summarise(metrics.entry),
      cpu: summarise(steady.map((sample) => Math.round(sample.cpuPct))),
      rss: summarise(steady.map((sample) => Math.round(sample.rssMb))),
    },
    rpc: Object.fromEntries([...metrics.rpc].map(([name, values]) => [name, summarise(values)])),
    rpcFailures: Object.fromEntries(metrics.rpcFailures),
    counts: metrics.counts,
    socketErrors: Object.fromEntries(metrics.errors),
  };
  report.slo = checkSlo(report, rules);
  return report;
};

const printReport = (report) => {
  const line = (label, s, unit = "ms") =>
    s?.n ? `  ${label.padEnd(10)} p50 ${s.p50}${unit}  p95 ${s.p95}${unit}  p99 ${s.p99}${unit}  max ${s.max}${unit}  (n=${s.n})` : `  ${label.padEnd(10)} no samples`;
  console.log(`${report.scenario}: ${report.players} players, ${report.dungeons} dungeons, ${report.heldSeconds.toFixed(0)}s measured`);
  console.log(line("heartbeat", report.metrics.heartbeat));
  console.log(line("npc gap", report.metrics.npc));
  console.log(line("entry", report.metrics.entry));
  if (report.metrics.cpu.n) console.log(line("cpu", report.metrics.cpu, "%"));
  if (report.metrics.rss.n) console.log(line("rss", report.metrics.rss, "MB"));
  for (const [name, s] of Object.entries(report.rpc)) console.log(line(name.slice(0, 10), s));
  if (Object.keys(report.rpcFailures).length) console.log(`  rpc failures ${JSON.stringify(report.rpcFailures)}`);
  console.log(`  counts ${JSON.stringify(report.counts)}`);
  if (Object.keys(report.socketErrors).length) console.log(`  socket errors ${JSON.stringify(report.socketErrors)}`);
  for (const rule of report.slo) console.log(`  SLO ${rule.ok ? "ok  " : "FAIL"} ${rule.text} (actual ${rule.actual})`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const report = await run(options).catch((error) => {
    console.error(`load-sim: ${error.message}`);
    process.exit(2);
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  process.exit(report.slo.every((rule) => rule.ok) ? 0 : 1);
}

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import { isIPv6 } from "node:net";
import { readJsonFile } from "./json-file.js";
import { envSetting } from "./env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const defaultConfigFile = path.join(serverRoot, "config", "server.defaults.json");

const asInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * `auto` leaves one core to the main thread and uses up to four for matches.
 * Four carried 700 simulated players in 280 dungeons at about a third busy
 * each; more mostly adds another GameMaster's worth of memory per thread.
 */
const MAX_AUTO_MATCH_WORKERS = 4;

/**
 * The most that may be asked for. Past this the threads mostly add memory, and
 * the database connections they open together (see storage/postgres.js) stop
 * fitting under the common limit of a hundred.
 */
export const MAX_MATCH_WORKERS = 16;

const asWorkerCount = (value, fallback = 0) => {
  const selected = value ?? fallback;
  if (String(selected).toLowerCase() === "auto") {
    // One core means nothing to leave the main thread: no workers at all.
    return Math.max(0, Math.min(MAX_AUTO_MATCH_WORKERS, availableParallelism() - 1));
  }
  return Math.max(0, Math.min(MAX_MATCH_WORKERS, asInt(selected, 0)));
};

/** Public ODS_* settings take precedence; DR_* remains a compatibility alias. */
const setting = (environment, name) => envSetting(name, environment);

const DEFAULT_ACTIVITY_THRESHOLDS = [1, 5, 9, 17];

/** Four ascending positive counts, from a list or "1,5,9,17"; the defaults otherwise. */
const activityThresholdsFrom = (value) => {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((entry) => Number(String(entry).trim()));
  const valid =
    list.length === 4 &&
    list.every((entry, index) => Number.isSafeInteger(entry) && entry > 0 && (index === 0 || entry > list[index - 1]));
  return valid ? list : DEFAULT_ACTIVITY_THRESHOLDS;
};

const configuredPath = ({ environmentValue, defaultValue, configDir }) =>
  environmentValue
    ? path.resolve(environmentValue)
    : path.resolve(configDir, defaultValue);

/**
 * The content directory a deployment has written, if it has written one.
 *
 * Derived rather than required, so that `npm start` serves what is there. An
 * empty or absent directory means the whole override mechanism stays off, which
 * is the right default for somebody who only wants to run the game.
 */
const defaultContentDir = () => {
  const here = path.join(serverRoot, "content");
  try {
    return fs.readdirSync(here).length ? here : "";
  } catch {
    return "";
  }
};

/**
 * Loads deployment settings from JSON, with environment variables kept as
 * process-specific overrides. Relative paths in the JSON file are resolved
 * from that file; relative paths in environment variables use the working
 * directory, matching normal command-line behaviour.
 */
export const loadServerConfig = (environment = process.env) => {
  const configFile = setting(environment, "CONFIG_FILE")
    ? path.resolve(setting(environment, "CONFIG_FILE"))
    : defaultConfigFile;
  const defaults = readJsonFile(configFile);
  const configDir = path.dirname(configFile);

  return {
    /** Address the HTTP server binds to. */
    host: setting(environment, "HOST") ?? defaults.host,
    port: asInt(setting(environment, "PORT"), defaults.port),

    /**
     * Advertised over service discovery. Must be reachable *by the client*, so it
     * cannot be 0.0.0.0 even when we bind to it.
     */
    publicHost: unbracketed(setting(environment, "PUBLIC_HOST") || defaults.publicHost),

    /**
     * The ports and socket host clients are told, where they differ from what
     * is bound: a router forwarding 9000 to 8080, or a tunnel that hands out a
     * host and port of its own for each listener. Advertising only — nothing
     * listens on these. Each defaults to its bound counterpart.
     */
    publicPort: asInt(
      setting(environment, "PUBLIC_PORT"),
      asInt(setting(environment, "PORT"), defaults.port)
    ),
    publicSocketHost: unbracketed(
      setting(environment, "PUBLIC_SOCKET_HOST") ||
        setting(environment, "PUBLIC_HOST") ||
        defaults.publicHost
    ),
    publicSocketPort: asInt(
      setting(environment, "PUBLIC_SOCKET_PORT"),
      asInt(setting(environment, "SOCKET_PORT"), defaults.gameSocketPort)
    ),

    /** Explicit acknowledgement required before cleartext ports bind remotely. */
    allowInsecureRemote:
      setting(environment, "ALLOW_INSECURE_REMOTE") === undefined
        ? defaults.allowInsecureRemote === true
        : setting(environment, "ALLOW_INSECURE_REMOTE") === "1",

    /** The DcSocket game server, started alongside the HTTP service. */
    gameSocketPort: asInt(setting(environment, "SOCKET_PORT"), defaults.gameSocketPort),

    /** Absolute time a new connection gets to authenticate. */
    socketLoginTimeoutMs: Math.max(
      1000,
      asInt(setting(environment, "SOCKET_LOGIN_TIMEOUT_MS"), defaults.socketLoginTimeoutMs ?? 15000)
    ),

    /** Network-idle time allowed after login; client heartbeats refresh it. */
    socketIdleTimeoutMs: Math.max(
      10000,
      asInt(setting(environment, "SOCKET_IDLE_TIMEOUT_MS"), defaults.socketIdleTimeoutMs ?? 120000)
    ),

    /** Time to flush a final protocol frame before a forced socket destroy. */
    socketCloseGraceMs: Math.max(
      100,
      asInt(setting(environment, "SOCKET_CLOSE_GRACE_MS"), defaults.socketCloseGraceMs ?? 2000)
    ),

    /** Fixed-cost admission bounds before a socket is allowed to allocate session state. */
    maxSocketConnections: Math.max(
      1,
      asInt(setting(environment, "MAX_SOCKET_CONNECTIONS"), defaults.maxSocketConnections ?? 2000)
    ),
    maxSocketConnectionsPerIp: Math.max(
      1,
      asInt(
        setting(environment, "MAX_SOCKET_CONNECTIONS_PER_IP"),
        defaults.maxSocketConnectionsPerIp ?? 64
      )
    ),
    /**
     * Requests one address may make to a listener in ten seconds; see http.js
     * for where 320 comes from. Raise it where every player arrives from one
     * address — a tunnel, a reverse proxy — because then they share the budget
     * of one.
     */
    httpRateLimit: Math.max(
      1,
      asInt(setting(environment, "HTTP_RATE_LIMIT"), defaults.httpRateLimit ?? 320)
    ),
    /**
     * Which rules refuse and which only count.
     *
     * Three of them, separately, because they rest on different evidence and
     * carry different risk. Cast matching and placement identity shared one flag
     * — so turning on a deterministic placement rule meant also turning on a
     * combat matcher that was not ready, and the weaker of the two decided when
     * either could ship.
     *
     * `audit` is the useful middle: the rule runs and reports and changes
     * nothing, which is how a false-positive rate gets measured on this
     * server's own players rather than on somebody else's recordings.
     *
     * Both old names still work, since a running deployment may set them.
     */
    castMode: mode(setting(environment, "CAST_MODE"), setting(environment, "REQUIRE_CAST")),
    placementMode: mode(setting(environment, "PLACEMENT_MODE"), setting(environment, "REQUIRE_CAST")),
    /**
     * Reach, which refuses by default like movement does.
     *
     * The other two wait for a false-positive rate measured on this server's
     * own players. This one has it: across 14479 of the official's hit claims
     * and 4689 of this server's, the furthest any landed past its attack's
     * authored reach was 253 units against a bound of 400. It costs an honest
     * player nothing and it only ever drops the hit — while with it off, a
     * client that claims a hit on every monster from where it stands clears
     * the floor in a couple of dozen packets.
     *
     * The old flag has nothing left to say: `1` asked for what is now the
     * default, and it never had a way to ask for off.
     */
    reachMode: mode(setting(environment, "REACH_MODE") ?? "enforce"),

    /**
     * Movement, which is the one that already shipped enforcing.
     *
     * So its default is `enforce` where the others default to `off` — turning
     * it into a mode is about being able to stand it down deliberately, not
     * about switching it on. `audit` is what a test harness wants: the rules
     * still run and still report, so a regression in them is still visible,
     * but a claim they dislike is not thrown away.
     *
     * Worth having for its own sake. A probe cannot be a faithful client in
     * every respect at once, and making it one before it could run at all put
     * the expensive work in front of the cheap.
     */
    movementMode: mode(setting(environment, "MOVEMENT_MODE") ?? "enforce"),

    /**
     * What this server calls itself when it answers a command.
     *
     * In the defaults file rather than env-only because it is identity a
     * deployment keeps, and the file is where somebody looks to find out what
     * their server is called. The environment still overrides it for a process,
     * which is the same layering every setting here uses.
     */
    serverName: setting(environment, "SERVER_NAME") ?? defaults.serverName,

    /**
     * Account ids that count as admin whatever their stored rank says.
     *
     * The first admin has to come from somewhere. Ranks live on the account and
     * are granted by a command, so a fresh database is a locked room: no rank
     * to run the command that grants the rank. This is the key, and it is an
     * environment flag rather than a seeded row so that revoking it is
     * restarting without it.
     *
     *   ODS_ADMIN_ACCOUNTS=1000000005,1000000006
     */
    adminAccounts: String(setting(environment, "ADMIN_ACCOUNTS") ?? "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id) && id > 0),

    /**
     * A directory this server hands to clients under /content/, or "" for none.
     *
     * Deliberately not the game's Resources folder. The client builds every
     * asset path as `download_root + path`, so overriding one path is how a
     * floor gets a tile library the player does not have on disk — and
     * everything not overridden should keep coming off the player's own copy.
     * Pointing this at a full mirror of the game would turn a lobby into a
     * second download of it.
     */
    contentDir: setting(environment, "CONTENT_DIR") ?? defaultContentDir(),

    /**
     * The browser build of the client (`bin/html5/bin`), served under
     * /play/, or "" for none. Played from here its page, the discovery answer
     * and the web services share one origin, so the browser needs no CORS; the
     * game socket takes the browser's WebSocket on its usual port.
     *
     *   ODS_WEB_CLIENT_DIR=/srv/web-client   then   http://host:8080/play/#account=…&token=…
     */
    webClientDir: setting(environment, "WEB_CLIENT_DIR") ?? "",

    /**
     * Where the client should fetch overridden assets from, or "" to override
     * nothing. Set it and asset paths cross the wire as absolute URLs at this
     * base instead of as names the client resolves on its own disk.
     *
     *   ODS_CONTENT_URL=http://192.168.1.10:8080/content
     *
     * Needs the client's `download_root` set to "" in DbConfiguration/Config.json,
     * because the shipped default of "./" is prepended to whatever we send.
     */
    contentBaseUrl:
      setting(environment, "CONTENT_URL") ??
      (defaultContentDir()
        ? `http://${hostInUrl(unbracketed(setting(environment, "PUBLIC_HOST") || defaults.publicHost))}:${asInt(
            setting(environment, "PUBLIC_PORT"),
            asInt(setting(environment, "PORT"), defaults.port)
          )}/content`
        : ""),

    /**
     * When true, unknown JSON-RPC methods answer with an empty result instead
     * of an error. It exists to enumerate what the client needs, and that job
     * is done: of the 29 distinct methods the official recordings show the
     * client calling, this server now answers all of them — 28 through the RPC
     * registry and `accountdetails` through the REST layer.
     *
     * So it is off by default. A server reachable by anyone should refuse input
     * it does not recognise rather than answer it, and an unimplemented method
     * discovered later is better as a loud error than as a silent empty array.
     * `ODS_STRICT=0` turns it back on for protocol work.
     */
    // Unset or empty is the default. Empty used to count as "not 1", so a
    // variable passed through blank switched strictness off.
    permissive: !setting(environment, "STRICT")
      ? defaults.permissive
      : setting(environment, "STRICT") !== "1",

    /**
     * Where accounts live: "file" keeps one JSON document per account, which
     * needs nothing installed; "postgres" uses the containerised database from
     * docker-compose.yml. File storage stays the default so the server runs on
     * a clean machine.
     */
    storage: setting(environment, "STORAGE") || defaults.storage,

    databaseUrl: setting(environment, "DATABASE_URL") ?? defaults.databaseUrl,

    /** Account state lives here, one JSON file per account id. */
    dataDir: configuredPath({
      environmentValue: setting(environment, "DATA_DIR"),
      defaultValue: defaults.dataDir,
      configDir,
    }),

    /**
     * Server-owned game-data snapshot. It is deliberately independent from the
     * client repository and refreshed through tools/sync-game-data.js.
     */
    resourcesDir: configuredPath({
      environmentValue: setting(environment, "RESOURCES_DIR"),
      defaultValue: defaults.resourcesDir,
      configDir,
    }),

    accountTemplateFile: configuredPath({
      environmentValue: setting(environment, "ACCOUNT_TEMPLATE"),
      defaultValue: defaults.accountTemplateFile,
      configDir,
    }),

    floorCatalogFile: configuredPath({
      environmentValue: setting(environment, "FLOOR_CATALOG"),
      defaultValue: defaults.floorCatalogFile,
      configDir,
    }),

    /**
     * Skins and summons some players have and others do not; see
     * src/content-packs.js. Local to a deployment, like its content, and
     * optional: without the file every client is sent the game's own content.
     */
    contentPacksFile: configuredPath({
      environmentValue: setting(environment, "CONTENT_PACKS"),
      defaultValue: defaults.contentPacksFile ?? "content-packs.json",
      configDir,
    }),

    /**
     * Dungeons are served by default now that entry is verified end to end.
     * Set DR_DUNGEON=0 to refuse entry instead — useful when working on the
     * lobby, since a refusal returns the client to town cleanly rather than
     * leaving it on the loading screen.
     */
    dungeonsEnabled:
      setting(environment, "DUNGEON") === undefined
        ? defaults.dungeonsEnabled
        : setting(environment, "DUNGEON") !== "0",

    /**
     * Milliseconds to wait between generating the dungeon area and the floor, so
     * the client can finish fetching the tile library the floor references.
     * A placeholder for proper interest-driven sequencing.
     */
    floorDelayMs: asInt(setting(environment, "FLOOR_DELAY_MS"), defaults.floorDelayMs),

    /**
     * Which NPCs to place: "all", "props" (barrels and crates only), "enemies"
     * or "none". A bisecting aid — when the client misbehaves in a dungeon it is
     * usually one class of actor that causes it, and this narrows it down in one
     * run instead of guessing.
     */
    npcFilter: setting(environment, "NPC_FILTER") ?? defaults.npcFilter,

    /**
     * Fallback interval for AUTO_TIMER_TRIGGER objects that do not provide the
     * level-authored intervalTime value, in milliseconds.
     */
    trapCycleMs: asInt(setting(environment, "TRAP_CYCLE_MS"), defaults.trapCycleMs),

    /** Server-authoritative NPC chase/attack simulation cadence. */
    npcAiTickMs: asInt(setting(environment, "NPC_AI_TICK_MS"), defaults.npcAiTickMs),

    /**
     * Which floor a run starts on, counting from one.
     *
     * Only for testing, and it exists because the alternative is playing to the
     * floor you want to look at. The trap test map is ten floors, one per
     * theme, so anything in the ice caves is eight floors of walking away —
     * every time the server restarts, which is every time it changes.
     *
     * Clamped to the run's real length, so a number past the end lands on the
     * last floor rather than on nothing.
     */
    startFloor: Math.max(1, asInt(setting(environment, "START_FLOOR"), defaults.startFloor ?? 1)),

    /**
     * The key every validation token is signed with — see auth.js.
     *
     * Whoever holds this can issue a token for any account, so it is the one
     * secret this server has. Left unset, startup writes a random one beside
     * the account data rather than making an operator invent one.
     */
    tokenSecret: setting(environment, "TOKEN_SECRET") ?? defaults.tokenSecret ?? "",

    /**
     * The internal API: where a web front end asks this server to act on
     * accounts, and the credential it presents.
     *
     * Its own listener rather than a path on the player-facing one, because
     * the two want different exposure and the player-facing one is documented
     * as being bound to `0.0.0.0` the moment anybody else is let in. Sharing a
     * port would mean following that instruction also publishes the endpoint
     * that mints tokens. Bound to loopback by default so the mistake takes a
     * deliberate act rather than an omission.
     *
     * Off unless a token is configured. A default secret would be no secret,
     * and an internal API that is open until somebody remembers to close it is
     * the wrong way round.
     */
    internalHost: setting(environment, "INTERNAL_HOST") ?? defaults.internalHost ?? "127.0.0.1",
    internalPort: asInt(setting(environment, "INTERNAL_PORT"), defaults.internalPort ?? 8081),
    internalToken: setting(environment, "INTERNAL_TOKEN") ?? defaults.internalToken ?? "",

    /**
     * Where health and status are answered; see status.js. A listener of its
     * own because it has no credential: what protects it is the address it is
     * bound to, which is loopback unless the operator says otherwise. Port 0
     * turns it off.
     */
    statusHost: setting(environment, "STATUS_HOST") || defaults.statusHost || "127.0.0.1",
    statusPort: Math.max(0, asInt(setting(environment, "STATUS_PORT"), defaults.statusPort ?? 8082)),
    allowRemoteStatus:
      setting(environment, "ALLOW_REMOTE_STATUS") === undefined
        ? defaults.allowRemoteStatus === true
        : setting(environment, "ALLOW_REMOTE_STATUS") === "1",
    /**
     * What a caller presents to read the status routes, for watching the
     * server from another machine. Read-only by construction: nothing on that
     * listener changes anything, so this is not the internal token and must
     * not be the same value — that one acts for every account.
     */
    statusToken: setting(environment, "STATUS_TOKEN") ?? defaults.statusToken ?? "",

    /**
     * What the market keeps of a sale. A gold sink, and the thing that makes
     * moving gold through the market lossy — ten per cent compounds, so ten
     * hops leave two thirds.
     */
    marketTaxRate: Math.min(
      0.9,
      Math.max(0, Number(setting(environment, "MARKET_TAX_RATE") ?? defaults.marketTaxRate ?? 0.1))
    ),
    /**
     * How long a new listing waits before anybody else can see or buy it. The
     * seller's stall shows it counting down and it can be taken back down
     * meanwhile, so a wrong price is caught before somebody snaps it up.
     */
    marketListingDelaySeconds: Math.max(
      0,
      asInt(setting(environment, "MARKET_LISTING_DELAY_SECONDS"), defaults.marketListingDelaySeconds ?? 180)
    ),
    allowInsecureInternal:
      setting(environment, "ALLOW_INSECURE_INTERNAL") === undefined
        ? defaults.allowInsecureInternal === true
        : setting(environment, "ALLOW_INSECURE_INTERNAL") === "1",

    /**
     * Whether tokens are checked. Off accepts whatever a client claims to be,
     * which is only reasonable where nobody else can reach the machine.
     */
    authEnabled:
      setting(environment, "AUTH") === undefined
        ? defaults.authEnabled !== false
        : setting(environment, "AUTH") !== "0",

    /**
     * Whether the server brings its own database up to date at startup.
     *
     * db/schema.sql only ever adds — every statement in it is a CREATE or an
     * ADD COLUMN, both guarded by IF NOT EXISTS — so running it against a
     * database that is behind is safe and idempotent, and the alternative was
     * finding out from "column tax does not exist" mid-request. Off is for a
     * deployment where the application's database user has no business holding
     * DDL rights.
     */
    migrate:
      setting(environment, "MIGRATE") === undefined
        ? defaults.migrate !== false
        : setting(environment, "MIGRATE") !== "0",

    /**
     * Where to record this server's own traffic, in the client's own format.
     * Unset records nothing; the recordings hold account tokens and are not
     * something to write by default.
     */
    captureDir: setting(environment, "CAPTURE_DIR")
      ? configuredPath({ environmentValue: setting(environment, "CAPTURE_DIR"), defaultValue: null, configDir })
      : null,

    /** Fallback pursuit radius for custom NPC rows that omit AggroRadius. */
    npcAggroRadius: asInt(setting(environment, "NPC_AGGRO_RADIUS"), defaults.npcAggroRadius ?? 1800),

    /** Server-authoritative trap projectile simulation cadence. */
    projectileTickMs: asInt(
      setting(environment, "PROJECTILE_TICK_MS"),
      defaults.projectileTickMs ?? 20
    ),

    /**
     * Players in a node's open public runs at which the world map calls it
     * Active, Popular, Bustling and Rampaging (see game-status.js). Four
     * ascending counts; anything else falls back to the defaults.
     *
     *   ODS_ACTIVITY_THRESHOLDS=1,5,9,17
     */
    activityThresholds: activityThresholdsFrom(
      setting(environment, "ACTIVITY_THRESHOLDS") ?? defaults.activityThresholds
    ),

    /**
     * How often a running dungeon writes the accounts that changed, in
     * milliseconds; 0 for never. Gold and experience are written when a floor
     * or the run ends and when a player leaves or is dropped — this is for the
     * endings that cannot save on the way out, a worker dying or the process
     * being killed, and it is what bounds their loss. See `startRunCheckpoints`.
     */
    runCheckpointMs:
      Math.max(
        0,
        asInt(setting(environment, "RUN_CHECKPOINT_SECONDS"), defaults.runCheckpointSeconds ?? 30)
      ) * 1000,

    /** Production delay between dungeonEnding and DistributedDungeonSummary. */
    dungeonSummaryDelayMs: asInt(
      setting(environment, "DUNGEON_SUMMARY_DELAY_MS"),
      defaults.dungeonSummaryDelayMs
    ),

    /**
     * Standing still in a dungeon. The warning is the official server's: its
     * "Zzz..." marker (HeroGameObject field 167) came up 30 seconds after a
     * hero last moved, turned or attacked. Sending the player back to town is
     * this server's own rule. Zero turns either off.
     */
    afkWarnMs: Math.max(0, asInt(setting(environment, "AFK_WARN_MS"), defaults.afkWarnMs ?? 30000)),
    afkKickMs: Math.max(0, asInt(setting(environment, "AFK_KICK_MS"), defaults.afkKickMs ?? 60000)),

    /** How close the hero must get to collect a doober, in world units. */
    pickupRadius: asInt(setting(environment, "PICKUP_RADIUS"), defaults.pickupRadius),

    /** Truncation limit for logged request/response bodies. */
    logBodyLimit: asInt(setting(environment, "LOG_LIMIT"), defaults.logBodyLimit),

    /** Minimum terminal log level: info, warn, error or silent. */
    logLevel: String(setting(environment, "LOG_LEVEL") ?? defaults.logLevel ?? "info").toLowerCase(),

    /**
     * Threads that run whole matches, the main thread keeping sockets, login,
     * the MatchMaker and presence. Zero runs everything in one thread, which is
     * the default until the worker mode has been played on with the real
     * client. match-worker-pool.js and match-worker-thread.js describe it.
     */
    matchWorkerCount: asWorkerCount(
      setting(environment, "MATCH_WORKERS"),
      defaults.matchWorkerCount
    ),

    /**
     * How long a match worker's event loop may go without turning over before
     * it is taken to be stuck, stopped, and its players sent home. It answers
     * between tasks, so heavy work that yields never trips it; one synchronous
     * task this long has already frozen every dungeon on the worker.
     */
    matchWorkerHangMs: Math.max(
      1000,
      asInt(setting(environment, "MATCH_WORKER_HANG_MS"), defaults.matchWorkerHangMs ?? 5000)
    ),

    /** Hard per-socket cap for multiplayer broadcasts waiting in Node memory. */
    maxOutboundBufferBytes: Math.max(
      64 * 1024,
      asInt(
        setting(environment, "MAX_OUTBOUND_BUFFER_BYTES"),
        defaults.maxOutboundBufferBytes ?? 4 * 1024 * 1024
      )
    ),
  };
};

/**
 * `off | audit | enforce`, or the older boolean that meant the last of those.
 *
 * Anything unrecognised is `off`: a mode nobody spelled right should not decide
 * to start dropping traffic.
 */
const MODES = new Set(["off", "audit", "enforce"]);

/**
 * The named variable decides when it is present, whether or not it is spelled
 * right — the older flag is only consulted in its absence.
 *
 * The other way round, `DR_CAST_MODE=enfore` alongside a legacy
 * `DR_REQUIRE_CAST=1` fell through to `enforce`, so a typo left enforcement on
 * while its author believed they had just changed it. Someone reaching for the
 * new name is making a decision about that rule; a misspelling should cost them
 * the rule, not silently keep the old answer.
 */
const mode = (named, legacy) => {
  // Absent means absent. An empty value is someone having set it to nothing,
  // which is a decision about that rule and not a reason to consult the old flag.
  if (named === undefined) return legacy === "1" ? "enforce" : "off";
  const value = String(named).toLowerCase();
  if (MODES.has(value)) return value;
  invalidModes.push(named);
  return "off";
};

/** Reported once at startup rather than thrown: a typo should not fail to boot. */
export const invalidModes = [];

/** `[2001:db8::1]` as it is often written; kept bare, and bracketed where it goes into a URL. */
const unbracketed = (host) => {
  const text = String(host ?? "");
  return /^\[.*\]$/.test(text) && isIPv6(text.slice(1, -1)) ? text.slice(1, -1) : text;
};

/** An IPv6 literal goes into a URL in brackets, or its colons read as a port. */
const hostInUrl = (host) => (isIPv6(String(host)) ? `[${host}]` : host);

export const publicBaseUrlFor = (settings) =>
  `http://${hostInUrl(settings.publicHost)}:${settings.publicPort}`;

const LOOPBACK = /^(?:localhost|::1|127(?:\.\d{1,3}){3})$/i;
const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

/** The variable as the operator spelled it, public name before legacy. */
const spelled = (environment, name) => {
  for (const key of [`ODS_${name}`, `DR_${name}`]) {
    if (environment[key] !== undefined) return { key, value: String(environment[key]) };
  }
  return null;
};

/**
 * What is wrong with the settings, said instead of worked around.
 *
 * `loadServerConfig` is forgiving on purpose — a number that will not parse
 * becomes the default, a switch is compared with one spelling — and that keeps
 * it total for the tests and tools that only want a config object. It is the
 * wrong behaviour at startup. `ODS_STORAGE=postgresql` ran on files and gave
 * every player a fresh account; `ODS_PORT=abc` listened on 8080;
 * `ODS_STRICT=true` switched strictness *off*; and each of them started
 * cleanly, so the operator went on believing what they had written.
 *
 * `refusals` stop the server. `warnings` are settings that are allowed and
 * almost never meant.
 */
export const configProblems = (environment = process.env) => {
  const refusals = [];
  const warnings = [];
  const settings = loadServerConfig(environment);

  for (const name of ["PORT", "SOCKET_PORT", "INTERNAL_PORT", "PUBLIC_PORT", "PUBLIC_SOCKET_PORT"]) {
    const given = spelled(environment, name);
    // Assigned nothing is the default, as it always has been.
    if (!given || given.value === "") continue;
    const port = /^\d+$/.test(given.value) ? Number(given.value) : NaN;
    if (!(port >= 1 && port <= 65535)) {
      refusals.push(
        `${given.key} must be a port number between 1 and 65535, not ${JSON.stringify(given.value)}`
      );
    }
  }

  // Zero is allowed here and nowhere else: it is how the listener is turned off.
  const statusPort = spelled(environment, "STATUS_PORT");
  if (statusPort && statusPort.value !== "") {
    const port = /^\d+$/.test(statusPort.value) ? Number(statusPort.value) : NaN;
    if (!(port >= 0 && port <= 65535)) {
      refusals.push(
        `${statusPort.key} must be a port number, or 0 to turn the status listener off, ` +
          `not ${JSON.stringify(statusPort.value)}`
      );
    }
  }
  if (settings.statusToken && settings.statusToken.length < 32) {
    refusals.push(
      `${spelled(environment, "STATUS_TOKEN")?.key ?? "statusToken"} must be at least 32 characters ` +
        "(openssl rand -hex 32)"
    );
  }
  if (settings.statusToken && settings.statusToken === settings.internalToken) {
    refusals.push(
      "ODS_STATUS_TOKEN must not be the internal token: whoever watches the server would then hold every account"
    );
  }
  if (
    settings.statusPort > 0 &&
    !LOOPBACK.test(String(settings.statusHost)) &&
    !settings.allowRemoteStatus &&
    !settings.statusToken
  ) {
    refusals.push(
      `${spelled(environment, "STATUS_HOST")?.key ?? "statusHost"} is ${settings.statusHost}, which is not ` +
        "loopback, and the status listener has no authentication; keep it on loopback, set " +
        "ODS_STATUS_TOKEN so that callers must present it, or set ODS_ALLOW_REMOTE_STATUS=1 " +
        "where the network in front of it is the access control"
    );
  }

  if (settings.storage !== "file" && settings.storage !== "postgres") {
    refusals.push(
      `${spelled(environment, "STORAGE")?.key ?? "storage"} must be "file" or "postgres", ` +
        `not ${JSON.stringify(settings.storage)}`
    );
  }

  for (const name of [
    "AUTH",
    "MIGRATE",
    "DUNGEON",
    "STRICT",
    "ALLOW_INSECURE_REMOTE",
    "ALLOW_INSECURE_INTERNAL",
    "ALLOW_REMOTE_STATUS",
  ]) {
    const given = spelled(environment, name);
    if (given && given.value !== "" && given.value !== "0" && given.value !== "1") {
      refusals.push(`${given.key} must be 0 or 1, not ${JSON.stringify(given.value)}`);
    }
  }

  const admins = spelled(environment, "ADMIN_ACCOUNTS");
  if (admins && admins.value.trim()) {
    const entries = admins.value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!entries.every((entry) => /^\d+$/.test(entry) && Number(entry) > 0)) {
      refusals.push(
        `${admins.key} must be comma-separated account ids, not ${JSON.stringify(admins.value)}`
      );
    }
  }

  /** An address a client can be handed, or why not. */
  const hostProblem = (key, host) => {
    if (WILDCARD.has(host)) {
      return (
        `${key} is the address clients are told to connect to, and a client cannot connect to ` +
        `${host}; set it to this machine's address as the players reach it`
      );
    }
    if (!host || (!isIPv6(host) && /[\s/:]/.test(host))) {
      return (
        `${key} must be a host name or address only — no scheme, port or path — ` +
        `not ${JSON.stringify(host)}`
      );
    }
    return null;
  };

  const publicHost = String(settings.publicHost ?? "");
  const publicProblem = hostProblem(spelled(environment, "PUBLIC_HOST")?.key ?? "publicHost", publicHost);
  const socketHost = spelled(environment, "PUBLIC_SOCKET_HOST");
  const socketProblem =
    socketHost && socketHost.value ? hostProblem(socketHost.key, unbracketed(socketHost.value)) : null;
  if (socketProblem) refusals.push(socketProblem);
  if (publicProblem) {
    refusals.push(publicProblem);
  } else if (!LOOPBACK.test(String(settings.host)) && LOOPBACK.test(publicHost)) {
    warnings.push(
      `listening on ${settings.host} but advertising ${publicHost}: a client on another machine ` +
        "will be told to connect to itself. Set ODS_PUBLIC_HOST to this machine's address as " +
        "the players reach it"
    );
  }

  return { refusals, warnings };
};

export const config = loadServerConfig();

export const publicBaseUrl = () => publicBaseUrlFor(config);

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { readJsonFile } from "./json-file.js";
import { envSetting } from "./env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const defaultConfigFile = path.join(serverRoot, "config", "server.defaults.json");

const asInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Public ODS_* settings take precedence; DR_* remains a compatibility alias. */
const setting = (environment, name) => envSetting(name, environment);

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
    publicHost: setting(environment, "PUBLIC_HOST") ?? defaults.publicHost,

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
    reachMode: mode(setting(environment, "REACH_MODE"), setting(environment, "ENFORCE_REACH")),

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
        ? `http://${setting(environment, "PUBLIC_HOST") ?? defaults.publicHost}:${asInt(
            setting(environment, "PORT"),
            defaults.port
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
    permissive:
      setting(environment, "STRICT") === undefined
        ? defaults.permissive
        : setting(environment, "STRICT") !== "1",

    /**
     * Where accounts live: "file" keeps one JSON document per account, which
     * needs nothing installed; "postgres" uses the containerised database from
     * docker-compose.yml. File storage stays the default so the server runs on
     * a clean machine.
     */
    storage: setting(environment, "STORAGE") ?? defaults.storage,

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
     * Where to record this server's own traffic, in the client's own format.
     * Unset records nothing; the recordings hold account tokens and are not
     * something to write by default.
     */
    captureDir: setting(environment, "CAPTURE_DIR")
      ? configuredPath({ environmentValue: setting(environment, "CAPTURE_DIR"), defaultValue: null, configDir })
      : null,

    /** Minimum distance at which a moving enemy begins pursuing the hero. */
    npcAggroRadius: asInt(setting(environment, "NPC_AGGRO_RADIUS"), defaults.npcAggroRadius ?? 1800),

    /** Server-authoritative trap projectile simulation cadence. */
    projectileTickMs: asInt(
      setting(environment, "PROJECTILE_TICK_MS"),
      defaults.projectileTickMs ?? 20
    ),

    /** Production delay between dungeonEnding and DistributedDungeonSummary. */
    dungeonSummaryDelayMs: asInt(
      setting(environment, "DUNGEON_SUMMARY_DELAY_MS"),
      defaults.dungeonSummaryDelayMs
    ),

    /** How close the hero must get to collect a doober, in world units. */
    pickupRadius: asInt(setting(environment, "PICKUP_RADIUS"), defaults.pickupRadius),

    /** Truncation limit for logged request/response bodies. */
    logBodyLimit: asInt(setting(environment, "LOG_LIMIT"), defaults.logBodyLimit),

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

export const config = loadServerConfig();

export const publicBaseUrl = () => `http://${config.publicHost}:${config.port}`;

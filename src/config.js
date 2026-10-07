import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import { isIPv6 } from "node:net";
import { readJsonFile } from "./json-file.js";
import { envSetting } from "./env.js";
import { parseTrustedProxies } from "./forwarded.js";

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

/**
 * A number no lower than `least`; one that cannot be read is the fallback.
 * Unlike `asInt` it keeps a fraction, for the settings that are a share or a
 * part of an hour.
 */
const asAmount = (value, fallback, least = 0) => {
  const parsed = value === undefined || value === null || String(value).trim() === "" ? NaN : Number(value);
  return Number.isFinite(parsed) ? Math.max(least, parsed) : fallback;
};

/** A share of something: between none of it and all of it. */
const asShare = (value, fallback) => Math.min(1, asAmount(value, fallback));

const DEFAULT_DAILY_REWARD_TIERS = [5, 10, 15];

/**
 * Three amounts, from a list or "5,10,15"; the defaults otherwise. Three
 * because the reward screen has three labels and reads three numbers.
 */
const dailyRewardTiersOf = (value) => {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((entry) => (String(entry).trim() === "" ? NaN : Number(String(entry).trim())));
  const valid = list.length === 3 && list.every((entry) => Number.isSafeInteger(entry) && entry >= 0);
  return valid ? list : null;
};
const dailyRewardTiersFrom = (value) => dailyRewardTiersOf(value) ?? DEFAULT_DAILY_REWARD_TIERS;

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
  // Read once, here, because four settings below follow it. One that cannot be
  // used is left out; the startup checks refuse it by name.
  const { url: publicUrl } = readPublicUrl(setting(environment, "PUBLIC_URL") ?? defaults.publicUrl);
  const publicHost = publicUrl?.host ?? unbracketed(setting(environment, "PUBLIC_HOST") || defaults.publicHost);
  const publicPort =
    publicUrl?.port ?? asInt(setting(environment, "PUBLIC_PORT"), asInt(setting(environment, "PORT"), defaults.port));
  const publicScheme = publicUrl?.scheme ?? "http";

  return {
    /** Address the HTTP server binds to. */
    host: setting(environment, "HOST") ?? defaults.host,
    port: asInt(setting(environment, "PORT"), defaults.port),

    /**
     * Advertised over service discovery. Must be reachable *by the client*, so it
     * cannot be 0.0.0.0 even when we bind to it.
     *
     * `ODS_PUBLIC_URL` says all of it at once — `https://play.example.net` —
     * and is the only way to say https: a server behind a TLS proxy has to
     * hand out the proxy's address, or the browser client, on an https page,
     * refuses every call after discovery as mixed content. Otherwise the host
     * and port are given apart and the scheme is http.
     */
    publicScheme,
    publicHost,

    /**
     * The ports and socket host clients are told, where they differ from what
     * is bound: a router forwarding 9000 to 8080, or a tunnel that hands out a
     * host and port of its own for each listener. Advertising only — nothing
     * listens on these. Each defaults to its bound counterpart.
     *
     * Behind https the socket defaults to the proxy's port instead. The browser
     * opens `wss://` from an https page, which the game port does not speak, so
     * the proxy is the only place its socket can go; it hands WebSocket
     * upgrades on to the game port (see docs/operations.md).
     */
    publicPort,
    publicSocketHost: unbracketed(
      setting(environment, "PUBLIC_SOCKET_HOST") ||
        publicUrl?.host ||
        setting(environment, "PUBLIC_HOST") ||
        defaults.publicHost
    ),
    publicSocketPort: asInt(
      setting(environment, "PUBLIC_SOCKET_PORT"),
      publicScheme === "https" ? publicPort : asInt(setting(environment, "SOCKET_PORT"), defaults.gameSocketPort)
    ),

    /**
     * Where the desktop client's game socket is, when it cannot be where the
     * browser's is. The desktop client speaks plain TCP, which an https proxy
     * cannot carry, so behind one it needs a host that reaches the game port
     * directly — a DNS record the proxy does not front. It is told so by its
     * own discovery address, `/desktop/game-status/service-discovery`: a
     * desktop player's ServiceDiscoveryUrl is the public address plus
     * `/desktop` (routes.js). The port defaults to the one the game socket is
     * bound to. Unset, that address answers what the ordinary one does.
     */
    desktopSocketHost: setting(environment, "DESKTOP_SOCKET_HOST")
      ? unbracketed(setting(environment, "DESKTOP_SOCKET_HOST"))
      : null,
    desktopSocketPort: asInt(
      setting(environment, "DESKTOP_SOCKET_PORT"),
      asInt(setting(environment, "SOCKET_PORT"), defaults.gameSocketPort)
    ),

    /**
     * The proxies whose `X-Forwarded-For` is believed: addresses and ranges,
     * "127.0.0.1, ::1" for one on the same machine. Without them every player
     * behind a proxy is the proxy's address, and shares its limits. See
     * forwarded.js.
     */
    trustedProxies: listOf(setting(environment, "TRUSTED_PROXIES") ?? defaults.trustedProxies),

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
     *   ODS_WEB_CLIENT_DIR=/srv/web-client   then   http://host:8080/play/#code=…
     *
     * The code is a one-time one from the website's Play button, which the
     * page trades at POST /launch for a session token (launch-codes.js).
     */
    webClientDir: setting(environment, "WEB_CLIENT_DIR") ?? "",

    /**
     * Whether the browser client's files are for signed-in website visitors
     * only. On, /play/ answers its entry page to anybody and every other file
     * only to a browser holding the play pass that trading a Play link's code
     * hands out (play-pass.js). Off by default: a client opened by hand, with
     * no website in front, has no way to get one.
     */
    webClientGate: setting(environment, "WEB_CLIENT_GATE") === "1",

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
        ? `${publicBaseUrlFor({ publicScheme, publicHost, publicPort })}/content`
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
     * How long entry waits for the client to say it is ready for the floor
     * (`requestentry`) and then for its hero (`requesthero`), before going on
     * without it.
     *
     * Every real client sends both; the fallback is for tools that do not. It
     * was floorDelayMs, five seconds, and the browser client keeps its loading
     * screen up until the art the area asked for has downloaded — longer than
     * that on a home connection. The server then sent the hero before the
     * client had made its HUD, and the client crashed on it.
     */
    entryHandshakeMs: asInt(setting(environment, "ENTRY_HANDSHAKE_MS"), defaults.entryHandshakeMs ?? 120_000),

    /**
     * Modes of a deployment's own, beside the shipped ones: module paths (or
     * file: URLs), comma-separated in ODS_MODES, relative to the working
     * directory. Each thread imports them as it starts its modes, so a mode
     * registers on the main thread and in every match worker alike; a module
     * default-exports `{ name, together, start }` or calls registerMode itself
     * (src/modes/README.md, "Where it runs").
     */
    modes: (setting(environment, "MODES") ?? (Array.isArray(defaults.modes) ? defaults.modes.join(",") : ""))
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),

    /** One-life runs (src/modes/one-life). Off unless asked for: ODS_ONELIFE=1. */
    oneLife: {
      enabled:
        setting(environment, "ONELIFE") === undefined
          ? Boolean(defaults.oneLife?.enabled)
          : setting(environment, "ONELIFE") === "1",
    },

    /**
     * Ranked races (docs/ranked.md). Off unless asked for: ODS_RANKED=1. The
     * rest has the defaults the design settled on; the lobby node must be one
     * the stock client's own game data has, and the lobby floor one of its own
     * tile files, or the client cannot build them.
     */
    ranked: {
      enabled:
        setting(environment, "RANKED") === undefined
          ? Boolean(defaults.ranked?.enabled)
          : setting(environment, "RANKED") === "1",
      lobbyNode: asInt(setting(environment, "RANKED_LOBBY_NODE"), defaults.ranked?.lobbyNode ?? 50003),
      lobbyFloor: setting(environment, "RANKED_LOBBY_FLOOR") ??
        defaults.ranked?.lobbyFloor ?? "castle/arena/db_floor_TUTORIAL_LEVEL_final.json",
      nodeTypes: defaults.ranked?.nodeTypes ?? ["DUNGEON"],
      exclude: defaults.ranked?.exclude ?? [],
      countdownMs: asInt(setting(environment, "RANKED_COUNTDOWN_MS"), defaults.ranked?.countdownMs ?? 5_000),
      lobbyIdleMs: asInt(setting(environment, "RANKED_LOBBY_IDLE_MS"), defaults.ranked?.lobbyIdleMs ?? 300_000),
      maxDurationMs: asInt(setting(environment, "RANKED_MAX_DURATION_MS"), defaults.ranked?.maxDurationMs ?? 1_800_000),
      forfeitWindowMs: asInt(setting(environment, "RANKED_FORFEIT_WINDOW_MS"), defaults.ranked?.forfeitWindowMs ?? 120_000),
      drawWindowMs: asInt(setting(environment, "RANKED_DRAW_WINDOW_MS"), defaults.ranked?.drawWindowMs ?? 5_000),
      loadTimeoutMs: asInt(setting(environment, "RANKED_LOAD_TIMEOUT_MS"), defaults.ranked?.loadTimeoutMs ?? 120_000),
      /**
       * Where in the lobby standing means waiting for a race, in floor
       * coordinates; outside it are the stands, for talking. Its edge is drawn
       * in skull piles (ranked/stock-client/ring.js). Belongs to the lobby
       * floor: the default is a square around the tutorial arena's pillar,
       * so another lobby floor needs its own, or null for "anywhere is the
       * ring" and no piles.
       */
      ring: defaults.ranked?.ring === undefined ? { x0: 3830, y0: 3653, x1: 4270, y1: 4093 } : defaults.ranked.ring,
      /**
       * Where heroes arrive in the lobby: outside the ring, or arriving would
       * be queueing. The default is between the ring's way in and the arena's
       * south gate. Null keeps the floor's own spawn.
       */
      lobbySpawn: defaults.ranked?.lobbySpawn === undefined ? { x: 4050, y: 4200 } : defaults.ranked.lobbySpawn,
      /**
       * Tiles of the lobby floor's own library to stand in place of the file's,
       * `[{ x, y, tileId }]` (floors.js, loadFloor). The default puts the
       * arena's two forest fillers on every neighbour but the north one, whose
       * lower half is the arena's own gate yard; empty keeps the file's.
       */
      lobbyTiles: defaults.ranked?.lobbyTiles ?? [],
      /**
       * The leagues, `[{ name, from, color }]` in rising order (ranked/leagues.js):
       * labels over bands of the rating, the first where everybody starts.
       * Unset, the defaults there — MCSR Ranked's bands, named for the game's
       * chest tiers.
       */
      leagues: defaults.ranked?.leagues ?? null,
      /**
       * How many of the others waiting each lobby shows, as nameless copies of
       * their heroes (ranked/stock-client/copies.js); the first to arrive
       * first. 0 shows nobody: every lobby is its own world again.
       */
      lobbyCopies: Math.max(0, asInt(setting(environment, "RANKED_LOBBY_COPIES"), defaults.ranked?.lobbyCopies ?? 8)),
      /**
       * The rival's ghost in a race (ranked/stock-client/adapter.js): drawn
       * with one of the game's buffs as a shade (`buff`, a Buff constant;
       * SHADOW_SLOW is a dark, pulsing one), under `name`, and shown to whoever
       * entered the room first, for `showMs` after the other came in; two
       * entering within `graceMs` see nothing of each other. Null draws no
       * ghost.
       */
      raceGhost:
        defaults.ranked?.raceGhost === undefined
          ? { buff: "SHADOW_SLOW", name: "RIVAL", graceMs: 2000, showMs: 3000 }
          : defaults.ranked.raceGhost,
      /** Whether the two racers hear each other's chat. */
      raceChat: defaults.ranked?.raceChat !== false,
      /**
       * Who may enter ranked: a least level for the active hero, and the
       * tutorial done. Both off by default — the bar an operator raises when
       * throwaway accounts start trading wins.
       */
      entry: {
        minHeroLevel: Math.max(0, asInt(setting(environment, "RANKED_MIN_HERO_LEVEL"), defaults.ranked?.entry?.minHeroLevel ?? 0)),
        requireTutorial:
          setting(environment, "RANKED_REQUIRE_TUTORIAL") === undefined
            ? defaults.ranked?.entry?.requireTutorial === true
            : setting(environment, "RANKED_REQUIRE_TUTORIAL") === "1",
      },
      /**
       * What a race pays, as a gift from MATCHMAKER waiting in town: an offer
       * id (`Offers` in the game data — 51101 is 1000 coins, 51102 3500, 51103
       * 8000) per league name, `"*"` for the rest, under `win` and `loss`.
       * Null pays nothing. The run itself pays no experience or chest
       * (`src/socket/run-rules.js`); this is the prize, and the only reward a
       * loser gets, so it is small.
       */
      rewards:
        defaults.ranked?.rewards === undefined
          ? { win: { "*": 51101, Gold: 51102, Dragon: 51103 }, loss: { "*": 51101 } }
          : defaults.ranked.rewards,
      /**
       * The rating scale (ranked/rating.js): where everybody starts, the most
       * one race moves a rating, and the least anybody falls to. The leagues'
       * edges go with it.
       */
      rating: {
        start: asInt(setting(environment, "RANKED_RATING_START"), defaults.ranked?.rating?.start ?? 1000),
        k: asInt(setting(environment, "RANKED_RATING_K"), defaults.ranked?.rating?.k ?? 40),
        floor: asInt(setting(environment, "RANKED_RATING_FLOOR"), defaults.ranked?.rating?.floor ?? 100),
      },
    },

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
    /**
     * The market's limits on what one account can do (see market-rules.js for
     * why each exists): listings an account may have up per hero it owns, the
     * most a weapon may be asked for as a multiple of what the shop would pay,
     * and the least that ceiling is ever allowed to be.
     */
    marketSlotsPerHero: Math.max(
      1,
      asInt(setting(environment, "MARKET_SLOTS_PER_HERO"), defaults.marketSlotsPerHero ?? 5)
    ),
    marketPriceCeilingMultiple: asAmount(
      setting(environment, "MARKET_PRICE_CEILING_MULTIPLE") ?? defaults.marketPriceCeilingMultiple,
      50,
      1
    ),
    marketMinCeiling: Math.max(
      0,
      asInt(setting(environment, "MARKET_MIN_CEILING"), defaults.marketMinCeiling ?? 1000)
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
     * Gems paid with a boss trophy, the first time that boss is beaten. The
     * official paid twenty-five; no table authors it, so it is set here.
     */
    trophyGems: Math.max(0, asInt(setting(environment, "TROPHY_GEMS"), defaults.trophyGems ?? 25)),

    /**
     * The Infinite dungeon floors that pay the trophy and the gems. The game's
     * table authors its own (`TrophyFloor` 25, `GemFloor` 20); these are what
     * the game is remembered paying on, and 0 hands a floor back to the table.
     */
    infiniteTrophyFloor: Math.max(
      0,
      asInt(setting(environment, "INFINITE_TROPHY_FLOOR"), defaults.infiniteTrophyFloor ?? 16)
    ),
    infiniteGemFloor: Math.max(
      0,
      asInt(setting(environment, "INFINITE_GEM_FLOOR"), defaults.infiniteGemFloor ?? 25)
    ),

    /**
     * What a day's login pays in gems on the first, second and third day of a
     * streak — multiplied by the heroes on the account — and what spinning the
     * boxes again costs. Neither is in the game's tables; the client shows the
     * numbers it is sent.
     */
    dailyRewardTiers: dailyRewardTiersFrom(
      setting(environment, "DAILY_REWARD_TIERS") ?? defaults.dailyRewardTiers
    ),
    dailyReplayCost: Math.max(
      0,
      asInt(setting(environment, "DAILY_REPLAY_COST"), defaults.dailyReplayCost ?? 5)
    ),

    /** How long before the same friend can be sent another gift, in hours. */
    giftCooldownHours: asAmount(
      setting(environment, "GIFT_COOLDOWN_HOURS") ?? defaults.giftCooldownHours,
      24
    ),

    /**
     * How often one account may speak on the global channel: so many lines at
     * once, then one every so many seconds.
     */
    globalChatBurst: Math.max(
      1,
      asInt(setting(environment, "GLOBAL_CHAT_BURST"), defaults.globalChatBurst ?? 3)
    ),
    globalChatLineSeconds: asAmount(
      setting(environment, "GLOBAL_CHAT_LINE_SECONDS") ?? defaults.globalChatLineSeconds,
      2,
      0.1
    ),

    /** The share of its health and Mana a hero stands back up with from a Health Bomb. */
    healthBombReviveShare: asShare(
      setting(environment, "HEALTH_BOMB_REVIVE_SHARE") ?? defaults.healthBombReviveShare,
      0.4
    ),

    /**
     * When food is worth walking over (see pickups.js): the share of what a
     * piece offers that the hero must be able to use, and the size — as a share
     * of the bar — at or under which a piece is a scrap and taken whenever
     * anything at all is missing.
     */
    pickupUsableShare: asShare(
      setting(environment, "PICKUP_USABLE_SHARE") ?? defaults.pickupUsableShare,
      0.5
    ),
    pickupScrapShare: asShare(
      setting(environment, "PICKUP_SCRAP_SHARE") ?? defaults.pickupScrapShare,
      0.25
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

const DEFAULT_PORTS = { http: 80, https: 443 };

/** The address clients are given for the web services; a scheme's own port is left unsaid. */
export const publicBaseUrlFor = (settings) => {
  const scheme = settings.publicScheme ?? "http";
  const port = Number(settings.publicPort) === DEFAULT_PORTS[scheme] ? "" : `:${settings.publicPort}`;
  return `${scheme}://${hostInUrl(settings.publicHost)}${port}`;
};

/** "a, b" or a list, as its non-empty entries. */
const listOf = (value) =>
  (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean);

/**
 * `ODS_PUBLIC_URL` as a scheme, host and port, or why it cannot be one.
 *
 * Only an address: the client builds `/rpc/`, `/api/` and the rest onto it
 * itself, so a path would be one the server does not answer under.
 */
const readPublicUrl = (value) => {
  const given = String(value ?? "").trim();
  if (!given) return { url: null, problem: null };
  let parsed;
  try {
    parsed = new URL(given);
  } catch {
    return { url: null, problem: "must be an address such as https://play.example.net" };
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (!(scheme in DEFAULT_PORTS)) return { url: null, problem: "must start with http:// or https://" };
  if (parsed.username || parsed.password) {
    return { url: null, problem: "must not carry a user name or password" };
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return { url: null, problem: "must be the address alone, with no path or query: the client adds its own" };
  }
  const host = unbracketed(parsed.hostname);
  if (WILDCARD.has(host)) {
    return { url: null, problem: `is the address clients are told to connect to, and a client cannot connect to ${host}` };
  }
  return { url: { scheme, host, port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS[scheme] }, problem: null };
};

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

  for (const name of ["PORT", "SOCKET_PORT", "INTERNAL_PORT", "PUBLIC_PORT", "PUBLIC_SOCKET_PORT", "DESKTOP_SOCKET_PORT"]) {
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

  const publicUrl = spelled(environment, "PUBLIC_URL");
  if (publicUrl && publicUrl.value.trim()) {
    const { problem } = readPublicUrl(publicUrl.value);
    if (problem) refusals.push(`${publicUrl.key} ${problem}, not ${JSON.stringify(publicUrl.value)}`);
    // Two settings for one address can only disagree.
    for (const name of ["PUBLIC_HOST", "PUBLIC_PORT"]) {
      const other = spelled(environment, name);
      if (other && other.value !== "") {
        refusals.push(
          `${publicUrl.key} replaces ${other.key}; set one or the other, not both`
        );
      }
    }
  }

  const proxies = spelled(environment, "TRUSTED_PROXIES");
  const unreadable = parseTrustedProxies(settings.trustedProxies).invalid;
  if (unreadable.length) {
    refusals.push(
      `${proxies?.key ?? "trustedProxies"} must be addresses or ranges such as 127.0.0.1 or 10.0.0.0/8; ` +
        `cannot read ${unreadable.map((entry) => JSON.stringify(entry)).join(", ")}`
    );
  }
  if (settings.publicScheme === "https" && settings.trustedProxies.length === 0) {
    warnings.push(
      "advertising https, so a proxy is in front, but ODS_TRUSTED_PROXIES is empty: every player " +
        "will count as the proxy's address and share its limits. Name the proxy, e.g. " +
        "ODS_TRUSTED_PROXIES=127.0.0.1,::1"
    );
  }

  const publicHost = String(settings.publicHost ?? "");
  const publicProblem = hostProblem(spelled(environment, "PUBLIC_HOST")?.key ?? "publicHost", publicHost);
  for (const name of ["PUBLIC_SOCKET_HOST", "DESKTOP_SOCKET_HOST"]) {
    const socketHost = spelled(environment, name);
    const socketProblem =
      socketHost && socketHost.value ? hostProblem(socketHost.key, unbracketed(socketHost.value)) : null;
    if (socketProblem) refusals.push(socketProblem);
  }
  if (publicProblem) {
    refusals.push(publicProblem);
  } else if (!LOOPBACK.test(String(settings.host)) && LOOPBACK.test(publicHost)) {
    warnings.push(
      `listening on ${settings.host} but advertising ${publicHost}: a client on another machine ` +
        "will be told to connect to itself. Set ODS_PUBLIC_HOST to this machine's address as " +
        "the players reach it"
    );
  }

  const tiers = spelled(environment, "DAILY_REWARD_TIERS");
  if (tiers && tiers.value !== "" && !dailyRewardTiersOf(tiers.value)) {
    warnings.push(
      `${tiers.key} must be three amounts such as 5,10,15, not ${JSON.stringify(tiers.value)}: ` +
        `the daily reward stays at ${settings.dailyRewardTiers.join(",")}`
    );
  }

  return { refusals, warnings };
};

export const config = loadServerConfig();

export const publicBaseUrl = () => publicBaseUrlFor(config);

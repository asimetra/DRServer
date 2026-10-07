/**
 * The stock-client adapter (docs/ranked.md, "The stock-client adapter").
 *
 * Everything here exists because the stock client cannot be changed:
 *
 *   entry   — JOIN on MATCHMAKER becomes a private run of the lobby node whose
 *             first floor is a quiet lobby; standing on it is being queued;
 *   notices — the effect book's banners and chat lines (ui-effects.json), or,
 *             for a client that shows them itself, the notices as data;
 *   start   — the race's floors are added to both runs and both lobby floors
 *             end at once, so each client moves on through its own floor
 *             transition into the race.
 *
 * It drives the core through its ports and the dungeon runtime through the
 * hooks in ../hooks.js; what it needs of the runtime is handed in, so it can be
 * tested without a socket.
 */
import { SYSTEM_FRIEND_ID, matchmakerName } from "./system-friend.js";
import { friendDoorHooks } from "../../friend-door.js";
import { insideRing, ringMarkers, ringSpot } from "./ring.js";
import { createLobbyCopies } from "../../copies.js";
import { TILE_SIZE } from "../../game-data.js";
import { placeLine, shownRating } from "../standing.js";
import { leagueAt, leagueRank, leaguesOf } from "../leagues.js";
import { runRules } from "../../run-rules.js";
import { runControls } from "../../runtime.js";
import { RANKED_MODE } from "../hooks.js";
import { warn } from "../../../log.js";

/**
 * What a ranked run pays and counts for (socket/run-rules.js). Gold and the
 * loot on the floor are kept, since they are what the floor gives anybody on
 * it; experience is not, nor chests, nor a first clear's keys, trophy and gems:
 * the dungeon is drawn, not chosen, and may be one this hero could not enter —
 * paid in full, ranked would be the way to farm the end of the map from level
 * one, losing on purpose. A race marks no node done, stands on no run board,
 * and takes nobody in.
 */
export const RANKED_RUN_RULES = runRules({
  mode: "ranked",
  // The lobby is open to every hero: the race is drawn, not chosen.
  unlockCheck: false,
  pays: { experience: false, chests: false, keys: false, trophies: false, gems: false },
  mapCredit: false,
  rankable: false,
  joinable: false,
  // A race moves two runs on together: they have to share a thread.
  together: true,
});

/**
 * A client that declares this shows ranked notices itself: it is kept them as
 * data, for `ranked/Status` (docs/ranked.md, "The modded-client adapter"), and
 * drawn nothing.
 */
export const SHOWS_NOTICES = "ranked.notices@1";
const NOTICES_KEPT = 32;

/**
 * A notice as the effect book names it (modes/effects.js): ranked's, and a
 * finish in the kind of its result — "VICTORY" and "DEFEAT" are not the same
 * moment.
 */
const booked = (notice) => ({
  mode: RANKED_MODE,
  ...notice,
  ...(notice.type === "finished" ? { variant: notice.result ?? "unknown" } : {}),
});

/** Wording when nobody hands any in: no lines, no parts. */
const NO_WORDS = Object.freeze({ line: () => null, part: () => "" });

const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/** "3:12.4": a race is under half an hour, and a tenth tells two close ones apart. */
const raceClock = (ms) => {
  const tenths = Math.round(ms / 100);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
};

/**
 * The hooks that answer where the connections are: entry, the friend list,
 * logging in. With match workers on they are all the main thread has of ranked
 * (../setup.js), and `waiting` is the count the ranked worker reports.
 */
export const stockClientEntryHooks = ({
  settings,
  waiting,
  tellPresence = () => {},
  joining = () => {},
  // What the gate asks of an account (setup.js): the active hero's level, and whether the tutorial is done.
  heroLevelOf = async () => Infinity,
  tutorialDoneFor = () => true,
}) => ({
  /**
   * MATCHMAKER, ranked's friend door (modes/friend-door.js): first on every
   * list with how many are waiting in its name, online and in a dungeon so
   * the client draws JOIN beside it, and JOIN on it a private run of the lobby
   * node, marked ranked wherever it is run.
   */
  ...friendDoorHooks({
    id: SYSTEM_FRIEND_ID,
    name: () => matchmakerName(waiting()),
    where: settings.lobbyNode,
    tellPresence,
    entry: (connection, request) => {
      joining(Number(connection?.accountId));
      return { ...request, mapNodeId: settings.lobbyNode, friendId: 0, mapId: 0, friendOnly: 1, mode: "ranked" };
    },
  }),

  /**
   * Who may enter ranked (settings.entry): a least hero level, the tutorial
   * done. Both off by default; an operator raises the bar when throwaway
   * accounts start to show. Refused, the client shows its own "not yet" popup.
   */
  async entryAllowed(account) {
    const entry = settings.entry ?? {};
    if (entry.minHeroLevel > 0) {
      const level = await heroLevelOf(account);
      if (!(level >= entry.minHeroLevel)) return { ok: false, reason: `hero level ${level} is under ${entry.minHeroLevel}` };
    }
    // Asked of the account's game data, which may be read from disk: awaited,
    // or a promise — always truthy — would pass everybody.
    if (entry.requireTutorial && !(await tutorialDoneFor(account))) return { ok: false, reason: "the tutorial is not done" };
    return { ok: true };
  },

  /**
   * The rules a ranked run plays by, known on every thread: the main thread
   * admits the entry (the unlock check), answers who may follow a player in,
   * and picks the worker (together) before any run exists.
   */
  modeRules: (mode) => (mode === "ranked" ? RANKED_RUN_RULES : null),
});

export const createStockClientAdapter = ({
  service,
  settings,
  sessionOf,
  // The run's context (modes/runtime.js): a player whose connection is closing
  // as this runs has none, and is null — the sweep walks every player each
  // second, and one closing must not cost the rest it.
  contextOf = runControls.contextOf,
  say,
  show = () => {},
  victory = () => {},
  defeat = () => {},
  sendHome = () => {},
  relay = () => {},
  snapshot = () => null,
  tellPresence = () => {},
  raceFloors,
  completeFloor,
  nameOf = async (accountId) => String(accountId),
  // The chat wording, `{ line(notice, params), part(name, params) }` — the effect book's.
  words = NO_WORDS,
  // How lobby copies are drawn (modes/copies.js, COPY_FRAMES); none, no copies.
  copyFrames = null,
  // A prize left waiting in town (modes/runtime.js, gift).
  gift = runControls.gift,
  // Whether a player's client declared a capability (modes/runtime.js, declares).
  declares = runControls.declares,
  clock = Date.now,
  heroLevelOf,
  tutorialDoneFor,
}) => {
  /**
   * accountId -> { phase: "lobby" | "race", queued, idle, idleSince, retryAt,
   * releasing, startedNoted, inRing, arriving, raceId, rival, over, outcome,
   * ended }. `arriving`: re-lobbied and between floors, unready until the new
   * floor stands. `crossed`: over the line, waiting on the rival's clock.
   * `rivalSeen`: the ghost has been shown once this race.
   * `over`: the race no longer waits on this run; `ended`: the run's own ending
   * is on screen, whether the game's (finished, failed) or one this adapter gave
   * it (endRun).
   */
  const players = new Map();
  /** "race:account" -> { rating, ratingChange }: what a race did to each, for the report. */
  const results = new Map();
  /** "race:account" -> that racer's report row as the race began: their build, for a rival who has gone. */
  const snapshots = new Map();
  const RESULTS_KEPT = 256;
  const keep = (map, key, value) => {
    map.set(key, value);
    if (map.size > RESULTS_KEPT) map.delete(map.keys().next().value);
  };
  /**
   * Accounts that pressed JOIN, until their run is planned — or, for an entry
   * refused before it was, until the sweep lets the mark go (JOINING_FOR_MS).
   */
  const joining = new Map();
  const JOINING_FOR_MS = 60_000;

  const idOf = (session) => Number(session?.accountId);
  /**
   * The ranked player a hook's session is, if its run is ranked. By the run's
   * own mark where the runtime set one (session.modeEntry): an entry left in
   * `players` by a run that ended unseen must never make an ordinary run of the
   * same account ranked — its rules, its floors held as a lobby's. A session
   * with no mark at all (a test's plain object) is looked up by account.
   */
  const rankedPlayer = (session) => {
    const mode = session?.modeEntry;
    if (mode !== undefined && mode !== "ranked") return null;
    return players.get(idOf(session)) ?? null;
  };
  /** The leagues a rating is named by (leagues.js); checked once, here. */
  const leagues = leaguesOf(settings.leagues);
  /** Where somebody stands on the board now, which the top league is a share of. */
  const placeOn = (accountId) => {
    const board = service.board();
    const index = board.findIndex((row) => Number(row.accountId) === Number(accountId));
    return { place: index >= 0 ? index + 1 : null, of: board.length };
  };

  /** The league somebody is in now, by rating and place. */
  const leagueOf = (accountId) => {
    const board = service.board();
    const index = board.findIndex((row) => Number(row.accountId) === Number(accountId));
    const rating = index >= 0 ? board[index].rating : service.statusOf(accountId).rating.rating;
    return leagueAt({ rating, place: index >= 0 ? index + 1 : null, of: board.length }, leagues);
  };
  /**
   * The others waiting, shown in each lobby as copies (copies.js); `lobbyCopies`
   * at most. A copy has no name — but a league with a `mark` puts that on its
   * tag, and the client colours it (leagues.js): who in the ring is Dragon or
   * Gold is seen at a glance, and nobody is named.
   */
  const copies =
    copyFrames && settings.lobbyCopies > 0
      ? createLobbyCopies({
        most: settings.lobbyCopies,
        sessionOf,
        contextOf,
        frames: copyFrames,
        name: (accountId) => leagueOf(accountId).mark ?? "",
      })
      : null;
  /**
   * The start's zoom. `ranked.started` in the book may zoom the camera in;
   * the client takes a floor zoom as the new default and never comes back on
   * its own, so `SETTLE_MS` after the start a second event (`started_settle`,
   * "reset" in the book) brings it home. Played from the sweep, so a second
   * or so late — the tween in takes a second itself.
   */
  const SETTLE_MS = 1500;
  const settles = new Map();
  /**
   * The race ghost (docs/ranked.md, "The race ghost"): the rival's copy in a
   * racer's own run, drawn as a shade. Whoever enters a room first is shown
   * whoever follows them into it; the one following is shown nobody — so
   * nobody can tail the leader through the doors — and two who enter together
   * (within `graceMs`) are shown nothing of each other. And the one shown is
   * shown for a moment, not for as long as the follower stands there: `showMs`
   * after the follower came in the ghost goes, and comes back in the next room
   * they follow into. "Somebody is on your heels" is the information; where
   * exactly they stand, second by second, was an advantage to the leader that
   * nobody asked for (decided 2026-10-05). A racer who has crossed the line is
   * shown the rival wherever they are on that floor: the wait for the rival's
   * clock becomes watching their last stretch.
   */
  const ghost = settings.raceGhost ?? null;
  const GRACE_MS = ghost?.graceMs ?? 2000;
  /** How long the follower's ghost stays once shown; nothing or 0 keeps it as long as they stay. */
  const SHOW_MS = Number(ghost?.showMs) > 0 ? Number(ghost.showMs) : Infinity;
  /** accountId -> { floorIndex, tile, enteredAt }: the room a racer is in and since when. */
  const rooms = new Map();
  const noteRoom = (accountId, session, position) => {
    const floorIndex = session.floorIndex ?? 0;
    const tile = `${Math.floor(position.x / TILE_SIZE)},${Math.floor(position.y / TILE_SIZE)}`;
    const room = rooms.get(accountId);
    if (room && room.floorIndex === floorIndex && room.tile === tile) return;
    rooms.set(accountId, { floorIndex, tile, enteredAt: clock() });
  };
  const ghostVisible = (viewer, subject) => {
    const me = players.get(viewer);
    const them = players.get(subject);
    if (me?.phase !== "race" || them?.phase !== "race" || me.rival !== subject || me.raceId !== them.raceId) return false;
    const mine = rooms.get(viewer);
    const theirs = rooms.get(subject);
    if (!mine || !theirs || mine.floorIndex !== theirs.floorIndex) return false;
    if (me.crossed) return true;
    const late = theirs.enteredAt - mine.enteredAt;
    return mine.tile === theirs.tile && late > GRACE_MS && clock() - theirs.enteredAt <= SHOW_MS;
  };
  const ghosts =
    copyFrames && ghost
      ? createLobbyCopies({
        most: 1,
        sessionOf,
        contextOf,
        frames: copyFrames,
        visibleTo: ghostVisible,
        name: ghost.name ?? "RIVAL",
        buff: ghost.buff ?? null,
        // Said once a race: the first time the rival is on their heels.
        onShown: (viewer) => {
          const player = players.get(viewer);
          if (!player || player.rivalSeen) return;
          player.rivalSeen = true;
          present(viewer, { type: "rival_seen" });
        },
      })
      : null;

  /** A player's hero did something its copies — in the lobbies, or the rival's ghost — do too. */
  const mirrored = (what) => (session, value) => {
    const accountId = idOf(session);
    const phase = rankedPlayer(session)?.phase;
    if (phase === "lobby") copies?.[what](accountId, value);
    else if (phase === "race") {
      if (what === "moved") noteRoom(accountId, session, value);
      ghosts?.[what](accountId, value);
    }
  };

  /** A line as the book wrote it, to this player alone. */
  const sayLine = (accountId, text) => {
    const session = sessionOf(accountId);
    if (session && text) say(contextOf(session), text);
  };

  const enqueue = (accountId, player) => {
    const answer = service.join(accountId);
    if (answer.ok) {
      player.queued = true;
      service.ready(accountId, !player.idle);
      return;
    }
    player.retryAt = answer.until ?? clock() + 5000;
    if (answer.reason === "cooldown") {
      present(accountId, { type: "cooldown", seconds: Math.ceil((answer.until - clock()) / 1000) });
    }
  };

  /**
   * Whether a lobby player stands in the ring (settings.ring): there, waiting
   * is being queued; outside it, in the stands, they wait and talk without
   * being drawn. No ring set: everywhere is the ring. No position yet, null:
   * the runtime asks for the hero before it puts it down, so arriving is not
   * yet anywhere, and the sweep decides once the hero stands somewhere.
   */
  /**
   * A lobby floor: the ring drawn in skulls, and the hero put down at `spawn` —
   * outside the ring on arrival, since walking in is joining the queue.
   */
  const lobbyFloor = (spawn = settings.lobbySpawn) => ({
    authored: settings.lobbyFloor,
    // The arena's neighbours as forest rather than bare sand (lobbyTiles).
    ...(settings.lobbyTiles?.length ? { retile: settings.lobbyTiles } : {}),
    quiet: { npc: ringMarkers(settings.ring), ...(spawn ? { spawn } : {}) },
  });

  const inRingNow = (session) => {
    const ring = settings.ring;
    if (!ring) return true;
    const at = contextOf(session)?.heroPosition;
    return at ? insideRing(ring, at) : null;
  };

  /**
   * A line said in a ranked lobby reaches everybody else waiting in one. Each
   * lobby is a private world with nobody else in it, and the stands are for
   * talking; a racer is not interrupted by it.
   */
  const said = (session, line) => {
    const accountId = idOf(session);
    const player = rankedPlayer(session);
    const listeners = [];
    if (player?.phase === "lobby") {
      for (const [id, other] of players) {
        if (id === accountId || other.phase !== "lobby") continue;
        const listener = sessionOf(id);
        if (listener) listeners.push(listener);
      }
    } else if (player?.phase === "race" && settings.raceChat !== false && player.rival) {
      // Racing, a line reaches the rival alone: the two of them, and nobody else.
      const them = players.get(player.rival);
      const listener = them?.phase === "race" && them.raceId === player.raceId ? sessionOf(player.rival) : null;
      if (listener) listeners.push(listener);
    }
    const speaker = listeners.length ? contextOf(session) : null;
    if (speaker) relay(speaker, line, listeners);
  };

  const hooks = {
    ...stockClientEntryHooks({
      settings,
      waiting: () => service.queue.counts().waiting,
      tellPresence,
      joining: (accountId) => joining.set(accountId, clock()),
      heroLevelOf,
      tutorialDoneFor,
    }),

    /** `/draw`: a racer asks to call the race off (race.js, offerDraw). */
    drawOffered(session) {
      const accountId = idOf(session);
      if (rankedPlayer(session)?.phase !== "race") return false;
      service.runEvent(accountId, "draw");
      return true;
    },

    /**
     * The run of an entry in the ranked mode is a lobby. The mode rides the
     * request to whichever thread runs the match (match-runtime.js,
     * `session.modeEntry`), so this needs no word from the thread that routed
     * it; `joining` is the same thing said here, for a caller that never marks
     * the session. The mark wins where there is one: an entry routed and then
     * refused (a transition under way, admission failing) leaves its id in
     * `joining`, and the player's next ordinary entry must not read that as
     * its own.
     */
    async planFor(session, mapNodeId) {
      const accountId = idOf(session);
      const mode = session.modeEntry !== undefined ? session.modeEntry : joining.has(accountId) ? "ranked" : null;
      joining.delete(accountId);
      if (mode !== "ranked" || Number(mapNodeId) !== settings.lobbyNode) return null;
      players.set(accountId, { phase: "lobby", queued: false, idle: false });
      return {
        floors: [lobbyFloor()],
        // The area preloads the lobby's art only; the race is drawn later.
        preloadArtFloors: 1,
        /**
         * Every tile library a race could be laid out from. The client reads a
         * floor's library out of what its area preloaded, synchronously, and
         * crashes building a floor whose library is not there — and the race
         * is drawn after this area is built. Tile files are small; the art,
         * which is not, stays the lobby's.
         */
        preloadTileLibraries: settings.raceTileLibraries ?? [],
      };
    },

    runRules: (session) => (rankedPlayer(session) ? RANKED_RUN_RULES : null),
    modeRules: (mode) => (mode === "ranked" ? RANKED_RUN_RULES : null),
    idlingAllowed: (session) => rankedPlayer(session)?.phase === "lobby",

    heroRequested(session) {
      const accountId = idOf(session);
      const player = rankedPlayer(session);
      if (!player) return;
      const floorIndex = session.floorIndex ?? 0;
      // A lobby floor built and its hero asked for: the others can stand on it now.
      if (player.phase === "lobby") copies?.floorUp(accountId, contextOf(session)?.floorDoid);
      // A race floor: the rival's ghost may stand on it, and no room is entered yet.
      if (player.phase === "race") {
        ghosts?.floorUp(accountId, contextOf(session)?.floorDoid);
        rooms.delete(accountId);
      }
      if (player.phase === "lobby" && player.arriving) {
        // Back on a fresh lobby floor after a re-lobby: in line all along, and
        // able to start again now. Put down in the ring, or the sweep decides.
        player.arriving = false;
        player.inRing = inRingNow(session);
        if (player.queued) service.ready(accountId, !player.idle);
        else if (player.inRing === true && !player.idle) enqueue(accountId, player);
        return;
      }
      if (player.phase === "lobby" && !player.queued) {
        player.inRing = inRingNow(session);
        welcome(accountId);
        if (player.inRing === true) enqueue(accountId, player);
        // The welcome has said where to go; the banner says where they are.
        else if (player.inRing === false) present(accountId, { type: "stands" }, { line: false });
      } else if (player.phase === "race" && floorIndex === player.lobbyFloors && !player.startedNoted) {
        player.startedNoted = true;
        service.runEvent(accountId, "started");
      }
    },

    floorCompleting(session) {
      const accountId = idOf(session);
      const player = rankedPlayer(session);
      if (!player) return true;
      if (player.releasing) {
        player.releasing = false;
        return true;
      }
      if (player.phase === "lobby") return false; // the lobby ends only by start() or relobby()
      if (player.over) return false; // a decided race goes no further, not even through a door
      const floorIndex = session.floorIndex ?? 0;
      const raceFloor = floorIndex - player.lobbyFloors + 1;
      if (floorIndex + 1 >= (session.floorCount ?? 1)) return finishLine(accountId, player);
      service.runEvent(accountId, "progress", { floor: raceFloor, of: player.raceFloors });
      return true;
    },

    runFailed(session) {
      const accountId = idOf(session);
      const player = rankedPlayer(session);
      if (player?.phase !== "race") return;
      // The run's own failure is its defeat, already on screen; the ghost goes with it.
      ghosts?.clear(accountId);
      player.over = true;
      player.ended = true;
      service.runEvent(accountId, "failed");
    },

    runLeft(session, how) {
      const accountId = idOf(session);
      const player = players.get(accountId);
      if (!player) return;
      players.delete(accountId);
      kept.delete(accountId);
      rooms.delete(accountId);
      if (player.phase === "lobby") service.leave(accountId);
      // A pairing counting down, or a race under way, is the race's to decide.
      service.runEvent(accountId, how);
      // Last: what the others are shown must never keep the queue or the race from hearing it.
      copies?.leave(accountId);
      ghosts?.leave(accountId);
    },

    idle(session, marked) {
      const accountId = idOf(session);
      const player = rankedPlayer(session);
      if (player?.phase === "race") ghosts?.afk(accountId, marked);
      if (!player || player.phase !== "lobby") return;
      player.idle = marked;
      player.idleSince = marked ? clock() : null;
      // Their copies say so too, the way the game marks anybody away.
      copies?.afk(accountId, marked);
      if (player.queued) service.ready(accountId, !marked);
      else if (!marked && player.inRing === true) enqueue(accountId, player);
    },

    /**
     * The hero's stream (modes/hooks.js, heroEvent): a lobby player's copies
     * and a racer's ghost follow their moves and swings; a line said reaches
     * whoever a lobby or a race lets hear it.
     */
    heroEvent(session, event) {
      switch (event?.type) {
        case "moved":
          return mirrored("moved")(session, event.position);
        case "turned":
          return mirrored("turned")(session, event.heading);
        case "swung":
          return mirrored("swung")(session, event.choreography);
        case "swingStopped":
          return mirrored("swingStopped")(session);
        case "said":
          return said(session, event.line);
        default:
          return undefined;
      }
    },

    /**
     * The racer's report (modes/hooks.js, reportRows): what the race did to
     * their rating after their name, on their own row — the one line of free
     * text the report draws — and the rival's row beside it, read live while
     * they are still in this race, else as their run stood when it began, so
     * the build they brought is there after they have gone. Named in full: the
     * report is after the race. A run that is not a race keeps its report.
     */
    reportRows(recipient, rows, { success, reportOf } = {}) {
      const accountId = idOf(recipient);
      const player = rankedPlayer(recipient);
      if (player?.phase !== "race") return rows;
      const out = [...rows];
      const mine = results.get(`${player.raceId}:${accountId}`);
      if (mine && out[0]) {
        const own = String(recipient.dungeonAccount?.name ?? contextOf(recipient)?.dungeonAccount?.name ?? "");
        out[0] = { ...out[0], name: `${own} ${signed(mine.ratingChange)}` };
      }
      if (!player.rival || out.length >= 4) return out;
      const them = players.get(player.rival);
      const racing = them?.phase === "race" && them.raceId === player.raceId;
      const live = racing ? sessionOf(player.rival) : null;
      const context = live ? contextOf(live) : null;
      const base = context ? reportOf?.(context, !success) : snapshots.get(`${player.raceId}:${player.rival}`);
      if (!base) return out;
      const name = String(context?.dungeonAccount?.name ?? base.name ?? "");
      const theirs = results.get(`${player.raceId}:${player.rival}`);
      out.push({ ...base, name: theirs ? `${name} ${signed(theirs.ratingChange)}` : name, transient: true });
      return out;
    },
  };

  /**
   * The last floor cleared. Whether it ends as the game would end it — its own
   * victory — depends on the race, not on being first over the line: each clock
   * starts when that player's floor was ready, so a rival who loaded later may
   * still win on time. Won at once (the usual case): the floor completes.
   * Lost, or a draw: the result's ending, and the floor holds. Not decided yet:
   * the floor holds, at most for the time the rival started behind, and the
   * result ends the run when it comes.
   */
  const finishLine = (accountId, player) => {
    player.crossed = true;
    player.finishing = true;
    try {
      service.runEvent(accountId, "finished");
    } finally {
      player.finishing = false;
    }
    // Not decided: the floor holds, and the wait is watching the rival (the ghost stays).
    if (!player.over) return false;
    if (player.outcome === "win") {
      /**
       * The floor ends now, into the game's own victory, so whatever ghost
       * stands here goes first, by its own disable. The rival following the
       * winner into the last room is shown exactly as the winner crosses the
       * line — the same millisecond, twice in four races on 2026-10-05 — and a
       * hero generated into a run's last instant and left to the floor's end
       * outlived the run on the client (summary.js, clearFloorObjects).
       */
      ghosts?.clear(accountId);
      player.ended = true;
      return true;
    }
    endRun(accountId, player);
    return false;
  };

  /**
   * The start port: both players' runs get the race's floors, then both lobby
   * floors end together. Checked for both before either is touched, so a
   * failure leaves nobody half-started.
   */
  const start = async (race) => {
    const inLobby = () =>
      race.ids.map((accountId) => {
        const session = sessionOf(accountId);
        const player = players.get(accountId);
        const context = session && player?.phase === "lobby" ? contextOf(session) : null;
        if (!context) throw new Error(`${accountId} is not in a ranked lobby`);
        return { accountId, player, context };
      });
    inLobby();
    const floors = await raceFloors(race.spec);
    // No floors would leave the lobby the run's last, and ending it would win it.
    if (!floors?.length) throw new Error(`node ${race.spec.mapNodeId} gave the race no floors`);
    // Read from disk, which took a moment: called off meanwhile — a drop, the
    // server stopping — there is nothing to start, and whoever is left has
    // already been told and is back in line in their lobby.
    if (race.decided) return;
    const sessions = inLobby();
    for (const { accountId, context } of sessions) {
      keep(snapshots, `${race.id}:${accountId}`, snapshot(context));
      // Racing now: their copies leave the lobbies as they do.
      copies?.leave(accountId);
    }
    for (const entry of sessions) {
      const { player, context } = entry;
      // Everything in the plan so far is lobby; the race's floors follow, each
      // numbered as the race's own (floor 1 of N on the client).
      player.lobbyFloors = context.floorPlan.floors.length;
      player.raceFloors = floors.length;
      entry.undo = runControls.planAhead(
        context,
        floors.map((floor, index) => ({ ...floor, numbered: { index, of: floors.length } }))
      );
      player.phase = "race";
      player.countingDown = false;
      player.releasing = true;
    }
    for (const { accountId, player, context, undo } of sessions) {
      if (endFloor(context)) continue;
      // A lobby floor that cannot end now (one already ending): this player
      // stays a lobby player as they were, and the race is the core's to void —
      // whoever was released before them is sent home by that.
      undo?.();
      player.phase = "lobby";
      player.releasing = false;
      throw new Error(`${accountId}'s lobby floor could not end into the race`);
    }
  };

  /** Ends a floor through the runtime; false when it did not end, a throw included. */
  const endFloor = (context) => {
    try {
      return completeFloor(context) !== false;
    } catch (problem) {
      warn(`ranked: could not end ${context?.accountId}'s floor: ${problem?.message ?? problem}`);
      return false;
    }
  };

  /**
   * A pairing called off during its countdown. The game's countdown cannot be
   * taken back — nothing in FloorEndingGui stops it — and at zero the client
   * fades out to wait for the next floor, which would never come. So the floor
   * changes after all, into a fresh copy of the lobby, the way start() ends the
   * lobby into the race. Called off, the player is back in line (onNotice), so
   * this lobby puts them down in the ring.
   */
  const relobby = (accountId, player) => {
    player.countingDown = false;
    const session = sessionOf(accountId);
    if (!session) return;
    const context = contextOf(session);
    // Whatever was to follow this floor, a fresh lobby instead.
    const undo = runControls.planAhead(context, [lobbyFloor(ringSpot(settings.ring) ?? settings.lobbySpawn)], {
      replace: true,
    });
    player.inRing = null;
    // In line, but between floors nobody can start a race: ready again once the
    // new floor stands and asks for its hero (heroRequested).
    player.arriving = true;
    player.releasing = true;
    if (endFloor(context)) return;
    // Already ending — a transition under way, whose floor will arrive and ask
    // for its hero all the same. The plan goes back as it was.
    undo?.();
    player.releasing = false;
    warn(`ranked: ${accountId}'s lobby could not be renewed; the floor under way stands in for it`);
  };

  /**
   * A notice as more than a chat line: the banner, sound and shake the effect
   * book gives it (src/socket/ui-effects.js). Shown first, since the chat line
   * waits on a name lookup; a failure here is logged and costs the line nothing.
   */
  const showNotice = (accountId, notice) => {
    const session = sessionOf(accountId);
    if (!session) return null;
    try {
      return show(contextOf(session), booked(notice));
    } catch (problem) {
      warn(`ranked: could not show ${accountId} ${notice.type}: ${problem.message}`);
      return null;
    }
  };

  /**
   * A decided race ends a run that is still going, the way the result says: the
   * game's own victory for a win, with no door to walk through; its defeat for
   * a loss; and back to town where nobody came out ahead — a draw, or a race
   * cancelled once its floors were loading. `ended` says whether it was
   * delivered: between floors it cannot be, and the sweep tries again.
   */
  const ENDINGS = { win: victory, loss: defeat, home: sendHome };
  const endRun = (accountId, player) => {
    const session = sessionOf(accountId);
    if (!session) return;
    const failed = (problem) => warn(`ranked: could not end ${accountId}'s run: ${problem?.message ?? problem}`);
    // The rival's ghost goes first, by its own disable, while the floor stands (copies.js, clear).
    ghosts?.clear(accountId);
    let delivered;
    try {
      delivered = ENDINGS[player.outcome](contextOf(session));
    } catch (problem) {
      failed(problem);
      return;
    }
    if (typeof delivered?.then !== "function") {
      player.ended = delivered !== false;
      return;
    }
    // An ending that answers later (going home is a transition, and with match
    // workers a call to the main thread): ended meanwhile, so the sweep does
    // not ask twice, and given back for the sweep to retry if it was not sent.
    player.ended = true;
    delivered.then(
      (sent) => {
        if (sent === false) player.ended = false;
      },
      (problem) => {
        failed(problem);
        player.ended = false;
      }
    );
  };

  /** What a notice means for a run in the race; null when the race goes on. */
  const outcomeOf = (notice) => {
    if (notice.type === "finished") return notice.result === "win" ? "win" : notice.result === "loss" ? "loss" : "home";
    return notice.type === "cancelled" ? "home" : null;
  };

  /** Notices from the core, as chat lines and effects. */
  const onNotice = (accountId, notice) => {
    // A pairing that came to nothing leaves its players where they stood. One
    // still on the lobby floor is still waiting, unless the core requeued them.
    const player = players.get(accountId);
    if (notice.type === "paired" && player) {
      player.raceId = notice.race;
      player.rival = notice.opponent;
    }
    if (notice.type === "finished") {
      keep(results, `${notice.race}:${accountId}`, { rating: notice.rating, ratingChange: notice.ratingChange });
      const prize = reward(accountId, notice);
      if (prize) notice = { ...notice, reward: prize };
    }
    if (notice.type === "started") settles.set(accountId, clock() + SETTLE_MS);
    const relobbying = notice.type === "cancelled" && player?.phase === "lobby" && player.countingDown === true;
    if (notice.type === "cancelled" && player?.phase === "lobby") {
      player.queued = notice.requeued === true;
      // Re-lobbied, they are between floors: in line if the core kept them
      // there, but able to start only once the new floor stands (relobby).
      // Whether they can start now is said here, not by the core: not between
      // floors, and not while idle — idle during the countdown would otherwise
      // be paired again at once, and sent idle into a race.
      if (player.queued) service.ready(accountId, relobbying ? false : !player.idle);
      else if (!relobbying) enqueue(accountId, player);
    }
    const shown = present(accountId, notice);
    if (notice.type === "paired" && player) player.countingDown = shown?.sent?.includes("countdown") === true;
    if (relobbying) relobby(accountId, player);
    // The race is over for this run. One that finished, failed or was walked
    // out of has had its ending already; one still going gets it now.
    const outcome = outcomeOf(notice);
    if (outcome && player?.phase === "race" && !player.over) {
      player.over = true;
      player.outcome = outcome;
      // One crossing the line right now is ended by finishLine, in its own turn.
      if (!player.ended && !player.finishing) endRun(accountId, player);
    }
  };

  /**
   * The prize: a gift from MATCHMAKER, waiting in town, by the result and the
   * league the race left the player in (settings.rewards, checked in setup.js).
   * Written on the run's own account, which the run's end saves; a racer who
   * is gone by now (dropped, left) has no account here and gets nothing,
   * which is also what their result deserves. Returns the offer's name, or
   * null when nothing was given.
   */
  const reward = (accountId, notice) => {
    const table = settings.rewards?.[notice.result];
    if (!table || !notice.rating) return null;
    const league = leagueAt({ rating: notice.rating.rating, place: notice.place, of: notice.of }, leagues);
    const offer = table[league.name] ?? table["*"];
    const session = sessionOf(accountId);
    if (!offer || !session) return null;
    // Said with the result at once; only a pile already full (runtime.js, gift) keeps it back.
    Promise.resolve(gift(session, offer.offerId, { from: SYSTEM_FRIEND_ID }))
      .then((given) => {
        if (!given) warn(`ranked: ${accountId}'s race prize was not given (no account here, or too many gifts waiting)`);
      })
      .catch((problem) => warn(`ranked: ${accountId}'s race prize was not given: ${problem.message}`));
    return offer.name;
  };

  /** Both times, so who finished first is the server's clock on the page, not each screen's view of the other. */
  const timesOf = ({ own = null, rival = null } = {}) => {
    if (own != null && rival != null) return words.part("times.both", { own: raceClock(own), rival: raceClock(rival) });
    if (own != null) return words.part("times.own", { own: raceClock(own) });
    if (rival != null) return words.part("times.rival", { rival: raceClock(rival) });
    return "";
  };

  /**
   * The chat line for a notice, in the book's words (ui-effects.json, `lines`):
   * its fields formatted for reading, and the parts that depend on what
   * happened. The rival is not named until the race is over: who it is matters
   * to nobody racing, and to somebody who would rather pick their opponents.
   * The finish names both, so the log keeps who raced whom.
   */
  const lineOf = async (notice, accountId, player) => {
    const params = { ...notice };
    // The prize, when the finish gave one; "" keeps the line whole otherwise.
    params.reward = notice.reward ? words.part("reward.gift", { what: notice.reward }) : "";
    if (notice.opponentRating) {
      params.opponentRating = shownRating(notice.opponentRating);
      params.opponentLeague = leagueAt({ rating: notice.opponentRating.rating, ...placeOn(notice.opponent) }, leagues).name;
    }
    if (notice.type === "finished") {
      const league = leagueAt({ rating: notice.rating.rating, place: notice.place, of: notice.of }, leagues);
      const was = leagueAt({ rating: notice.rating.rating - notice.ratingChange, ...(notice.was ?? {}) }, leagues);
      params.rating = shownRating(notice.rating);
      params.league = league.name;
      params.ratingChange = signed(notice.ratingChange);
      // A league crossed is said with the result: the number alone would leave it to be noticed.
      params.moved = league === was
        ? ""
        : words.part(leagueRank(league, leagues) > leagueRank(was, leagues) ? "moved.up" : "moved.down", { league: league.name });
      params.versus = player?.rival
        ? words.part("versus", { me: await nameOf(accountId), rival: await nameOf(player.rival) })
        : "";
      const why = notice.forfeit ? "forfeit" : notice.reason;
      params.why = words.part(`why.${why}`) || why;
      params.times = timesOf(notice.times);
    }
    if (notice.type === "cancelled") params.requeued = notice.requeued ? words.part("requeued") : "";
    if (notice.type === "welcome") {
      params.standing = placeLine(notice, words.part);
      params.how = words.part(notice.ring ? "how.ring" : "how.anywhere");
    }
    return words.line(booked(notice), params);
  };

  /** accountId -> the latest notices, for a client that shows them itself. */
  const kept = new Map();

  /**
   * How a player is shown a notice — the one place that decides. The stock
   * path: the book's effects, then its chat line, unless a banner that says the
   * same was shown (`replacesChat`) or the caller wants the banner alone. A
   * client that declared SHOWS_NOTICES is kept the notice as data instead, and
   * drawn nothing. Returns what the effects did, so a caller can ask whether
   * the game's countdown went.
   */
  const present = (accountId, notice, { line = true, player = players.get(accountId) } = {}) => {
    const session = sessionOf(accountId);
    if (session && declares(contextOf(session), SHOWS_NOTICES)) {
      keep(kept, accountId, [...(kept.get(accountId) ?? []), { ...notice, at: clock() }].slice(-NOTICES_KEPT));
      return null;
    }
    const shown = showNotice(accountId, notice);
    if (!line || shown?.replacesChat) return shown;
    lineOf(notice, accountId, player)
      .then((text) => sayLine(accountId, text))
      .catch((problem) => warn(`ranked: could not tell ${accountId} about ${notice.type}: ${problem.message}`));
    return shown;
  };

  /**
   * The line a player gets on arriving in the lobby: where they stand, and how
   * to race. In chat whatever the client's strings, because a banner fades and
   * the log keeps it.
   */
  const welcome = (accountId) => {
    const board = service.board();
    const index = board.findIndex((row) => Number(row.accountId) === Number(accountId));
    const { rating } = index >= 0 ? board[index] : service.statusOf(accountId).rating;
    const league = leagueAt({ rating, place: index >= 0 ? index + 1 : null, of: board.length }, leagues);
    present(accountId, {
      type: "welcome",
      rating,
      league: league.name,
      color: league.color,
      place: index >= 0 ? index + 1 : null,
      of: board.length,
      ring: Boolean(settings.ring),
    });
  };

  /**
   * Walking between the ring and the stands. Into the ring is into the queue,
   * whose own notice says so; out to the stands leaves it, said here. A pairing
   * already counting down is not undone by a step: the race decides that.
   */
  const watchRing = (accountId, player) => {
    const session = sessionOf(accountId);
    if (!session) return;
    const inRing = inRingNow(session);
    if (inRing === null) return;
    const arriving = player.inRing == null;
    if (!arriving && inRing === player.inRing) return;
    if (service.statusOf(accountId).state === "in_race") return;
    player.inRing = inRing;
    if (inRing) {
      if (!player.queued && !player.idle) enqueue(accountId, player);
      return;
    }
    if (player.queued) service.leave(accountId);
    player.queued = false;
    // Arriving, the welcome has said where to go: the banner alone says where they are.
    present(accountId, { type: "stands" }, { line: !arriving });
  };

  /**
   * Once a second: lobby idling past its limit leaves the queue; cooldowns that
   * ran out rejoin; an ending that found the player between floors is sent now.
   */
  const sweep = () => {
    const now = clock();
    for (const [accountId, at] of joining) if (now - at >= JOINING_FOR_MS) joining.delete(accountId);
    for (const [accountId, at] of settles) {
      if (now < at) continue;
      settles.delete(accountId);
      if (players.get(accountId)?.phase === "race") present(accountId, { type: "started_settle" }, { line: false });
    }
    for (const [accountId, player] of players) {
      if (player.phase === "race" && player.over && !player.ended) endRun(accountId, player);
      if (player.phase !== "lobby") continue;
      watchRing(accountId, player);
      if (player.queued && player.idle && now - player.idleSince >= settings.lobbyIdleMs) {
        service.leave(accountId);
        player.queued = false;
        present(accountId, { type: "idle" });
      } else if (!player.queued && !player.idle && player.inRing === true && now >= (player.retryAt ?? Infinity)) {
        player.retryAt = undefined;
        enqueue(accountId, player);
      }
    }
    copies?.sync([...players].filter(([, player]) => player.phase === "lobby").map(([accountId]) => accountId));
    ghosts?.sync([...players].filter(([, player]) => player.phase === "race").map(([accountId]) => accountId));
  };

  /**
   * What the outside reads: the lobby's players, and the notices kept for a
   * client that shows its own — what `ranked/Status` will answer.
   */
  return {
    hooks,
    start,
    onNotice,
    sweep,
    players,
    notices: (accountId) => [...(kept.get(Number(accountId)) ?? [])],
    /** Whose copies a lobby player is shown. */
    copiesShownTo: (accountId) => copies?.shownTo(accountId) ?? [],
  };
};

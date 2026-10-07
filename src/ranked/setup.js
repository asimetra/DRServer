/**
 * Starts ranked, if the operator asked for it (ODS_RANKED=1), and wires the
 * stock-client adapter into the running server. Returns a stop function, which
 * ends any race under way void and must run before connections close: a
 * connection closing mid-race is a player dropping, and that decides it.
 *
 * Where it runs is `where`:
 *
 *   local   no match workers: all of it, here.
 *   main    match workers on, on the main thread: only what answers on a
 *           connection — entry, the friend list, logging in. The rest is on
 *           one worker (remote.js says why one), which reports its count.
 *   worker  inside that worker: the queue, the races and every ranked run,
 *           finding that worker's own players through modes/runtime.js.
 */
import { config } from "../config.js";
import { info, warn } from "../log.js";
import { createRankedService } from "./index.js";
import { createRecords } from "./records.js";
import { installRankedHooks } from "./hooks.js";
import { nodePool, randomPicker } from "./race-spec.js";
import { RANKED_WORKER, rankedStarted, rankedWaiting, tellRankedWaiting } from "./remote.js";
import { createStockClientAdapter, stockClientEntryHooks } from "./stock-client/adapter.js";

const TICK_MS = 1000;

/**
 * What the entry gate asks of an account, answered from the game data: the
 * active hero's level, and whether the tutorial — the first boss map — is done.
 */
const gateQuestions = async () => {
  const { heroById, loadGameMaster } = await import("../gamemaster.js");
  const { heroLevel } = await import("../progression.js");
  const { getMapNodeBit } = await import("../map-progress.js");
  const gm = await loadGameMaster();
  const activeAvatar = (account) =>
    (account?.account_avatars ?? []).find((row) => row.id === account?.active_avatar) ?? account?.account_avatars?.[0];
  const tutorialBit = (gm.raw.MapPage ?? []).find((node) => node.Constant === "TUTORIAL")?.BitIndex ?? null;
  return {
    heroLevelOf: async (account) => {
      const avatar = activeAvatar(account);
      const hero = avatar ? await heroById(avatar.avatar_id) : null;
      return hero ? heroLevel(gm, hero, avatar.experience ?? 0) : 1;
    },
    tutorialDoneFor: (account) =>
      tutorialBit === null || getMapNodeBit(activeAvatar(account)?.completed_mapnode_mask, tutorialBit),
  };
};

/**
 * `{ win: { league|"*": offerId }, loss: {...} }` → the same with each offer
 * checked against the game data and carrying its name (`BundleName`, else
 * `Name`), which the chat line says. Null or nothing pays nothing.
 */
export const rewardOffersOf = (rewards, gm) => {
  if (!rewards || typeof rewards !== "object") return null;
  const offers = gm?.raw?.Offers ?? [];
  const out = {};
  for (const result of ["win", "loss"]) {
    const table = rewards[result];
    if (!table || typeof table !== "object") continue;
    out[result] = {};
    for (const [league, id] of Object.entries(table)) {
      const offer = offers.find((row) => Number(row.Id) === Number(id));
      if (!offer) {
        warn(`ranked: rewards.${result}.${league}: no offer ${id} in the game data; it pays nothing`);
        continue;
      }
      out[result][league] = { offerId: Number(offer.Id), name: offer.BundleName || offer.Name || `offer ${offer.Id}` };
    }
  }
  return out;
};

/** The main thread's half with match workers on: the connection's hooks, and a way to stop the rest. */
const startOnMain = async (settings) => {
  const { tellSystemPresence } = await import("../socket/presence.js");
  const uninstallCommands = await rankedCommands();
  const hooks = stockClientEntryHooks({
    settings,
    waiting: rankedWaiting,
    tellPresence: tellSystemPresence,
    ...(await gateQuestions()),
  });
  // Only while the worker says ranked is up there (remote.js): otherwise no
  // MATCHMAKER on the list, and a JOIN is left as the client sent it.
  const whileUp = (answer, otherwise) => (...args) => (rankedStarted() ? answer(...args) : otherwise(...args));
  const uninstall = installRankedHooks({
    ...hooks,
    friendList: whileUp(hooks.friendList, (rows) => rows),
    loggedIn: whileUp(hooks.loggedIn, () => {}),
    routeEntry: whileUp(hooks.routeEntry, (connection, request) => request),
    entryAllowed: whileUp(hooks.entryAllowed, async () => ({ ok: false, reason: "ranked is not running" })),
  });
  if (rankedStarted()) {
    info(`ranked: on — the queue, the races and every ranked run are on match worker ${RANKED_WORKER}`);
  } else {
    warn(`ranked: match worker ${RANKED_WORKER} did not start it; MATCHMAKER stays off until it does`);
  }
  return async () => {
    uninstall();
    uninstallCommands();
  };
};

/** The mode's chat commands, on whichever thread this is (ranked/commands.js). */
const rankedCommands = async () => {
  const { installRankedCommands } = await import("./commands.js");
  const { bookWords } = await import("../socket/ui-effects.js");
  const { loadExistingAccount } = await import("../accounts.js");
  return installRankedCommands({ bookWords, loadExistingAccount });
};

export const startRanked = async ({
  where = config.matchWorkerCount > 0 ? "main" : "local",
} = {}) => {
  const settings = config.ranked;
  if (!settings?.enabled) return async () => {};
  if (where === "main") return startOnMain(settings);

  // Loaded here so a server with ranked off never reads any of it.
  const { loadGameMaster, mapNode } = await import("../gamemaster.js");
  const { floorPlanForMapNode, loadFloor, tileLibrariesFor } = await import("../socket/floors.js");
  const { runControls } = await import("../modes/runtime.js");
  const { tellAsServer } = await import("../socket/chat.js");
  const { sayToListeners } = await import("../socket/global-chat.js");
  const { bookWords, playNotice } = await import("../socket/ui-effects.js");
  const { buildDungeonReport } = await import("../socket/summary.js");
  const { tellSystemPresence } = await import("../socket/presence.js");
  const { loadExistingAccount } = await import("../accounts.js");
  const { buffGenerate, heroGenerate, heroHeadingUpdate, heroPositionUpdate, objectDisable, playerGenerate } = await import(
    "../socket/objects.js"
  );
  const { heroAfkUpdate } = await import("../socket/afk.js");
  const { remoteAttackChoreography, remoteStopChoreography } = await import("../socket/buster.js");

  const gm = await loadGameMaster();
  if (!(await mapNode(settings.lobbyNode))) {
    warn(`ranked: off — the lobby node ${settings.lobbyNode} is not in the game data`);
    return async () => {};
  }
  // And the lobby floor itself, retiled as configured: a tile the library
  // lacks is found here, in one line, and not by every JOIN at entry.
  try {
    await loadFloor(settings.lobbyFloor, { retile: settings.lobbyTiles ?? [] });
  } catch (problem) {
    warn(`ranked: off — the lobby floor cannot be built: ${problem.message}`);
    return async () => {};
  }
  const pool = nodePool(gm.raw.MapPage, { nodeTypes: settings.nodeTypes, exclude: settings.exclude });
  // Every tile library the draw can reach, for the lobby's area to preload (see
  // the adapter's planFor). The seed does not change which library a node uses.
  const raceTileLibraries = new Set();
  for (const node of pool) {
    for (const library of await tileLibrariesFor(await floorPlanForMapNode(node.Id, { seed: 1 }))) {
      raceTileLibraries.add(library);
    }
  }
  // The race ghost's shade is one of the game's own buffs, named in the settings.
  let raceGhost = settings.raceGhost ?? null;
  if (raceGhost?.buff) {
    const row = (gm.raw.Buff ?? []).find((buff) => buff.Constant === raceGhost.buff);
    if (!row) warn(`ranked: no buff named "${raceGhost.buff}" for the race ghost; it is drawn plain`);
    raceGhost = { ...raceGhost, buff: row?.Id ?? null };
  }
  // The prizes are offers in the game data; one that is not is dropped, with a warning.
  const rewards = rewardOffersOf(settings.rewards, gm);
  const rules = {
    countdownMs: settings.countdownMs,
    maxDurationMs: settings.maxDurationMs,
    forfeitWindowMs: settings.forfeitWindowMs,
    drawWindowMs: settings.drawWindowMs,
    loadTimeoutMs: settings.loadTimeoutMs,
  };

  let adapter = null;
  const service = createRankedService({
    records: createRecords({ storage: config.storage, dataDir: config.dataDir }),
    picker: randomPicker({ pool }),
    rules,
    rating: settings.rating,
    start: (race) => adapter.start(race),
  });
  await service.load();

  adapter = createStockClientAdapter({
    service,
    settings: { ...settings, raceTileLibraries: [...raceTileLibraries], raceGhost, rewards },
    // Ending a run and finding a player are the mode surface's (modes/runtime.js);
    // on a match worker the lookup is the worker's own members.
    sessionOf: runControls.sessionOf,
    say: (session, text) => tellAsServer(session, text),
    show: playNotice,
    words: bookWords,
    victory: runControls.win,
    defeat: runControls.lose,
    // An exit asked for on the player's behalf. Its answer, false when it was not
    // sent, reaches the adapter's endRun, which leaves the sweep to try again.
    sendHome: runControls.sendHome,
    // The lobbies' shared channel, on the global one's rules: restricted and
    // blocked speakers stay unheard, a flood is held to its pace, and it is logged.
    relay: (speaker, line, listeners) => {
      sayToListeners(speaker, line, listeners, "ranked lobby");
    },
    // Each racer's report row as the race begins: a rival who leaves keeps their build on it.
    snapshot: (context) => {
      try {
        return buildDungeonReport(context, false);
      } catch (problem) {
        warn(`ranked: no report snapshot of ${context.accountId}: ${problem.message}`);
        return null;
      }
    },
    tellPresence: tellSystemPresence,
    // Each floor carries the drawn node's level and tier: they follow the race
    // onto the lobby's plan, which has neither, so its monsters are the node's
    // own and not level 1 (floors.js, plannedNpcLevel).
    raceFloors: async (spec) => {
      const node = await mapNode(spec.mapNodeId);
      const plan = await floorPlanForMapNode(spec.mapNodeId, { seed: spec.seed });
      return plan.floors.map((floor) => ({
        ...floor,
        node,
        ...(plan.npcLevel ? { npcLevel: plan.npcLevel } : {}),
        ...(plan.tier ? { tier: plan.tier } : {}),
      }));
    },
    // Ending the lobby floor into the race: the mode surface's (modes/runtime.js).
    completeFloor: runControls.endFloor,
    nameOf: async (accountId) => (await loadExistingAccount(accountId))?.name ?? `#${accountId}`,
    ...(await gateQuestions()),
    // A copy is drawn and moved with what a party member is (stock-client/copies.js).
    copyFrames: {
      player: playerGenerate,
      hero: heroGenerate,
      position: heroPositionUpdate,
      heading: heroHeadingUpdate,
      afk: heroAfkUpdate,
      attack: remoteAttackChoreography,
      stopAttack: remoteStopChoreography,
      buff: buffGenerate,
      disable: (doid) => objectDisable(doid),
    },
  });
  service.onNotice(adapter.onNotice);
  const uninstall = installRankedHooks(adapter.hooks);
  const uninstallCommands = await rankedCommands();

  let reported = null;
  const timer = setInterval(() => {
    // Neither may take the server down: a ranked fault is ranked's alone.
    try {
      adapter.sweep();
    } catch (problem) {
      warn(`ranked: sweep failed: ${problem.stack ?? problem}`);
    }
    service.tick().catch((problem) => warn(`ranked: tick failed: ${problem.stack ?? problem}`));
    const { waiting } = service.queue.counts();
    if (waiting !== reported) {
      reported = waiting;
      tellRankedWaiting(waiting);
    }
  }, TICK_MS);
  timer.unref?.();

  info(
    `ranked: on${where === "worker" ? ` (match worker ${RANKED_WORKER})` : ""} — ` +
      `lobby node ${settings.lobbyNode}, ${pool.length} dungeons in the draw ` +
      `(${raceTileLibraries.size} tile libraries), ` +
      `${service.board().length} rated player(s)`
  );
  let stopping = null;
  return () => {
    stopping ??= (async () => {
      clearInterval(timer);
      await service.stop();
      uninstall();
      uninstallCommands();
    })();
    return stopping;
  };
};

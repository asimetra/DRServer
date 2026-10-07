/**
 * Delve: a boss rush with no end, for a party anybody may join.
 *
 * The way in is DELVE on the friend list — a friend door, with how many are
 * inside — and JOIN beside it. `/delve`, said in a dungeon, still arms the
 * player's next entry instead; `/delve off` calls it off. Every floor is a
 * boss's own map — one of the game's trophy dungeons, drawn at random and never
 * the same twice in a row — and each is harder than the last: the monsters'
 * level, then their health, damage and attack speed, and every few bosses one
 * more of the game's own modifiers. The run goes on until the party falls, or
 * walks out. Every few bosses beaten leaves a gift waiting in town, better the
 * deeper it was earned, and how deep each player went is kept.
 *
 * A reference mode as much as a game: it is written against the mode surface
 * alone (src/modes/README.md) — hooks, run rules, run controls, records, game
 * data, chat commands — and loaded from outside src/ (ODS_MODES), which is
 * what it proves: a mode the core does not know about, on every thread.
 *
 *   ODS_MODES=examples/modes/delve/index.js npm start
 */
import { randomUUID } from "node:crypto";
import { installModeHooks } from "../../../src/modes/hooks.js";
import { runRules } from "../../../src/socket/run-rules.js";
import { runControls } from "../../../src/modes/runtime.js";
import { createModeRecords } from "../../../src/modes/records.js";
import { gameTable, mapNodes, nodePlan, planTileLibraries } from "../../../src/modes/game-data.js";
import { onTold, tellMain } from "../../../src/modes/seat.js";
import { friendDoorHooks } from "../../../src/modes/friend-door.js";
import { define, undefineMode } from "../../../src/socket/commands.js";
import { ROLE } from "../../../src/socket/roles.js";
import { info } from "../../../src/log.js";

export const DELVE_MODE = "delve";

/**
 * What a delve pays and counts for. Gold, experience and the bosses' own chests
 * as any run pays them; not a boss's trophy, keys or gems, which a run that
 * draws the same boss again and again would farm; and the map is not marked:
 * a drawn boss was not a boss reached. Anybody may join — a delve is a party's.
 */
export const DELVE_RUN_RULES = runRules({
  mode: DELVE_MODE,
  // Every hero may delve: the bosses are drawn, not chosen.
  unlockCheck: false,
  pays: { keys: false, trophies: false, gems: false },
  mapCredit: false,
  rankable: false,
  joinable: true,
  // The report comes only when the party falls: a chest is the player's as it is picked up.
  chestsKept: "pickup",
  // Ten seconds to be got back up, as Infinite gives, not the minute a dungeon does.
  defeatCountdownSeconds: 10,
});

/** The settings a deployment may change (createDelve's `settings`); these are the defaults. */
export const DELVE_DEFAULTS = Object.freeze({
  /** Boss nodes never drawn: the tutorial's, and the village's defence, which is not a boss fight. */
  exclude: ["TUTORIAL", "NORDIC_VILLAGE_BOSS"],
  /** The monsters' level on the first boss, and how much it rises with each one after. */
  startLevel: 10,
  levelPerBoss: 6,
  /** Shares over 1 added with each boss after the first: +12% health, +8% damage, +5% attack speed. */
  healthPerBoss: 0.12,
  damagePerBoss: 0.08,
  attackSpeedPerBoss: 0.05,
  /**
   * The boss heals this share of what it deals: from the `lifeStealFrom`th boss,
   * rising with each after, up to `lifeStealMost`.
   */
  lifeStealFrom: 3,
  lifeStealPerBoss: 0.05,
  lifeStealMost: 0.4,
  /**
   * The best chest a boss may drop, by how deep (1 common, 2 uncommon, 3 rare,
   * 4 legendary): a boss rush draws the same chests again and again, and a
   * legendary should not come easy.
   */
  chests: [
    { from: 1, most: 1 },
    { from: 4, most: 2 },
    { from: 8, most: 3 },
    { from: 12, most: 4 },
  ],
  /** One more modifier every this many bosses, from the list below (the game's DungeonModifier rows). */
  modifierEvery: 3,
  modifiers: [
    "INFINITE_DEADLY_DAMAGE", "INFINITE_SCARY_SPEED", "INFINITE_ATTACK_SPEED", "INFINITE_MELEE_DEFENSE",
    "INFINITE_RANGED_DEFENSE", "INFINITE_MAGIC_DEFENSE", "INFINITE_IMMUNITY_STUN", "INFINITE_IMMUNITY_CHILL",
    "INFINITE_IMMUNITY_SHOCK", "INFINITE_IMMUNITY_KNOCKBACK", "INFINITE_RESIST_BURN", "INFINITE_RESIST_POISON",
    "INFINITE_ICE_BOMBS", "INFINITE_DANGEROUS_DEATHS", "INFINITE_HEALTH_SCARE", "INFINITE_REGEN_NEGATION",
  ],
  /**
   * A gift every this many bosses beaten, by how deep: the offer of the
   * deepest step reached (Common, Uncommon, Rare, Legendary Key).
   */
  giftEvery: 3,
  gifts: [
    { from: 3, offerId: 51201 },
    { from: 6, offerId: 51205 },
    { from: 9, offerId: 51209 },
    { from: 12, offerId: 51213 },
  ],
  /**
   * Who the gift says it is from: an id that is nobody's account, which the
   * client draws as "SOMEBODY". The run, not a player.
   */
  giftFrom: 0,
  /** The friend door's id (modes/friend-door.js): reserved, under 1000; MATCHMAKER is 999. */
  doorId: 998,
});

/** The gift for having beaten `beaten` bosses, or null when it is not a gift step. */
export const giftFor = (beaten, settings = DELVE_DEFAULTS) => {
  if (!(beaten > 0) || beaten % settings.giftEvery !== 0) return null;
  const earned = settings.gifts.filter((step) => beaten >= step.from);
  return earned.length ? earned[earned.length - 1] : null;
};

/** How hard the `depth`th boss is (1 for the first): what each of its floors carries. */
export const difficultyAt = (depth, settings = DELVE_DEFAULTS) => {
  const after = Math.max(0, depth - 1);
  const stealing = depth - settings.lifeStealFrom;
  const chestStep = settings.chests.filter((step) => depth >= step.from).at(-1);
  return {
    npcLevel: settings.startLevel + settings.levelPerBoss * after,
    healthBonus: settings.healthPerBoss * after,
    damageBonus: settings.damagePerBoss * after,
    attackSpeedBonus: settings.attackSpeedPerBoss * after,
    lifeSteal: stealing >= 0 ? Math.min(settings.lifeStealMost, settings.lifeStealPerBoss * (stealing + 1)) : 0,
    chestMost: chestStep?.most ?? 1,
  };
};

/**
 * The mode, over what it is handed: `bosses` — each `{ node, floors, tier }`,
 * a boss node and its authored maps — and the ports it speaks through. Kept
 * apart from the game data so a test hands it bosses of its own.
 */
export const createDelve = ({
  bosses,
  modifierIds = [],
  tileLibraries = [],
  settings = DELVE_DEFAULTS,
  controls = runControls,
  records = null,
  // How this thread's count of delvers reaches whoever answers friend lists (tellMain).
  tellInside = () => {},
  // The core's presence, standing in for it in a test.
  tellPresence = undefined,
  random = Math.random,
  clock = Date.now,
}) => {
  if (!bosses?.length) throw new Error("delve: no boss to draw");
  /** Accounts whose next entry is a delve. */
  const armed = new Set();
  /** The node every delve is entered by, which strangers are matched into it by. */
  const entryNode = bosses[0].node.Id;

  const draw = (last) => {
    const choices = bosses.length > 1 ? bosses.filter((boss) => boss.node.Id !== last) : bosses;
    return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
  };

  /** The `depth`th boss's floors, harder than the last's, with the modifiers earned so far. */
  const step = (state) => {
    const boss = draw(state.last);
    state.last = boss.node.Id;
    if (state.depth > 1 && (state.depth - 1) % settings.modifierEvery === 0 && modifierIds.length) {
      const unused = modifierIds.filter((id) => !state.modifiers.includes(id));
      if (unused.length) state.modifiers = [...state.modifiers, unused[Math.floor(random() * unused.length)]];
    }
    const hard = difficultyAt(state.depth, settings);
    return boss.floors.map((floor) => ({
      ...floor,
      node: boss.node,
      ...(boss.tier ? { tier: boss.tier } : {}),
      ...hard,
      modifiers: [...state.modifiers],
    }));
  };

  /** The delve's own state, kept on its plan: one per run, shared by the party. */
  const stateOf = (session) => session?.floorPlan?.delve ?? null;
  const isDelve = (session) => session?.modeEntry === DELVE_MODE && Boolean(stateOf(session));
  const idOf = (session) => Number(session?.accountId);
  /**
   * accountId -> the run they are in, noted as their hero stands on a floor.
   * A player leaving arrives raw, without the run's plan to read the state off.
   */
  const runOf = new Map();

  /** How deep a player went, kept once per run: on falling with the party, or on walking out. */
  const keep = (session) => {
    const accountId = idOf(session);
    const state = stateOf(session) ?? runOf.get(accountId);
    if (runOf.delete(accountId)) countChanged();
    if (!state || !records || !accountId || state.kept.has(accountId)) return;
    state.kept.add(accountId);
    records
      .append({ id: `${state.id}:${accountId}`, at: clock(), accounts: [accountId], beaten: state.depth - 1 })
      .catch(() => {});
  };

  /** A delve entry: public, at the one node strangers are matched by. */
  const delveEntry = (request) => ({ ...request, mapNodeId: entryNode, friendId: 0, mapId: 0, friendOnly: 0, mode: DELVE_MODE });

  /**
   * How many are delving, as the main thread hears each worker say it (`inside`,
   * below): worker -> its count. A list answered on a worker knows only its own.
   */
  const insideBy = new Map();
  const insideNow = () => [...insideBy.values()].reduce((sum, count) => sum + count, 0);
  /** This thread's own count changed: told to the main thread (or heard here, without workers). */
  const countChanged = () => tellInside(runOf.size);

  /**
   * The way in: DELVE on every friend list (modes/friend-door.js), with how
   * many are inside, and JOIN on it a delve. Nothing to type, nothing armed —
   * the friend list is how the stock client enters a mode.
   */
  const door = friendDoorHooks({
    id: settings.doorId,
    name: () => (insideNow() > 0 ? `DELVE (${insideNow()})` : "DELVE"),
    where: entryNode,
    tellPresence,
    entry: (connection, request) => delveEntry(request),
  });

  const hooks = {
    friendList: door.friendList,
    loggedIn: door.loggedIn,
    isSystemAccount: door.isSystemAccount,
    routeEntry(connection, request) {
      if (Number(request?.friendId) === settings.doorId) return door.routeEntry(connection, request);
      const accountId = Number(connection?.accountId);
      if (!armed.has(accountId)) return request;
      // Joining somebody keeps the arming for the player's own next run, as one life does.
      if (Number(request?.friendId) || Number(request?.mapId)) return request;
      armed.delete(accountId);
      return delveEntry(request);
    },
    modeRules: (mode) => (mode === DELVE_MODE ? DELVE_RUN_RULES : null),
    runRules: (session) => (session?.modeEntry === DELVE_MODE ? DELVE_RUN_RULES : null),

    async planFor(session, mapNodeId) {
      if (session?.modeEntry !== DELVE_MODE) return null;
      const state = { id: randomUUID(), depth: 1, last: null, modifiers: [], kept: new Set(), told: new Map(), since: new Map() };
      return {
        floors: step(state),
        // The first boss's art with the area; each next one's as its floor comes.
        preloadArtFloors: 1,
        // Every boss's tile file: the client reads a floor's out of what the area preloaded.
        preloadTileLibraries: tileLibraries,
        delve: state,
      };
    },

    heroRequested(session) {
      if (!isDelve(session)) return;
      const state = stateOf(session);
      const accountId = idOf(session);
      if (!runOf.has(accountId)) {
        runOf.set(accountId, state);
        countChanged();
      }
      // The boss a player first stood at: a gift is for bosses fought, not for arriving before one.
      if (!state.since.has(accountId)) state.since.set(accountId, state.depth);
      // Each player told once a boss: a two-map boss is one boss, and a late joiner hears the one they arrived at.
      if (state.told.get(accountId) === state.depth) return;
      state.told.set(accountId, state.depth);
      const floor = session.floorPlan.floors[session.floorIndex ?? 0];
      const mods = floor?.modifiers?.length ? `, ${floor.modifiers.length} modifier(s)` : "";
      controls.say(session, `Delve: boss ${state.depth} — ${floor?.node?.Name ?? "?"} (level ${floor?.npcLevel ?? "?"}${mods})`);
    },

    /**
     * A floor ending. The boss's last map: the next boss goes on the plan before
     * the core decides this floor was the run's last, and every gift step
     * reached leaves a gift for whoever is here. Never held.
     */
    floorCompleting(session) {
      if (!isDelve(session)) return true;
      const state = stateOf(session);
      if ((session.floorIndex ?? 0) + 1 < (session.floorCount ?? 1)) return true;
      const beaten = state.depth;
      state.depth += 1;
      controls.planAhead(session, step(state));
      const gift = giftFor(beaten, settings);
      if (gift) {
        // To everybody standing in the run now who fought at least a gift's worth of its bosses:
        // a friend joining just before the twelfth does not walk off with its legendary key.
        for (const member of controls.party(session)) {
          const since = state.since.get(idOf(member)) ?? state.depth;
          if (beaten - since + 1 < settings.giftEvery) continue;
          Promise.resolve(controls.gift(member, gift.offerId, { from: settings.giftFrom })).catch(() => null);
          controls.say(member, `Delve: ${beaten} bosses beaten — a gift waits in town.`);
        }
      }
      return true;
    },

    runFailed: keep,
    runLeft: keep,
  };

  /** Arms (`on`) or disarms the account's next entry; whether it is armed now, or null for no account. */
  const arm = (accountId, on = true) => {
    const id = Number(accountId);
    if (!id) return null;
    if (on) armed.add(id);
    else armed.delete(id);
    return armed.has(id);
  };

  /** Arms or disarms by turns. */
  const toggle = (accountId) => arm(accountId, !armed.has(Number(accountId)));

  /** The main thread: worker `from` says `inside` are delving there. */
  const heardInside = (from, inside) => {
    if (Number.isFinite(inside) && inside >= 0) insideBy.set(from, inside);
  };

  return {
    hooks,
    arm,
    toggle,
    armed: (accountId) => armed.has(Number(accountId)),
    entryNode,
    heardInside,
    inside: insideNow,
  };
};

/** The bosses the game data has: each boss node's authored maps, its tier, and their tile files. */
export const bossesFromGameData = async (settings = DELVE_DEFAULTS) => {
  const bosses = [];
  const libraries = new Set();
  for (const node of await mapNodes()) {
    if (node.NodeType !== "BOSS" || settings.exclude.includes(node.Constant)) continue;
    const plan = await nodePlan(node.Id, { seed: 1 });
    const floors = (plan?.floors ?? []).filter((floor) => floor.authored);
    if (!floors.length) continue;
    bosses.push({ node, floors, tier: plan.tier ?? null });
    for (const library of await planTileLibraries({ floors })) libraries.add(library);
  }
  const wanted = new Set(settings.modifiers);
  const modifierIds = (await gameTable("DungeonModifier")).filter((row) => wanted.has(row.Constant)).map((row) => row.Id);
  return { bosses, tileLibraries: [...libraries], modifierIds };
};

/** The mode as the registry starts it (src/modes/index.js): on every thread, no seat. */
export default {
  name: DELVE_MODE,
  together: false,
  async start({ where }) {
    const data = await bossesFromGameData();
    const delve = createDelve({
      ...data,
      records: createModeRecords({ mode: DELVE_MODE }),
      tellInside: (inside) => tellMain(DELVE_MODE, { inside }),
    });
    const uninstall = installModeHooks(DELVE_MODE, delve.hooks);
    info(`delve: on (${where}) — ${data.bosses.length} bosses, entered by node ${delve.entryNode}`);
    // A worker starting — a replacement included — has nobody delving yet: its count starts from nothing.
    if (where === "worker") tellMain(DELVE_MODE, { inside: 0 });
    // The arming is kept where entries are routed, told there from wherever /delve was said.
    const unlisten =
      where === "worker"
        ? () => {}
        : onTold(DELVE_MODE, (data = {}, from) => {
          if ("inside" in data) return delve.heardInside(from, data.inside);
          const armedNow = delve.arm(data.accountId, data.on);
          info(`delve: ${data.accountId}'s next entry ${armedNow ? "is a delve" : "is ordinary"}`);
        });
    define({
      name: "delve",
      mode: DELVE_MODE,
      role: ROLE.PLAYER,
      summary: "make your next dungeon a delve: boss after boss, each harder, until the party falls. /delve off calls it off",
      usage: "[off]",
      run: ({ session, args = [], reply }) => {
        const accountId = Number(session?.accountId);
        if (!accountId) return reply.warn("no account to arm");
        const on = String(args[0] ?? "").toLowerCase() !== "off";
        tellMain(DELVE_MODE, { accountId, on });
        reply(on ? "delve: your next dungeon is a boss rush. /delve off to call it off" : "delve: off");
      },
    });
    return async () => {
      unlisten();
      undefineMode(DELVE_MODE);
      uninstall();
    };
  },
};

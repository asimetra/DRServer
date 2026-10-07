/**
 * What a game mode may ask the core to do: the other half of the seam.
 * hooks.js is the core asking a mode; this is a mode asking back. Ranked needed
 * all of it before it was here and reached into src/socket for each piece, so
 * it is surface now (src/modes/README.md, "What a mode may rely on").
 *
 * Each one takes the player's session however the mode holds it — a hook's
 * context, or what `sessionOf` found — and works out the run's context itself.
 * A player whose connection is closing has no context left; then the answer is
 * the "not done" one (false, or null) rather than a throw.
 */
import { completeFloor, reportRunLost, reportRunWon } from "../socket/floorstate.js";
import { matchHost } from "../socket/match-host.js";
import { grantBuff as grantBuffOn } from "../socket/buffs.js";
import { sessionHolding } from "../socket/presence.js";
import { creditGoldAndExperience, healHero, queueAccountSave, restoreMana } from "../socket/rewards.js";
import { giveGift } from "../gifts.js";
import { generateWeapon } from "../chests.js";
import { storageLimit, unequippedWeapons } from "../inventory-space.js";
import { loadGameMaster } from "../gamemaster.js";
import { info, warn } from "../log.js";
import { tellAsServer } from "../socket/chat.js";
import { membersOf } from "../socket/match-world.js";

/**
 * Who `sessionOf` asks. The main thread's connections by default; a match
 * worker installs its own members at start-up (installSessionLookup), since
 * the runs there are not connections of that thread.
 */
let lookup = null;

/** A floor plan entry the core can build (README, "The floor plan"). */
const isPlanFloor = (floor) =>
  Boolean(floor) &&
  typeof floor === "object" &&
  (typeof floor.authored === "string" ||
    (Boolean(floor.generated) && typeof floor.generated === "object" && typeof floor.generated.tileLibrary === "string"));

/** The run's context for a session; a context (it has its member) is already one. */
const contextOf = (session) => {
  if (!session) return null;
  if (session.member) return session;
  try {
    return session.world?.contextFor?.(session, { activate: false }) ?? session;
  } catch {
    // A closed member cannot be given a context, and has no run left to act on.
    return null;
  }
};

export const runControls = Object.freeze({
  /**
   * Everybody in the player's run, the player included, each as the others'
   * controls take them: who a party-wide gift or line goes to. Empty with no run.
   */
  party: (session) => {
    const context = contextOf(session);
    return context ? [...membersOf(context)] : [];
  },

  /** The player's session on this thread, by account; null when their run is not here. */
  sessionOf: (accountId) => (lookup ?? sessionHolding)(accountId) ?? null,

  /** Wins the run now, without its last floor: the victory, then the report. False if it was already over. */
  win: (session) => {
    const context = contextOf(session);
    return context ? reportRunWon(context) : false;
  },

  /** Loses the run now: the defeat, then the report. False if it was already over. */
  lose: (session) => {
    const context = contextOf(session);
    return context ? reportRunLost(context) : false;
  },

  /**
   * Sends the player out of the dungeon and back to town, as their own exit
   * would. Answers later: false when it was not sent, so a mode may try again.
   */
  sendHome: async (session) => {
    const context = contextOf(session);
    return context ? matchHost().sendHome(context) : false;
  },

  /**
   * Sets what comes after the floor the player is on: `floors`, plan entries as
   * `planFor` gives them, after the plan's last — or with `replace`, in place of
   * every floor after this one. The party shares one plan. Called from
   * `floorCompleting`, it is what an endless run does: the floor about to end
   * finds one more after it. Answers a function that puts the plan back as it
   * was, for when the next step (endFloor) did not happen; null with no run.
   * Only while the plan is still this one: after a later planAhead, undoing the
   * earlier would throw the later away too, so it does nothing and says so.
   */
  planAhead: (session, floors, { replace = false } = {}) => {
    if (!Array.isArray(floors) || !floors.every(isPlanFloor)) {
      throw new TypeError("planAhead takes plan floors: each { authored: file } or { generated: { tileLibrary, ... } }");
    }
    const context = contextOf(session);
    const plan = context?.floorPlan;
    if (!plan || !Array.isArray(plan.floors)) return null;
    const was = { floors: plan.floors, floorCount: context.floorCount };
    const kept = replace ? plan.floors.slice(0, (context.floorIndex ?? 0) + 1) : plan.floors;
    const mine = [...kept, ...floors];
    plan.floors = mine;
    context.floorCount = mine.length;
    return () => {
      if (plan.floors !== mine) {
        warn("modes: a planAhead was undone after the plan had changed again; left as it is");
        return false;
      }
      plan.floors = was.floors;
      context.floorCount = was.floorCount;
      return true;
    };
  },

  /**
   * Ends the floor the player is on now, as its exit would: on to the plan's
   * next, or the run won on the last. False when it could not — already ending,
   * or a mode's floorCompleting holding it.
   */
  endFloor: (session) => {
    const context = contextOf(session);
    if (!context) return false;
    try {
      return completeFloor(context) !== false;
    } catch {
      return false;
    }
  },

  /**
   * Pays the player now: gold to the account and experience to the hero, shown
   * on the report and kept with the account. Whole amounts, as given — not the
   * run rules' (they say what the game's own pickups pay) nor a legendary's
   * share. Answers what was paid, `{ gold, experience }`.
   */
  reward: (session, { gold = 0, experience = 0 } = {}) => {
    const context = contextOf(session);
    return context ? creditGoldAndExperience(context, gold, experience) : { gold: 0, experience: 0 };
  },

  /**
   * Heals the player's hero by a share of its most (0 to 1), as food does, and
   * gives back a share of its mana. A hero that is down is not healed: getting
   * up is a revive. Answers what was gained, `{ health, mana }`.
   */
  heal: (session, { health = 0, mana = 0 } = {}) => {
    const context = contextOf(session);
    if (!context) return { health: 0, mana: 0 };
    return { health: healHero(context, health), mana: restoreMana(context, mana) };
  },

  /**
   * Leaves a gift waiting for the player in town: any offer from the game data,
   * said to be `from` that account id (an id of the mode's own,
   * as ranked's MATCHMAKER is, or a player's). Kept with the account. Answers
   * the gift, or null: no such offer, no account here, or the player holding
   * as many as they may.
   */
  gift: async (session, offerId, { from } = {}) => {
    if (!Number.isSafeInteger(from) || from < 0) {
      warn(`modes: a gift needs \`from\`, the account id it is said to be from; offer ${offerId} was not given`);
      return null;
    }
    const context = contextOf(session);
    const account = context?.dungeonAccount;
    if (!account) return null;
    // Any offer in the game data: a prize may be what a player could never
    // give another (ranked's are), so not only the free gifts.
    const offers = (await loadGameMaster()).raw?.Offers ?? [];
    if (!offers.some((offer) => Number(offer.Id) === Number(offerId))) {
      warn(`modes: no offer ${offerId} in the game data; nothing was given to ${account.id}`);
      return null;
    }
    const given = giveGift(account, { offerId, fromAccountId: from });
    if (given) context.accountChanged = true;
    return given;
  },

  /**
   * Puts a weapon in the player's storage, as an opened chest would: one the
   * hero they are playing can use, of `rarity` (a Rarity Type, COMMON to
   * LEGENDARY) and at about `level` — the mode's level, not the hero's, never
   * above the hero's last. Kept with the account and seen in town. Answers the
   * weapon, or null: no account here, no such rarity, or storage full.
   */
  weapon: async (session, { rarity, level } = {}) => {
    const context = contextOf(session);
    const account = context?.dungeonAccount;
    const avatar = context?.dungeonAvatar;
    if (!account || !avatar) return null;
    const gm = await loadGameMaster();
    const row = gm.raw?.Rarity?.find((entry) => entry.Type === rarity && entry.Id <= 4);
    const hero = gm.heroById?.get(avatar.avatar_id);
    const wanted = Math.trunc(Number(level));
    if (!row || !hero || !(wanted >= 1)) {
      warn(`modes: no weapon of ${JSON.stringify(rarity)} at level ${JSON.stringify(level)} for ${account.id}`);
      return null;
    }
    if (unequippedWeapons(account) >= storageLimit(account)) return null;
    const item = generateWeapon({
      gm,
      hero,
      rarity: row,
      level: wanted,
      accountId: account.id,
      id: await matchHost().nextObjectId(account),
      random: context.random ?? Math.random,
    });
    if (!item) return null;
    account.account_items = [...(account.account_items ?? []), item];
    // Written now, not at a report that may be a long way off (a delve's comes when the party falls).
    queueAccountSave(context);
    info(`[${context.id}] mode weapon ${item.item_id} (${rarity}, level ${item.requiredlevel}) for ${account.id}`);
    return item;
  },

  /**
   * A line in the player's chat log from the server, to them alone. False with
   * nobody to tell. For what a banner or a sound says, the effect book
   * (playEvent); this is the words.
   */
  say: (session, text) => {
    const context = contextOf(session);
    if (!context || typeof text !== "string" || !text) return false;
    tellAsServer(context, text);
    return true;
  },

  /** Puts a buff from the game data on the player's hero. The buff object's doid, or null. */
  grantBuff: async (session, constant) => {
    const context = contextOf(session);
    return context ? grantBuffOn(context, constant) : null;
  },
});

/** A thread whose runs are not its connections says how to find them; returns a function that undoes it. */
export const installSessionLookup = (find) => {
  lookup = find;
  return () => {
    if (lookup === find) lookup = null;
  };
};

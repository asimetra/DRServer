import {
  loadGameMaster,
  heroById,
  spawnDooberAction,
  spawnDooberActions,
} from "../gamemaster.js";
import { superStatCeiling, superStatValue } from "../hero-stats.js";
import { info, warn } from "../log.js";
import { isPositionBlocked, nearestClearPosition } from "./navigation.js";
import { inFrontOf } from "./heading.js";
import { CLID } from "./opcodes.js";
import { dooberGenerate, objectDisable } from "./objects.js";
import { dooberSpawnFrom, pickByRarity } from "./drops.js";
import { trackDoober } from "./pickups.js";

/**
 * The Battle Chef's pots, and anything else whose timeline leaves something on
 * the floor.
 *
 * None of it is named in code. `Resources/Combat/AttackTimeline.json` carries a
 * `spawndoober` action with every parameter — what to spawn, how far in front,
 * how far it may scatter, how long it lies there — and `ScriptTimeline` builds
 * nothing for that action, sharing an empty case with `attemptRevive` and
 * `spawnnpc`. That is the client saying the whole thing is the server's.
 *
 *   TM_COOK_FOOD_COOLDOWN  FOOD_COOK  offset 120  spread 250/100  ttl 15
 *   TM_COOK_BUFF_COOLDOWN  FOOD_BUFF  offset 170  spread 250/100  ttl 15
 *   TM_COOK_FOOD           FOOD       offset 170  spread  50/50   ttl 30
 *
 * So an attack cooks something exactly when its own timeline says so, and the
 * poison pot — which calls `spawnNpcForAttack` instead — is not one of these.
 */

const FRAMES_PER_SECOND = 24;

const unitRandom = (random) => Math.min(1 - Number.EPSILON, Math.max(0, random()));

/**
 * How many pickups one pot leaves.
 *
 * Not the chef's doing. The captured pots produced three, four, four and five
 * in four uses by the same cook, so the number varies per use and the training
 * points are spent on what comes out rather than how much of it — which is
 * what the Cooking stat's own description says, and what this used to have
 * backwards.
 *
 * Neither the timeline nor the Doober row authors a count; the spawn action
 * carries `odds: 1` and nothing else. Three to five is what was seen.
 */
const MIN_COOKED = 3;
const MAX_COOKED = 5;

const cookedCount = (random) =>
  MIN_COOKED + Math.floor(unitRandom(random) * (MAX_COOKED - MIN_COOKED + 1));

/**
 * The rarity table a cooked pickup is drawn against.
 *
 * Not the floor's. `DOOBER` is what a barrel or a corpse rolls on — COMMON
 * three quarters of the time, UNCOMMON a fifth, RARE a twentieth and **no UBER
 * at all** — and cooking was using it, which is why the pot handed out
 * meatbones and a turkey was arithmetically impossible.
 *
 * The chef has his own rows. `CHEF_COOK` is an even quarter across all four,
 * so meatbone, ham, steak and turkey are equally likely: a quarter of the
 * health bar up to the whole of it. `CHEF_BUFF_COOK` is flat because the three
 * soups are all COMMON and differ only in which buff they carry.
 */
const RARITY_TABLE_BY_DOOBER_TYPE = {
  FOOD_COOK: "CHEF_COOK",
  FOOD_BUFF: "CHEF_BUFF_COOK",
};

/** The ladder FOOD_COOK climbs: meatbone, ham, steak, turkey. */
const RARITY_LADDER = ["COMMON", "UNCOMMON", "RARE", "UBER"];

/**
 * Which tier a trained chef cooks at.
 *
 * The training points buy quality, not quantity. A chef with 65 of the 75 that
 * COOKING can hold — the one in the captures — produced six steaks and three
 * hams in nine items, with no meatbone below and no turkey above, which is a
 * narrow band sitting just under the top rather than a spread across all four.
 *
 * So the share of the stat picks the tier, `floor(share x 3)`, and the draw is
 * that tier two times in three and the one below it otherwise. At 65/75 that
 * is steak mostly and ham sometimes, which is what was recorded; untrained it
 * is meatbone, and full it is turkey with steak between.
 *
 * Fitted to that observation rather than authored: nothing in the tables
 * connects COOKING to rarity, and `COOKING_UPGRADE` is referenced by nothing.
 * See docs/evidence.md.
 */
const cookedTier = (share, random) => {
  const target = Math.min(
    RARITY_LADDER.length - 1,
    Math.floor(Math.max(0, Math.min(1, share)) * (RARITY_LADDER.length - 1))
  );
  const stepDown = unitRandom(random) < 1 / 3 ? 1 : 0;
  return RARITY_LADDER[Math.max(0, target - stepDown)];
};

/**
 * What a `spawnname` asks for, which is not always a category.
 *
 * The name was read as a `DooberType` and rolled on a rarity table, which is
 * right for the four that are one — FOOD_COOK, FOOD_BUFF, CROWD and FOOD — and
 * wrong for the seven that name a row outright. `FOOD_HAMBURGER` is a
 * `Doobers` row, not a type, so filtering by type found nothing, the caller
 * warned "no concrete GameMaster doober", and the Battle Chef's Dungeon Buster
 * dropped nothing at all. The same silence covered the loot spawn's gold and
 * experience and all three Crowd Pleasers.
 *
 * An exact row wins, because a name that is one is not asking to be rolled for.
 */
const cookedDoober = async (dooberType, random, share = 0) => {
  const { doobers, rarityProbById } = await loadGameMaster();

  const named = doobers.find((doober) => doober.Constant === dooberType);
  if (named) return named;

  const candidates = doobers.filter((doober) => doober.DooberType === dooberType);
  if (!candidates.length) return null;

  /**
   * Only the food ladder is climbed. The three soups are all COMMON and differ
   * by the buff they carry, so theirs stays an even draw on its own row.
   */
  if (dooberType === "FOOD_COOK") {
    const rarity = cookedTier(share, random);
    const tier = candidates.filter((doober) => doober.Rarity === rarity);
    if (tier.length) return tier[Math.floor(unitRandom(random) * tier.length)];
  }

  const table = RARITY_TABLE_BY_DOOBER_TYPE[dooberType] ?? "DOOBER";
  return pickByRarity(candidates, rarityProbById.get(table) ?? {}, random);
};

/**
 * In front of the hero by the action's offset, scattered by its own spread.
 *
 * "In front" needs the heading in radians and the wire carries degrees, so this
 * took a cosine of a number between 0 and 360 and scattered the chef's cooking
 * in a direction unrelated to where he was facing. See heading.js — the client
 * converts before it does the same arithmetic.
 */
const spawnPosition = (origin, heading, action, random) => {
  const reach = Number(action.offset ?? 0);
  const spreadX = Number(action.randomXoffset ?? 0);
  const spreadY = Number(action.randomYoffset ?? 0);
  const ahead = inFrontOf(origin, heading, reach);
  return {
    x: ahead.x + (unitRandom(random) * 2 - 1) * spreadX,
    y: ahead.y + (unitRandom(random) * 2 - 1) * spreadY,
  };
};

const expireDoober = (session, doid) => {
  session.dooberTimers?.delete(doid);
  if (!session.doobers?.has(doid)) return;
  session.doobers.delete(doid);
  if (session.objects?.get(doid) !== CLID.DistributedDooberGameObject) return;
  session.send(objectDisable(doid));
  session.objects.delete(doid);
};

/** One pickup: the roll, a clear place to land, and the pop-out animation. */
const cookOne = async (session, { action, origin, heading, random, share }) => {
  const doober = await cookedDoober(action.spawnname, random, share);
  if (!doober) {
    warn(`powerups: ${action.spawnname} has no concrete GameMaster doober`);
    return null;
  }

  let position = spawnPosition(origin, heading, action, random);
  if (isPositionBlocked(session.navigation, position)) {
    position = nearestClearPosition(session.navigation, position, 0, {
      reach: 300,
      reachableFrom: origin,
      towards: origin,
    });
  }
  if (!position) {
    warn(`[${session.id}] powerup had no clear landing position`);
    return null;
  }

  const doid = session.allocateDoid(CLID.DistributedDooberGameObject);
  session.objects?.set(doid, CLID.DistributedDooberGameObject);
  trackDoober(session, doid, {
    ...position,
    constant: doober.Constant,
    gold: doober.Gold ?? 0,
    xp: doober.Exp ?? 0,
    crowd: doober.Crowd ?? 0,
    hpPercentage: doober.HP_PERCENTAGE ?? 0,
    mpPercentage: doober.MP_PERCENTAGE ?? 0,
    buffGranted: doober.BuffGranted,
  });
  session.send(
    dooberGenerate({
      doid,
      parent: session.floorDoid,
      zone: session.dungeonZone ?? 0,
      dooberType: doober.Id,
      position,
    })
  );
  session.send(dooberSpawnFrom(doid, origin));

  const lifetimeMs = Math.max(0, Number(action.timetolive ?? 0) * 1000);
  if (lifetimeMs) {
    const timer = setTimeout(() => expireDoober(session, doid), lifetimeMs);
    timer.unref?.();
    session.dooberTimers ??= new Map();
    session.dooberTimers.set(doid, timer);
  }
  return doid;
};

/**
 * Makes a finished pot action server-visible. The client has the timeline
 * artwork but deliberately treats `spawndoober` as server-owned, so it can
 * never be the authority for these pickups or their buffs.
 */
export const spawnPowerup = async (
  session,
  { origin = session.heroPosition, heading = session.heroHeading, action, count } = {}
) => {
  if (!session.floorDoid || !origin || !action) return null;

  const random = session.random ?? Math.random;
  const gm = await loadGameMaster();
  const hero = await heroById(session.dungeonAvatar?.avatar_id);
  const wanted = count ?? cookedCount(random);

  /**
   * The share of COOKING this chef has bought, which is what decides quality.
   * A hero with no cooking slot has no share and cooks at the bottom of the
   * ladder, which is where a non-chef belongs.
   */
  const ceiling = hero ? superStatCeiling(gm, hero, "COOKING") : 0;
  const share =
    ceiling > 0 ? superStatValue(gm, hero, session.dungeonAvatar, "COOKING") / ceiling : 0;

  const doids = [];
  for (let index = 0; index < wanted; index++) {
    const doid = await cookOne(session, { action, origin, heading, random, share });
    if (doid) doids.push(doid);
  }
  if (doids.length) info(`[${session.id}] cooked ${doids.length} ${action.spawnname}`);
  return doids.length ? doids[0] : null;
};

/** An attack cooks something exactly when its own timeline says it does. */
export const powerupActionFor = (attack) => spawnDooberAction(attack?.AttackTimeline);

export const isPowerupAttack = async (attack) => Boolean(await powerupActionFor(attack));

/**
 * Schedules a timeline's own spawn frames at the client's 24 fps cadence.
 *
 * Anchored wherever the caller says rather than always on the hero, because a
 * cooking pot is not the only thing whose timeline leaves pickups behind: an
 * NPC's `DeathAttack` authors them too, and the reward chest is the one that
 * matters. `REWARD_CHEST_A` dies into `LOOT_SPAWN_A1`, whose timeline carries
 * forty-seven `spawndoober` actions between frames 10 and 145 — 24 EXP_SMALL,
 * 19 GOLD_SMALL, 4 GOLD_MEDIUM. At 24 fps that is a shower beginning 0.42s
 * after the break and lasting 5.63, which is what six recorded runs show:
 * forty-seven pickups, 5.66–5.78 seconds, every time.
 *
 * The cadence *is* the animation. Nothing staggers the drops on purpose — they
 * arrive as their frames come up — and `dooberSpawnFrom`, which `cookOne`
 * already sends, is what makes each one fly out of the chest instead of
 * appearing on top of it.
 *
 * The wait before an attack may be used again is not this function's business —
 * see cooldowns.js, which applies it to every attack that authors one.
 */
export const scheduleTimelineDoobers = async (session, attack, { origin, heading } = {}) => {
  const actions = await spawnDooberActions(attack?.AttackTimeline);
  const from = origin ?? session.heroPosition;
  if (!actions.length || !session.floorDoid || !from) return false;

  const floorDoid = session.floorDoid;
  const at = { ...from };
  const facing = heading ?? session.heroHeading;
  session.powerupSpawnTimers ??= new Set();

  /**
   * A timeline that authors several is describing an arrangement: twelve
   * hamburgers at twelve offsets and angles is a ring, and one per action is
   * what makes it one. A timeline that authors a single action is the cooking
   * pot, whose count is the chef's own roll — see `cookedCount`.
   */
  const perAction = actions.length > 1 ? 1 : undefined;

  /**
   * When this floor will have finished dropping things.
   *
   * `completeFloor` reads it so the victory countdown starts after the loot has
   * settled rather than on top of it: the chest's own timeline runs 6.3 seconds,
   * and the captures put COLLECT_TREASURE_GO at the end of that, not at the
   * break — chest death to dungeonEnding measures 13.37, 13.41 and 13.45s
   * against the 13.29 this produces.
   */
  const lastFrameMs = Math.max(
    ...actions.map((action) => (Number(action.frame ?? 0) / FRAMES_PER_SECOND) * 1000)
  );
  session.lootSettlesAt = Math.max(session.lootSettlesAt ?? 0, Date.now() + lastFrameMs);

  for (const action of actions) {
    const timer = setTimeout(
      () => {
        session.powerupSpawnTimers?.delete(timer);
        if (!session.dungeonActive || session.floorDoid !== floorDoid) return;
        spawnPowerup(session, { origin: at, heading: facing, action, count: perAction }).catch(
          (error) => warn(`[${session.id}] doober spawn failed: ${error.message}`)
        );
      },
      (Number(action.frame ?? 0) / FRAMES_PER_SECOND) * 1000
    );
    timer.unref?.();
    session.powerupSpawnTimers.add(timer);
  }
  return true;
};

/** The hero-anchored case, which is every powerup a player casts. */
export const schedulePowerup = (session, attack) => scheduleTimelineDoobers(session, attack);

/** Clears scheduled cooking and uncollected temporary pickup timers on teardown. */
export const clearDungeonPowerups = (session) => {
  for (const timer of session.powerupSpawnTimers ?? []) clearTimeout(timer);
  session.powerupSpawnTimers?.clear();
  for (const timer of session.dooberTimers?.values() ?? []) clearTimeout(timer);
  session.dooberTimers?.clear();
};

import { layerFor, dooberGenerate } from "./objects.js";
import { treasureForTier, dooberForConstant, mapNode, dooberById } from "../gamemaster.js";
import { CLID } from "./opcodes.js";
import { trackDoober } from "./pickups.js";
import { warn } from "../log.js";
import { plannedFloorEntry, plannedTreasure, plannedTreasureCount } from "./floors.js";

/**
 * The treasures and doobers a floor places: which placements are rewards,
 * what a reward placeholder stands in for, and `buildCollectables`.
 */

/**
 * Doober ids 30100..30105 are the four chests and the two item boxes — see
 * awardTreasureChest.
 *
 * The boxes were left out, and they are not scenery: SMALL_ITEM_BOX carries no
 * gold, no experience and no health, so `applyDooberReward` returned on its
 * first line and recorded nothing at all. The client still played the pickup,
 * because collecting is a frame the server sends before it decides what the
 * thing was worth — so a box looked collected and vanished.
 *
 * They are chests in the client's own vocabulary: UIHud names 60001..60004 for
 * the four chests and 60005, 60006 for the two boxes, one unbroken run.
 */
const FIRST_TREASURE_DOOBER = 30100;
const LAST_TREASURE_DOOBER = 30105;

const isTreasureDoober = (id) =>
  Number(id) >= FIRST_TREASURE_DOOBER && Number(id) <= LAST_TREASURE_DOOBER;

/**
 * How many reward spots on a floor actually pay a treasure.
 *
 * The tiles mark far more than a run is meant to hand over — an ordinary Arena
 * floor carries three `TREASURE` and sixteen `RANDOM_REWARD` against a node
 * that authorises two. Paying every one of them would multiply the reward
 * economy by ten.
 *
 * `MapPage.MaxTreasure` is the allowance, and it belongs to the run rather than
 * the floor: of 93 official runs on treasure-bearing nodes — 60 of one floor
 * and 33 of two — not one exceeded it, and a second floor bought nothing extra.
 *
 * Chests are placed with the floor rather than dropped by it. `CategoryProb`
 * gives TREASURE a flat 0 for ENEMY, PROP, PET and HERO, and the captures
 * agree: of 95 treasures observed, 90 arrived within two seconds of the floor
 * generate and the rest bore no relation to any death.
 */
const treasuresOwedFor = (node) => Math.max(0, Number(node?.MaxTreasure ?? 0));

/**
 * What a tile writes when it means "a reward goes here" without saying which.
 *
 * Both are the map node's to answer. Neither names a doober row, but only one
 * of them fails to name a DooberType as well — see `buildCollectables`.
 */
const REWARD_PLACEHOLDERS = new Set(["TREASURE", "RANDOM_REWARD"]);

/** Exported so a test can hold the list against what the trap actually is. */
export const isRewardPlaceholder = (constant) => REWARD_PLACEHOLDERS.has(constant);

/**
 * And what each of those spots becomes.
 *
 * `RaritySpawn` carries one row per tier rank spreading `TOTALS` 1 across five
 * chest rarities and the two item boxes, which answers both halves at once:
 * which rarity, and whether a chest arrives instead of a box. Reading only the
 * chest half is what left the boxes — the powerup drops — never spawning at
 * all, while 46 SMALL_ITEM_BOX and 26 ROYAL_ITEM_BOX appear across the official
 * recordings, more than any single chest.
 *
 * It also explains the shape of the run. ARENA_B is COMMON 0.5 / SMALL_ITEM_BOX
 * 0.5 against MaxTreasure 2, so chests per run come out binomial(2, 0.5) —
 * which is what 93 official runs measured:
 *
 *      0 chests   24%        binomial(2, 0.5) says 25%
 *      1 chest    51%                             50%
 *      2 chests   26%                             25%
 *
 * That half used to sit here as a constant. It is not a constant: ICE_CAVES_D
 * spreads 0.1/0.25/0.25 across three rarities and 0.4 across the two boxes.
 *
 * `LEGENDARY_CHEST` is zero on all 55 rows, so a tier roll can never pay one —
 * and no dragon chest appears in 70 official recordings. The only legendary in
 * the game is node 50083's `BossRewardTreasureId`, which is why that is asked
 * first.
 */
const rewardForPlacement = async (session, placement, node) => {
  const random = session.random ?? Math.random;
  /**
   * How many: the run rules' count where they give one (run-rules.js), else the
   * node's — counted once for the run, or once for each node's stretch where
   * the plan's floors bring their own (modes/README.md, `node`). An endless run
   * of bosses (delve) is one boss after another, each with its own allowance;
   * counted once, the first boss's would have stood for the whole run. Kept on
   * the session that builds the floor, not the world: in a party, a floor
   * another member builds starts from a full allowance (modes/README.md).
   */
  const countedFor = plannedFloorEntry(session)?.node?.Id ?? null;
  if (session.treasuresOwed == null || session.treasuresOwedNode !== countedFor) {
    session.treasuresOwed = plannedTreasureCount(session) ?? treasuresOwedFor(node);
    session.treasuresOwedNode = countedFor;
  }
  // What: the floor plan's or the run rules' treasure where they name one; "none" pays gold.
  const planned = plannedTreasure(session);

  if (session.treasuresOwed > 0 && planned !== "none") {
    const rewardId = planned ?? Number(node?.BossRewardTreasureId ?? 0);
    const treasure =
      (rewardId && (await dooberById(rewardId))) ||
      (await treasureForTier(node?.TierRank, random));
    if (treasure) {
      session.treasuresOwed -= 1;
      return treasure;
    }
  }

  /**
   * Everything the node does not owe a chest for still pays something. A spot
   * that rolled gold, or a treasure spot past the cap, becomes ordinary loot
   * rather than disappearing — the floor keeps its pickup either way.
   */
  return dooberForConstant("GOLD_MEDIUM", random);
};

export const buildCollectables = async (context, placements) => {
  const { session, floorDoid } = context;
  let built = 0;

  for (const placement of placements) {
    if (!context.isActive()) break;
    /**
     * The placeholders are asked about first, and that is not tidiness.
     *
     * `dooberForConstant` falls back to reading an unmatched constant as a
     * *DooberType* and picking one of that type at random, which is how FOOD
     * and FOOD_BUFF resolve. `TREASURE` is also a DooberType — the one all six
     * chests and boxes share — so a tile spot named TREASURE never reached the
     * branch below. It resolved to a uniform one-in-six instead, bypassing the
     * map node entirely.
     *
     * Reported from play as a legendary chest on a floor that cannot pay one,
     * and the recording says exactly that: node 50004 spawned a DRAGON_CHEST,
     * and 50003 spawned two ROYAL_ITEM_BOX and a SMALL_ITEM_BOX, while their
     * RANDOM_REWARD spots — which land in the branch below because nothing
     * shares that name — correctly paid the uncommon chest their tier allows.
     * Only node 50083 authorises a legendary anywhere in the game.
     *
     * It also broke the count. Each of these spots paid out unconditionally, so
     * an ordinary floor handed over its three TREASURE placements on top of
     * whatever the node actually owed.
     */
    let doober = REWARD_PLACEHOLDERS.has(placement.constant)
      ? null
      : await dooberForConstant(placement.constant, session.random ?? Math.random);
    if (!context.isActive()) break;
    if (!doober) {
      /**
       * RANDOM_REWARD and TREASURE are placeholders for "whatever this map node
       * pays out", which the tile cannot know. Two places carry it, and only
       * twelve nodes use the first:
       *
       *   MapPage.BossRewardTreasureId  a doober id, on the twelve BOSS nodes
       *   ColiseumTiers.Treasure        a RewardCategory, on everything else
       *
       * The other ninety-four nodes report BossRewardTreasureId 0, so reading
       * only that left every generated dungeon's chests unresolved and the
       * placement skipped — the reward simply never appeared on the floor.
       */
      const node = await mapNode(session.mapNodeId);
      const reward = await rewardForPlacement(session, placement, node);
      if (!reward) {
        warn(`dungeon: unresolved collectable "${placement.constant}"`);
        continue;
      }
      doober = reward;
    }

    const dooberDoid = session.allocateDoid(CLID.DistributedDooberGameObject);
    trackDoober(session, dooberDoid, {
      x: placement.x,
      y: placement.y,
      constant: doober.Constant,
      gold: doober.Gold ?? 0,
      xp: doober.Exp ?? 0,
      crowd: doober.Crowd ?? 0,
      hpPercentage: doober.HP_PERCENTAGE ?? 0,
      mpPercentage: doober.MP_PERCENTAGE ?? 0,
      // Marks this as a chest to be earned, the way spawnBossReward does.
      ...(isTreasureDoober(doober.Id) ? { treasure: doober.Id } : {}),
    });

    session.send(
      dooberGenerate({
        doid: dooberDoid,
        parent: floorDoid,
        zone: session.dungeonZone,
        dooberType: doober.Id,
        position: placement,
        // No Doobers column names a layer, so the tile is the only thing that
        // can lift a chest reward clear of the scenery it sits in.
        layer: layerFor(null, placement.layer),
      })
    );
    built++;
  }
  return built;
};

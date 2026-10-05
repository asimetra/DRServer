/**
 * Grants chests to an account, for testing the open flow in the real client.
 *
 *   node tools/grant.js                      # 2 of each weapon chest
 *   node tools/grant.js --chests 60004:5     # 5 legendary chests
 *   node tools/grant.js --coins 50000        # add gold
 *   node tools/grant.js --gems 500 --keys 20 # premium currency, 20 of each key
 *   node tools/grant.js --daily-reset        # make the daily reward claimable
 *   node tools/grant.js --level 100          # every hero to level 100
 *   node tools/grant.js --level 30 --hero 106  # just the Ghost Samurai
 *   node tools/grant.js --powerups            # 99 of every powerup
 *   node tools/grant.js --powerups 5          # 5 of every powerup
 *   node tools/grant.js --weapons 8           # 8 rolled weapons, unequipped, to trade
 *   node tools/grant.js --offer 55572          # grant an exact shop offer for free
 *   node tools/grant.js --placeables          # one of every weapon that places something
 *   node tools/grant.js --equip HERO_MONSTER_AXE   # and hold one of them
 *   node tools/grant.js --bombs               # 10 health and 10 party revive bombs
 *   node tools/grant.js --maps                # mark every non-Infinite map node beaten
 *   node tools/grant.js --maps ARENA          # only nodes whose TierRank starts ARENA
 *   node tools/grant.js --account 1000000005
 *
 * Works against whichever backend the server is configured for, so it needs the
 * same DR_STORAGE / DR_DATABASE_URL as the server.
 */
// Must be first: it fills the environment config.js reads as it is evaluated.
import "../src/load-env.js";
import {
  closeAccountStorage,
  loadAccount,
  saveAccount,
  nextObjectId,
} from "../src/accounts.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { giveChests, giveKeys, rollWeapons, setHeroLevel, topUpPowerups } from "../src/grants.js";
import { config } from "../src/config.js";
import { purchaseOffer } from "../src/store.js";
import { acquireProcessLock, initializeProcessStorage } from "../src/process-lock.js";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const accountId = Number(argument("account", 1000000005));

/** "60004:5,60003:2" -> [[60004, 5], [60003, 2]] */
const parseRequest = (text) =>
  text.split(",").map((part) => {
    const [chestId, count = "1"] = part.split(":");
    return [Number(chestId), Number(count)];
  });

/** Only granted when --chests is given, or when nothing else was asked for. */
const DEFAULT = "60001:2,60002:2,60003:2,60004:2";

const grant = async () => {
  const gm = await loadGameMaster();
  const chestsById = new Map(gm.raw.Chests.map((chest) => [chest.Id, chest]));
  const account = await loadAccount(accountId);
  account.account_chests ??= [];

  const askedForSomethingElse =
    ["coins", "gems", "keys", "level", "offer"].some((name) => argument(name)) ||
    process.argv.includes("--daily-reset") ||
    process.argv.includes("--powerups") ||
    process.argv.includes("--bombs") ||
    process.argv.includes("--maps") ||
    process.argv.includes("--placeables") ||
    argument("weapons") !== undefined ||
    Boolean(argument("equip"));
  const chestRequest = argument("chests", askedForSomethingElse ? "" : DEFAULT);

  for (const [chestId, count] of chestRequest ? parseRequest(chestRequest) : []) {
    const chest = chestsById.get(chestId);
    if (!chest) {
      console.error(`unknown chest ${chestId}`);
      continue;
    }
    await giveChests(account, chestId, count);
    console.log(`+${count} ${chest.Name} (${chest.Rarity})`);
  }

  // Chests are opened with a key of the matching rarity, so granting chests
  // without keys leaves them unopenable.
  const keys = Number(argument("keys", 0));
  if (keys) {
    giveKeys(account, keys);
    console.log(`+${keys} of each key`);
  }

  // AskAboutDailyReward reports the reward as claimed when last_reward_date
  // falls on today, and the client only shows the box screen when it does not.
  // Backdating a day is what makes it appear again.
  if (process.argv.includes("--daily-reset")) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    account.last_reward_date = yesterday.toISOString();
    console.log(`last_reward_date -> ${yesterday.toISOString().slice(0, 10)} (claimable again)`);
  }

  /** Levelling for testing (grants.js, setHeroLevel). */
  const level = argument("level");
  if (level !== undefined) {
    const onlyHero = argument("hero");
    const changed = setHeroLevel(account, { level: Number(level), hero: onlyHero ? Number(onlyHero) : null }, gm);
    for (const { hero, level: reached } of changed) console.log(`${hero} -> level ${reached}`);
  }

  /** Every powerup, for testing the two consumable slots: topped up to the count (grants.js). */
  if (process.argv.includes("--powerups")) {
    const count = Number(argument("powerups", 99)) || 99;
    const kinds = await topUpPowerups(account, count, gm);
    console.log(`${kinds} powerups topped up to ${count} each`);
  }

  /**
   * Opens the world map, for reaching a dungeon without playing to it.
   *
   * Completion is a bit per node in `completed_mapnode_mask`, indexed by
   * MapPage.BitIndex — the same bit awardDungeonCompletion sets on a first
   * clear. Infinite nodes are skipped: that mode is not implemented, so marking
   * them beaten would only put unreachable entries on the map.
   *
   * The mask lives on the account and is mirrored onto each avatar, which is
   * what the client reads back, so both are written here.
   */
  if (process.argv.includes("--maps")) {
    const { setMapNodeBit } = await import("../src/socket/rewards.js");
    const filter = argument("maps", "");
    const wanted = gm.raw.MapPage.filter(
      (node) =>
        node.NodeType !== "INFINITE" &&
        Number.isFinite(node.BitIndex) &&
        (!filter || String(node.TierRank ?? "").startsWith(filter))
    );

    let mask = account.completed_mapnode_mask ?? "";
    for (const node of wanted) mask = setMapNodeBit(mask, node.BitIndex);
    account.completed_mapnode_mask = mask;
    for (const avatar of account.account_avatars ?? []) {
      avatar.completed_mapnode_mask = mask;
    }
    account.completed_dungeons = Math.max(account.completed_dungeons ?? 0, wanted.length);
    console.log(`${wanted.length} map node(s) marked complete${filter ? ` (${filter}*)` : ""}`);
  }

  /**
   * The two revive bombs. Not powerups — both are `ItemCategory: STUFF` — and
   * they are worth granting on their own because the server now charges the
   * account for a self-revive, so an account holding none simply stays down.
   */
  if (process.argv.includes("--bombs")) {
    const count = Number(argument("bombs", 10)) || 10;
    account.account_stackables ??= [];
    for (const stackId of [60001, 60018]) {
      const row = gm.raw.Stackables.find((entry) => Number(entry.Id) === stackId);
      const existing = account.account_stackables.find(
        (entry) => Number(entry.stack_id) === stackId
      );
      if (existing) existing.count = count;
      else
        account.account_stackables.push({
          id: await nextObjectId(account),
          account_id: account.id,
          stack_id: stackId,
          count,
          is_new: 1,
        });
      console.log(`${row?.Name ?? stackId} set to ${count}`);
    }
  }

  /**
   * One of every hero weapon whose attack leaves something on the floor.
   *
   * Also read from the data: a weapon qualifies when its Attack1 or its charged
   * attack has a spawnnpc action on its timeline, which is exactly what
   * placeables.js acts on. That is the poison pot, the two fissure hammers and
   * the monster axe, the Ranger's decoy and the three Vampire Hunter traps.
   *
   * Granted unequipped, so they show up in the inventory to be tried against
   * whichever hero they belong to.
   */
  /** Spare weapons to trade with, rolled as a chest rolls them, unequipped (grants.js). */
  const weaponRequest = argument("weapons");
  if (weaponRequest !== undefined) {
    const wanted = Math.max(1, Number(weaponRequest) || 5);
    const made = await rollWeapons(account, wanted, { gm });
    if (!made) console.error(`account ${account.id} has no hero, and a weapon is rolled against one`);
    else console.log(`rolled ${made} weapon(s) into account ${account.id}`);
  }

  if (process.argv.includes("--placeables")) {
    const timelines = new Map(gm.raw.Attack.map((attack) => [attack.Constant, attack]));
    const placesSomething = (constant) => {
      const attack = constant && timelines.get(constant);
      const timeline = attack && gm.timelines.get(attack.AttackTimeline);
      return (timeline?.frames ?? []).some((frame) =>
        (frame.actions ?? []).some((action) =>
          ["spawnnpc", "spawnnpcforattack"].includes(String(action.type ?? "").toLowerCase())
        )
      );
    };

    account.account_items ??= [];
    let granted = 0;
    for (const weapon of gm.raw.WeaponItem) {
      if (!String(weapon.Constant ?? "").startsWith("HERO_")) continue;
      if (!placesSomething(weapon.Attack1) && !placesSomething(weapon.ChargeAttack)) continue;

      account.account_items.push({
        id: await nextObjectId(account),
        item_id: weapon.Id,
        account_id: account.id,
        power: Math.max(1, Math.round(Number(weapon.Power) || 1)),
        avatar_id: null,
        avatar_slot: null,
        is_new: 1,
        requiredlevel: 1,
        rarity: 1,
        modifier1: 0,
        modifier2: 0,
        legendarymodifier: 0,
        created: new Date().toISOString(),
      });
      granted++;
      console.log(`+ ${weapon.Constant}`);
    }
    console.log(`${granted} placing weapons granted, unequipped`);
  }

  /**
   * An exact authored offer, without charging its shop price.
   *
   * This is the generic way to grant named legendary variants. A Polaris Staff
   * is not a second WeaponItem: offer 55572 grants base item 18503 with the
   * authored legendary rarity, power, level and three modifiers. Rebuilding
   * that tuple here would be another store implementation, so the real free
   * purchase path remains the single source of truth.
   */
  const offerRequest = argument("offer");
  if (offerRequest !== undefined) {
    const offerId = Number(offerRequest);
    if (!Number.isInteger(offerId) || offerId <= 0) {
      throw new Error(`offer must be a positive integer, not "${offerRequest}"`);
    }
    const before = new Set((account.account_items ?? []).map((item) => Number(item.id)));
    const granted = await purchaseOffer({
      account,
      offerId,
      nextId: () => nextObjectId(account),
      free: true,
    });
    const items = (account.account_items ?? []).filter((item) => !before.has(Number(item.id)));
    console.log(
      `+ offer ${offerId} ${granted.offer.Name}` +
        (items.length ? ` — item instance(s) ${items.map((item) => item.id).join(", ")}` : "")
    );
  }

  /**
   * Puts a weapon in the active avatar's hand.
   *
   * Granting one is not holding one, and every scenario that exercises a weapon
   * needs it held: which weapon swung is what prices the attack, what the cast
   * is matched against, and what decides whether anything is placed at all.
   * Equipping is exactly setting `avatar_id` and `avatar_slot` on the item row,
   * which is what the captured `equipItemOnAvatar` does.
   */
  if (argument("equip")) {
    const wanted = String(argument("equip")).toUpperCase();
    const weapon = gm.raw.WeaponItem.find((item) => item.Constant === wanted);
    if (!weapon) {
      console.log(`no weapon called ${wanted}`);
    } else {
      const avatarId = Number(account.active_avatar);
      const avatar = (account.account_avatars ?? []).find(
        (candidate) => Number(candidate.id) === avatarId
      );
      account.account_items ??= [];
      let row = account.account_items.find((item) => Number(item.item_id) === Number(weapon.Id));
      if (!row) {
        row = {
          id: await nextObjectId(account),
          item_id: weapon.Id,
          account_id: account.id,
          power: Math.max(1, Math.round(Number(weapon.Power) || 1)),
          avatar_id: null,
          avatar_slot: null,
          is_new: 1,
          requiredlevel: 1,
          rarity: 1,
          modifier1: 0,
          modifier2: 0,
          legendarymodifier: 0,
          created: new Date().toISOString(),
        };
        account.account_items.push(row);
      }
      // Slot 1, and whatever was there steps aside rather than being held twice.
      for (const item of account.account_items) {
        if (Number(item.avatar_id) === avatarId && Number(item.avatar_slot) === 1) {
          item.avatar_id = null;
          item.avatar_slot = null;
        }
      }
      row.avatar_id = avatarId;
      row.avatar_slot = 1;
      console.log(
        `${weapon.Constant} equipped in slot 1 of avatar ${avatarId}` +
          (avatar ? ` (hero ${avatar.avatar_id})` : "")
      );
    }
  }

  const coins = Number(argument("coins", 0));
  if (coins) {
    account.basic_currency = (account.basic_currency ?? 0) + coins;
    console.log(`+${coins} coins -> ${account.basic_currency}`);
  }

  const gems = Number(argument("gems", 0));
  if (gems) {
    account.premium_currency = (account.premium_currency ?? 0) + gems;
    console.log(`+${gems} gems -> ${account.premium_currency}`);
  }

  await saveAccount(account);
  console.log(
    `account ${account.id} now holds ${account.account_chests.length} chest(s) ` +
      `[storage: ${config.storage}]`
  );
};

const main = async () => {
  const releaseProcessLock = await acquireProcessLock();
  try {
    // PostgreSQL's shared object-id sequence is repaired at server startup,
    // but this tool is also an exclusive allocator and may be the first process
    // run after an import. Initialize it under the same lock before any grant.
    await initializeProcessStorage();
    await grant();
  } finally {
    await releaseProcessLock();
    await closeAccountStorage();
  }
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.message);
    process.exit(1);
  }
);

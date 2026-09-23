import { legendaryDropBonus } from "../hero-stats.js";
import { saveAccount, nextObjectId } from "../accounts.js";
import { info, warn } from "../log.js";
import { getMapNodeBit, setMapNodeBit } from "../map-progress.js";
import { hitPointsUpdate } from "./combat.js";
import { CLID, OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { buffMultiplierFor } from "./buffs.js";
import { infiniteFloorGold, infiniteProgressFor } from "../infinite.js";

export { getMapNodeBit, setMapNodeBit } from "../map-progress.js";

export const FLID_PLAYER_BASIC_CURRENCY = 181;
export const FLID_HERO_EXPERIENCE_POINTS = 164;
export const FLID_HERO_DUNGEON_BUSTER_POINTS = 166;
export const FLID_HERO_MANA_POINTS = 163;

const fieldUpdate = (doid, fieldId, value) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(fieldId)
    .u32(value)
    .frame();

export const playerBasicCurrencyUpdate = (doid, value) =>
  fieldUpdate(doid, FLID_PLAYER_BASIC_CURRENCY, value);

export const heroExperienceUpdate = (doid, value) =>
  fieldUpdate(doid, FLID_HERO_EXPERIENCE_POINTS, value);

export const heroDungeonBusterPointsUpdate = (doid, value) =>
  fieldUpdate(doid, FLID_HERO_DUNGEON_BUSTER_POINTS, value);

export const heroManaPointsUpdate = (doid, value) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_HERO_MANA_POINTS)
    .u16(value)
    .frame();

const rewardAmount = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const rewardRatio = (value) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const percentageAmount = (maximum, ratio) =>
  ratio > 0 ? Math.max(1, Math.round(maximum * ratio)) : 0;

export const queueAccountSave = (session) => {
  const account = session.dungeonAccount;
  if (!account) return null;

  const persist = session.persistDungeonAccount ?? saveAccount;
  const previous = session.rewardSavePromise ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() => persist(account));
  session.rewardSavePromise = pending;
  pending.catch((error) =>
    warn(`[${session.id}] could not persist dungeon reward: ${error.message}`)
  );
  return pending;
};

/**
 * Tops the hero up by a share of its maximum, and reports it.
 *
 * Shared by anything that heals: food off the floor, the Battle Chef's pot, and
 * a health potion — which is the same idea spelled differently, as
 * `DoPercentHealthDamage` with `PercentHealthDamageValue` on its usage attack.
 */
export const healHero = (session, ratio) => {
  const hero = session.actors?.get(session.heroDoid);
  const share = rewardRatio(ratio);
  if (!share || !hero || hero.dead) return 0;

  const maximum = rewardAmount(hero.maxHitPoints);
  const previous = rewardAmount(hero.hitPoints);
  hero.hitPoints = Math.min(maximum, previous + percentageAmount(maximum, share));
  if (hero.hitPoints === previous) return 0;
  session.send(hitPointsUpdate(session.heroDoid, CLID.HeroGameObject, hero.hitPoints));
  return hero.hitPoints - previous;
};

/** The same for Mana, which lives on the session rather than on an actor. */
export const restoreMana = (session, ratio) => {
  const share = rewardRatio(ratio);
  if (!share || !session.heroDoid) return 0;

  const maximum = rewardAmount(session.maxHeroManaPoints);
  const previous = rewardAmount(session.heroManaPoints);
  session.heroManaPoints = Math.min(maximum, previous + percentageAmount(maximum, share));
  if (session.heroManaPoints === previous) return 0;
  session.send(heroManaPointsUpdate(session.heroDoid, session.heroManaPoints));
  return session.heroManaPoints - previous;
};

/**
 * A flat number of Mana points back, as `ManaPerHit` gives rather than as a
 * doober's percentage does. Only the Ranger's snare scroll carries it — five
 * a hit — and it is the whole reason to swing that weapon.
 */
export const grantMana = (session, points) => {
  const amount = rewardAmount(points);
  if (!amount || !session.heroDoid) return 0;

  const maximum = rewardAmount(session.maxHeroManaPoints);
  const previous = rewardAmount(session.heroManaPoints);
  session.heroManaPoints = Math.min(maximum, previous + amount);
  if (session.heroManaPoints === previous) return 0;
  session.send(heroManaPointsUpdate(session.heroDoid, session.heroManaPoints));
  return session.heroManaPoints - previous;
};

/** Gold, XP and Buster points are party progress; owner state remains per member. */
export const applyProgressReward = (
  session,
  { gold: offeredGold = 0, xp: offeredXp = 0, crowd: offeredCrowd = 0 }
) => {
  /**
   * Raised by whatever this member's own weapons carry — see
   * `legendaryDropBonus`. Applied here rather than where the doober is made,
   * because the drop is shared across the party and the legendary is not: one
   * player's `Midas Touch` pays that player and nobody else, which is what this
   * function being called once per member with their own context is for.
   */
  const weapons = session.heroWeapons ?? [];
  const gold = rewardAmount(offeredGold * (1 + legendaryDropBonus(weapons, "gold")));
  const xp = rewardAmount(offeredXp * (1 + legendaryDropBonus(weapons, "xp")));
  const crowd = rewardAmount(
    offeredCrowd * buffMultiplierFor(session, session.heroDoid, "BUSTER")
  );
  if (!gold && !xp && !crowd) return false;

  if (gold || xp) {
    session.dungeonRewards ??= { gold: 0, gems: 0, xp: 0 };
    session.dungeonRewards.gold += gold;
    session.dungeonRewards.xp += xp;
  }

  if (gold && session.dungeonAccount) {
    session.dungeonAccount.basic_currency =
      rewardAmount(session.dungeonAccount.basic_currency) + gold;
    if (session.playerDoid) {
      session.send(
        playerBasicCurrencyUpdate(session.playerDoid, session.dungeonAccount.basic_currency)
      );
    }
  }

  if (xp && session.dungeonAvatar) {
    session.dungeonAvatar.experience = rewardAmount(session.dungeonAvatar.experience) + xp;
    if (session.heroDoid) {
      session.send(heroExperienceUpdate(session.heroDoid, session.dungeonAvatar.experience));
    }
  }

  if (crowd) {
    const maximum = rewardAmount(session.maxDungeonBusterPoints) || 0xffffffff;
    session.dungeonBusterPoints = Math.min(
      maximum,
      rewardAmount(session.dungeonBusterPoints) + crowd
    );
    if (session.heroDoid) {
      session.send(
        heroDungeonBusterPointsUpdate(
          session.heroDoid,
          session.dungeonBusterPoints
        )
      );
    }
  }

  // Crowd is run-local; only account-backed Gold/XP need a persistence write.
  if (gold || xp) queueAccountSave(session);
  return true;
};

/** Applies the authoritative GameMaster values attached to a collected doober. */
export const applyDooberReward = (session, doober) => {
  const gold = rewardAmount(doober.gold);
  const xp = rewardAmount(doober.xp);
  const crowd = rewardAmount(doober.crowd);
  const hpPercentage = rewardRatio(doober.hpPercentage);
  const mpPercentage = rewardRatio(doober.mpPercentage);
  if (!gold && !xp && !crowd && !hpPercentage && !mpPercentage && !doober.treasure) {
    return false;
  }

  // A treasure picked up off the floor is a chest earned. The two tables run in
  // step — 30100..30103 against 60001..60004 — which a captured run confirms:
  // a GOLD_CHEST collected (30102) reported RARE CHEST (60003) as its loot.
  if (doober.treasure) awardTreasureChest(session, doober.treasure).catch(() => {});

  applyProgressReward(session, { gold, xp, crowd });

  healHero(session, hpPercentage);
  restoreMana(session, mpPercentage);

  return true;
};

/**
 * Records the deepest Infinite room the hero actually entered.
 *
 * The score is depth reached, not floors cleared. In an official run whose
 * last generated floor was 55009, losing on that floor made the next
 * championsboard response report score 10. Recording only from
 * `awardInfiniteFloor` left that same run at 9 and also kept the floor-three
 * chest grey on the map after the player had reached floor four.
 *
 * Called after the hero is installed on a floor, including late joins. The
 * queued write matters for the one room that is not subsequently cleared: a
 * normal floor award already saves the preceding rooms, while defeat or a
 * disconnect must not lose the room that was reached.
 */
export const noteInfiniteFloorReached = (session) => {
  const definition = session.infiniteDefinition;
  const account = session.dungeonAccount;
  if (!definition || !account) return null;

  const floorNumber = Math.max(1, Math.trunc(Number(session.floorIndex ?? 0)) + 1);
  const progress = infiniteProgressFor(account, {
    nodeId: session.mapNodeId,
    avatarDoid: session.dungeonAvatar?.id ?? session.heroDoid,
    epoch: session.infiniteEpoch,
    create: true,
  });
  if (floorNumber <= progress.score) return progress.score;

  progress.score = floorNumber;
  queueAccountSave(session);
  info(`[${session.id}] Infinite room ${floorNumber} reached — score ${progress.score}`);
  return progress.score;
};

/** Pays the data-authored Infinite floor coin and milestone rewards once. */
export const awardInfiniteFloor = (session) => {
  const definition = session.infiniteDefinition;
  const account = session.dungeonAccount;
  if (!definition || !account) return null;
  const floorNumber = (session.floorIndex ?? 0) + 1;
  session.infiniteAwardedFloors ??= new Set();
  if (session.infiniteAwardedFloors.has(floorNumber)) return null;
  session.infiniteAwardedFloors.add(floorNumber);

  const gold = infiniteFloorGold(definition, floorNumber);
  const gems = floorNumber === Number(definition.GemFloor)
    ? rewardAmount(definition.GemRewardAmount)
    : 0;
  const trophy = floorNumber === Number(definition.TrophyFloor) ? 1 : 0;
  const reward = [1, 2, 3, 4]
    .map((slot) => ({
      dooberId: Number(definition[`Reward${slot}`] ?? 0),
      floor: Number(definition[`Reward${slot}Floor`] ?? 0),
    }))
    .find((entry) => entry.floor === floorNumber && entry.dooberId > 0);

  account.basic_currency = rewardAmount(account.basic_currency) + gold;
  account.premium_currency = rewardAmount(account.premium_currency) + gems;
  account.trophies = rewardAmount(account.trophies) + trophy;
  const progress = infiniteProgressFor(account, {
    nodeId: session.mapNodeId,
    avatarDoid: session.dungeonAvatar?.id ?? session.heroDoid,
    epoch: session.infiniteEpoch,
    create: true,
  });
  // Reaching a room, rather than clearing it, owns the score. Keep this max as
  // a compatibility guard for callers that award a synthetic floor without
  // first building its world; production records it in noteInfiniteFloorReached.
  progress.score = Math.max(progress.score, floorNumber);
  if (reward && !progress.claimed.includes(reward.dooberId)) {
    progress.claimed.push(reward.dooberId);
    session.infiniteClaimedThisRun ??= new Set();
    session.infiniteClaimedThisRun.add(reward.dooberId);
  }
  session.dungeonRewards ??= { gold: 0, gems: 0, xp: 0 };
  session.dungeonRewards.gold += gold;
  session.dungeonRewards.gems += gems;
  if (session.playerDoid && gold) {
    session.send(playerBasicCurrencyUpdate(session.playerDoid, account.basic_currency));
  }
  if (reward) awardTreasureChest(session, reward.dooberId).catch(() => {});
  if (gold || gems || trophy || reward) queueAccountSave(session);
  info(
    `[${session.id}] Infinite floor ${floorNumber} — +${gold} gold, +${gems} gems, ` +
      `+${trophy} trophy${reward ? `, treasure ${reward.dooberId}` : ""}`
  );
  return { floorNumber, gold, gems, trophy, reward: reward?.dooberId ?? 0 };
};

/**
 * Pays out finishing a dungeon and records that it happened.
 *
 * The amounts are the map node's, never the client's: the shipped tables zero
 * the chest's own drop values precisely so this decision cannot be forged from
 * the outside. MapPage carries what a node is worth, and its BitIndex is what
 * the world map reads to decide which nodes have been beaten — without it every
 * run leaves no trace and the player is stuck replaying the first dungeon.
 */
export const awardDungeonCompletion = async (session) => {
  const account = session.dungeonAccount;
  const node = session.mapPage;
  if (!account || !node || session.completionAwarded) return null;
  session.completionAwarded = true;

  /**
   * First clear or a replay? The mask is the record, so it has to be read
   * before it is written. A node beaten before still pays its gold and
   * experience — that is why anyone farms a dungeon — but its trophy and its
   * keys are the reward for beating it, and are handed over once.
   */
  const bitIndex = Number.isFinite(node.BitIndex) ? Number(node.BitIndex) : null;
  const firstClear = bitIndex === null || !getMapNodeBit(account.completed_mapnode_mask, bitIndex);

  /**
   * Gold and experience are not paid here: they lie on the floor as the boss
   * chest's drop and are credited when the player walks over them. Paying both
   * would hand the node out twice.
   */
  const gold = 0;
  const experience = 0;
  const basicKeys = firstClear ? rewardAmount(node.BasicKeys) : 0;
  const premiumKeys = firstClear ? rewardAmount(node.PremiumKeys) : 0;
  /**
   * A trophy is for a boss, not for a dungeon.
   *
   * Twelve of the map's nodes are NodeType BOSS — Proving Grounds, the Knight
   * Fortress, Icewater Caverns, Dark Barrows, Prisoner's Keep and the rest —
   * and those are the ones that pay. The other eighty-five are ordinary
   * DUNGEONs and the nine INFINITEs are the Ultimates; neither pays a trophy.
   * The twelve are also exactly the nodes carrying a CustomTileset, which is
   * why they are hand-authored rather than laid out from the tile library.
   *
   * The amount is not in the tables — every node reports TrophyReq 0 and none
   * carries an award column — so one per boss beaten is taken from the game.
   */
  const trophies = firstClear && node.NodeType === "BOSS" ? 1 : 0;

  account.basic_currency = (account.basic_currency ?? 0) + gold;
  if (basicKeys) account.basic_keys = (account.basic_keys ?? 0) + basicKeys;
  if (premiumKeys) account.premium_keys = (account.premium_keys ?? 0) + premiumKeys;
  if (trophies) account.trophies = (account.trophies ?? 0) + trophies;
  account.completed_dungeons = (account.completed_dungeons ?? 0) + 1;

  const avatar = session.dungeonAvatar;
  if (bitIndex !== null) {
    account.completed_mapnode_mask = setMapNodeBit(account.completed_mapnode_mask, bitIndex);
    if (avatar) {
      avatar.completed_mapnode_mask = setMapNodeBit(avatar.completed_mapnode_mask, bitIndex);
    }
  }

  // The summary screen has a slot for this; it reads as "new" only once.
  session.receivedTrophy = trophies;

  if (avatar && experience) {
    avatar.experience = (avatar.experience ?? 0) + experience;
  }

  session.dungeonRewards ??= { gold: 0, gems: 0, xp: 0 };
  session.dungeonRewards.gold += gold;
  session.dungeonRewards.xp += experience;

  await queueAccountSave(session);
  info(
    `[${session.id}] ${firstClear ? "first clear of" : "replayed"} "${node.Name}" — ` +
      `+${gold} gold, +${experience} xp, +${basicKeys} basic key(s), ` +
      `+${trophies} trophy, node bit ${node.BitIndex}`
  );
  return { gold, experience, basicKeys, trophies, firstClear };
};

/** The first treasure doober and the first chest, so the offset lines them up. */
const FIRST_TREASURE_DOOBER = 30100;
const FIRST_CHEST = 60001;

/**
 * Notes the chest a collected treasure is worth — and deliberately does not
 * hand it over.
 *
 * A treasure picked up off the floor is not yet a chest on the account. It
 * becomes one when the player keeps it on the report screen, and until then it
 * lives only here, as the run's own record of what it is owed.
 *
 * Measured rather than assumed, because this was implemented the other way
 * round first. Across the official captures every one of seven increases in
 * `account_chests` follows a TakeChest or an OpenChest, and none happens on any
 * other event: one run collected four treasures, kept one and dropped three,
 * and the account went 6 → 7 — never to 10 and back. The report screen being
 * drawn does not do it either; the account still read 6 while it was up.
 *
 * So the three DropChests changed nothing, which is the tell: there was nothing
 * to remove. And walking out before the report keeps no chests at all, which is
 * what makes finishing the run worth something.
 *
 * Gold is the opposite and stays that way — it is banked as it is picked up,
 * and quitting mid-run does not give it back.
 */
export const awardTreasureChest = async (session, dooberType) => {
  const account = session.dungeonAccount;
  const chestId = FIRST_CHEST + (Number(dooberType) - FIRST_TREASURE_DOOBER);
  /* Six, not four: the two item boxes sit at the top of the same run, which is
     the client's own numbering rather than this server's arithmetic. */
  if (!account || chestId < FIRST_CHEST || chestId > FIRST_CHEST + 5) return null;

  session.dungeonTreasures ??= [];
  session.dungeonTreasures.push({ dooberType: Number(dooberType), chestId });

  // Nothing to save: the account has not changed, and will not until the
  // player keeps this on the report.
  info(`[${session.id}] treasure ${dooberType} collected — chest ${chestId} owed`);
  return chestId;
};

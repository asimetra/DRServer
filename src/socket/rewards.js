import { legendaryDropBonus } from "../hero-stats.js";
import { matchHost } from "./match-host.js";
import { info, warn } from "../log.js";
import { getMapNodeBit, setMapNodeBit } from "../map-progress.js";
import { hitPointsUpdate } from "./combat.js";
import { CLID, OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { buffMultiplierFor } from "./buffs.js";
import { infiniteFloorGold, infiniteProgressFor, infiniteTrophiesFor } from "../infinite.js";
import { followRunSave } from "./run-saves.js";
import { membersOf, worldOf } from "./match-world.js";
import { config } from "../config.js";

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

/**
 * The completion share the account's roster adds: a sixteenth of the node's
 * bonus for every hero owned past the second.
 *
 * Every solo run in the official corpus pays exactly this: a five-hero account
 * on five nodes (2325 -> 435, 2220 -> 416, 2015 -> 377, …), a six-hero one on
 * twenty, and nothing to accounts of one and two heroes. The client's battle
 * popup says five percent per hero past the first, which the six-hero runs
 * cannot tell apart and the five-hero runs disprove. Two cases pay more and
 * are not modelled: parties (the same five-hero account got 465 beside a
 * six-hero one) and one three-hero account (137 -> 15). In neither is this
 * above what the official gave, so it never pays out more. Floored, and never
 * more than the bonus itself.
 */
export const completionTeamXpBonus = (node, account) => {
  const bonus = rewardAmount(node?.CompletionXPBonus);
  const crew = Math.max(0, (account?.account_avatars ?? []).length - 2);
  return Math.max(0, Math.min(bonus, Math.floor((bonus * crew) / 16)));
};

export const queueAccountSave = (session) => {
  const account = session.dungeonAccount;
  if (!account) return null;
  // Whatever was waiting for a checkpoint goes with this save: it writes the
  // account, and the account is where the coins already are.
  session.accountChanged = false;

  const persist = session.persistDungeonAccount ?? matchHost().saveAccount;
  const previous = session.rewardSavePromise ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() => persist(account));
  session.rewardSavePromise = pending;
  // Followed to the end: a save storage refuses is tried again, and the account
  // is not let go until it is written. See run-saves.js.
  followRunSave(account.id, pending, () => persist(account));
  pending.catch((error) =>
    warn(`[${session.id}] could not persist dungeon reward: ${error.message}`)
  );
  return pending;
};

/**
 * Writes the accounts of a run that have changed since they were last written.
 *
 * Gold and experience used to queue a save each as they were picked up — on a
 * player's own recordings a third of a save a second, four a second in a
 * fight, every one of them the whole account. Nothing about a coin needs
 * storage that instant: the client is told the new total from the account in
 * memory, and that account is what every later save writes.
 *
 * So a pickup only marks the account, and this is what writes it: when a floor
 * ends, and on the run's clock. The other endings write the account themselves
 * and always did — the report, leaving, being dropped, the server stopping —
 * and anything else that saves in between (a chest, an Infinite floor's
 * reward, a bomb spent) takes the coins along, because a save is of the
 * account and not of the thing that prompted it.
 */
export const saveChangedAccounts = (session) => {
  let saved = 0;
  for (const member of membersOf(worldOf(session) ?? session)) {
    const context = member.world && !member.world.destroyed ? member.world.contextFor(member) : member;
    if (!context.accountChanged) continue;
    queueAccountSave(context);
    saved += 1;
  }
  return saved;
};

/**
 * The run's clock: every so often, whatever changed is written.
 *
 * For the endings nothing can announce. A match worker that dies takes its
 * memory with it, and so does a process that is killed; neither gets to save
 * on the way out. The clock is what bounds those to one interval of gold and
 * experience — thirty seconds unless `ODS_RUN_CHECKPOINT_SECONDS` says
 * otherwise, and none at all at zero, for an operator who would rather have no
 * write that an ending did not ask for.
 *
 * One a run, on the run's own scope, so it stops with the run.
 */
export const startRunCheckpoints = (session, intervalMs = config.runCheckpointMs) => {
  const scope = session.runScope;
  if (!scope || !(intervalMs > 0) || session.runCheckpoint) return false;
  session.runCheckpoint = scope.interval(() => saveChangedAccounts(session), intervalMs);
  return true;
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

/**
 * The whole points in an amount of experience, with the rest kept for next time.
 *
 * A star arrives as a whole number — run-xp.js rounds it where it drops — but a
 * legendary that raises experience by a share makes it fractional again, and
 * the hero's total is whole. Truncating each one would lose the share entirely
 * on a small star (a tenth more of 1 is never 2), so what does not make a point
 * is carried to the next. It is this member's own and less than a point, so
 * nothing is owed for it when the run ends.
 */
const wholeExperience = (session, offered) => {
  if (!Number.isFinite(offered) || offered <= 0) return 0;
  // The epsilon is for sums such as five 9.2s arriving as 45.99999999999999.
  const owed = offered + (session.xpCarry ?? 0);
  const whole = Math.floor(owed + 1e-9);
  session.xpCarry = Math.max(0, owed - whole);
  return whole;
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
  const xp = wholeExperience(session, offeredXp * (1 + legendaryDropBonus(weapons, "xp")));
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

  // Crowd is run-local; only account-backed Gold/XP have anything to write,
  // and not now — see saveChangedAccounts.
  if ((gold || xp) && session.dungeonAccount) session.accountChanged = true;
  return true;
};

/** Applies the authoritative GameMaster values attached to a collected doober. */
export const applyDooberReward = (session, doober) => {
  const gold = rewardAmount(doober.gold);
  // Left fractional: applyProgressReward carries what does not make a point.
  const xp = Number.isFinite(doober.xp) ? Math.max(0, doober.xp) : 0;
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
  // A floor reached by `/complete` was not reached; see `runAssisted`.
  if (session.runAssisted) return null;

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
  /**
   * A run that had a floor ended by command pays no floor from then on, and
   * `noteInfiniteFloorReached` raises no depth for it. Depth is the only thing
   * an Infinite dungeon measures, and a command that walks through its floors
   * would otherwise be the fastest way to all of its rewards.
   */
  if (session.runAssisted) return null;
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
  const progress = infiniteProgressFor(account, {
    nodeId: session.mapNodeId,
    avatarDoid: session.dungeonAvatar?.id ?? session.heroDoid,
    epoch: session.infiniteEpoch,
    create: true,
  });
  if (trophy) {
    account.infinite_progress.trophies = infiniteTrophiesFor(account) + trophy;
    account.trophies = rewardAmount(account.trophies) + trophy;
  }
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

  // Coins are collected from the floor. Completion XP is paid here for every
  // node type; boss chests therefore carry no second copy of it.
  const gold = 0;
  const experience = rewardAmount(node.CompletionXPBonus);
  const teamExperience = completionTeamXpBonus(node, account);
  const basicKeys = firstClear ? rewardAmount(node.BasicKeys) : 0;
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
  /**
   * And a trophy comes with gems.
   *
   * Reported from play on the official server: a boss beaten for the first
   * time pays twenty-five gems beside its trophy and its key. Nothing here
   * paid any — completing a node never touched the premium currency. Like the
   * trophy itself the amount is in no table: no MapPage column carries gems,
   * and the only gem figures in the game data are the shop's and the Infinite
   * dungeons' own gem floor, which is the same twenty-five. So it is the
   * server's setting, `trophyGems`, and what the game paid is its default.
   */
  const gems = trophies * rewardAmount(config.trophyGems);

  account.basic_currency = (account.basic_currency ?? 0) + gold;
  if (basicKeys) account.basic_keys = (account.basic_keys ?? 0) + basicKeys;
  if (trophies) account.trophies = (account.trophies ?? 0) + trophies;
  if (gems) account.premium_currency = rewardAmount(account.premium_currency) + gems;
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

  session.completionXpBonus = experience;
  session.completionTeamXpBonus = teamExperience;
  /**
   * Banked, and not announced on the hero. The report carries both lines and
   * the client counts the bar up from `completionXpBase`; the official sends no
   * experience update after dungeonEnding on any of 47 recorded endings. By now
   * a party that walked out has no hero on the floor to send one to.
   */
  if (avatar) {
    session.completionXpBase = rewardAmount(avatar.experience);
    avatar.experience = session.completionXpBase + experience + teamExperience;
  }

  session.dungeonRewards ??= { gold: 0, gems: 0, xp: 0 };
  session.dungeonRewards.gold += gold;
  session.dungeonRewards.gems = (session.dungeonRewards.gems ?? 0) + gems;

  await queueAccountSave(session);
  info(
    `[${session.id}] ${firstClear ? "first clear of" : "replayed"} "${node.Name}" — ` +
      `+${gold} gold, +${experience} xp (+${teamExperience} crew), +${basicKeys} basic key(s), ` +
      `+${trophies} trophy, +${gems} gems, node bit ${node.BitIndex}`
  );
  return { gold, experience, basicKeys, trophies, gems, firstClear };
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

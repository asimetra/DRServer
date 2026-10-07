import { info } from "../log.js";
import { CLID, OP } from "./opcodes.js";
import { dooberGenerate } from "./objects.js";
import { PacketWriter } from "./packet.js";
import { trackDoober } from "./pickups.js";
import { xpWeightOf } from "./run-xp.js";
import { plannedTreasure } from "./floors.js";

export const FLID_DOOBER_SPAWN_FROM = 290;

const positiveNumber = (value) =>
  Number.isFinite(value) ? Math.max(0, Number(value)) : 0;

const rewardAmount = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0);

const unitRandom = (random) => Math.min(1 - Number.EPSILON, Math.max(0, random()));

const weightedKey = (weights, random) => {
  const entries = Object.entries(weights).filter(
    ([key, weight]) => key !== "Id" && positiveNumber(weight) > 0
  );
  const total = entries.reduce((sum, [, weight]) => sum + positiveNumber(weight), 0);
  if (!total) return null;

  let point = unitRandom(random) * total;
  for (const [key, weight] of entries) {
    point -= positiveNumber(weight);
    if (point < 0) return key;
  }
  return entries.at(-1)?.[0] ?? null;
};

const randomItem = (items, random) =>
  items.length ? items[Math.floor(unitRandom(random) * items.length)] : null;

/**
 * One of the candidates, drawn by the authored rarity weights rather than
 * evenly. Shared with the Battle Chef's pots, which face the same question.
 */
export const pickByRarity = (candidates, rarityProb, random) => {
  if (!candidates.length) return null;
  const rarity = weightedKey(rarityProb, random);
  const matching = rarity
    ? candidates.filter((candidate) => candidate.Rarity === rarity)
    : [];
  return randomItem(matching.length ? matching : candidates, random);
};

const isGold = (doober) => doober.DooberType === "GOLD" || doober.DooberType === "COIN";

/**
 * The star a monster leaves, which its own row names.
 *
 * `XP_DOOBER_VISUAL` is the doober and `XP` is what it weighs. The official
 * never rolls it: every recorded kill at weight 1 dropped EXP_SMALL, at 3
 * EXP_MEDIUM and at 10 EXP_LARGE — 7151 kills, none otherwise. A row that
 * weighs nothing leaves no star whatever visual it carries; what counts as
 * weighing something is run-xp.js's to say.
 */
export const xpDooberFor = (npc, allDoobers = []) => {
  if (!xpWeightOf(npc)) return null;
  return (
    allDoobers.find(
      (doober) => doober.DooberType === "EXP" && doober.Constant === npc.XP_DOOBER_VISUAL
    ) ?? null
  );
};

/**
 * Production emits a star and a coin for reward-bearing enemies and then
 * applies the NPC's authored probability/count to the CategoryProb/DooberDrop
 * matrix. All selection inputs here are GameMaster-authored rather than
 * hard-coded ids; what the star is worth is the run's — see run-xp.js.
 *
 * `xp: false` leaves the star out, for a monster another one called up.
 */
export const rollNpcRewardDoobers = (npc, rewardData, random = Math.random, { xp = true } = {}) => {
  const rewards = [];
  const { allDoobers = [], candidates = [], categoryProb = {}, rarityProb = {} } =
    rewardData ?? {};

  const experience = xp ? xpDooberFor(npc, allDoobers) : null;
  if (experience) rewards.push(experience);
  if (npc.CharType === "ENEMY" && positiveNumber(npc.Exp) > 0) {
    const gold = pickByRarity(candidates.filter(isGold), rarityProb, random);
    if (gold) rewards.push(gold);
  }

  const probability = Math.min(1, positiveNumber(npc.DooberProb));
  if (unitRandom(random) >= probability) return rewards;

  const min = Math.max(0, Math.trunc(positiveNumber(npc.MinDoobers)));
  const max = Math.max(min, Math.trunc(positiveNumber(npc.MaxDoobers)));
  const count = min + Math.floor(unitRandom(random) * (max - min + 1));

  for (let index = 0; index < count; index++) {
    const category = weightedKey(categoryProb, random);
    const categoryCandidates = category
      ? candidates.filter((candidate) => candidate.DooberType === category)
      : [];
    const reward = pickByRarity(
      categoryCandidates.length ? categoryCandidates : candidates,
      rarityProb,
      random
    );
    if (reward) rewards.push(reward);
  }

  return rewards;
};

export const dooberSpawnFrom = (doid, position) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_DOOBER_SPAWN_FROM)
    .f32(position.x)
    .f32(position.y)
    .frame();

const landingPosition = (origin, index, total, baseAngle, random) => {
  const angle = baseAngle + (index * Math.PI * 2) / Math.max(1, total);
  const distance = 90 + unitRandom(random) * 70;
  return {
    x: origin.x + Math.cos(angle) * distance,
    y: origin.y + Math.sin(angle) * distance,
  };
};

/** Generates death drops at their landing points, then starts the fly-out animation. */
export const spawnNpcRewards = (
  session,
  { floorDoid, npc, rewardData, origin, random = Math.random, xp = true, xpWorth }
) => {
  const active = session.infiniteActiveModifiers ?? [];
  const noHealth = active.some((modifier) => modifier.NoHealthDrop);
  const noMana = active.some((modifier) => modifier.NoManaDrop);
  const noBuster = active.some((modifier) => modifier.NoBusterDrop);
  // The one doober whose worth is the run's rather than its own column.
  const star = xp ? xpDooberFor(npc, rewardData?.allDoobers) : null;
  const rewards = rollNpcRewardDoobers(npc, rewardData, random, { xp }).filter((doober) =>
    !(noHealth && Number(doober.HP_PERCENTAGE ?? 0) > 0) &&
    !(noMana && Number(doober.MP_PERCENTAGE ?? 0) > 0) &&
    !(noBuster && Number(doober.Crowd ?? 0) > 0)
  );
  if (!rewards.length || !floorDoid || !origin) return [];

  const baseAngle = unitRandom(random) * Math.PI * 2;
  const spawned = [];
  for (let index = 0; index < rewards.length; index++) {
    const doober = rewards[index];
    const position = landingPosition(origin, index, rewards.length, baseAngle, random);
    const doid = session.allocateDoid(CLID.DistributedDooberGameObject);
    trackDoober(session, doid, {
      ...position,
      constant: doober.Constant,
      gold: doober.Gold ?? 0,
      xp: doober === star && Number.isFinite(xpWorth) ? xpWorth : doober.Exp ?? 0,
      crowd: doober.Crowd ?? 0,
      hpPercentage: doober.HP_PERCENTAGE ?? 0,
      mpPercentage: doober.MP_PERCENTAGE ?? 0,
    });
    session.send(
      dooberGenerate({
        doid,
        parent: floorDoid,
        zone: session.dungeonZone ?? 0,
        dooberType: doober.Id,
        position,
      })
    );
    session.send(dooberSpawnFrom(doid, origin));
    spawned.push({ doid, doober, position });
  }

  info(
    `[${session.id}] ${npc.Constant} dropped ` +
      spawned.map(({ doober }) => doober.Constant).join(", ")
  );
  return spawned;
};

/**
 * Drops a map node's boss reward where its chest stood.
 *
 * The chest's own GameMaster row pays nothing — DooberProb and Exp are both
 * zero, deliberately, because a reward the client can see is a reward it can
 * forge. What it is worth belongs to the node: BossRewardTreasureId names the
 * pickup and TotalEnemyCoin says what it carries. CompletionXPBonus is paid
 * for every node by awardDungeonCompletion, so putting it here would pay boss
 * nodes twice and ordinary nodes not at all.
 */
export const spawnBossReward = (session, { floorDoid, origin, node, random = Math.random }) => {
  if (!node || !floorDoid || !origin) return null;

  // The floor plan's treasure, where it names one, stands in for the node's.
  const dooberType = plannedTreasure(session) ?? Number(node.BossRewardTreasureId ?? 0);
  if (!dooberType) return null;

  const doid = session.allocateDoid(CLID.DistributedDooberGameObject);
  trackDoober(session, doid, {
    ...landingPosition(origin, 0, 1, unitRandom(random) * Math.PI * 2, random),
    constant: `MAPNODE_${node.Id}_REWARD`,
    gold: rewardAmount(node.TotalEnemyCoin),
    xp: 0,
    crowd: 0,
    hpPercentage: 0,
    mpPercentage: 0,
    // Marks this as a chest to be earned, not just coins on the floor.
    treasure: dooberType,
  });
  session.send(
    dooberGenerate({
      doid,
      parent: floorDoid,
      zone: session.dungeonZone,
      dooberType,
      position: session.doobers.get(doid),
    })
  );
  info(
    `[${session.id}] boss reward ${dooberType} dropped — ` +
      `${rewardAmount(node.TotalEnemyCoin)} gold`
  );
  return doid;
};

/**
 * One piece of food, dropped by a weapon rather than by the monster.
 *
 * `Saucier` and `Cook's` spawn food on hitting and on killing, and neither the
 * client nor this server read their columns.
 *
 * Which food is not a choice. Two doobers carry `DooberType` `CHEF_FOOD` and
 * they are named after the two events: `FOOD_CHEF_HIT`, the "Chef Burger" worth
 * 2% of the bar, and `FOOD_CHEF_DEATH`, the "Chef Cupcake" worth 20%. Neither
 * appears in `DooberDrop` at all — no monster drops either — so they exist for
 * this and for the Battle Chef's `COOKING`, whose `HitSpawnBase` of 1% and
 * `DeathSpawnBase` of 5% are the same two events again.
 *
 * The first version of this picked from the victim's own drop table instead,
 * which handed out sausages and bacon. Those are ordinary loot; the burger is
 * the one the modifier promises.
 */
const CHEF_FOOD = { hit: "FOOD_CHEF_HIT", death: "FOOD_CHEF_DEATH" };

export const spawnFoodDoober = (session, { gm, floorDoid, origin, onDeath = false, random = Math.random }) => {
  if (!floorDoid || !origin) return null;
  const wanted = onDeath ? CHEF_FOOD.death : CHEF_FOOD.hit;
  const doober = gm?.dooberByConstant?.get(wanted);
  if (!doober) return null;

  const position = landingPosition(origin, 0, 1, unitRandom(random) * Math.PI * 2, random);
  const doid = session.allocateDoid(CLID.DistributedDooberGameObject);
  trackDoober(session, doid, {
    ...position,
    constant: doober.Constant,
    gold: doober.Gold ?? 0,
    xp: doober.Exp ?? 0,
    crowd: doober.Crowd ?? 0,
    hpPercentage: doober.HP_PERCENTAGE ?? 0,
    mpPercentage: doober.MP_PERCENTAGE ?? 0,
  });
  session.send(
    dooberGenerate({
      doid,
      parent: floorDoid,
      zone: session.dungeonZone ?? 0,
      dooberType: doober.Id,
      position,
    })
  );
  session.send(dooberSpawnFrom(doid, origin));
  return { doid, doober, position };
};

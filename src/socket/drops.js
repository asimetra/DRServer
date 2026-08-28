import { info } from "../log.js";
import { CLID, OP } from "./opcodes.js";
import { dooberGenerate } from "./objects.js";
import { PacketWriter } from "./packet.js";
import { trackDoober } from "./pickups.js";

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
 * Production emits a base XP/gold pair for reward-bearing enemies and then
 * applies the NPC's authored probability/count to the CategoryProb/DooberDrop
 * matrix. Exact late-game scaling is still calibration work; all selection
 * inputs here are nevertheless GameMaster-authored rather than hard-coded ids.
 */
export const rollNpcRewardDoobers = (npc, rewardData, random = Math.random) => {
  const rewards = [];
  const { allDoobers = [], candidates = [], categoryProb = {}, rarityProb = {} } =
    rewardData ?? {};

  if (npc.CharType === "ENEMY" && positiveNumber(npc.Exp) > 0) {
    const experience = pickByRarity(
      allDoobers.filter((doober) => doober.DooberType === "EXP"),
      rarityProb,
      random
    );
    const gold = pickByRarity(candidates.filter(isGold), rarityProb, random);
    if (experience) rewards.push(experience);
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
  { floorDoid, npc, rewardData, origin, random = Math.random }
) => {
  const rewards = rollNpcRewardDoobers(npc, rewardData, random);
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
 * pickup and TotalEnemyCoin and CompletionXPBonus say what it carries.
 */
export const spawnBossReward = (session, { floorDoid, origin, node, random = Math.random }) => {
  if (!node || !floorDoid || !origin) return null;

  const dooberType = Number(node.BossRewardTreasureId ?? 0);
  if (!dooberType) return null;

  const doid = session.allocateDoid(CLID.DistributedDooberGameObject);
  trackDoober(session, doid, {
    ...landingPosition(origin, 0, 1, unitRandom(random) * Math.PI * 2, random),
    constant: `MAPNODE_${node.Id}_REWARD`,
    gold: rewardAmount(node.TotalEnemyCoin),
    xp: rewardAmount(node.CompletionXPBonus),
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
      `${rewardAmount(node.TotalEnemyCoin)} gold, ${rewardAmount(node.CompletionXPBonus)} xp`
  );
  return doid;
};

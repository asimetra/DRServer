/**
 * The week, as the client counts it.
 *
 * Epoch parameters, taken from a live capture of the official server rather
 * than guessed: a one-week window offset by 40 hours. The client is sent both
 * with the server's time and counts weeks as `int((seconds + offset) /
 * duration)` (GameClock.getEpoch), which turns on Tuesday at 08:00 UTC.
 *
 * This server told the client that and then counted its own weeks from the
 * Unix epoch with no offset, which turn on Thursday at midnight. For forty
 * hours of every week the two were in different weeks: the map's countdown
 * reached zero and the scores it promised to reset stayed where they were.
 * One clock now, here, for the answer the client is given and for everything
 * this server resets by it.
 */
export const EPOCH_DURATION_SECONDS = 604800;
export const EPOCH_OFFSET_SECONDS = 144000;

/** Trophies earned outside boss-clear masks, kept with Infinite progress. */
export const infiniteTrophiesFor = (account) =>
  Math.max(0, Math.trunc(Number(account?.infinite_progress?.trophies ?? 0)));

export const infiniteEpoch = (now = Date.now()) =>
  Math.floor((Number(now) / 1000 + EPOCH_OFFSET_SECONDS) / EPOCH_DURATION_SECONDS);

const progressRootOf = (account) => {
  if (!account.infinite_progress || typeof account.infinite_progress !== "object") {
    account.infinite_progress = {};
  }
  return account.infinite_progress;
};

/**
 * A hero's Infinite trophy: once, ever, whichever node it was earned on.
 *
 * Kept beside the count, by hero, because the count alone could not say who
 * had been paid — and so everybody was, every run. Returns whether this hero
 * had it still to earn, and records that it now has.
 */
export const claimInfiniteTrophy = (account, avatarId) => {
  const root = progressRootOf(account);
  const hero = Number(avatarId);
  const earned = Array.isArray(root.trophy_heroes) ? root.trophy_heroes.map(Number) : [];
  if (earned.includes(hero)) return false;
  root.trophy_heroes = [...earned, hero];
  root.trophies = infiniteTrophiesFor(account) + 1;
  return true;
};

/** A hero's Infinite gems: once in each week, whichever node they were earned on. */
export const claimInfiniteGems = (account, avatarId, epoch) => {
  const root = progressRootOf(account);
  const weeks = root.gem_weeks && typeof root.gem_weeks === "object" ? root.gem_weeks : {};
  if (Number(weeks[Number(avatarId)]) === Number(epoch)) return false;
  root.gem_weeks = { ...weeks, [Number(avatarId)]: Number(epoch) };
  return true;
};

export const infiniteDefinitionForNode = (gm, node) => {
  if (node?.NodeType !== "INFINITE") return null;
  return (gm?.raw?.InfiniteDungeons ?? []).find(
    (row) => row.Constant === node.InfiniteDungeon || Number(row.Id) === Number(node.Id)
  ) ?? null;
};

/** Deterministic weekly selection: four distinct authored modifiers per node. */
export const infiniteModifierIdsForNode = (gm, node, epoch = infiniteEpoch()) => {
  const candidates = (gm?.raw?.DungeonModifier ?? [])
    .map((row) => Number(row.Id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((a, b) => a - b);
  if (candidates.length < 4) return [];

  let state = (Number(node?.Id ?? 0) ^ Math.imul(Number(epoch), 0x9e3779b1)) >>> 0;
  const pool = [...candidates];
  const selected = [];
  while (selected.length < 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    selected.push(pool.splice(state % pool.length, 1)[0]);
  }
  return selected;
};

export const infiniteMapDetails = (gm, { epoch = infiniteEpoch() } = {}) =>
  (gm?.raw?.MapPage ?? [])
    .filter((node) => node.NodeType === "INFINITE")
    .map((node) => ({
      epoch,
      nodeId: Number(node.Id),
      modifiers: infiniteModifierIdsForNode(gm, node, epoch),
    }));

export const activeInfiniteModifiers = (gm, definition, modifierIds, floorNumber) => {
  if (!definition) return [];
  const rowsById = new Map((gm?.raw?.DungeonModifier ?? []).map((row) => [Number(row.Id), row]));
  return modifierIds.flatMap((id, index) => {
    const startsAt = Math.max(1, Number(definition[`DMod${index + 1}FloorStart`] ?? Infinity));
    if (floorNumber < startsAt) return [];
    const row = rowsById.get(Number(id));
    return row ? [{ ...row, newThisFloor: floorNumber === startsAt ? 1 : 0 }] : [];
  });
};

export const infiniteFloorGold = (definition, floorNumber) => {
  if (!definition) return 0;
  return Math.max(0, Math.min(
    Number(definition.CoinRewardCap ?? Infinity),
    Number(definition.CoinRewardBase ?? 0) +
      Number(definition.CoinRewardFloor ?? 0) * Math.max(0, Number(floorNumber ?? 0))
  ));
};

export const infiniteRewards = (
  definition,
  floorNumber,
  { alreadyClaimed = [], claimedThisRun = [] } = {}
) => {
  if (!definition) return [];
  const claimed = new Set(alreadyClaimed.map(Number));
  const currentRun = new Set(claimedThisRun.map(Number));
  return [1, 2, 3, 4].map((slot) => {
    const dooberId = Number(definition[`Reward${slot}`] ?? 0);
    const rewardFloor = Number(definition[`Reward${slot}Floor`] ?? 0);
    let status = 0;
    if (claimed.has(dooberId)) status = 1;
    else if (floorNumber === rewardFloor) status = 3;
    else if (currentRun.has(dooberId)) status = 2;
    return { dooberId, floorNumber: rewardFloor, status };
  }).filter(({ dooberId, floorNumber: rewardFloor }) => dooberId > 0 && rewardFloor > 0);
};

/** Per-avatar, per-node progress for one weekly epoch. Mutates on create. */
export const infiniteProgressFor = (
  account,
  { nodeId, avatarDoid, epoch, create = false }
) => {
  if (!account) return { epoch, score: 0, claimed: [] };
  const root = account.infinite_progress && typeof account.infinite_progress === "object"
    ? account.infinite_progress
    : {};
  if (create) account.infinite_progress = root;
  const nodeKey = String(Number(nodeId));
  const avatarKey = String(Number(avatarDoid));
  const node = root[nodeKey] && typeof root[nodeKey] === "object" ? root[nodeKey] : {};
  if (create) root[nodeKey] = node;
  let progress = node[avatarKey];
  if (!progress || Number(progress.epoch) !== Number(epoch)) {
    progress = { epoch: Number(epoch), score: 0, claimed: [] };
    if (create) node[avatarKey] = progress;
  }
  progress.score = Math.max(0, Math.trunc(Number(progress.score ?? 0)));
  progress.claimed = [...new Set((progress.claimed ?? []).map(Number).filter(Number.isFinite))];
  return progress;
};

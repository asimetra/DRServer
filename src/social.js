import { isOnline, dungeonOf, friendshipChanged } from "./socket/presence.js";
import { listAccountIds, loadAccount, loadExistingAccount, saveAccount, saveAccounts } from "./accounts.js";
import { warn } from "./log.js";
import { infiniteEpoch } from "./infinite.js";

/**
 * Friends, gifts and the two leaderboards.
 *
 * Between them these are the most-called endpoints the client has — roughly two
 * hundred calls across the recorded sessions — and none of them had a handler,
 * so every one fell through to the permissive empty-array reply. An empty array
 * is the wrong shape for most of them: three answer with an object, and the
 * client indexes into fields that simply were not there.
 *
 * Every shape below is the recorded response from the official server, and the
 * fields are the ones the client is seen to read. Two would have been missed by
 * reading a truncated log instead of the whole body:
 * `getAllMapnodeScores.avatar_scores`, which DBAccountInfo.parseScoreResponse
 * reads for the player's own account, and `GetAllGifts.excludeIds`.
 *
 * What is deliberately *not* copied is the content. The official rows describe
 * a population of millions; a custom server's population is whoever plays on
 * it. So the friend endpoints resolve against the accounts this server holds,
 * and the boards answer honestly empty until something records a score.
 */

/**
 * `identifier` is the network and the account joined: every recorded row reads
 * `3_<account_id>`, and 3 is the networkId the client logs in with.
 */
const NETWORK_ID = 3;

/** Friend lists cross the wire as JSON *strings*, not arrays. */
const parseIdList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    warn(`social: could not parse friend list ${value.slice(0, 40)}`);
    return [];
  }
};

const encodeIdList = (ids) => JSON.stringify(ids.map(Number));

/**
 * The code a player reads out to be added.
 *
 * Derived from the account id rather than stored beside it, so there is nothing
 * to allocate, nothing to collide and nothing to migrate: every account has had
 * one since it was created. Base 32 without the letters that are mistaken for
 * digits — no I, O, S or Z — because this is a string somebody says out loud.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXY0123456789";

export const friendCodeOf = (account) => {
  let id = Number(account?.id ?? account ?? 0);
  if (!Number.isFinite(id) || id <= 0) return null;
  let code = "";
  while (id > 0) {
    code = ALPHABET[id % ALPHABET.length] + code;
    id = Math.floor(id / ALPHABET.length);
  }
  return code.padStart(6, ALPHABET[0]);
};

/**
 * The reverse, so a code somebody typed becomes the account it names.
 *
 * Refused past the safe integer range rather than allowed to overflow. Base 32
 * runs out of exact arithmetic at eleven characters, and past it two different
 * codes read as the same number — `99999999999999` and `9999999999999A` both
 * come out 1.1805916207174113e+21, which would be one code naming two accounts
 * or two naming one. Nothing has an id near there and the caller checks the
 * account exists before doing anything with it, so this is not reachable today;
 * it is closed because "a code names one account" should be true of the
 * function rather than true of the way it happens to be called.
 *
 * Extra leading pad characters are accepted on purpose, since they are zeroes
 * and mean nothing: somebody reading a code out loud who says one A too many is
 * still naming the same person.
 */
export const accountIdFromCode = (code) => {
  const text = String(code ?? "").trim().toUpperCase();
  if (!text) return null;
  let id = 0;
  for (const character of text) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return null;
    id = id * ALPHABET.length + digit;
    if (!Number.isSafeInteger(id)) return null;
  }
  return id > 0 ? id : null;
};

export const friendIdsOf = (account) => parseIdList(account?.ingame_friends);
export const ignoredIdsOf = (account) => parseIdList(account?.ignore_friends);
export const pendingFriendRequestsOf = (account) =>
  Array.isArray(account?.friend_requests) ? account.friend_requests : [];

/** The skin the account is currently showing, which is its active avatar's. */
export const activeSkinOf = (account) => {
  const avatars = account?.account_avatars ?? [];
  const active = avatars.find((row) => row.id === account?.active_avatar) ?? avatars[0];
  return active?.skin_type ?? 0;
};

/**
 * One row of the friend and ignore lists.
 *
 * The last three are not read by this client and are here on purpose.
 * `FriendInfo` takes online state and the dungeon a friend is in from
 * `PresenceManager` over the socket, not from this payload, and its `pic` is
 * built from a network avatar rather than a URL. Anyone modding the client
 * later will look here first, so the same answers are written here too — the
 * cost is three fields and the alternative is a reader having to discover that
 * the JSON is silent about the thing it most obviously should carry.
 */
export const friendRowOf = (account, isIngameFriend) => ({
  account_id: account.id,
  name: account.name,
  trophies: account.trophies ?? 0,
  active_skin: activeSkinOf(account),
  is_ingame_friend: isIngameFriend,
  identifier: `${NETWORK_ID}_${account.id}`,
  friend_code: friendCodeOf(account),
  is_online: isOnline(account.id),
  current_dungeon: dungeonOf(account.id),
  avatar_url: null,
});

/** Loads the accounts named by a list, skipping ids this server does not hold. */
const loadKnown = async (ids) => {
  const known = new Set(await listAccountIds());
  const rows = [];
  for (const id of ids) {
    if (!known.has(Number(id))) continue;
    rows.push(await loadAccount(Number(id)));
  }
  return rows;
};

/**
 * Makes the friendship, both ways, and saves both sides.
 *
 * Both because a one-sided friend sits in one panel and not the other, which is
 * worse than either having it or not having it.
 *
 * Idempotent: adding somebody already there changes nothing rather than
 * doubling them in the list.
 */
export const befriend = async (account, friend) => {
  // Whatever path got here, a block stands: a friendship would start telling
  // the blocked player where the blocker is again.
  if (blockedBetween(account, friend)) return false;
  const add = (owner, otherId) => {
    const ids = friendIdsOf(owner);
    if (ids.includes(Number(otherId))) return false;
    owner.ingame_friends = encodeIdList([...ids, Number(otherId)]);
    return true;
  };
  const changed = [add(account, friend.id), add(friend, account.id)];
  // Together, so that a half-made friendship is not a state either panel can
  // be left showing.
  const touched = [changed[0] && account, changed[1] && friend].filter(Boolean);
  if (touched.length) await saveAccounts(touched);
  // Both panels, live: see presence.js for why the one who asked needs telling.
  if (touched.length) friendshipChanged(account.id, friend.id, true);
  return changed[0] || changed[1];
};

/** Either of the two has the other on their block list. */
export const blockedBetween = (account, other) =>
  ignoredIdsOf(account).includes(Number(other.id)) ||
  ignoredIdsOf(other).includes(Number(account.id));

const dropFriend = (owner, otherId) => {
  const ids = friendIdsOf(owner);
  if (!ids.includes(Number(otherId))) return false;
  owner.ingame_friends = encodeIdList(ids.filter((id) => Number(id) !== Number(otherId)));
  return true;
};

const dropRequestsFrom = (owner, senderId) => {
  const pending = pendingFriendRequestsOf(owner);
  const kept = pending.filter((row) => Number(row.account_id) !== Number(senderId));
  if (kept.length === pending.length) return false;
  owner.friend_requests = kept;
  return true;
};

/**
 * Undoes it, both ways, for the same reason it was made both ways.
 *
 * A one-sided removal leaves the other player with a friend who does not have
 * them, and the panel that still shows the row is the one that cannot act on it.
 * Only a friend the owner actually lists is looked up: the id is the client's.
 */
export const unfriend = async (account, formerId) => {
  if (!friendIdsOf(account).includes(Number(formerId))) return false;
  const friend = await loadExistingAccount(Number(formerId));
  const changed = [dropFriend(account, formerId), friend && dropFriend(friend, account.id)];
  const touched = [changed[0] && account, changed[1] && friend].filter(Boolean);
  if (touched.length) await saveAccounts(touched);
  // And an ex-friend stops being told where you are.
  if (touched.length) friendshipChanged(account.id, formerId, false);
  return Boolean(changed[0] || changed[1]);
};

/**
 * Blocking, which is one-sided on purpose.
 *
 * The blocker's list is the blocker's own: telling the other account it has been
 * blocked would be a thing they could read. It also drops the friendship, since
 * blocking somebody you are friends with and staying friends with them is not a
 * state either panel can draw, and every request waiting between the two, since
 * accepting one afterwards would make that friendship again. All of it in one
 * save. Only an account that exists can be blocked.
 */
export const ignore = async (account, otherId) => {
  const id = Number(otherId);
  if (!Number.isSafeInteger(id) || id <= 0 || id === Number(account.id)) return false;
  const other = await loadExistingAccount(id);
  if (!other) return false;
  const ids = ignoredIdsOf(account);
  const blocked = !ids.includes(id);
  if (blocked) account.ignore_friends = encodeIdList([...ids, id]);
  const friendship = [dropFriend(account, id), dropFriend(other, account.id)];
  const requests = [dropRequestsFrom(account, id), dropRequestsFrom(other, account.id)];
  const touched = [
    (blocked || friendship[0] || requests[0]) && account,
    (friendship[1] || requests[1]) && other,
  ].filter(Boolean);
  if (touched.length) await saveAccounts(touched);
  if (friendship[0] || friendship[1]) friendshipChanged(account.id, id, false);
  return blocked;
};

export const unignore = async (account, otherId) => {
  const ids = ignoredIdsOf(account);
  if (!ids.includes(Number(otherId))) return false;
  account.ignore_friends = encodeIdList(ids.filter((id) => Number(id) !== Number(otherId)));
  await saveAccount(account);
  return true;
};

export const friendRecordFor = (account) => ({
  account_id: account.id,
  // Facebook's side of the friend graph. Null throughout the captures, and the
  // client only tests it for truth.
  network_friends: null,
  ingame_friends: encodeIdList(friendIdsOf(account)),
  ignore_friends: encodeIdList(ignoredIdsOf(account)),
  // DBAccountInfo.parseFriendResponse stores this when set and does nothing
  // else with the reply. Null in every capture, so there is nothing to cache.
  friends_hash: null,
});

/**
 * A friend request, in the shape the live server answered `DRFriendRequest` and
 * `DRFriendRequestPending` with: who asked (`account_id`, `name`, `trophies`,
 * `active_skin`), whom (`to_account_id`), and `curr_state` 0 for waiting. The
 * two fields this server added before it had a recording — `identifier` and
 * `friend_code` — stay, since the panel has been reading them.
 *
 * Also what a request stored before those fields existed is widened to on the
 * way out, so an old pending row answers in the same shape as a new one.
 */
export const requestRowOf = (request, recipientId) => ({
  ...request,
  facebook_id: request.facebook_id ?? "",
  to_account_id: Number(request.to_account_id ?? recipientId),
  curr_state: request.curr_state ?? 0,
  created: request.created ?? null,
});

/** The block list as the client keeps it: `[id,...]`, as text. */
export const blockListTextOf = (account) => encodeIdList(ignoredIdsOf(account));

export const friendDataFor = async (account) =>
  (await loadKnown(friendIdsOf(account))).map((row) => friendRowOf(row, true));

export const ignoredDataFor = async (account) =>
  (await loadKnown(ignoredIdsOf(account))).map((row) => friendRowOf(row, false));

/**
 * The two boards.
 *
 * The whole client stack behind them is namespaced for it — II_UIMapBattlePopup
 * asks for the top twenty, II_AccountTopScoreInfo reads `top_scores` keyed by
 * account, II_AvatarMapnodeScore reads `avatar_scores` — and every map node id
 * in the captured rows is one of the nine INFINITE_* nodes: 50158 is
 * INFINITE_TEMPLE, 50150 INFINITE_ARENA, 50162 INFINITE_TRIBAL. So the `score`
 * a row carries is that mode's deepest room reached in the current weekly
 * epoch. The selection popup also uses `avatar_scores` to decide which four
 * milestone chests are already earned, so an empty but well-shaped response is
 * not cosmetic: it hides both the score and the chest the run just reached.
 *
 *   championsboard  {top_scores:[{account_id, mapnode_id, score, active_skin,
 *                    name, weapon1..3}], avatar_scores:[{avatar_id, mapnode_id,
 *                    score}]}
 *   top twenty      [{account_id, active_skin, name, score, weapon1..3}]
 */
const infiniteScoreEntries = (account, epoch = infiniteEpoch()) => {
  const root = account?.infinite_progress;
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];

  const ownedAvatars = new Set((account.account_avatars ?? []).map((row) => Number(row.id)));
  const scores = [];
  for (const [nodeKey, avatars] of Object.entries(root)) {
    const mapNodeId = Number(nodeKey);
    if (!Number.isSafeInteger(mapNodeId) || !avatars || typeof avatars !== "object") continue;
    for (const [avatarKey, progress] of Object.entries(avatars)) {
      const avatarId = Number(avatarKey);
      const score = Math.max(0, Math.trunc(Number(progress?.score ?? 0)));
      if (
        !ownedAvatars.has(avatarId) ||
        Number(progress?.epoch) !== Number(epoch) ||
        score <= 0
      ) continue;
      scores.push({ avatar_id: avatarId, mapnode_id: mapNodeId, score });
    }
  }
  return scores;
};

const weaponJson = (item) => JSON.stringify(item ? {
  type: Number(item.item_id ?? 0),
  power: Number(item.power ?? 0),
  rarity: Number(item.rarity ?? 0),
  requiredLevel: Number(item.requiredlevel ?? 1),
  modifier1: Number(item.modifier1 ?? 0),
  modifier2: Number(item.modifier2 ?? 0),
  legendaryModifier: Number(item.legendarymodifier ?? 0),
} : null);

const boardRow = (account, score) => {
  const avatar = (account.account_avatars ?? []).find(
    (row) => Number(row.id) === Number(score.avatar_id)
  );
  const equipped = new Map(
    (account.account_items ?? [])
      .filter((item) => Number(item.avatar_id) === Number(score.avatar_id))
      .map((item) => [Number(item.avatar_slot), item])
  );
  return {
    account_id: Number(account.id),
    mapnode_id: score.mapnode_id,
    score: score.score,
    active_skin: Number(avatar?.skin_type ?? activeSkinOf(account)),
    name: account.name ?? `Player${account.id}`,
    weapon1: weaponJson(equipped.get(0)),
    weapon2: weaponJson(equipped.get(1)),
    weapon3: weaponJson(equipped.get(2)),
  };
};

const bestScoresByNode = (account, epoch = infiniteEpoch()) => {
  const best = new Map();
  for (const score of infiniteScoreEntries(account, epoch)) {
    const previous = best.get(score.mapnode_id);
    if (!previous || score.score > previous.score) best.set(score.mapnode_id, score);
  }
  return best;
};

export const mapNodeScoresFor = async (
  requesterId,
  friendAccountIds = [],
  avatarIds = [],
  { epoch = infiniteEpoch() } = {}
) => {
  const requestedAccounts = new Set(
    (Array.isArray(friendAccountIds) ? friendAccountIds : []).map(Number)
  );
  requestedAccounts.add(Number(requesterId));
  const accounts = await loadKnown([...requestedAccounts]);
  const requester = accounts.find((account) => Number(account.id) === Number(requesterId));
  const requestedAvatars = Array.isArray(avatarIds) && avatarIds.length
    ? new Set(avatarIds.map(Number))
    : null;

  const top_scores = accounts.flatMap((account) =>
    [...bestScoresByNode(account, epoch).values()].map((score) => boardRow(account, score))
  );
  const avatar_scores = requester
    ? infiniteScoreEntries(requester, epoch).filter(
        (score) => !requestedAvatars || requestedAvatars.has(score.avatar_id)
      )
    : [];
  return { top_scores, avatar_scores };
};

export const topTwentyFor = async (_requesterId, mapNodeId, { epoch = infiniteEpoch() } = {}) => {
  const node = Number(mapNodeId);
  const accounts = await loadKnown(await listAccountIds());
  return accounts
    .flatMap((account) => {
      const score = bestScoresByNode(account, epoch).get(node);
      return score ? [boardRow(account, score)] : [];
    })
    .sort((a, b) => b.score - a.score || a.account_id - b.account_id)
    .slice(0, 20);
};

/**
 * The gift inbox lives in `gifts.js`.
 *
 * It was here, answering `{gifts, excludeIds}` off two raw account columns, and
 * describing `excludeIds` as "the offers the client should not send again".
 * They are not offers. `FriendPopulater` compares each entry against a friend's
 * `excludeId`, which for a legacy-client friend is `Std.string(this.id)` — so
 * they are the accounts that cannot be gifted right now, and the list is the
 * only form the cooldown takes anywhere in the client.
 */

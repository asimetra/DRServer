/**
 * MATCHMAKER: the friend every player has, so the stock client shows a JOIN
 * button for ranked (docs/ranked.md, "Entry: a system friend").
 *
 * 999 is below ACCOUNT_ID_FLOOR, so registration never hands it out; below the
 * first doid, so no object shares it; and under the 0x7fffffff the client casts
 * friend ids to. It is never stored in any account — only added to answers.
 */
export const SYSTEM_FRIEND_ID = 999;

/** One of the default hero skins: an unknown one crashes the client's portrait. */
const PORTRAIT_SKIN = 151;

/**
 * Above any real friend's trophies, so the client — which sorts online friends
 * by trophies and ignores the server's order — always puts it first.
 */
const PINNED_TROPHIES = 999;

export const isSystemAccount = (accountId) => Number(accountId) === SYSTEM_FRIEND_ID;

export const systemFriendRow = ({ waiting = 0, where = 0 } = {}) => ({
  account_id: SYSTEM_FRIEND_ID,
  // Plain ASCII: the game's font has no guarantee of anything else.
  name: waiting > 0 ? `MATCHMAKER (${waiting})` : "MATCHMAKER",
  trophies: PINNED_TROPHIES,
  active_skin: PORTRAIT_SKIN,
  is_ingame_friend: true,
  identifier: `3_${SYSTEM_FRIEND_ID}`,
  friend_code: "",
  is_online: true,
  current_dungeon: where,
  avatar_url: null,
});

/** A friend list with MATCHMAKER first and any stored copy of it dropped. */
export const withSystemFriend = (rows, row) => [
  row,
  ...rows.filter((friend) => !isSystemAccount(friend.account_id)),
];

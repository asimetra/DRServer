/**
 * MATCHMAKER: ranked's friend door (src/modes/friend-door.js), the friend every
 * player has, so the stock client shows a JOIN button for ranked
 * (docs/ranked.md, "Entry: a system friend").
 *
 * 999 is below ACCOUNT_ID_FLOOR, so registration never hands it out; below the
 * first doid, so no object shares it; and under the 0x7fffffff the client casts
 * friend ids to. It is never stored in any account — only added to answers.
 */
import { friendDoorRow } from "../../modes/friend-door.js";

export const SYSTEM_FRIEND_ID = 999;

export const isSystemAccount = (accountId) => Number(accountId) === SYSTEM_FRIEND_ID;

/** Its name, with how many wait in the queue. Plain ASCII: the game's font has no guarantee of anything else. */
export const matchmakerName = (waiting = 0) => (waiting > 0 ? `MATCHMAKER (${waiting})` : "MATCHMAKER");

export const systemFriendRow = ({ waiting = 0, where = 0 } = {}) =>
  friendDoorRow({ id: SYSTEM_FRIEND_ID, name: matchmakerName(waiting), where });

/** A friend list with MATCHMAKER first and any stored copy of it dropped. */
export const withSystemFriend = (rows, row) => [
  row,
  ...rows.filter((friend) => !isSystemAccount(friend.account_id)),
];

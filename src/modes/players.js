/**
 * What a mode may read of a player's account: the name, the active hero's
 * level, and whether a map node is done — what an entry gate asks of the
 * account the core hands `entryAllowed`, and what a line calls a player.
 * Reads, never writes: what a mode gives goes through runControls.
 */
import { loadExistingAccount } from "../accounts.js";
import { heroById, loadGameMaster } from "../gamemaster.js";
import { heroLevel } from "../progression.js";
import { getMapNodeBit } from "../map-progress.js";

const activeAvatar = (account) =>
  (account?.account_avatars ?? []).find((row) => row.id === account?.active_avatar) ?? account?.account_avatars?.[0] ?? null;

/** An account's name, or null for no such account. */
export const playerName = async (accountId) =>
  (await loadExistingAccount(Number(accountId)).catch(() => null))?.name ?? null;

/** The level of an account's active hero; 1 with none. */
export const activeHeroLevel = async (account) => {
  const avatar = activeAvatar(account);
  const hero = avatar ? await heroById(avatar.avatar_id) : null;
  return hero ? heroLevel(await loadGameMaster(), hero, avatar.experience ?? 0) : 1;
};

/** Whether an account's active hero has done the map node `constant`; null for a node the game data lacks. */
export const nodeDone = async (account, constant) => {
  const node = ((await loadGameMaster()).raw?.MapPage ?? []).find((row) => row.Constant === constant);
  if (!node || node.BitIndex == null) return null;
  return getMapNodeBit(activeAvatar(account)?.completed_mapnode_mask, node.BitIndex);
};

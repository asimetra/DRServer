/**
 * The client's own admin console, answered.
 *
 * Backtick in the game asks `webMagicWord/AskIfAdmin`; a non-zero answer
 * opens the junkbyte console with a command line, and its slash words post
 * `webMagicWord/doMagicWord` with a word and its arguments
 * (MagicWordManager.hx): `Test`, `UnlockAllMapNodes avatar`,
 * `LockAllMapNodes avatar`, `UnlockMapNodes avatar start [end]`,
 * `GiveGems n`, `GiveCoins n`, `GiveXp avatar xp`. After each the client asks
 * `AskForAccountDetails` and reloads itself from the answer, so a change
 * shows at once.
 *
 * Who is an admin is the one rule the chat commands and the internal API
 * use: named in ODS_ADMIN_ACCOUNTS, or holding the rank (socket/roles.js). The
 * console gives an admin nothing a chat command could not; it is a second
 * door to the same room, with the client's own screen behind it. A word from
 * anybody else is refused, and every word that takes effect is recorded in
 * the admin's name (admin-actions.js), as the internal API's calls are.
 *
 * The words act on the caller's own account only — the client sends its own
 * id, and dispatch (rpc.js) refuses a call made in another's name — so this is
 * a tool for testing and for setting up a test account, not for reaching into
 * a player's. The internal API is where that is done, and logged.
 */
import { register } from "./rpc.js";
import { config } from "./config.js";
import { loadAccount, saveAccount } from "./accounts.js";
import { forTheClient } from "./server-only-fields.js";
import { loadGameMaster } from "./gamemaster.js";
import { setMapNodeBit } from "./map-progress.js";
import { ROLE, roleOf } from "./socket/roles.js";
import { recordAdminAction } from "./admin-actions.js";
import { info, warn } from "./log.js";

/** The chat commands' rule, and the internal API's: named in the setting, or holding the rank. */
export const isAdminAccount = (account) =>
  Boolean(account) &&
  (config.adminAccounts?.includes(Number(account.id)) || roleOf(account) >= ROLE.ADMIN);

/** Enough for any test account; a typo with an extra zero still buys nothing that matters. */
const MOST_CURRENCY = 1_000_000;
const MOST_XP = 100_000_000;

const whole = (value, { least = 1, most }) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < least || n > most) throw new Error(`expected a whole number from ${least} to ${most}`);
  return n;
};

const avatarOf = (account, avatarId) => {
  const avatar = (account.account_avatars ?? []).find((row) => Number(row.id) === Number(avatarId));
  if (!avatar) throw new Error(`no hero ${avatarId} on this account`);
  return avatar;
};

const nodesBetween = async (start, end) => {
  const gm = await loadGameMaster();
  const nodes = (gm.raw.MapPage ?? []).filter((row) => Number(row.Id) >= start && Number(row.Id) <= end);
  if (!nodes.length) throw new Error(`no map nodes between ${start} and ${end}`);
  return nodes;
};

const unlock = (avatar, nodes) => {
  for (const node of nodes) avatar.completed_mapnode_mask = setMapNodeBit(avatar.completed_mapnode_mask, Number(node.BitIndex));
  return nodes.length;
};

/**
 * Each word: (account, args) -> lines for the client's console. The account
 * is saved afterwards by the caller; a word that throws saves nothing.
 */
const WORDS = {
  Test: async () => ["ok"],

  UnlockAllMapNodes: async (account, [avatarId]) => {
    const avatar = avatarOf(account, avatarId);
    const gm = await loadGameMaster();
    const count = unlock(avatar, gm.raw.MapPage ?? []);
    return [`unlocked ${count} map nodes for hero ${avatar.id}`];
  },

  LockAllMapNodes: async (account, [avatarId]) => {
    const avatar = avatarOf(account, avatarId);
    avatar.completed_mapnode_mask = "";
    return [`locked every map node for hero ${avatar.id}`];
  },

  UnlockMapNodes: async (account, [avatarId, start, end]) => {
    const avatar = avatarOf(account, avatarId);
    const first = whole(start, { least: 1, most: 1_000_000 });
    const last = Math.max(first, whole(end ?? first, { least: 0, most: 1_000_000 }));
    const count = unlock(avatar, await nodesBetween(first, last));
    return [`unlocked ${count} map nodes (${first}..${last}) for hero ${avatar.id}`];
  },

  GiveGems: async (account, [amount]) => {
    const gems = whole(amount, { most: MOST_CURRENCY });
    account.premium_currency = Math.min(MOST_CURRENCY * 10, Number(account.premium_currency ?? 0) + gems);
    return [`gems: ${account.premium_currency}`];
  },

  GiveCoins: async (account, [amount]) => {
    const coins = whole(amount, { most: MOST_CURRENCY });
    account.basic_currency = Math.min(MOST_CURRENCY * 10, Number(account.basic_currency ?? 0) + coins);
    return [`coins: ${account.basic_currency}`];
  },

  GiveXp: async (account, [avatarId, amount]) => {
    const avatar = avatarOf(account, avatarId);
    const xp = whole(amount, { most: MOST_XP });
    avatar.experience = Math.min(MOST_XP * 10, Number(avatar.experience ?? 0) + xp);
    return [`hero ${avatar.id} experience: ${avatar.experience}`];
  },
};

export const MAGIC_WORDS = Object.freeze(Object.keys(WORDS));

/** `(accountId, token, demographics)` -> 1 for an admin, 0 for anybody else. */
register("webMagicWord/AskIfAdmin", async ([accountId]) => {
  const account = await loadAccount(Number(accountId));
  const admin = isAdminAccount(account);
  info(`console: account ${accountId} asked if admin: ${admin ? "yes" : "no"}`);
  return admin ? 1 : 0;
});

/** `(accountId, token, demographics)` -> the account as accountdetails serves it, for the client to reload from. */
register("webMagicWord/AskForAccountDetails", async ([accountId]) =>
  forTheClient(await loadAccount(Number(accountId)))
);

/** `(accountId, token, [word, ...args], demographics)` -> lines for the console. */
register("webMagicWord/doMagicWord", async ([accountId, , args]) => {
  const id = Number(accountId);
  const [word, ...rest] = Array.isArray(args) ? args : [];
  const account = await loadAccount(id);
  if (!isAdminAccount(account)) {
    warn(`console: account ${id} is not an admin and asked for ${String(word)}`);
    throw new Error("you are not an admin");
  }
  const run = Object.hasOwn(WORDS, String(word)) ? WORDS[word] : null;
  if (!run) throw new Error(`unknown magic word "${String(word)}"`);

  const lines = await run(account, rest);
  await saveAccount(account);
  await recordAdminAction({ actor: id, action: `console.${word}`, target: id, detail: { args: rest } });
  info(`console: ${id} ${word} ${JSON.stringify(rest)} -> ${lines.join("; ")}`);
  return lines;
});

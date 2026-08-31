import { register } from "./rpc.js";
import { issueToken } from "./auth.js";
import {
  loadAccount,
  saveAccount,
  nextObjectId,
  listAccountIds,
  withAccountLock,
  withTwoAccountLocks,
} from "./accounts.js";
import { openChest, pickWeighted, ChestError, NOTHING_AWARDED } from "./chests.js";
import { loadGameMaster } from "./gamemaster.js";
import { moveConsumableToSlot, reconcileConsumables } from "./consumables.js";
import { purchaseOffer, weaponSaleValue, stackableSaleValue, petSaleValue, StoreError } from "./store.js";
import { statPointsEarned, heroLevel, STAT_CAP, STAT_SLOTS } from "./progression.js";
import {
  accountIdFromCode,
  activeSkinOf,
  befriend,
  friendCodeOf,
  friendDataFor,
  friendIdsOf,
  friendRecordFor,
  ignore,
  ignoredDataFor,
  mapNodeScoresFor,
  topTwentyFor,
  unfriend,
  unignore,
} from "./social.js";
import { excludeIdsFor, giftsFor, sendGift, takeGift } from "./gifts.js";
import { info, warn } from "./log.js";

/**
 * Game-specific JSON-RPC handlers. `rpc.js` stays pure infrastructure
 * (registry, dispatch, tokens); everything that encodes client expectations
 * lives here.
 *
 * Rule of thumb when adding one: find the callback that consumes the response
 * in the client and mirror exactly the fields or indices it reads. Several of
 * these endpoints answer with positional arrays rather than objects.
 */

/**
 * The client asks for a fresh token during play, presenting the one it holds.
 * That presentation is the whole check and it has already happened: every POST
 * carries the token in `X-Validation-Token` and the route refused the call if
 * it did not verify. So the only token that comes from outside this server is
 * the first one a player is ever given — see tools/grant.js.
 */
register("account/token", ([accountId]) => {
  const token = issueToken(accountId, { term: "session" });
  info(`rpc: issued validation token for account ${accountId}`);
  return token;
});

/**
 * account/GetFacebookId — params [remotePlayerId, accountId, token].
 *
 * The last method the client calls that this server had no answer for, which
 * is why it is here: with it registered, nothing legitimate depends on the
 * permissive fallback any more and unknown methods can be refused outright.
 *
 * There is no Facebook integration and there will not be one, so the honest
 * answer is that this player has no Facebook id. The client is built for it —
 * `PlayerGameObject` only raises FACEBOOK_ID_RECEIVED_EVENT when the string
 * comes back non-empty, and otherwise just stores the blank.
 *
 * The account id is the *second* parameter here; the first names the player
 * being asked about, who is someone else by definition.
 */
register("account/GetFacebookId", async () => "", { account: 1 });

/**
 * Persists OptionsPanel and editable-HUD preferences.
 *
 * DBAccountInfo updates its in-memory map first and then sends
 * (accountId, token, name, value). The response callback reads nothing, but the
 * next accountdetails login must return the row or every option snaps back.
 */
register("account/AlterAttribute", async ([accountId, , rawName, rawValue]) => {
  const name = String(rawName ?? "");
  const value = String(rawValue ?? "");
  if (!name || name.length > 128 || value.length > 4096) {
    throw new Error("invalid account attribute");
  }

  const account = await loadAccount(Number(accountId));
  account.account_attributes ??= [];
  const existing = account.account_attributes.find((row) => row.name === name);
  if (existing) {
    existing.value = value;
  } else {
    account.account_attributes.push({
      id: await nextObjectId(account),
      account_id: account.id,
      name,
      value,
    });
  }
  await saveAccount(account);
  info(`rpc: saved account attribute ${name} for ${account.id}`);
  return true;
});

/**
 * Epoch parameters, taken from a live capture of the official server rather
 * than guessed: a one-week window offset by 40 hours. The offset is what lines
 * the reset up with the operator's chosen boundary, so a zero here would drift
 * every recurring window in the game.
 */
const EPOCH_DURATION = 604800;
const EPOCH_OFFSET = 144000;

/**
 * GameClock.finishSetWebServerTime reads this positionally:
 *   [0] W3C-DTF timestamp, [1] epoch duration (s), [2] epoch offset (s).
 * The epoch pair drives recurring windows such as weekly resets; the client's
 * own defaults are one week with no offset. Returning null here segfaults the
 * client, which indexes result[0] without a null check.
 */
const webServerTimestamp = () => [new Date().toISOString(), EPOCH_DURATION, EPOCH_OFFSET];

register("storeGetWebServerTimestamp/getWebServerTimestamp", webServerTimestamp, { account: null });
register("webMagicWord/getWebServerTimestamp", webServerTimestamp, { account: null });

const isToday = (isoDate) =>
  Boolean(isoDate) && new Date(isoDate).toUTCString().slice(0, 16) === new Date().toUTCString().slice(0, 16);

/**
 * Seconds until the daily reward is available again, or zero when it already
 * is. The live values decode cleanly as a countdown to the next UTC midnight —
 * 83129 seconds recorded just before 01:00 UTC — which is also what the client
 * reads: the box screen appears only while this is zero.
 */
const secondsUntilDailyReset = (account) => {
  if (!isToday(account.last_reward_date)) return 0;
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(0, Math.round((midnight - Date.now()) / 1000));
};

/**
 * The day of the streak, which runs 1..3 and then stays there. Two accounts pin
 * it: one on its first consecutive day reported 1, one on its sixth reported 3.
 */
const dailyRewardDay = (account) =>
  Math.min(DAILY_REWARD_TIERS.length, Math.max(1, account.concurrent_days ?? 1));

/**
 * The multiplier is the number of heroes on the account, not the streak — the
 * reward scales with how many characters you own. Both captures agree: two
 * avatars reported 2, six reported 6.
 */
const heroCount = (account) => Math.max(1, (account.account_avatars ?? []).length);

/**
 * What the day pays, by the client's own arithmetic in UIDailyRewards:
 * `tiers[day - 1] * multiplier`. The captured account — day 1, two heroes —
 * works out at 5 × 2 = 10, exactly the gems it received.
 */
const dailyRewardAmount = (account) =>
  DAILY_REWARD_TIERS[dailyRewardDay(account) - 1] * heroCount(account);

/** The positional array UIDailyRewards reads, shared by both endpoints. */
const dailyRewardStatus = (account) => [
  dailyRewardDay(account),
  heroCount(account),
  DAILY_REWARD_TIERS,
  secondsUntilDailyReset(account),
  DAILY_REPLAY_COST,
];

/**
 * Values observed on the live server: three reward tiers worth 5/10/15 gold.
 * The trailing element's meaning is still unknown; the client only forwards it
 * to setRewardAmounts.
 */
const DAILY_REWARD_TIERS = [5, 10, 15];
/**
 * Gems charged to spin the boxes again — gems, not gold. The capture is
 * unambiguous: across four redeems the account's gold never moved while its
 * gems went +10 once and then -5 per replay.
 */
const DAILY_REPLAY_COST = 5;

/** Constant tail element of the redeem response; its meaning is unknown. */


/**
 * UIDailyRewards reads this positionally (see uI/dailyRewards/UIDailyRewards.hx):
 *   [0] consecutive login day, 1..3
 *   [1] crew size — used as a divisor, so it must be non-zero
 *   [2] array of gold amounts per day, indexed [day - 1]
 *   [3] already-redeemed flag; > 0 makes the client close the popup immediately
 *   [4] passed on to setRewardAmounts
 *
 * We report "already redeemed today", which skips the reward flow entirely.
 * Implementing the real thing means driving the popup's animation state, and
 * nothing else depends on it yet.
 */
register("store/AskAboutDailyReward", async ([accountId]) =>
  dailyRewardStatus(await loadAccount(Number(accountId))));

/**
 * The avatarrecord calls feed their response straight back into
 * DBAccountInfo.parseResponse (see AvatarInfo.mResponseCallback and
 * DBAccountInfo.changeActiveAvatarRPC), so each must answer with a **full
 * account payload** — an empty result logs "Got empty array on parseResponse"
 * and leaves the UI showing stale data.
 *
 * All of them take (validationToken, accountId, ...), hence params[1].
 * The mutations themselves are not persisted yet; the client is told the
 * current state, which keeps it consistent but loses the change on restart.
 */
/**
 * A mutation answers with the account's scalar fields plus the lists it
 * actually changed — nothing more.
 *
 * The live server is precise about this: setActiveAvatar returns 25 fields and
 * no lists, while equipItemOnAvatar and SellWeapon return 26, the extra one
 * being account_items. Sending everything would overwrite parts of the client's
 * view it just updated itself; sending nothing leaves the inventory screen
 * showing the old gear, because the client refreshes from this response.
 *
 * Lists are dropped by shape rather than by name, so the header keeps following
 * the schema on its own.
 */
const accountHeader = (account, include = []) => {
  const header = Object.fromEntries(
    Object.entries(account).filter(([, value]) => !Array.isArray(value))
  );
  for (const field of include) header[field] = account[field] ?? [];
  return header;
};

/** Mutations that move gear around report the inventory back. */
const withInventory = (account) => accountHeader(account, ["account_items"]);

const respondWithAccount = async (params) => accountHeader(await loadAccount(Number(params[1])));

/**
 * avatarrecord/setSkin — params [token, accountId, avatarInstanceId, skinId].
 *
 * Costumes. This was registered against the stub that answers with the account
 * and writes nothing, so picking one succeeded and changed nothing at all: the
 * fourth parameter went on the floor and every avatar stayed on the skin it was
 * born in, however many the player had bought.
 *
 * Two things are checked here rather than taken from the request. The client
 * does refuse a skin the player does not own before it calls, but a check only
 * the client makes is not a check; and a skin names the hero it belongs to, so
 * a Berserker asking for the Ranger's costume is refused whatever it owns.
 *
 * A hero's own default skin is not an entitlement anybody buys and is not in
 * `account_skins`, so it is allowed on its own hero without one.
 */
register("avatarrecord/setSkin", async ([, accountId, avatarInstanceId, skinId]) => {
  const account = await loadAccount(Number(accountId));
  const avatar = findAvatar(account, avatarInstanceId);
  if (!avatar) throw new Error(`no avatar ${avatarInstanceId} on account ${accountId}`);

  const wanted = Number(skinId);
  const gm = await loadGameMaster();
  const skin = (gm.raw?.Skins ?? []).find((row) => Number(row.Id) === wanted);
  const hero = gm.heroById?.get(Number(avatar.avatar_id));

  /**
   * A refused change answers with the account rather than an error.
   *
   * The client has already applied the skin locally before it calls — the
   * tavern sets `skinId` and then sends — and it does not handle a failure from
   * this call at all: `RPC_updateAvatarSkin` passes an `updateFailure` that
   * only forwards to a callback this path never assigns, so an error is
   * swallowed or delivered to whatever the last screen happened to leave there.
   * Throwing would leave the player looking at a costume the server had
   * refused, with nothing to correct it.
   *
   * Answering with the account does correct it: the avatar parse reads
   * `skin_type` straight back into `skinId`, so the optimistic change is undone
   * by the reply. The attempt is refused, the player sees the truth, and the
   * server says so in its log.
   */
  const refuse = (why) => {
    warn(`rpc: refused skin ${skinId} for avatar ${avatar.id} on ${accountId}: ${why}`);
    return accountHeader(account, ["account_avatars"]);
  };

  if (!skin) return refuse("no such skin");
  if (skin.ForHero !== hero?.Constant) {
    return refuse(`${skin.Constant} belongs to ${skin.ForHero}, not ${hero?.Constant}`);
  }

  // A hero's own default is not an entitlement anybody buys, so it is not in
  // account_skins and is allowed on its own hero without being there.
  const isDefault = skin.Constant === hero.DefaultSkin;
  const owned = (account.account_skins ?? []).some((row) => Number(row.skin_type) === wanted);
  if (!isDefault && !owned) return refuse(`account does not own ${skin.Constant}`);

  avatar.skin_type = wanted;
  await saveAccount(account);
  info(`rpc: ${accountId} wears ${skin.Constant} on avatar ${avatar.id}`);
  return accountHeader(account, ["account_avatars"]);
}, { account: 1 });

/**
 * avatarrecord/updateAvatarSlots — params
 * [token, accountId, avatarInstanceId, stat1, stat2, stat3, stat4].
 *
 * Training. The four values are absolute totals, not deltas: the screen adds up
 * locally while the player clicks and writes the whole set once, on leaving or
 * switching hero (UIHeroTraining.writeStatsToDatabase).
 *
 * Which means the request is a claim about the hero's entire build, and every
 * part of it has to be checked here. A client is free to send four large
 * numbers, or negative ones to mint points back, or the same totals against a
 * level-1 hero. None of that is visible as cheating in the response — the stats
 * simply take effect and the hero hits harder forever.
 *
 * The budget is earned, not granted: two points per level from the Leveling
 * table, so 200 at level 100, and no single stat may pass 75.
 */
register("avatarrecord/updateAvatarSlots", async ([, accountId, avatarInstanceId, ...slots]) => {
  const account = await loadAccount(Number(accountId));

  const avatar = (account.account_avatars ?? []).find(
    (entry) => entry.id === Number(avatarInstanceId)
  );
  if (!avatar) throw new Error(`no avatar ${avatarInstanceId} on account ${accountId}`);

  const gm = await loadGameMaster();
  const hero = gm.heroById.get(avatar.avatar_id);
  if (!hero) throw new Error(`avatar ${avatar.id} is hero ${avatar.avatar_id}, which we have no row for`);

  const fields = Array.from({ length: STAT_SLOTS }, (_, index) => `statupgrade${index + 1}`);
  const wanted = fields.map((_, index) => Number(slots[index]));

  for (const [index, value] of wanted.entries()) {
    // A missing slot must not read as zero: Number(null) is 0, and silently
    // treating an absent value as "no points here" would wipe a stat.
    const raw = slots[index];
    if (raw === null || raw === undefined || raw === "" || !Number.isInteger(value) || value < 0) {
      throw new Error(`stat ${index + 1} is ${raw}, which is not a whole number of points`);
    }
    if (value > STAT_CAP) {
      throw new Error(`stat ${index + 1} asks for ${value}, over the cap of ${STAT_CAP}`);
    }
    // Points only come back through a retrain, which is a purchase. Letting a
    // stat fall would hand out a free respec and, worse, free points to move.
    const current = Number(avatar[fields[index]] ?? 0);
    if (value < current) {
      throw new Error(`stat ${index + 1} drops ${current} to ${value}; that needs a retrain`);
    }
  }

  const spent = wanted.reduce((total, value) => total + value, 0);
  const earned = statPointsEarned(gm, hero, Number(avatar.experience ?? 0));
  if (spent > earned) {
    throw new Error(
      `avatar ${avatar.id} spends ${spent} points at level ` +
        `${heroLevel(gm, hero, Number(avatar.experience ?? 0))}, having earned ${earned}`
    );
  }

  fields.forEach((field, index) => {
    avatar[field] = wanted[index];
  });

  await saveAccount(account);
  info(`rpc: avatar ${avatar.id} trained to [${wanted}] — ${spent}/${earned} points`);
  return accountHeader(account, ["account_avatars"]);
}, { account: 1 });

/**
 * account/OpenChest — params are
 * [accountId, chestInstanceId, token, forHeroId, forHeroSkinId].
 *
 * The hero matters: the drop pool is limited to weapons that hero can wield,
 * which is why the client sends it. On success the client expects the account
 * payload *and* the reward keys in the same object — it looks the won weapon up
 * in the inventory the very same response carries.
 */
register("account/OpenChest", async ([accountId, chestInstanceId, , forHeroId]) => {
  const account = await loadAccount(Number(accountId));

  const reward = await openChest({
    account,
    chestInstanceId: Number(chestInstanceId),
    heroInstanceId: Number(forHeroId),
    nextId: () => nextObjectId(account),
  });

  await saveAccount(account);
  info(`rpc: chest ${chestInstanceId} awarded item ${reward.WeaponId} to ${accountId}`);
  return { ...account, ...reward };
});

/**
 * account/DropChest — params [accountId, chestInstanceId, token].
 *
 * The inventory's abandon button. The chest is given up unopened and costs no
 * key; the answer has to carry account_chests, because the client rebuilds its
 * chest slots from this response and an omitted list leaves the abandoned chest
 * sitting there.
 */
register("account/DropChest", async ([accountId, chestInstanceId]) => {
  const account = await loadAccount(Number(accountId));
  const held = (account.account_chests ?? []).find((entry) => entry.id === Number(chestInstanceId));
  if (!held) throw new Error(`no chest ${chestInstanceId} on account ${accountId}`);

  account.account_chests = account.account_chests.filter((entry) => entry.id !== held.id);
  await saveAccount(account);
  info(`rpc: dropped chest ${held.chest_id} for ${accountId}`);
  return accountHeader(account, ["account_chests"]);
});

/**
 * Inventory mutations.
 *
 * Equipping is not a flag on the item — it is the pair (avatar_id, avatar_slot)
 * being set, and unequipping is those two going back to null. That is exactly
 * how the live server represents it, so these handlers do the same thing and
 * persist it.
 *
 * All of them answer with the account header, matching the live server: the
 * client has already applied the change locally, and sending our full account
 * back would overwrite its view.
 */

const findItem = (account, itemInstanceId) =>
  (account.account_items ?? []).find((item) => item.id === Number(itemInstanceId));

/** params: [accountId, avatarInstanceId, itemInstanceId, equipSlot, token] */
register("avatarmanager/equipItemOnAvatar", async ([accountId, avatarId, itemId, slot]) => {
  const account = await loadAccount(Number(accountId));
  const item = findItem(account, itemId);
  if (!item) throw new Error(`no item ${itemId} on account ${accountId}`);

  // A slot holds one weapon: whatever was there is displaced back to the bag.
  for (const other of account.account_items) {
    if (other.avatar_id === Number(avatarId) && other.avatar_slot === Number(slot)) {
      other.avatar_id = null;
      other.avatar_slot = null;
    }
  }

  item.avatar_id = Number(avatarId);
  item.avatar_slot = Number(slot);
  item.is_new = 0;

  await saveAccount(account);
  return withInventory(account);
});

/** params: [accountId, itemInstanceId, token] */
register("avatarmanager/unequipItemOffAvatar", async ([accountId, itemId]) => {
  const account = await loadAccount(Number(accountId));
  const item = findItem(account, itemId);
  if (item) {
    item.avatar_id = null;
    item.avatar_slot = null;
    await saveAccount(account);
  }
  return withInventory(account);
});

/** params: [accountId, weaponInstanceId, token] */
register("store/SellWeapon", async ([accountId, itemId]) => {
  const account = await loadAccount(Number(accountId));
  const item = findItem(account, itemId);
  if (!item) throw new Error(`no item ${itemId} to sell`);

  const value = weaponSaleValue(await loadGameMaster(), item);

  account.account_items = account.account_items.filter((entry) => entry.id !== item.id);
  account.basic_currency = (account.basic_currency ?? 0) + value;

  await saveAccount(account);
  info(`rpc: sold item ${item.id} for ${value} gold`);
  return withInventory(account);
});

/** params: [token, accountId, avatarInstanceId, skinId] */
register("avatarrecord/setActiveAvatar", async ([, accountId, avatarInstanceId]) => {
  const account = await loadAccount(Number(accountId));
  if ((account.account_avatars ?? []).some((avatar) => avatar.id === Number(avatarInstanceId))) {
    account.active_avatar = Number(avatarInstanceId);
    await saveAccount(account);
  }
  return accountHeader(account);
}, { account: 1 });

/**
 * store/PurchaseOffer — params [accountId, ?, offerId, token, demographics].
 *
 * The request names an offer and nothing else: no price, no quantity, no item
 * stats. Everything is read from GameMaster here, so a modified client cannot
 * ask for a discount or invent what it receives. Unknown offers, real-money
 * offers and unaffordable ones are refused.
 */
register("store/PurchaseOffer", async ([accountId, , offerId]) => {
  const account = await loadAccount(Number(accountId));

  const { offer, touched } = await purchaseOffer({
    account,
    offerId: Number(offerId),
    nextId: () => nextObjectId(account),
  });

  await saveAccount(account);
  info(`rpc: bought "${offer.Name}" (${offer.Price} ${offer.CurrencyType}) for ${accountId}`);
  return accountHeader(account, touched);
});

/**
 * store/SellStackable — params [accountId, stackableInstanceId, token].
 *
 * There is no count: the call names a bag row and the whole stack goes. This is
 * what the inventory's abandon button does with a potion.
 */
register("store/SellStackable", async ([accountId, stackableId]) => {
  const account = await loadAccount(Number(accountId));
  const row = (account.account_stackables ?? []).find((entry) => entry.id === Number(stackableId));
  if (!row) throw new Error(`no stackable ${stackableId} on account ${accountId}`);

  const gm = await loadGameMaster();
  account.account_stackables = account.account_stackables.filter((entry) => entry.id !== row.id);
  account.basic_currency =
    (account.basic_currency ?? 0) + stackableSaleValue(gm, row.stack_id, row.count ?? 0);

  await saveAccount(account);
  info(`rpc: sold stackable ${row.stack_id} x${row.count} for ${accountId}`);
  return accountHeader(account, ["account_stackables"]);
});

/** store/SellPet — params [accountId, petInstanceId, token]. */
register("store/SellPet", async ([accountId, petId]) => {
  const account = await loadAccount(Number(accountId));
  const pet = (account.account_pets ?? []).find((entry) => entry.id === Number(petId));
  if (!pet) throw new Error(`no pet ${petId} on account ${accountId}`);

  const gm = await loadGameMaster();
  account.account_pets = account.account_pets.filter((entry) => entry.id !== pet.id);
  account.basic_currency = (account.basic_currency ?? 0) + petSaleValue(gm, pet.npc_id);

  await saveAccount(account);
  return accountHeader(account, ["account_pets"]);
});

/**
 * store/RequestRedeemDailyRewards — params
 * [accountId, token, boxIndex, ?, demographics].
 *
 * The screen shows three mystery boxes and the player picks one. The response
 * is a two-element array: the offer behind *every* box, so the UI can reveal
 * the ones not taken, and then the account.
 *
 *   [[offerId, offerId, offerId], account]
 *
 * The three come from the CONSUMABLE_DAILY drop table, the same distribution
 * chests use — every id seen in the capture appears in that row.
 */
register("store/RequestRedeemDailyRewards", async ([accountId, , boxIndex = 0, payToReplay = false]) => {
  const account = await loadAccount(Number(accountId));
  const gm = await loadGameMaster();

  // Spinning again is a paid action, and the price has to be checked here —
  // the client only asks, it does not decide.
  const replaying = Boolean(payToReplay);
  if (replaying) {
    const balance = Number(account.premium_currency ?? 0);
    if (balance < DAILY_REPLAY_COST) {
      throw new Error(`a replay costs ${DAILY_REPLAY_COST} gems, account has ${balance}`);
    }
    account.premium_currency = balance - DAILY_REPLAY_COST;
  }

  const row = gm.raw.ChestDropRates.find((entry) => entry.Rarity === "CONSUMABLE_DAILY");
  const weights = Object.fromEntries(
    Object.entries(row ?? {})
      .filter(([key, value]) => key.startsWith("id_") && typeof value === "number" && value > 0)
      .map(([key, value]) => [key.slice(3), value])
  );

  const boxes = [0, 1, 2].map(() => Number(pickWeighted(weights)));
  const chosen = boxes[Math.min(Math.max(Number(boxIndex) || 0, 0), boxes.length - 1)];

  // Only the picked box is granted; the other two are revealed and lost.
  try {
    await purchaseOffer({ account, offerId: chosen, nextId: () => nextObjectId(account), free: true });
  } catch (error) {
    warn(`rpc: daily reward ${chosen} could not be granted: ${error.message}`);
  }

  const today = new Date();
  const claimedBefore = account.last_reward_date ? new Date(account.last_reward_date) : null;

  // The login bonus is only for the first spin of the day; a paid replay
  // re-rolls the boxes but does not pay the day out again.
  let awarded = 0;
  if (!replaying) {
    account.concurrent_days =
      claimedBefore && today - claimedBefore < 2 * 24 * 60 * 60 * 1000
        ? (account.concurrent_days ?? 0) + 1
        : 1;
    awarded = dailyRewardAmount(account);
    account.premium_currency = Number(account.premium_currency ?? 0) + awarded;
  }
  account.last_reward_date = today.toISOString();

  await saveAccount(account);
  info(
    `rpc: daily reward box ${boxIndex} -> offer ${chosen} for ${accountId}` +
      (replaying ? ` (replay, -${DAILY_REPLAY_COST} gems)` : ` (+${awarded} gems)`)
  );

  /**
   * Six elements, in the order UIDailyRewards reads them: the offers behind all
   * three boxes, the account, the countdown to the next reward, a flag, the
   * refreshed status array, and a constant. Returning fewer leaves the client
   * reading past the end of the array, which is what closed the game on the
   * replay button.
   */
  return [
    boxes,
    accountHeader(account, ["account_stackables", "account_attributes", "account_boosters"]),
    secondsUntilDailyReset(account),
    false,
    dailyRewardStatus(account),
    awarded,
  ];
});
/**
 * Consumables and pets.
 *
 * A consumable is not copied onto a hero, it is *moved*: equipping takes the
 * stack out of the bag and onto the avatar's slot, and unequipping puts it
 * back. The captures show it plainly — the bag row for the potion disappears on
 * equip and returns with its count on unequip.
 *
 * Slots are zero-based on the wire and one-based in the field names, so slot 0
 * fills consumable1 and slot 1 fills consumable2.
 */

const findAvatar = (account, avatarInstanceId) =>
  (account.account_avatars ?? []).find((avatar) => avatar.id === Number(avatarInstanceId));

const consumableFields = (slot) => {
  const index = Number(slot) === 1 ? 2 : 1;
  return { id: `consumable${index}_id`, count: `consumable${index}_count` };
};

/** Puts a stack back in the bag, merging with any rows already there. */
const returnToBag = async (account, stackId, count) => {
  if (!stackId || !count) return;
  account.account_stackables ??= [];
  const existing = account.account_stackables.find((row) => row.stack_id === stackId);
  if (existing) {
    existing.count = (existing.count ?? 0) + count;
    return;
  }
  account.account_stackables.push({
    id: await nextObjectId(account),
    account_id: account.id,
    stack_id: stackId,
    count,
    is_new: 0,
  });
};

/** params: [accountId, avatarInstanceId, stackId, slot, ?, token] */
register("avatarmanager/equipConsumableOnAvatar", async ([accountId, avatarId, stackId, slot]) => {
  const account = await loadAccount(Number(accountId));
  const avatar = findAvatar(account, avatarId);
  if (!avatar) throw new Error(`no avatar ${avatarId} on account ${accountId}`);

  /**
   * Asked for wherever it is, not only in the bag.
   *
   * The bag was the only place this looked, and equipping is what takes a stack
   * out of the bag — so moving a powerup from one slot to the other threw "no
   * stackable in the bag" and left the client's equip screen blank. It is the
   * same request whether the stack is bagged or already worn.
   */
  const moved = await moveConsumableToSlot(account, avatar, stackId, slot);
  if (!moved) throw new Error(`no stackable ${stackId} in the bag or in a slot`);

  await saveAccount(account);
  return accountHeader(account, ["account_avatars", "account_stackables"]);
});

/** params: [accountId, avatarInstanceId, stackId, slot, token] */
register("avatarmanager/unequipConsumableOffAvatar", async ([accountId, avatarId, , slot]) => {
  const account = await loadAccount(Number(accountId));
  const avatar = findAvatar(account, avatarId);
  if (!avatar) throw new Error(`no avatar ${avatarId} on account ${accountId}`);

  const field = consumableFields(slot);
  await returnToBag(account, avatar[field.id], avatar[field.count]);
  avatar[field.id] = 0;
  avatar[field.count] = 0;

  await saveAccount(account);
  return accountHeader(account, ["account_avatars", "account_stackables"]);
});

/** params: [accountId, avatarInstanceId, petInstanceId, token] */
register("avatarmanager/equipPetOnAvatar", async ([accountId, avatarId, petId]) => {
  const account = await loadAccount(Number(accountId));
  const avatar = findAvatar(account, avatarId);
  if (!avatar) throw new Error(`no avatar ${avatarId} on account ${accountId}`);

  const pet = (account.account_pets ?? []).find((entry) => entry.id === Number(petId));
  if (!pet) throw new Error(`no pet ${petId} on account ${accountId}`);

  // A hero walks with one pet, so whichever was following it steps aside.
  for (const other of account.account_pets) {
    if (other.equipped_hero === avatar.id) other.equipped_hero = null;
  }
  pet.equipped_hero = avatar.id;
  pet.is_new = 0;

  await saveAccount(account);
  return accountHeader(account, ["account_pets"]);
});

/** params: [accountId, petInstanceId, token] */
register("avatarmanager/unEquipPet", async ([accountId, petId]) => {
  const account = await loadAccount(Number(accountId));
  const pet = (account.account_pets ?? []).find((entry) => entry.id === Number(petId));
  if (pet) {
    pet.equipped_hero = null;
    await saveAccount(account);
  }
  return accountHeader(account, ["account_pets"]);
});

/**
 * Friends, gifts and the boards.
 *
 * These were the most-called endpoints with no handler at all — around two
 * hundred calls across the recorded sessions, every one falling through to the
 * permissive empty-array reply. Three of them answer with an *object*, so an
 * array was not merely empty but the wrong type, and the client indexed fields
 * that were not there.
 *
 * The paths are the recorded ones and are not all under the service you would
 * guess: the friend lists live under `leaderboard`, the boards under
 * `championsboard`, pending requests under `friendrequests`, gifts under
 * `store` and `getmod` under `modrpc`.
 *
 * See src/social.js for what backs them.
 */

/** params: [accountId, token] */
register("leaderboard/getFriendRecord", async ([accountId]) =>
  friendRecordFor(await loadAccount(Number(accountId)))
);

/** params: [accountId, {}, token] */
register("leaderboard/getFriendData", async ([accountId]) =>
  friendDataFor(await loadAccount(Number(accountId)))
);

/** params: [accountId, token] */
register("leaderboard/getIgnoreFriendData", async ([accountId]) =>
  ignoredDataFor(await loadAccount(Number(accountId)))
);

/**
 * params: [accountId, token]
 *
 * Incoming friend requests. Empty until something can create one — there is no
 * request flow here yet, and an invented pending request would show a stranger
 * in the player's social panel.
 */
register("friendrequests/DRFriendRequestPending", async () => [], { account: null });

/**
 * Who the sixth parameter names, which is not always the same kind of thing.
 *
 * Two screens call `DRFriendRequest` and they do not agree on what they send.
 * `DistributedDungeonSummary.addFriend` passes `personId`, the `UInt` account
 * id of somebody the player has just finished a dungeon with — there is nothing
 * to type on that screen. `UIInvite` passes whatever is in its text box.
 *
 * Reading both as base 32 is why adding a friend off the summary did nothing.
 * That alphabet holds the digits, so an account id is a *valid* code — 1000000006
 * reads as a number in the trillions — and the lookup came back "not found"
 * rather than failing in a way anybody would notice.
 *
 * What the text box will let through is worth knowing, because it decides what
 * a friend code can be here at all. `inviteViaEmail` tests `^1[0-9]{9}$` first
 * and, on a match, sends the text untouched — "looks like an account ID, not a
 * Steam ID", in its own words. Anything else has to satisfy
 * `SteamIdConverter.isValidSteamId`: either a SteamID64, or Steam's hex, which
 * is `^[bcdfghjkmnpqrtvw]+$` and at most twelve long. Nothing else is sent at
 * all — the box clears itself and says the address is invalid.
 *
 * So the ten-digit account id is the one code a player can actually type today,
 * and it is what these ids already look like. The base 32 code from `social.js`
 * cannot be: `73YVTG` holds digits and a Y, which is neither form. It stays in
 * the friend rows for whoever mods this client later, and is still accepted
 * below, but the account id is tried first — that is what arrives, and trying
 * the code first would let an all-digit code shadow a real id.
 */
const namedAccountId = async (value) => {
  const known = new Set(await listAccountIds());
  const holds = (id) => (id && known.has(Number(id)) ? Number(id) : null);

  if (typeof value === "number") return holds(value);

  const text = String(value ?? "").trim();
  if (!text) return null;
  const asId = /^\d+$/.test(text) ? holds(Number(text)) : null;
  return asId ?? holds(accountIdFromCode(text));
};

/**
 * params: [name, trophies, activeSkin, facebookId, accountId, value, demographics, token]
 *
 * Somebody typed a friend code into the invite box. `UIInvite` reads the answer
 * as an outcome rather than as data, and there are four of them:
 *
 *   null            "already a friend"
 *   []              "not found", and offers to send an email instead
 *   false           "invite sent"
 *   an object       "request sent to X", drawn with its `active_skin`
 *
 * So the edge cases have somewhere to go without inventing a fifth.
 *
 * Adding yourself answers `null`. It is not literally true, but the alternative
 * is `[]`, which opens a modal offering to email an invitation to your own
 * address — a worse thing to do to somebody who has just mistyped their own
 * code. The short inline prompt is the right size for the mistake.
 *
 * The friendship is made both ways at once. This server has no pending-request
 * flow — `DRFriendRequestPending` is empty and honestly so — and a one-sided
 * friend would sit in one panel and not the other, which is worse than either
 * having it or not.
 */
register("friendrequests/DRFriendRequest", async (params) => {
  const accountId = Number(params[4]);
  const typed = params[5];

  const account = await loadAccount(accountId);
  const wantedId = await namedAccountId(typed);
  // `namedAccountId` already answered null for anything this server does not
  // hold, so "not found" and "unreadable" arrive here as the same thing.
  if (!wantedId || wantedId === accountId) return wantedId === accountId ? null : [];

  const friends = friendIdsOf(account);
  if (friends.includes(wantedId)) return null;

  const friend = await loadAccount(wantedId);
  await befriend(account, friend);

  return {
    to_account_id: friend.id,
    active_skin: activeSkinOf(friend),
    name: friend.name,
    friend_code: friendCodeOf(friend),
  };
}, { account: 4 });

/**
 * params: [accountId, [friendIds], token]
 *
 * `UIFriends` sends the whole selection at once and reads nothing back but the
 * fact that it answered — it refreshes its own list from `getFriendData`. The
 * count is returned rather than nothing so a log line can say what happened.
 */
register("friendrequests/DRFriendRemove", async ([accountId, friendIds]) => {
  const account = await loadAccount(Number(accountId));
  let removed = 0;
  for (const id of friendIds ?? []) if (await unfriend(account, id)) removed++;
  return { removed };
});

/**
 * params: [accountId, personId, token]
 *
 * Blocking from the dungeon summary, one player at a time. It drops the
 * friendship as well, which is `ignore`'s doing and explained there.
 */
register("friendrequests/IgnoreFriend", async ([accountId, personId]) => {
  const account = await loadAccount(Number(accountId));
  return { blocked: await ignore(account, personId) };
});

/** params: [accountId, [friendIds], token] — the blocked panel, whole selection. */
register("friendrequests/UnblockFriend", async ([accountId, friendIds]) => {
  const account = await loadAccount(Number(accountId));
  let unblocked = 0;
  for (const id of friendIds ?? []) if (await unignore(account, id)) unblocked++;
  return { unblocked };
});

/**
 * params: [accountId, [requestIds], [toAccountIds], state, token]
 *
 * State 1 accepts and state 2 declines — `UIPending` logs `DRFriendDecline`
 * against the second one, which is the only place either number is named.
 *
 * Accepting makes the friendship, because this server has no pending requests
 * to consume: `DRFriendRequestPending` answers empty, so nothing can reach this
 * except a client holding a list from somewhere else. Declining has nothing to
 * remove and says so quietly rather than failing, which is what the panel wants
 * either way — it refreshes itself from the friend list afterwards.
 */
const REQUEST_ACCEPTED = 1;

register("friendrequests/DRFriendRequestUpdate", async ([accountId, , toIds, state]) => {
  if (Number(state) !== REQUEST_ACCEPTED) return { accepted: 0 };
  const account = await loadAccount(Number(accountId));
  let accepted = 0;
  for (const id of toIds ?? []) {
    const friendId = await namedAccountId(Number(id));
    if (!friendId || friendId === account.id) continue;
    if (await befriend(account, await loadAccount(friendId))) accepted++;
  }
  return { accepted };
});

/**
 * params: [{reportingPlayerId, reportingPlayerName, reportedPlayerId,
 *           reportedPlayerName, reportReasons, matchPlayers}]
 *
 * One object rather than a list, which is `UIReportPopup` calling it that way.
 *
 * Recorded and nothing else. A report is a person's claim about another person
 * and this server has nobody to hand it to, so acting on it automatically would
 * be a way to take somebody's account by accusing them — the same hole the
 * sanction ladder is held back from. Logging it means a report made in the game
 * is a report somebody can find later, which is the honest half of the feature.
 */
register("report/ReportPlayer", async ([report]) => {
  const reasons = Array.isArray(report?.reportReasons) ? report.reportReasons : [];
  info(
    `report: ${report?.reportingPlayerId} (${report?.reportingPlayerName}) reported ` +
      `${report?.reportedPlayerId} (${report?.reportedPlayerName}) for [${reasons.join(", ")}]`
  );
  return { received: true };
}, { account: null });

/** params: [accountId, token] */
register("store/GetAllGifts", async ([accountId]) =>
  giftsFor(await loadAccount(Number(accountId)))
);

/**
 * params: [accountId, offerId, networkId, [requestIds], [toAccountIds], token]
 *
 * Sending. The client makes one call per recipient and passes a request id it
 * invented; that id is read and thrown away, because a sender who names the
 * identifier of a row on somebody else's account is a sender who can overwrite
 * one. The offer is checked against the three the table calls free gifts.
 *
 * The answer is the exclude list, which is what the recording shows the real
 * server returning — it grows by one recipient per call, sorted, and the client
 * uses it to grey out who it can no longer send to.
 *
 * One bad recipient does not sink the rest. The client sends them one at a time
 * anyway, so a batch here is already unusual; refusing the whole call because
 * the fourth id in it is a stranger would lose three good gifts.
 */
register("store/GiftOffer", async ([accountId, offerId, , , toIds]) => {
  /**
   * One gift at a time, holding both accounts, smallest id first.
   *
   * Both locks, because each gift is a read-modify-write on each side: the
   * cooldown is the only thing rationing this, and two fired together would
   * both read a clean sheet, both send, and the second save would drop the
   * first record — a friend receiving as many free items as somebody can hold
   * the button down for.
   *
   * And in sorted order rather than sender-then-recipient, which is what
   * `withTwoAccountLocks` is for. Taking them in the order the work happens to
   * want is how A gifting B while B gifts A ends with each holding one and
   * waiting for the other. It also collapses the pair when they are the same
   * account, which a plain nesting cannot do: these locks are not reentrant, so
   * gifting yourself took the sender's lock and then waited for it forever,
   * where `sendGift` would have refused it in a line.
   */
  const senderId = Number(accountId);
  const known = new Set(await listAccountIds());
  let sent = 0;

  for (const toId of Array.isArray(toIds) ? toIds : []) {
    const recipientId = Number(toId);
    if (!known.has(recipientId)) {
      warn(`rpc: ${senderId} tried to gift unknown account ${toId}`);
      continue;
    }
    try {
      const gift = await withTwoAccountLocks(senderId, recipientId, async () => {
        const sender = await loadAccount(senderId);
        const recipient = recipientId === senderId ? sender : await loadAccount(recipientId);
        const made = await sendGift({ sender, recipient, offerId });
        await saveAccount(recipient);
        if (recipient !== sender) await saveAccount(sender);
        return made;
      });
      sent++;
      info(`rpc: ${senderId} gifted offer ${gift.offer_id} to ${recipientId}`);
    } catch (problem) {
      warn(`rpc: ${senderId} could not gift ${recipientId}: ${problem.message}`);
    }
  }

  return withAccountLock(senderId, async () => excludeIdsFor(await loadAccount(senderId)).sort());
});

/**
 * params: [accountId, requestId, token, demographics]
 *
 * Accepting. The request id is the only thing the client says, and it says
 * nothing about what the gift holds — the offer comes off the row this server
 * wrote when the gift was made. The row is taken before it is granted, so the
 * same id sent twice finds an empty pile the second time.
 *
 * `DBAccountInfo.acceptGift` feeds a truthy answer to `parseResponse`, so this
 * has to be an account payload; falsy means "nothing happened" and is what an
 * unknown id gets.
 */
register("store/AcceptGift", async ([accountId, requestId]) => {
  const account = await loadAccount(Number(accountId));
  const gift = takeGift(account, requestId);
  if (!gift) {
    warn(`rpc: ${account.id} tried to accept gift ${requestId}, which is not theirs`);
    return false;
  }

  const { touched } = await purchaseOffer({
    account,
    offerId: Number(gift.offer_id),
    nextId: () => nextObjectId(account),
    free: true,
  });
  await saveAccount(account);
  info(`rpc: ${account.id} accepted offer ${gift.offer_id} from ${gift.from_account_id}`);
  return accountHeader(account, touched);
});

/** params: [accountId, [requestIds], token, demographics] — the same, in a batch. */
register("store/AcceptAllGifts", async ([accountId, requestIds]) => {
  const account = await loadAccount(Number(accountId));
  const touched = new Set();
  let taken = 0;

  for (const requestId of Array.isArray(requestIds) ? requestIds : []) {
    const gift = takeGift(account, requestId);
    if (!gift) continue;
    const grant = await purchaseOffer({
      account,
      offerId: Number(gift.offer_id),
      nextId: () => nextObjectId(account),
      free: true,
    });
    for (const list of grant.touched ?? []) touched.add(list);
    taken++;
  }

  if (!taken) return false;
  await saveAccount(account);
  info(`rpc: ${account.id} accepted ${taken} gift(s)`);
  return accountHeader(account, [...touched]);
});

/**
 * params: [accountId, requestId, token, demographics]
 *
 * Declining. The same taking, without the granting — the client ignores the
 * answer and drops its own copy either way.
 */
register("store/DeclineGift", async ([accountId, requestId]) => {
  const account = await loadAccount(Number(accountId));
  if (!takeGift(account, requestId)) return false;
  await saveAccount(account);
  return true;
});

/** params: [accountId, [friendAccountIds], token] */
register("championsboard/getAllMapnodeScores", async () => mapNodeScoresFor(), { account: null });

/** params: [accountId, mapNodeId, token] */
register("championsboard/getTopTwenty", async () => topTwentyFor(), { account: null });

/**
 * params: [networkId] — moderation rules. The live server answers with an empty
 * list, so nothing is moderated rather than nothing being said.
 */
register("modrpc/getmod", () => [], { account: null });

/** params: [accountId] — timed store offers; empty in every capture. */
register("store/GetLimitedOfferStatus", () => [], { account: null });

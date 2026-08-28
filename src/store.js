import { loadGameMaster } from "./gamemaster.js";
import { warn } from "./log.js";

/**
 * Buying and selling.
 *
 * The client is not trusted with any of it. A purchase request carries an offer
 * id and nothing else — no price, no quantity, no item stats — and this module
 * looks all of that up in GameMaster. A request naming an offer that does not
 * exist, or that the account cannot afford, is refused rather than honoured.
 * The same goes for selling: the payout comes from the tables, never from the
 * client.
 */

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Mirrors the chest code's refusal, which is the one error code we have seen. */
export const REFUSED = -537;

const CURRENCY_COLUMN = {
  BASIC: "basic_currency",
  PREMIUM: "premium_currency",
};

const KEY_COLUMNS = {
  BasicKeys: "basic_keys",
  UncommonKeys: "uncommon_keys",
  RareKeys: "rare_keys",
  LegendaryKeys: "legendary_keys",
};

/**
 * Consumable keys have no column of their own on the account — they are held as
 * stackables, the same as any other consumable.
 */
const CONSUMABLE_KEY_STACKABLES = {
  ConsumableSmallKeys: 60001,
  ConsumableRoyalKeys: 60018,
};

const addStackable = async (account, stackId, count, nextId) => {
  account.account_stackables ??= [];
  const existing = account.account_stackables.find((row) => row.stack_id === stackId);
  if (existing) {
    existing.count = (existing.count ?? 0) + count;
    return;
  }
  account.account_stackables.push({
    id: await nextId(),
    account_id: account.id,
    stack_id: stackId,
    count,
    is_new: 1,
  });
};

/**
 * Weapons bought from the shop come with their statistics already decided —
 * power, level, rarity and up to three modifiers are columns on the offer, not
 * a roll. That is the difference between a purchase and a chest.
 */
const grantWeapon = async (account, detail, nextId) => ({
  id: await nextId(),
  item_id: detail.WeaponId,
  account_id: account.id,
  power: detail.WeaponPower ?? 0,
  avatar_id: null,
  avatar_slot: null,
  is_new: 1,
  requiredlevel: detail.Level ?? 1,
  rarity: detail.Rarity ?? 1,
  modifier1: detail.Modifier1 ?? 0,
  modifier2: detail.Modifier2 ?? 0,
  legendarymodifier: detail.Modifier3 ?? 0,
  created: new Date().toISOString(),
});

/**
 * The two weapons a newly bought hero arrives with, one per slot.
 *
 * The rule behind the real choice is not settled. A captured Sorcerer purchase
 * granted weapons 18502 and 19501; both happen to be power 8, but "strongest of
 * the type" is wrong — 19503 in the same type is power 14 — and "weakest" is
 * wrong too. Nothing in the tables marks a weapon as a starter.
 *
 * So this takes the lowest id of each of the hero's first two mastery types,
 * which is the plainest reading of "the basic one" and matches the second of
 * the two observed weapons. It is a stand-in until more purchases are captured.
 */
const starterWeapons = (gm, hero) => {
  const types = Object.entries(hero)
    .filter(([key, value]) => key.endsWith("_TYPE") && value)
    .map(([key]) => key)
    .slice(0, 2);

  return types
    .map((type) => {
      const candidates = gm.raw.WeaponItem.filter(
        (weapon) =>
          weapon.Mastertype === type &&
          weapon.Constant.startsWith("HERO_") &&
          !weapon.Constant.includes("LEGACY") &&
          (weapon.Power ?? 0) > 0
      );
      return candidates.sort((a, b) => a.Id - b.Id)[0];
    })
    .filter(Boolean);
};

/**
 * Applies one OfferDetails row. Returns the account lists it touched, so the
 * response can carry exactly those and no more.
 */
const applyDetail = async ({ account, detail, gm, nextId, granted }) => {
  const touched = new Set();

  if (detail.WeaponId) {
    if ((account.account_items ?? []).length >= (account.buckets_weapon ?? 0)) {
      throw new StoreError(REFUSED, "weapon storage is full");
    }
    const rarityId = gm.raw.Rarity.find((row) => row.Type === detail.Rarity)?.Id ?? 1;
    account.account_items = [
      ...(account.account_items ?? []),
      await grantWeapon(account, { ...detail, Rarity: rarityId }, nextId),
    ];
    touched.add("account_items");
  }

  if (detail.StackableId && detail.StackableCount) {
    await addStackable(account, detail.StackableId, detail.StackableCount, nextId);
    touched.add("account_stackables");
  }

  for (const [column, accountColumn] of Object.entries(KEY_COLUMNS)) {
    if (!detail[column]) continue;
    account[accountColumn] = (account[accountColumn] ?? 0) + detail[column];
    granted.add(accountColumn);
  }

  for (const [column, stackId] of Object.entries(CONSUMABLE_KEY_STACKABLES)) {
    if (!detail[column]) continue;
    await addStackable(account, stackId, detail[column], nextId);
    touched.add("account_stackables");
  }

  if (detail.Coins) {
    account.basic_currency = (account.basic_currency ?? 0) + detail.Coins;
    granted.add("basic_currency");
  }
  if (detail.Gems) {
    account.premium_currency = (account.premium_currency ?? 0) + detail.Gems;
    granted.add("premium_currency");
  }
  if (detail.WeaponSlots) {
    account.buckets_weapon = (account.buckets_weapon ?? 0) + detail.WeaponSlots;
    granted.add("buckets_weapon");
  }

  if (detail.ChestId) {
    account.account_chests = [
      ...(account.account_chests ?? []),
      { id: await nextId(), account_id: account.id, chest_id: detail.ChestId },
    ];
    touched.add("account_chests");
  }

  /**
   * Buying a hero adds an avatar, which is what the client redraws the roster
   * from. Granting the money's worth of nothing here means the shop takes the
   * payment and the client then tries to display a hero the account does not
   * have.
   */
  if (detail.HeroId) {
    /**
     * The hero has to exist in *our* GameMaster. A client can ask for any offer
     * id it likes, and a modified one — or a snapshot newer than ours — may name
     * a hero we have no data for. Handing over an avatar the rest of the server
     * cannot resolve would break the account rather than the request, so it is
     * refused outright instead of skipped.
     */
    const hero = gm.heroById.get(detail.HeroId);
    if (!hero) {
      throw new StoreError(REFUSED, `offer ${detail.OfferId} grants unknown hero ${detail.HeroId}`);
    }

    const alreadyOwned = (account.account_avatars ?? []).some(
      (avatar) => avatar.avatar_id === detail.HeroId
    );
    if (!alreadyOwned) {
      const now = new Date().toISOString();
      const avatarId = await nextId();
      account.account_avatars = [
        ...(account.account_avatars ?? []),
        {
          id: avatarId,
          account_id: account.id,
          avatar_id: detail.HeroId,
          // Heroes arrive on their default skin; the ids run alongside the
          // hero ids, 101..106 mapping to 151..156.
          skin_type: detail.HeroId + 50,
          experience: 0,
          completed_mapnode_mask: "",
          statupgrade1: 0,
          statupgrade2: 0,
          statupgrade3: 0,
          statupgrade4: 0,
          consumable1_id: 0,
          consumable1_count: 0,
          consumable2_id: 0,
          consumable2_count: 0,
          created: now,
        },
      ];
      account.highest_avatar = Math.max(account.highest_avatar ?? 1, account.account_avatars.length);
      touched.add("account_avatars");
      granted.add("hero");

      // A new hero does not arrive empty-handed: the capture shows two starter
      // weapons already equipped in slots 0 and 1.
      for (const [slot, weapon] of starterWeapons(gm, hero).entries()) {
        account.account_items = [
          ...(account.account_items ?? []),
          {
            id: await nextId(),
            item_id: weapon.Id,
            account_id: account.id,
            power: weapon.Power,
            avatar_id: avatarId,
            avatar_slot: slot,
            is_new: 0,
            requiredlevel: 1,
            rarity: 1,
            modifier1: 0,
            modifier2: 0,
            legendarymodifier: 0,
            created: now,
          },
        ];
        touched.add("account_items");
      }
    }
  }

  if (detail.SkinId) {
    account.account_skins = [
      ...(account.account_skins ?? []),
      { id: await nextId(), account_id: account.id, skin_type: detail.SkinId },
    ];
    touched.add("account_skins");
  }

  if (detail.PetId) {
    account.account_pets = [
      ...(account.account_pets ?? []),
      { id: await nextId(), account_id: account.id, npc_id: detail.PetId, equipped_hero: null, is_new: 1 },
    ];
    touched.add("account_pets");
  }

  return touched;
};

/**
 * Retraining a hero is sold as an offer, but it grants nothing the tables can
 * describe: 51303 has no OfferDetails rows at all. The client hard-codes the id
 * (UIHeroTraining.RESPEC_OFFER_ID) and, once the purchase returns, zeroes the
 * four stat bars and writes them back.
 *
 * So the effect has to live here. It applies to the active avatar: the training
 * screen makes whichever hero you are looking at active before letting you buy,
 * and the call itself carries no hero.
 */
const RESPEC_OFFER_ID = 51303;

const respec = (account) => {
  const avatar = (account.account_avatars ?? []).find((entry) => entry.id === account.active_avatar);
  if (!avatar) throw new StoreError(REFUSED, `account ${account.id} has no active avatar to retrain`);

  const spent = [1, 2, 3, 4].reduce((total, slot) => total + Number(avatar[`statupgrade${slot}`] ?? 0), 0);
  if (!spent) throw new StoreError(REFUSED, `avatar ${avatar.id} has no points placed`);

  for (const slot of [1, 2, 3, 4]) avatar[`statupgrade${slot}`] = 0;
  return spent;
};

/**
 * Buys an offer. Mutates the account and returns the list names that changed.
 */
export const purchaseOffer = async ({ account, offerId, nextId, free = false }) => {
  const gm = await loadGameMaster();

  const offer = gm.raw.Offers.find((row) => row.Id === offerId);
  if (!offer) throw new StoreError(REFUSED, `no such offer ${offerId}`);

  // Rewards hand over an offer's contents without charging for it — a daily
  // box is the same grant as a purchase, minus the price.
  const column = CURRENCY_COLUMN[offer.CurrencyType];
  if (!free) {
    if (!column) {
      // Real-money offers are not something this server can settle.
      throw new StoreError(REFUSED, `offer ${offerId} is paid in ${offer.CurrencyType}`);
    }

    const price = Number(offer.Price ?? 0);
    const balance = Number(account[column] ?? 0);
    if (balance < price) {
      throw new StoreError(REFUSED, `offer ${offerId} costs ${price}, account has ${balance}`);
    }
  }

  const details = gm.raw.OfferDetails.filter((row) => row.OfferId === offerId);
  if (!details.length && offerId !== RESPEC_OFFER_ID) {
    throw new StoreError(REFUSED, `offer ${offerId} grants nothing`);
  }

  const touched = new Set();
  const granted = new Set();

  if (offerId === RESPEC_OFFER_ID) {
    const returned = respec(account);
    touched.add("account_avatars");
    granted.add("respec");
    warn(`respec: avatar ${account.active_avatar} got ${returned} points back`);
  }
  for (const detail of details) {
    for (const field of await applyDetail({ account, detail, gm, nextId, granted })) touched.add(field);
  }

  /**
   * Nothing to hand over means nothing to charge for. Buying a hero already on
   * the account is the case that bites: the grant quietly does nothing while
   * the price is taken anyway, and the player watches their gems drop for no
   * reason.
   */
  if (!touched.size && !granted.size) {
    throw new StoreError(REFUSED, `offer ${offerId} would grant nothing`);
  }

  // Charged only once the grant succeeded, so a refusal costs nothing.
  if (!free) account[column] = Number(account[column] ?? 0) - Number(offer.Price ?? 0);

  return { offer, touched: [...touched] };
};

/**
 * The base price a rarity sells against: its key offer, or that offer's coin
 * twin when one exists. Rarities are priced through the key that opens their
 * chests, which is why no weapon carries a price of its own.
 */
const rarityBasePrice = (gm, rarity) => {
  const offer = gm.raw.Offers.find((row) => row.Id === rarity.KeyOfferId);
  if (!offer) return 0;
  const coinOffer = offer.CoinOfferId && gm.raw.Offers.find((row) => row.Id === offer.CoinOfferId);
  return Number((coinOffer || offer).Price ?? 0);
};

/**
 * Sale value of a weapon, as the client computes it in ItemInfo.get_sellCoins.
 *
 * The price shown on the item card is worked out client-side, so anything else
 * here is a number the player watches change when they hit sell. The rarity
 * sets a floor and a ceiling as percentages of that base price, and the weapon's
 * level and modifier levels slide between them:
 *
 *   t     = level/100 * LevelWeight + (sum of modifier levels)/(3*n) * ModifierWeight
 *   value = round(((MaxSellPercent - MinSellPercent) * t + MinSellPercent) * base)
 *
 * Power is not part of it, and neither is the legendary modifier — the client
 * keeps that one in a separate field and only sums modifier1 and modifier2.
 */
export const weaponSaleValue = (gm, item) => {
  const rarity = gm.raw.Rarity.find((row) => row.Id === item.rarity);
  if (!rarity) return 0;

  let weight = 1;
  let levels = 0;
  if (rarity.NumberOfModifiers > 0) {
    weight = rarity.NumberOfModifiers * 3;
    for (const id of [item.modifier1, item.modifier2]) {
      if (!id) continue;
      levels += gm.raw.Modifiers.find((row) => row.Id === id)?.MODIFIER_LEVEL ?? 0;
    }
  }

  const slide =
    ((item.requiredlevel ?? 0) / 100) * rarity.LevelWeight +
    (levels / weight) * rarity.ModifierWeight;

  const value =
    ((rarity.MaxSellPercent - rarity.MinSellPercent) * slide + rarity.MinSellPercent) *
    rarityBasePrice(gm, rarity);

  return Math.max(0, Math.round(value));
};

/**
 * Stackables and pets carry their own sale price in GameMaster.
 *
 * Every one of the 35 stackables has SellCoins 0, which is not missing data:
 * potions are given up rather than sold, and the inventory's button says so.
 * The multiplication is kept because the whole stack goes at once.
 */
export const stackableSaleValue = (gm, stackId, count = 1) => {
  const row = gm.raw.Stackables.find((entry) => entry.Id === stackId);
  return Math.max(0, Math.round((row?.SellCoins ?? 0) * count));
};

export const petSaleValue = (gm, npcId) => {
  const row = gm.raw.Npc.find((entry) => entry.Id === npcId);
  return Math.max(0, Math.round(row?.SellCoin ?? 0));
};

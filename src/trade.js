import { loadAccount, saveAccounts, withTwoAccountLocks } from "./accounts.js";
import { heldAccount } from "./account-registry.js";
import { occupiedSlots, storageLimit } from "./inventory-space.js";
import { info } from "./log.js";

/**
 * Moving weapons and gold between two accounts, all of it or none of it.
 *
 * The negotiation is not here. Who offered what, who has agreed and who is
 * still looking belongs to whatever is running the trade screen; this is only
 * the moment both sides have said yes, and its whole job is that the moment
 * either happens completely or not at all.
 *
 * Two things make that true, and both already existed. `withTwoAccountLocks`
 * takes the pair in id order, so two trades touching the same accounts cannot
 * interleave and cannot deadlock against each other. `saveAccounts` writes both
 * sides on one transaction, so a crash between them cannot leave the weapon on
 * neither account or on both.
 */

export class TradeRefused extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "TradeRefused";
    this.reason = reason;
  }
}

const refuse = (reason, message) => new TradeRefused(reason, message);

const accountIdOf = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffff_ffff) {
    throw refuse("bad_account", `${value} is not an account id`);
  }
  return id;
};

/**
 * What one side is giving, checked against what it actually holds.
 *
 * Nothing is moved here. Both sides have to be found sound before either is
 * touched, because the accounts may be the very objects a player is holding —
 * the registry hands every holder the same one — and a refusal that had
 * already taken a weapon off somebody would be a refusal that lost it.
 */
const gather = (account, offer) => {
  const gold = Number(offer?.gold ?? 0);
  if (!Number.isSafeInteger(gold) || gold < 0) {
    throw refuse("bad_offer", `${offer?.gold} is not an amount of gold`);
  }
  if (gold > Number(account.basic_currency ?? 0)) {
    throw refuse("not_enough_gold", `account ${account.id} does not have ${gold} gold`);
  }

  const wanted = offer?.items ?? [];
  if (!Array.isArray(wanted)) throw refuse("bad_offer", "items must be a list");

  const items = [];
  const seen = new Set();
  for (const value of wanted) {
    const id = Number(value);
    if (seen.has(id)) {
      throw refuse("bad_offer", `item ${id} is offered twice`);
    }
    seen.add(id);

    const item = (account.account_items ?? []).find((row) => Number(row.id) === id);
    if (!item) {
      throw refuse("not_owned", `account ${account.id} does not hold item ${id}`);
    }
    /**
     * Equipped weapons are refused rather than quietly taken off. The hero's
     * statistics were worked out from what it was holding, the client draws
     * the slot, and a weapon that vanished out of a hand mid-negotiation is a
     * surprise where "unequip it first" is a sentence.
     */
    if (Number(item.avatar_id ?? 0)) {
      throw refuse("equipped", `item ${id} is equipped — unequip it first`);
    }
    items.push(item);
  }

  return { gold, items };
};

/**
 * Whether what each side is about to receive fits.
 *
 * Counted the way the client counts, since that is the number the player is
 * shown: unequipped weapons plus held chests, against `buckets_weapon`. Both
 * sides are checked after the whole exchange rather than before, because a
 * trade that fills a bag also empties one, and refusing a full account that is
 * giving away more than it takes would be refusing arithmetic.
 */
const roomFor = (account, giving, receiving) => {
  const after = occupiedSlots(account) - giving.items.length + receiving.items.length;
  if (after > storageLimit(account)) {
    throw refuse(
      "no_room",
      `account ${account.id} would hold ${after} of ${storageLimit(account)} slots`
    );
  }
};

const hand = (from, to, taken) => {
  from.basic_currency = Number(from.basic_currency ?? 0) - taken.gold;
  to.basic_currency = Number(to.basic_currency ?? 0) + taken.gold;

  for (const item of taken.items) {
    from.account_items.splice(from.account_items.indexOf(item), 1);
    /**
     * The id travels with the weapon. It is the identity of that instance
     * rather than a key into one account's list — the same number is the
     * object id the protocol uses — so minting a new one would be turning the
     * weapon into a different weapon.
     */
    to.account_items.push({
      ...item,
      account_id: to.id,
      avatar_id: null,
      avatar_slot: null,
      is_new: 1,
    });
  }
};

const describe = (taken) =>
  [taken.gold ? `${taken.gold} gold` : null, taken.items.length ? `items ${taken.items.map((item) => item.id).join(",")}` : null]
    .filter(Boolean)
    .join(" and ") || "nothing";

/**
 * `parties` is exactly two, each `{ accountId, items, gold }`.
 *
 * Refusing while either player is in a dungeon is a rule about the game rather
 * than about this code. The registry means a trade would not be lost — a
 * session holds the same object everybody else does — but the player is using
 * those weapons in a run that is still going, and the hero's statistics were
 * settled when they walked in.
 */
export const settleTrade = async ({ parties } = {}) => {
  if (!Array.isArray(parties) || parties.length !== 2) {
    throw refuse("bad_offer", "a trade has exactly two parties");
  }

  const [firstId, secondId] = parties.map((party) => accountIdOf(party?.accountId));
  if (firstId === secondId) {
    throw refuse("bad_offer", "an account cannot trade with itself");
  }

  for (const id of [firstId, secondId]) {
    if (heldAccount(id)) {
      throw refuse("in_dungeon", `account ${id} is in a dungeon`);
    }
  }

  return withTwoAccountLocks(firstId, secondId, async () => {
    const first = await loadAccount(firstId);
    const second = await loadAccount(secondId);

    // Checked again inside the locks: a run can begin between the first look
    // and here, and this is the one that decides.
    for (const id of [firstId, secondId]) {
      if (heldAccount(id)) throw refuse("in_dungeon", `account ${id} is in a dungeon`);
    }

    const fromFirst = gather(first, parties[0]);
    const fromSecond = gather(second, parties[1]);

    roomFor(first, fromFirst, fromSecond);
    roomFor(second, fromSecond, fromFirst);

    hand(first, second, fromFirst);
    hand(second, first, fromSecond);

    await saveAccounts([first, second]);

    /**
     * Written down because a trade is the one thing here that moves value
     * between two people, and "it was not me" is the complaint an operator
     * cannot answer from the account rows alone — they only show where things
     * ended up.
     */
    info(
      `trade: ${firstId} gave ${describe(fromFirst)} to ${secondId}, ` +
        `and received ${describe(fromSecond)}`
    );

    return {
      parties: [
        { accountId: firstId, gave: describe(fromFirst), gold: Number(first.basic_currency) },
        { accountId: secondId, gave: describe(fromSecond), gold: Number(second.basic_currency) },
      ],
    };
  });
};

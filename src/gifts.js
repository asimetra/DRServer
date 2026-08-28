import { loadGameMaster } from "./gamemaster.js";
import { friendIdsOf } from "./social.js";

/**
 * Sending somebody a free consumable, and being allowed to do it again tomorrow.
 *
 * The whole feature is three offers wide. Of the 3169 rows in `Offers`, exactly
 * three are free gifts — Health Bomb, Health Shot and Mana Shot, all priced 0 —
 * and each grants one stackable. Every gift in the recordings is one of them:
 * eight of offer 51301 and one of 51399.
 *
 * That narrowness is what makes this safe to build. The sender names an offer,
 * and an offer id is the one thing here a modified client picks freely — so if
 * anything but those three were reachable, gifting an alt account would be a way
 * to hand it any of the 3072 weapon offers for nothing. The list is derived from
 * the table rather than written down, so it follows the data, and anything
 * outside it is refused.
 *
 * What the client is trusted with, and what it is not:
 *
 *   trusted   which of the three offers to send, and to whom — both checked
 *   trusted   that a button was pressed to accept a gift
 *   NOT       what the gift contains. `AcceptGift` carries a request id and
 *             nothing else, so what arrives is whatever this server wrote down
 *             when the gift was made, never what the receiver claims it was.
 *   NOT       the request id of a gift it is creating. The official client
 *             invents one — `0_1787354382405.14_1000164031`, its own clock and
 *             the recipient — and a sender choosing the identifier of a row on
 *             somebody else's account is a sender who can overwrite one. Minted
 *             here instead; the client's is read and discarded.
 */

/** A day per recipient. */
const HOUR = 60 * 60 * 1000;
export const GIFT_COOLDOWN_MS = 24 * HOUR;

/**
 * How long the cooldown really is, as far as the recordings can say.
 *
 * They show it is per recipient and clears on about a one-day scale: sixteen
 * accounts sat on one player's exclude list from 2026-08-15 19:34 and were gone
 * by 2026-08-16 20:11, some twenty-five hours later. That is consistent with a
 * rolling day and with a reset at some daily boundary both, and there are not
 * enough transitions in the captures to tell those apart. A rolling day is the
 * one chosen, because it is the one that cannot be gamed by sending just before
 * the boundary and again just after.
 */

/** Bounds the sent-log so an account cannot grow one without limit. */
const MAX_SEND_HISTORY = 512;
/** And the pending pile, which is fed by other people. */
export const MAX_PENDING_GIFTS = 200;

/**
 * The offers that may be given away.
 *
 * Read off the table: free, and named as a gift. That is exactly the three the
 * game ships, and deriving it means a fourth added later is gifted without
 * anybody having to remember this file exists.
 */
export const giftableOfferIds = async () => {
  const gm = await loadGameMaster();
  const ids = new Set();
  for (const offer of gm.raw.Offers) {
    if (Number(offer.Price) !== 0) continue;
    if (!/\(free gift\)/i.test(String(offer.Name ?? ""))) continue;
    ids.add(Number(offer.Id));
  }
  return ids;
};

const sendHistoryOf = (account) =>
  Array.isArray(account?.gift_sends) ? account.gift_sends : [];

/** Who this account has given to recently, newest first, expired ones dropped. */
const recentSends = (account, now) =>
  sendHistoryOf(account).filter((row) => now - Number(row.at ?? 0) < GIFT_COOLDOWN_MS);

/**
 * The accounts the client must not offer as gift targets.
 *
 * `FriendPopulater` hides any friend whose id is in here, so this is the only
 * expression the cooldown has: there is no timer anywhere in the client and no
 * countdown in the payload. Strings, because that is what `excludeId` is
 * compared against — `Std.string(this.id)` for a legacy-client friend.
 */
export const excludeIdsFor = (account, now = Date.now()) =>
  recentSends(account, now).map((row) => String(row.to));

/** Whether this pair is inside the window, which is the question the send asks. */
export const canGiftTo = (account, toId, now = Date.now()) =>
  !recentSends(account, now).some((row) => Number(row.to) === Number(toId));

export const pendingGiftsFor = (account) => (Array.isArray(account?.gifts) ? account.gifts : []);

/**
 * The shape `GetAllGifts` answers with, matching the official one field for
 * field. The client reads only `from_account_id`, `offer_id` and `request_id`
 * off a row, and the rest is here because the recording carries it and somebody
 * modding this later should find the same thing the real server sent.
 */
export const giftsFor = (account, now = Date.now()) => ({
  gifts: pendingGiftsFor(account),
  excludeIds: excludeIdsFor(account, now),
});

/**
 * A request id nobody else chose.
 *
 * Same shape the client makes, because that shape is what a modded client and
 * the real one both expect to hand back: a counter, a timestamp and the account
 * it belongs to. The last part matters — a gift can only be accepted by the
 * account named in its own id, so an id that names somebody else is refused
 * without having to look anything up.
 */
let sequence = 0;

export const mintRequestId = (toAccountId, now = Date.now()) =>
  `${sequence++ % 1000}_${now}_${Number(toAccountId)}`;

export const requestIdNames = (requestId, accountId) =>
  String(requestId ?? "").endsWith(`_${Number(accountId)}`);

export class GiftError extends Error {}

/**
 * Puts one gift on somebody's pile and starts the sender's clock.
 *
 * Refuses rather than silently dropping, because each refusal is a thing an
 * unmodified client cannot ask for: it does not offer an ungiftable offer, does
 * not gift a stranger, and hides anybody already on the exclude list.
 */
export const sendGift = async ({ sender, recipient, offerId, now = Date.now() }) => {
  const offer = Number(offerId);
  if (!(await giftableOfferIds()).has(offer)) {
    throw new GiftError(`offer ${offer} is not a gift`);
  }
  if (Number(recipient.id) === Number(sender.id)) {
    throw new GiftError("an account cannot gift itself");
  }
  if (!friendIdsOf(sender).includes(Number(recipient.id))) {
    throw new GiftError(`${recipient.id} is not a friend of ${sender.id}`);
  }
  if (!canGiftTo(sender, recipient.id, now)) {
    throw new GiftError(`${sender.id} has already gifted ${recipient.id} today`);
  }
  if (pendingGiftsFor(recipient).length >= MAX_PENDING_GIFTS) {
    throw new GiftError(`${recipient.id} is holding too many gifts`);
  }

  const gift = {
    id: Number(`${now}`.slice(-9)),
    network_id: 3,
    to_account_key: String(recipient.id),
    from_account_id: Number(sender.id),
    offer_id: offer,
    request_id: mintRequestId(recipient.id, now),
    created: new Date(now).toISOString(),
  };

  recipient.gifts = [...pendingGiftsFor(recipient), gift];
  sender.gift_sends = [
    ...recentSends(sender, now),
    { to: Number(recipient.id), at: now },
  ].slice(-MAX_SEND_HISTORY);

  return gift;
};

/**
 * Takes one off the pile and says what it was worth.
 *
 * Removed before anything is granted, and returned so the caller grants exactly
 * the offer written down here. Accepting twice finds nothing the second time,
 * which is the whole defence against a client that sends the same request id
 * repeatedly — there is no amount of asking that turns one gift into two.
 */
export const takeGift = (account, requestId) => {
  const id = String(requestId ?? "");
  if (!requestIdNames(id, account.id)) return null;
  const pending = pendingGiftsFor(account);
  const gift = pending.find((row) => String(row.request_id) === id);
  if (!gift) return null;
  account.gifts = pending.filter((row) => String(row.request_id) !== id);
  return gift;
};

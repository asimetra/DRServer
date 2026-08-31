import { PacketWriter } from "./packet.js";
import { OP } from "./opcodes.js";
import { info, warn } from "../log.js";
import { ChestError, openChest } from "../chests.js";
import { nextObjectId } from "../accounts.js";
import { queueAccountSave } from "./rewards.js";
import { membersOf } from "./match-world.js";

/**
 * The dungeon report's chest buttons.
 *
 * Three of the four chest fields on DistributedDungeonSummary are requests the
 * client makes about the treasure it carried out of a run, and the fourth is
 * the answer:
 *
 *   282  OpenChest            u32 accountId, u32 slot
 *   283  TakeChest            u32 accountId, u32 slot     — the "keep" button
 *   284  DropChest            u32 accountId, u32 slot     — "abandon"
 *   285  TransactionResponse  u32 accountId, u8 succeeded, u32 offerId, u32 weaponId
 *
 * `slot` is not a chest id. It is an index into the report's own
 * chest_type_1..4 — `findSlotForChest` walks exactly those four fields — which
 * is the order `session.dungeonTreasures` was built in.
 *
 * None of this was answered before. Keep in particular did not fail quietly:
 * `keepChestFromInventory` puts up a TAKING_ITEM popup and waits for 285, so a
 * player who pressed it sat under that popup until they killed the client.
 *
 * **Keep is the grant.** A treasure picked up off the floor is only a claim
 * until this screen; the chest reaches the account when the player keeps it,
 * and Abandon removes nothing because nothing was ever added.
 *
 * That is measured, and it replaced the opposite assumption. Across the
 * official captures all seven increases in `account_chests` follow a TakeChest
 * or an OpenChest and nothing else — one run collected four treasures, kept one
 * and dropped three, and the account went 6 → 7 rather than to 10 and back. The
 * report being drawn does not do it either: the account still read 6 while it
 * was on screen.
 *
 * So walking out before the report keeps no chests, which is what makes
 * finishing a run worth something. Gold is the opposite and stays that way —
 * banked as it is picked up, and a mid-run quit does not give it back.
 */

export const FLID_OPEN_CHEST = 282;
export const FLID_TAKE_CHEST = 283;
export const FLID_DROP_CHEST = 284;
const FLID_TRANSACTION_RESPONSE = 285;

/** The report has four treasure slots; the client cannot address a fifth. */
const REPORT_TREASURE_SLOTS = 4;

/**
 * Who hears the answer, and why it is everybody.
 *
 * The captured sessions received responses addressed to five other accounts —
 * party members opening and keeping their own chests — so the official sends
 * this to the whole summary rather than to the asker. That is what the client's
 * own `mDBFacade.accountId != account_id` guard exists to ignore, and matching
 * it means a modified client cannot learn anything it was not already told.
 *
 * `membersOf` covers the solo case too: with no match world it yields the one
 * session, the same way sendDungeonSummary reaches its recipients.
 */
const respond = (session, succeeded, { offerId = 0, weaponId = 0 } = {}) => {
  const doid = session.summaryDoid;
  const accountId = session.dungeonAccount?.id ?? session.accountId ?? 0;
  if (!doid || !accountId) return 0;

  const frame = new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_TRANSACTION_RESPONSE)
    .u32(accountId)
    .u8(succeeded ? 1 : 0)
    .u32(offerId)
    .u32(weaponId)
    .frame();

  let sent = 0;
  for (const member of membersOf(session)) {
    member.send?.(frame);
    sent += 1;
  }
  return sent;
};

/**
 * Reads the two words every one of these carries.
 *
 * The account id the client states is checked rather than used. Every request
 * has to be about the sender's own chests, and the sender is the socket; a
 * request naming somebody else is refused instead of being quietly applied to
 * whoever sent it.
 */
const readRequest = (session, reader) => {
  if (reader.remaining < 8) return null;
  const claimed = reader.u32();
  const slot = reader.u32();

  const account = session.dungeonAccount;
  if (!account) return null;
  if (claimed !== account.id) {
    warn(`[${session.id}] chest request named account ${claimed}, not ${account.id}`);
    return null;
  }
  return { account, slot };
};

/**
 * The treasure a slot stands for, if it is still the player's to decide about.
 *
 * `settled` is what stops a slot being spent twice. The client clears its own
 * slot as soon as it acts and `findSlotForChest` skips a cleared one, so a
 * repeat means either a resend or a modified client — and the second abandon of
 * one slot must not take a chest the player never offered up.
 */
const treasureAt = (session, slot) => {
  if (!Number.isInteger(slot) || slot < 0 || slot >= REPORT_TREASURE_SLOTS) return null;
  const treasure = session.dungeonTreasures?.[slot];
  if (!treasure || treasure.settled) return null;
  return treasure;
};

/**
 * Puts the chest on the account, which is what Keep and Open actually do.
 *
 * `is_new` is sent by the official — every chest row in a captured payload
 * carries it, and every one of them is 1. It was left out of this server's
 * schema once, on the reasoning that the client diffs against the list it last
 * held; the captures say otherwise.
 */
const grantChest = async (account, treasure) => {
  const chest = {
    id: await nextObjectId(account),
    account_id: account.id,
    chest_id: treasure.chestId,
    is_new: 1,
  };
  account.account_chests = [...(account.account_chests ?? []), chest];
  return chest;
};

/**
 * Persist, then answer — in that order, and not as a matter of tidiness.
 *
 * `TransactionResponse` calls `getUsersFullAccountInfo()` and holds the popup
 * open until DB_ACCOUNT_INFO_LOADED comes back. Replying first would race the
 * client's own refetch against the write and hand it back the state it already
 * had.
 */
const settle = async (session, succeeded, reward) => {
  try {
    await queueAccountSave(session);
  } catch (problem) {
    warn(`[${session.id}] chest transaction could not be saved: ${problem.message}`);
    return respond(session, false);
  }
  return respond(session, succeeded, reward);
};

/**
 * Keep. The chest is already on the account, so this confirms and records that
 * the slot is spent.
 *
 * Deliberately not gated on storage space. The client checks
 * `isThereEmptySpaceInWeaponStorage()` before it ever sends this and offers the
 * player abandon instead, so a take that arrives has already been consented to;
 * refusing it here would be the server deleting a chest the player asked to
 * keep. Overflow is the better failure.
 */
export const handleTakeChest = async (session, reader) => {
  const request = readRequest(session, reader);
  if (!request) return respond(session, false);

  const treasure = treasureAt(session, request.slot);
  if (!treasure) {
    warn(`[${session.id}] keep names no unspent treasure in slot ${request.slot}`);
    return respond(session, false);
  }

  treasure.settled = "kept";
  const chest = await grantChest(request.account, treasure);
  info(
    `[${session.id}] kept chest ${treasure.chestId} from report slot ${request.slot} ` +
      `— instance ${chest.id}`
  );
  return settle(session, true);
};

/**
 * Abandon. The chest goes back off the account.
 *
 * **No answer, and that is measured.** Across the official captures the client
 * sent six drops and not one was replied to, while all six takes were answered
 * within 351-397ms. The client agrees: `abandonChestCallback` clears its own
 * slot in the confirm handler and never waits. Sending 285 here would push it
 * through a popup path it did not ask for.
 */
export const handleDropChest = async (session, reader) => {
  const request = readRequest(session, reader);
  if (!request) return false;

  const treasure = treasureAt(session, request.slot);
  if (!treasure) {
    warn(`[${session.id}] abandon names no unspent treasure in slot ${request.slot}`);
    return false;
  }

  /**
   * Nothing is removed, because nothing was ever added: the treasure is only a
   * claim on a chest until it is kept. That is what the captures show — three
   * abandons in one run left the account exactly where it was.
   *
   * So this only spends the slot, and no save is needed for the same reason.
   */
  treasure.settled = "dropped";
  info(`[${session.id}] abandoned chest ${treasure.chestId} from report slot ${request.slot}`);
  return true;
};

/**
 * Open, from the report rather than from the inventory screen.
 *
 * The same award `account/OpenChest` performs — one implementation, so a chest
 * opened here cannot roll differently from the same chest opened in town. The
 * key is spent by `openChest` and only once the award is certain.
 *
 * No capture covers this: the recorded runs never had a key in hand at the
 * report. What settles the reply's shape is the other side of those captures —
 * party members' opens came back carrying an offer (75004) or a weapon
 * (6313632) in the fields a keep leaves zero.
 */
export const handleOpenChest = async (session, reader) => {
  const request = readRequest(session, reader);
  if (!request) return respond(session, false);

  const treasure = treasureAt(session, request.slot);
  if (!treasure) {
    warn(`[${session.id}] open names no unspent treasure in slot ${request.slot}`);
    return respond(session, false);
  }

  /**
   * Kept first, then opened. `openChest` works on a chest the account holds —
   * the same one the inventory screen opens — so the treasure has to become
   * real before it can be spent. A refusal below puts it back, leaving the
   * player exactly where they started rather than out a chest they never got
   * to open.
   */
  const chest = await grantChest(request.account, treasure);

  try {
    const reward = await openChest({
      account: request.account,
      chestInstanceId: chest.id,
      heroInstanceId: session.dungeonAvatar?.id,
      nextId: () => nextObjectId(request.account),
    });
    treasure.settled = "opened";
    info(
      `[${session.id}] opened chest ${treasure.chestId} from report slot ${request.slot} ` +
        `— item ${reward.WeaponId}`
    );
    return settle(session, true, {
      offerId: Number(reward.OfferId ?? 0),
      weaponId: Number(reward.WeaponId ?? 0),
    });
  } catch (problem) {
    /**
     * Taken back off again. The grant above was only so `openChest` had
     * something to work on; a refusal must not leave the player holding a chest
     * the report screen has already cleared from its slot, which they would
     * then never see again.
     */
    request.account.account_chests = (request.account.account_chests ?? []).filter(
      (entry) => entry.id !== chest.id
    );
    const why = problem instanceof ChestError ? problem.message : `unexpected: ${problem.message}`;
    warn(`[${session.id}] could not open chest ${treasure.chestId}: ${why}`);
    return respond(session, false);
  }
};

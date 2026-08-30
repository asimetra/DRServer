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
 * **Keep does not grant anything.** The chest reached the account when it was
 * picked up off the floor, in `awardTreasureChest`, so by the time this screen
 * is drawn the run is already banked. Keep confirms and Abandon takes it back.
 * A player who closes the report without pressing either keeps what they
 * collected, which is the side to err on.
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

/** The chest row a report slot names, or null once it is no longer held. */
const chestFor = (account, treasure) =>
  (account.account_chests ?? []).find((entry) => entry.id === treasure.id) ?? null;

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
  if (!chestFor(request.account, treasure)) {
    warn(`[${session.id}] keep names chest ${treasure.id}, no longer on the account`);
    return respond(session, false);
  }

  treasure.settled = "kept";
  info(`[${session.id}] kept chest ${treasure.chestId} from report slot ${request.slot}`);
  // Nothing changed on the account, but the client refetches on this answer
  // regardless, so it must not read a half-written run.
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

  const chest = chestFor(request.account, treasure);
  if (!chest) {
    warn(`[${session.id}] abandon names chest ${treasure.id}, no longer on the account`);
    return false;
  }

  treasure.settled = "dropped";
  request.account.account_chests = request.account.account_chests.filter(
    (entry) => entry.id !== chest.id
  );
  info(`[${session.id}] abandoned chest ${treasure.chestId} from report slot ${request.slot}`);
  // Caught rather than thrown: nothing is waiting on this one, so a failed
  // write is worth a line naming the chest and nothing more.
  await queueAccountSave(session).catch((problem) =>
    warn(`[${session.id}] abandoned chest ${treasure.chestId} but could not save: ${problem.message}`)
  );
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

  try {
    const reward = await openChest({
      account: request.account,
      chestInstanceId: treasure.id,
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
    // A refusal is the live server's own answer for "rolled something but could
    // not hand it over", and the chest stays put for the player to keep instead.
    const why = problem instanceof ChestError ? problem.message : `unexpected: ${problem.message}`;
    warn(`[${session.id}] could not open chest ${treasure.chestId}: ${why}`);
    return respond(session, false);
  }
};

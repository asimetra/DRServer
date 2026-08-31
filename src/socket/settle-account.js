import { saveAccount } from "../accounts.js";
import { reconcileConsumables } from "../consumables.js";
import { warn } from "../log.js";

/**
 * Writes the run down, once.
 *
 * **Once is the whole point.** `session.dungeonAccount` is loaded when the
 * dungeon is entered and held for the length of the run, while every JSON-RPC
 * the client makes reads its own fresh copy and writes the whole account back.
 * So a session that saves its snapshot late does not merge with those writes —
 * it overwrites them with a picture taken minutes earlier.
 *
 * That is not theoretical. From a captured session, to the second:
 *
 *   11:41:30  chest opened on the report screen, weapon 2073742255 awarded
 *   11:41:30  the reveal popup sends the player into the inventory, still in
 *             the dungeon — they equip the weapon and drop a spare chest, both
 *             over JSON-RPC, both landing correctly on disk
 *   11:41:46  the player leaves the report; the teardown saves the account it
 *             loaded at *entry*, which knows about neither
 *
 * The weapon came back unequipped and the dropped chest came back. The teardown
 * write is the last one in the log; nothing else touched the account for the
 * remaining 73 seconds of the session.
 *
 * Hence the flag rather than a second save. The report screen is the last
 * moment the run's own numbers can still change, and it is also the moment the
 * client hands the player an inventory — so the run is written down there, and
 * leaving writes nothing.
 *
 * Leaving still has to settle a run that never reached a report: quitting
 * mid-floor, wiping, or dropping the connection all arrive at `leaveDungeon`
 * without a summary, and the carry rule below has to run for those too.
 */

/**
 * Puts the run's powerups back where the carry rule says they belong.
 *
 * Whatever was not drunk goes back in the bag and the slot is topped up out of
 * it, which is the same call equipping makes.
 *
 * Everything it needs is taken *before* the teardown runs, because the teardown
 * deletes it. This used to end in `queueAccountSave(session)`, which opens by
 * reading `session.dungeonAccount` — deleted by then, so it returned null and
 * the settled account was never written down. The rule had run correctly and
 * died in memory.
 *
 * Reported from play: spend the last of a powerup, kill the process rather than
 * walking out, and the slot still shows the item at "x0".
 *
 * Chained onto whatever save is already in flight so the two cannot land out of
 * order. `saveAccount` now orders the writes themselves, one per account, so
 * this is no longer the only thing standing between two of them; it stays
 * because the settle has to run *after* the reward save it is reconciling
 * against, which is an ordering of the work rather than of the writes.
 *
 * Both save seams are kept, the way the other callers keep them. A session
 * carrying its own `queueAccountSave` has said how it wants to be saved, and
 * `saveAccount` writes a file named after `account.id` — so a session that
 * overrides the save because it has no real account behind it should not be
 * quietly handed to the real one.
 */
export const settleDungeonAccount = (session) => {
  const account = session?.dungeonAccount;
  const avatar = session?.dungeonAvatar;
  if (!account || !avatar) return null;
  if (session.accountSettled) return null;
  session.accountSettled = true;

  // Read now, because the teardown deletes `persistDungeonAccount` too.
  const queued = session.queueAccountSave;
  const persist = session.persistDungeonAccount ?? saveAccount;
  const save = queued ? () => queued(session) : () => persist(account);

  const pending = (session.rewardSavePromise ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => reconcileConsumables(account, avatar))
    .then(save)
    .catch((problem) => warn(`[${session.id}] powerup reconcile failed: ${problem.message}`));

  // Becomes the save in flight, so anything that still queues one orders behind
  // it rather than racing it — and so a caller that wants to wait can.
  session.rewardSavePromise = pending;
  return pending;
};

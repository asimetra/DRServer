/**
 * The two powerup slots on an avatar, and the one repair that needs no context.
 *
 * Separate from `consumables.js` because the carry rule there has to allocate
 * bag-row ids, which means importing `accounts.js` — and `accounts.js` repairs
 * loaded accounts, which means it would have to import back. Nothing here
 * imports anything, so both can depend on it and neither depends on the other.
 */

/** Slots are one-based in the account fields and there are exactly two. */
export const SLOTS = [1, 2];

export const fieldsFor = (slot) => ({
  id: `consumable${slot}_id`,
  count: `consumable${slot}_count`,
});

export const positive = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
};

/**
 * Clears powerups that ran out, for accounts already written that way.
 *
 * The clearing half of the carry rule and none of the topping up, because this
 * runs on every account load — including loads during a run, where refilling a
 * slot out of the bag would hand a player powerups they had already spent.
 * Releasing a slot with nothing behind it gives them nothing, so it is safe
 * wherever it lands.
 *
 * Needed because the settle at the end of a run went unwritten: it corrected
 * the account in memory, and the save that should have followed read a session
 * field the teardown had already deleted. So an account that quit a dungeon
 * empty-handed kept the "x0" on disk. One local account had both halves of it —
 * `70005` in a slot with nothing behind it, and a `60018` bag row at zero.
 *
 * A zero bag row is the same defect seen from the other side: the client draws
 * the bag from these rows, so it is an item in the inventory the player can
 * neither use, sell, nor get rid of.
 */
export const repairSpentPowerups = (account) => {
  const avatars = Array.isArray(account?.account_avatars) ? account.account_avatars : [];
  const rows = Array.isArray(account?.account_stackables) ? account.account_stackables : [];
  let repaired = 0;

  for (const avatar of avatars) {
    for (const slot of SLOTS) {
      const field = fieldsFor(slot);
      const stackId = positive(avatar?.[field.id]);
      if (!stackId) continue;

      const bagged = positive(rows.find((row) => Number(row.stack_id) === stackId)?.count);
      if (positive(avatar[field.count]) + bagged > 0) continue;

      avatar[field.id] = 0;
      avatar[field.count] = 0;
      repaired += 1;
    }
  }

  const kept = rows.filter((row) => positive(row?.count) > 0);
  if (kept.length !== rows.length) {
    account.account_stackables = kept;
    repaired += rows.length - kept.length;
  }

  return repaired;
};

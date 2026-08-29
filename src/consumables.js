/**
 * How many of a powerup a hero carries, and where the rest of them live.
 *
 * There is one rule here and everything else is a consequence of it:
 *
 *     total = carried + bagged
 *     carried = min(CARRY_LIMIT, total)
 *     bagged  = total - carried
 *
 * Written as an invariant rather than as a set of events, because the events
 * are the part that keeps growing. Entering a dungeon, finishing one, dying in
 * one, quitting, dropping the connection, equipping, unequipping — each is
 * another place that would have to remember to move the same two numbers in
 * opposite directions. Restoring the rule instead is the same call every time,
 * it is safe to make twice, and it is safe to make when nothing has changed.
 *
 * Equipping used to move the whole stack: a hundred potions went onto the
 * avatar and the bag row was deleted. That is why a hero could walk in with
 * ninety-seven of something and never run out.
 */
import { nextObjectId } from "./accounts.js";

/** What a hero can carry into a dungeon, per slot. */
export const CARRY_LIMIT = 9;

/** Slots are one-based in the account fields and there are exactly two. */
const SLOTS = [1, 2];

const fieldsFor = (slot) => ({
  id: `consumable${slot}_id`,
  count: `consumable${slot}_count`,
});

const positive = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
};

/**
 * Puts a count into the bag for a stack id, creating or removing the row.
 *
 * A row at zero is removed rather than kept, because the client draws the bag
 * from these rows and a zero row is an item in the inventory with "x0" on it —
 * something the player cannot use, sell or get rid of.
 */
const setBagged = async (account, stackId, count) => {
  account.account_stackables ??= [];
  const rows = account.account_stackables;
  const index = rows.findIndex((row) => Number(row.stack_id) === Number(stackId));

  if (count <= 0) {
    if (index !== -1) rows.splice(index, 1);
    return;
  }

  if (index !== -1) {
    rows[index].count = count;
    return;
  }

  rows.push({
    id: await nextObjectId(account),
    account_id: account.id,
    stack_id: Number(stackId),
    count,
    is_new: 0,
  });
};

/**
 * Restores the rule for both powerup slots of one avatar.
 *
 * Slots are settled in order rather than in parallel: both draw from the same
 * bag, so telling each of them independently that it may have nine would
 * invent stock when the same stack sits in both.
 *
 * An empty slot is left alone. Nothing is equipped there, so there is no item
 * whose total this could be about, and helping itself to something from the bag
 * would be equipping on the player's behalf.
 */
/**
 * Drops every bag row that has reached zero, not only the ones a slot names.
 *
 * The slot loop below can only clean up stacks something is equipped to, so a
 * key or a potion that ran out on its own stayed in the bag showing "x0" — an
 * item the player can neither use nor sell nor get rid of. One live account was
 * carrying `60018 x0` exactly that way.
 */
const sweepEmptyRows = (account) => {
  if (!Array.isArray(account?.account_stackables)) return;
  account.account_stackables = account.account_stackables.filter(
    (row) => positive(row?.count) > 0
  );
};

export const reconcileConsumables = async (account, avatar) => {
  if (!avatar) {
    sweepEmptyRows(account);
    return;
  }

  for (const slot of SLOTS) {
    const field = fieldsFor(slot);
    const stackId = positive(avatar[field.id]);
    if (!stackId) {
      avatar[field.count] = 0;
      continue;
    }

    const bagged = positive(
      (account.account_stackables ?? []).find((row) => Number(row.stack_id) === stackId)?.count
    );
    const total = positive(avatar[field.count]) + bagged;

    if (total === 0) {
      // Nothing left anywhere: the slot stops being reserved for it, so the
      // player can put something they do own there instead.
      avatar[field.id] = 0;
      avatar[field.count] = 0;
      await setBagged(account, stackId, 0);
      continue;
    }

    const carried = Math.min(CARRY_LIMIT, total);
    avatar[field.count] = carried;
    await setBagged(account, stackId, total - carried);
  }

  sweepEmptyRows(account);
};

/**
 * Puts a stack in a slot, wherever it currently is.
 *
 * Equipping used to look only in the bag, and equipping is what takes a stack
 * *out* of the bag — so a powerup already in one slot could not be moved to the
 * other. The lookup failed, the RPC threw, and the client was left on an equip
 * screen with nothing to draw.
 *
 * So the question is "where is this stack", not "is it in the bag": it may be
 * in the bag, it may be in the other slot, and it may be in both. Whatever is
 * displaced goes back to the bag first, and the rule settles the counts after.
 */
export const moveConsumableToSlot = async (account, avatar, stackId, slot) => {
  const id = positive(stackId);
  if (!avatar || !id) return false;

  const target = fieldsFor(Number(slot) === 1 ? 2 : 1);
  const other = fieldsFor(Number(slot) === 1 ? 1 : 2);

  const inBag = positive(
    (account.account_stackables ?? []).find((row) => Number(row.stack_id) === id)?.count
  );
  const inOther = positive(avatar[other.id]) === id ? positive(avatar[other.count]) : 0;
  const inTarget = positive(avatar[target.id]) === id ? positive(avatar[target.count]) : 0;
  if (!inBag && !inOther && !inTarget) return false;

  // Whatever the target slot was holding is not this stack, so it goes back.
  if (positive(avatar[target.id]) && positive(avatar[target.id]) !== id) {
    const displaced = positive(avatar[target.id]);
    const bagged = positive(
      (account.account_stackables ?? []).find((row) => Number(row.stack_id) === displaced)?.count
    );
    await setBagged(account, displaced, bagged + positive(avatar[target.count]));
  }

  // Taken out of the other slot rather than duplicated into this one.
  if (inOther) {
    avatar[other.id] = 0;
    avatar[other.count] = 0;
  }

  avatar[target.id] = id;
  avatar[target.count] = inOther + inTarget;
  await reconcileConsumables(account, avatar);
  return true;
};

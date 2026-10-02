import assert from "node:assert/strict";
import test from "node:test";

import { SOLD_LISTINGS, planWrite, snapshotOf } from "../src/storage/account-rows.js";

/**
 * What a save has to write, worked out from what storage already holds.
 *
 * A save used to empty every list an account has and write each row back, one
 * statement a row: an account with a hundred weapons cost about a hundred and
 * twenty-five round trips, and a dungeon did that for every coin picked up.
 * The account that came back from a coin differed from the one in storage by
 * one number.
 *
 * So a save is planned against a picture of what storage holds — taken when
 * the account was read or last written — and only the difference is sent. The
 * plan is still "make storage equal this object"; it only leaves out the rows
 * that already are.
 */

const account = (overrides = {}) => ({
  id: 500,
  name: "Simetra",
  basic_currency: 1000,
  premium_currency: 5,
  friend_requests: [],
  infinite_progress: {},
  account_avatars: [
    { id: 11, account_id: 500, avatar_id: 101, experience: 4000, created: "2026-09-01T10:00:00.000Z" },
  ],
  account_items: [
    { id: 21, account_id: 500, item_id: 9001, power: 40, avatar_id: 11, avatar_slot: 0, is_new: 0 },
    { id: 22, account_id: 500, item_id: 9002, power: 55, avatar_id: null, avatar_slot: null, is_new: 1 },
  ],
  account_attributes: [{ id: 31, account_id: 500, name: "tutorial", value: "done" }],
  market_listings: [],
  ...overrides,
});

const stored = (value) => snapshotOf(value, 7);
const ops = (plan) => ({
  full: plan.full,
  columns: plan.accountColumns,
  removes: Object.fromEntries([...plan.removes].map(([table, rows]) => [table, rows.map((row) => row.id)])),
  inserts: Object.fromEntries([...plan.inserts].map(([table, rows]) => [table, rows.map((row) => row.id)])),
  updates: Object.fromEntries([...plan.updates].map(([table, rows]) => [table, rows.map((row) => row.id)])),
});

test("with nothing known about storage, the whole account is written", () => {
  const plan = planWrite(null, account());

  assert.equal(plan.full, true);
  assert.deepEqual(ops(plan).inserts, {
    account_avatars: [11],
    account_items: [21, 22],
    account_attributes: [31],
  });
  assert.deepEqual(ops(plan).updates, {});
});

test("an account that has not changed writes no rows at all", () => {
  const plan = planWrite(stored(account()), account());

  assert.deepEqual(ops(plan), { full: false, columns: [], removes: {}, inserts: {}, updates: {} });
  assert.equal(plan.version, 7, "and it is held against the version that picture was taken at");
});

test("a coin picked up is one column of one row", () => {
  const plan = planWrite(stored(account()), account({ basic_currency: 1010 }));

  assert.deepEqual(ops(plan), {
    full: false,
    columns: ["basic_currency"],
    removes: {},
    inserts: {},
    updates: {},
  });
});

test("experience gained is the hero's row and nothing else", () => {
  const next = account();
  next.account_avatars[0].experience = 4012;

  assert.deepEqual(ops(planWrite(stored(account()), next)), {
    full: false,
    columns: [],
    removes: {},
    inserts: {},
    updates: { account_avatars: [11] },
  });
});

test("a weapon gained, one sold and one equipped are an insert, a delete and an update", () => {
  const next = account();
  next.account_items = [
    { ...next.account_items[1], avatar_id: 11, avatar_slot: 1, is_new: 0 },
    { id: 23, account_id: 500, item_id: 9003, power: 70, avatar_id: null, avatar_slot: null, is_new: 1 },
  ];

  const plan = ops(planWrite(stored(account()), next));
  assert.deepEqual(plan.removes, { account_items: [21] });
  assert.deepEqual(plan.inserts, { account_items: [23] });
  assert.deepEqual(plan.updates, { account_items: [22] });
});

/**
 * `account_attributes` is unique on (account, name), and two rows trading names
 * cannot be updated one at a time without the first colliding with the second.
 * Nothing references an attribute, so a changed one is taken out and put back.
 */
test("a changed attribute is removed and written again rather than updated", () => {
  const next = account({ account_attributes: [{ id: 31, account_id: 500, name: "tutorial", value: "skipped" }] });

  const plan = ops(planWrite(stored(account()), next));
  assert.deepEqual(plan.removes, { account_attributes: [31] });
  assert.deepEqual(plan.inserts, { account_attributes: [31] });
  assert.deepEqual(plan.updates, {});
});

/** A hero's row is updated in place: removing it would unequip everything it wears. */
test("a hero is never removed and re-inserted for having changed", () => {
  const next = account();
  next.account_avatars[0].experience = 9999;

  const plan = planWrite(stored(account()), next);
  assert.equal(plan.removes.has("account_avatars"), false);
});

test("a listing that sells moves from the open table to the sold one", () => {
  const listed = account({
    market_listings: [{ id: 41, account_id: 500, item_id: 9005, price: 300, listed_at: "2026-10-01T10:00:00.000Z" }],
  });
  const sold = account({
    market_listings: [{
      id: 41, account_id: 500, item_id: 9005, price: 300, listed_at: "2026-10-01T10:00:00.000Z",
      sold_to: 777, sold_at: "2026-10-02T09:00:00.000Z", tax: 30, proceeds: 270,
    }],
  });

  const plan = ops(planWrite(stored(listed), sold));
  assert.deepEqual(plan.removes, { market_listings: [41] });
  assert.deepEqual(plan.inserts, { [SOLD_LISTINGS]: [41] });
});

/**
 * A column a row does not carry is left to the table's default, and is known
 * afterwards only as "defaulted". The same row offered again has to compare
 * equal to that, or it is rewritten on every save for the rest of its life.
 */
test("a row without a column compares equal to itself once written", () => {
  const sparse = account({ account_items: [{ id: 21, account_id: 500, item_id: 9001 }] });
  const first = planWrite(null, sparse);

  const again = planWrite({ ...first.next, version: 8 }, sparse);
  assert.deepEqual(ops(again), { full: false, columns: [], removes: {}, inserts: {}, updates: {} });
});

test("the order of a row's keys is not a change", () => {
  const shuffled = account();
  shuffled.account_items = shuffled.account_items.map((row) =>
    Object.fromEntries(Object.entries(row).reverse())
  );

  assert.deepEqual(ops(planWrite(stored(account()), shuffled)).updates, {});
});

test("the plan keeps what it saw, whatever happens to the account afterwards", () => {
  const live = account();
  const plan = planWrite(stored(account()), live);
  live.basic_currency = 5;
  live.account_items.length = 0;

  const later = planWrite({ ...plan.next, version: 8 }, account());
  assert.deepEqual(ops(later).columns, [], "the picture is of the account as it was planned");
  assert.deepEqual(ops(later).inserts, {});
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-trade-"));
process.env.ODS_DATA_DIR = dataDir;

const { loadAccount, saveAccount, saveAccounts } = await import("../src/accounts.js");
const { settleTrade, TradeRefused } = await import("../src/trade.js");
const { holdAccount, releaseAccount, forgetHeldAccounts } = await import(
  "../src/account-registry.js"
);

after(async () => {
  delete process.env.ODS_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => forgetHeldAccounts());

let nextItemId = 1_500_000_000;

const weapon = (accountId, extra = {}) => ({
  id: nextItemId++,
  account_id: accountId,
  item_id: 11001,
  power: 5,
  avatar_id: null,
  avatar_slot: null,
  is_new: 0,
  requiredlevel: 1,
  rarity: 1,
  modifier1: 0,
  modifier2: 0,
  legendarymodifier: 0,
  created: new Date().toISOString(),
  ...extra,
});

/** A pair of accounts holding only what the test puts in them. */
const pair = async (first, second) => {
  const one = await loadAccount(first);
  const two = await loadAccount(second);
  for (const account of [one, two]) {
    account.account_items = [];
    account.basic_currency = 1000;
    account.buckets_weapon = 50;
  }
  await saveAccounts([one, two]);
  return [one, two];
};

const itemIds = (account) => account.account_items.map((item) => Number(item.id)).sort();

test("weapons and gold cross in both directions", async () => {
  const [one, two] = await pair(7001, 7002);
  const mine = weapon(7001);
  const theirs = weapon(7002);
  one.account_items.push(mine);
  two.account_items.push(theirs);
  await saveAccounts([one, two]);

  await settleTrade({
    parties: [
      { accountId: 7001, items: [mine.id], gold: 250 },
      { accountId: 7002, items: [theirs.id], gold: 0 },
    ],
  });

  const after1 = await loadAccount(7001);
  const after2 = await loadAccount(7002);

  assert.deepEqual(itemIds(after1), [Number(theirs.id)]);
  assert.deepEqual(itemIds(after2), [Number(mine.id)]);
  assert.equal(after1.basic_currency, 750);
  assert.equal(after2.basic_currency, 1250);
});

/**
 * The id is the identity of that instance, and the protocol uses the same
 * number as an object id. Minting a new one would be turning the weapon into a
 * different weapon.
 */
test("a weapon keeps its id and arrives unequipped and new", async () => {
  const [one] = await pair(7003, 7004);
  const mine = weapon(7003, { power: 42, rarity: 3, is_new: 0 });
  one.account_items.push(mine);
  await saveAccount(one);

  await settleTrade({
    parties: [
      { accountId: 7003, items: [mine.id], gold: 0 },
      { accountId: 7004, items: [], gold: 0 },
    ],
  });

  const [received] = (await loadAccount(7004)).account_items;
  assert.equal(Number(received.id), Number(mine.id));
  assert.equal(received.account_id, 7004);
  assert.equal(received.power, 42);
  assert.equal(received.rarity, 3);
  assert.equal(received.avatar_id, null);
  assert.equal(received.is_new, 1);
});

/**
 * The accounts handed to a trade may be the very objects a player is holding,
 * since the registry gives every holder the same one. A refusal that had
 * already taken a weapon off somebody would be a refusal that lost it.
 */
test("a refusal leaves both accounts exactly as they were", async () => {
  const [one, two] = await pair(7005, 7006);
  const mine = weapon(7005);
  const theirs = weapon(7006);
  one.account_items.push(mine);
  two.account_items.push(theirs);
  await saveAccounts([one, two]);

  await assert.rejects(
    () =>
      settleTrade({
        parties: [
          { accountId: 7005, items: [mine.id], gold: 0 },
          // The second half cannot be honoured: they do not hold this one.
          { accountId: 7006, items: [theirs.id, 999_999_999], gold: 0 },
        ],
      }),
    (problem) => problem instanceof TradeRefused && problem.reason === "not_owned"
  );

  assert.deepEqual(itemIds(await loadAccount(7005)), [Number(mine.id)]);
  assert.deepEqual(itemIds(await loadAccount(7006)), [Number(theirs.id)]);
  assert.equal((await loadAccount(7005)).basic_currency, 1000);
});

test("gold nobody has is refused", async () => {
  await pair(7007, 7008);
  await assert.rejects(
    () =>
      settleTrade({
        parties: [
          { accountId: 7007, items: [], gold: 5000 },
          { accountId: 7008, items: [], gold: 0 },
        ],
      }),
    (problem) => problem.reason === "not_enough_gold"
  );
  assert.equal((await loadAccount(7007)).basic_currency, 1000);
});

test("an equipped weapon is refused rather than quietly unequipped", async () => {
  const [one] = await pair(7009, 7010);
  const held = weapon(7009, { avatar_id: one.active_avatar, avatar_slot: 0 });
  one.account_items.push(held);
  await saveAccount(one);

  await assert.rejects(
    () =>
      settleTrade({
        parties: [
          { accountId: 7009, items: [held.id], gold: 0 },
          { accountId: 7010, items: [], gold: 0 },
        ],
      }),
    (problem) => problem.reason === "equipped"
  );
});

/**
 * Counted the way the client counts, and after the whole exchange: a trade
 * that fills a bag also empties one.
 */
test("a bag that would overflow is refused, and one that only looks full is not", async () => {
  const [one, two] = await pair(7011, 7012);
  one.buckets_weapon = 2;
  one.account_items = [weapon(7011), weapon(7011)];
  two.account_items = [weapon(7012), weapon(7012)];
  await saveAccounts([one, two]);

  // Taking two while giving none puts them at four of two.
  await assert.rejects(
    () =>
      settleTrade({
        parties: [
          { accountId: 7011, items: [], gold: 0 },
          { accountId: 7012, items: two.account_items.map((item) => item.id), gold: 0 },
        ],
      }),
    (problem) => problem.reason === "no_room"
  );

  // Taking two while giving two leaves them exactly where they were.
  await settleTrade({
    parties: [
      { accountId: 7011, items: one.account_items.map((item) => item.id), gold: 0 },
      { accountId: 7012, items: two.account_items.map((item) => item.id), gold: 0 },
    ],
  });
  assert.equal((await loadAccount(7011)).account_items.length, 2);
});

/**
 * Not a rule about this code — the registry means the trade would not be lost.
 * It is a rule about the game: those weapons are in a run that is still going.
 */
test("a player in a dungeon cannot trade", async () => {
  const [one] = await pair(7013, 7014);
  holdAccount(one);

  await assert.rejects(
    () =>
      settleTrade({
        parties: [
          { accountId: 7013, items: [], gold: 10 },
          { accountId: 7014, items: [], gold: 0 },
        ],
      }),
    (problem) => problem.reason === "in_dungeon"
  );

  releaseAccount(7013);
  await settleTrade({
    parties: [
      { accountId: 7013, items: [], gold: 10 },
      { accountId: 7014, items: [], gold: 0 },
    ],
  });
  assert.equal((await loadAccount(7014)).basic_currency, 1010);
});

test("an account cannot trade with itself", async () => {
  await pair(7015, 7016);
  await assert.rejects(
    () =>
      settleTrade({
        parties: [
          { accountId: 7015, items: [], gold: 1 },
          { accountId: 7015, items: [], gold: 0 },
        ],
      }),
    (problem) => problem.reason === "bad_offer"
  );
});

test("offering the same weapon twice is refused", async () => {
  const [one] = await pair(7017, 7018);
  const mine = weapon(7017);
  one.account_items.push(mine);
  await saveAccount(one);

  await assert.rejects(
    () =>
      settleTrade({
        parties: [
          { accountId: 7017, items: [mine.id, mine.id], gold: 0 },
          { accountId: 7018, items: [], gold: 0 },
        ],
      }),
    (problem) => problem.reason === "bad_offer"
  );
});

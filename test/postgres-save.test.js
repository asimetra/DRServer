import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * A save sends only what changed, and storage ends up equal to the account.
 *
 * Both halves, against a real database, because the second is the one that
 * matters and no fake can vouch for it: after any sequence of saves, an account
 * read back from storage has to be the account that was saved. A save that
 * writes less is only worth having if nothing can tell.
 *
 * PostgreSQL only, like the other tests that need one:
 *
 *   ODS_STORAGE=postgres ODS_DATABASE_URL=postgres://… npm test -- test/postgres-save.test.js
 */

const postgresOnly = { skip: process.env.ODS_STORAGE !== "postgres" && "PostgreSQL only" };

const FIRST = 1_999_500_000;
let storage;
let pg;
let admin;
let statements = null;

before(async () => {
  if (postgresOnly.skip) return;
  ({ default: pg } = await import("pg"));
  storage = await import("../src/storage/postgres.js");
  admin = new pg.Client({ connectionString: process.env.ODS_DATABASE_URL });
  await admin.connect();
  await admin.query("DELETE FROM accounts WHERE id >= $1 AND id < $2", [FIRST, FIRST + 1000]);

  // Every statement the storage layer sends, while a test is listening.
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function query(text, ...rest) {
    if (statements && this !== admin) statements.push(typeof text === "string" ? text : text.text);
    return original.call(this, text, ...rest);
  };
});

after(async () => {
  if (postgresOnly.skip) return;
  await admin.query("DELETE FROM accounts WHERE id >= $1 AND id < $2", [FIRST, FIRST + 1000]);
  await admin.end();
  await storage.close();
});

const sent = async (work) => {
  statements = [];
  try {
    await work();
    return statements.map((text) => text.trim().split(/\s+/).slice(0, 3).join(" "));
  } finally {
    statements = null;
  }
};

let nextRow = 0;
const rowId = () => 1_900_000_000 + ++nextRow + Math.floor(Math.random() * 1e6) * 1000;

const weapon = (accountId, more = {}) => ({
  id: rowId(), account_id: accountId, item_id: 9001, power: 40, avatar_id: null, avatar_slot: null,
  is_new: 1, requiredlevel: 1, rarity: 1, modifier1: 0, modifier2: 0, legendarymodifier: 0,
  created: "2026-09-01T10:00:00.000Z",
  ...more,
});

const newAccount = (index, weapons = 3) => {
  const id = FIRST + index;
  const hero = {
    id: rowId(), account_id: id, avatar_id: 101, skin_type: 151, experience: 4000,
    completed_mapnode_mask: "", statupgrade1: 0, statupgrade2: 0, statupgrade3: 0, statupgrade4: 0,
    consumable1_id: 0, consumable1_count: 0, consumable2_id: 0, consumable2_count: 0,
    created: "2026-09-01T10:00:00.000Z",
  };
  return {
    id,
    name: `Diff${index}_${Math.floor(Math.random() * 1e9)}`,
    basic_currency: 1000,
    premium_currency: 5,
    friend_requests: [],
    gifts: [],
    gift_sends: [],
    infinite_progress: {},
    account_avatars: [hero],
    account_items: [
      weapon(id, { avatar_id: hero.id, avatar_slot: 0, is_new: 0 }),
      ...Array.from({ length: weapons - 1 }, () => weapon(id)),
    ],
    account_stackables: [{ id: rowId(), account_id: id, stack_id: 60001, count: 3, is_new: 0 }],
    account_chests: [],
    account_pets: [],
    account_skins: [],
    account_attributes: [
      { id: rowId(), account_id: id, name: "tutorial", value: "done" },
      { id: rowId(), account_id: id, name: "music", value: "off" },
    ],
    market_listings: [],
  };
};

/** The account as storage holds it now, read with nothing remembered. */
const stored = async (id) => {
  storage.forgetAccountSnapshots();
  return storage.loadAccount(id);
};

const LISTS = [
  "account_avatars", "account_items", "account_stackables", "account_chests",
  "account_pets", "account_skins", "account_attributes", "market_listings",
];

/** Every field the account carries is what storage holds, and no row is extra. */
const assertStored = async (account, message = "") => {
  const fromStorage = await stored(account.id);
  for (const column of ["name", "basic_currency", "premium_currency"]) {
    assert.equal(Number.isNaN(Number(account[column])) ? fromStorage[column] : Number(fromStorage[column]),
      Number.isNaN(Number(account[column])) ? account[column] : Number(account[column]),
      `${message} accounts.${column}`);
  }
  assert.deepEqual(fromStorage.infinite_progress, account.infinite_progress ?? {}, `${message} infinite_progress`);
  for (const list of LISTS) {
    const key = (row) => `${row.id}|${row.sold_at ?? ""}`;
    const want = [...(account[list] ?? [])].sort((a, b) => key(a).localeCompare(key(b)));
    const have = [...(fromStorage[list] ?? [])].sort((a, b) => key(a).localeCompare(key(b)));
    assert.equal(have.length, want.length, `${message} ${list} holds ${want.length} rows`);
    for (const [index, row] of want.entries()) {
      for (const [column, value] of Object.entries(row)) {
        if (value === undefined) continue;
        const held = have[index][column];
        assert.deepEqual(
          typeof value === "number" ? Number(held) : held,
          value,
          `${message} ${list} row ${row.id} column ${column}`
        );
      }
    }
  }
  return fromStorage;
};

test("an account read back is the account that was saved", postgresOnly, async () => {
  const account = newAccount(1, 12);
  await storage.saveAccount(account);

  const fromStorage = await assertStored(account);
  assert.equal("version" in fromStorage, false, "and the version is storage's own, not the account's");
});

test("a coin is one statement between a BEGIN and a COMMIT, however much the account holds", postgresOnly, async () => {
  const account = newAccount(2, 150);
  await storage.saveAccount(account);

  account.basic_currency += 10;
  const shape = await sent(() => storage.saveAccount(account));

  assert.deepEqual(shape, ["BEGIN", "UPDATE accounts SET", "COMMIT"]);
  await assertStored(account);
});

test("experience is the hero's row, and what the hero wears stays on", postgresOnly, async () => {
  const account = newAccount(3, 40);
  await storage.saveAccount(account);

  account.account_avatars[0].experience += 12;
  const shape = await sent(() => storage.saveAccount(account));

  assert.deepEqual(shape, ["BEGIN", "UPDATE accounts SET", "UPDATE account_avatars SET", "COMMIT"]);
  const fromStorage = await assertStored(account);
  assert.equal(
    Number(fromStorage.account_items.find((item) => item.avatar_slot === 0).avatar_id),
    account.account_avatars[0].id,
    "the equipped weapon is still equipped"
  );
});

test("a save of an account that has not changed touches no list", postgresOnly, async () => {
  const account = newAccount(4, 20);
  await storage.saveAccount(account);

  assert.deepEqual(await sent(() => storage.saveAccount(account)), ["BEGIN", "UPDATE accounts SET", "COMMIT"]);
});

test("a first save of many weapons is a statement a table, not a statement a weapon", postgresOnly, async () => {
  const account = newAccount(5, 200);

  const shape = await sent(() => storage.saveAccount(account));

  assert.equal(shape.filter((text) => text.startsWith("INSERT INTO account_items")).length, 1);
  assert.ok(shape.length < 25, `${shape.length} statements for two hundred weapons`);
  await assertStored(account);
});

test("an account loaded and saved back writes nothing but its version", postgresOnly, async () => {
  const account = newAccount(6, 30);
  await storage.saveAccount(account);

  const loaded = await stored(account.id);
  assert.deepEqual(await sent(() => storage.saveAccount(loaded)), ["BEGIN", "UPDATE accounts SET", "COMMIT"]);
});

test("gaining, losing, equipping and selling all land", postgresOnly, async () => {
  const account = newAccount(7, 6);
  await storage.saveAccount(account);
  const hero = account.account_avatars[0];

  const [, second, third] = account.account_items;
  account.account_items = account.account_items.filter((item) => item !== third);
  second.avatar_id = hero.id;
  second.avatar_slot = 1;
  account.account_items.push(weapon(account.id, { power: 77 }));
  account.account_stackables[0].count = 9;
  account.account_chests.push({ id: rowId(), account_id: account.id, chest_id: 60004 });
  account.market_listings.push({
    id: third.id, account_id: account.id, item_id: third.item_id, price: 300,
    listed_at: "2026-10-01T10:00:00.000Z", power: third.power, requiredlevel: 1, rarity: 1,
    modifier1: 0, modifier2: 0, legendarymodifier: 0, created: third.created,
  });
  await storage.saveAccount(account);
  await assertStored(account, "after the trade-in:");

  // And then it sells, which moves the listing to the sold table.
  Object.assign(account.market_listings[0], {
    sold_to: 777, sold_at: "2026-10-02T09:00:00.000Z", tax: 30, proceeds: 270,
  });
  await storage.saveAccount(account);
  const fromStorage = await assertStored(account, "after the sale:");
  assert.equal(Number(fromStorage.market_listings[0].sold_to), 777);
});

test("two attributes trading names do not collide on the way", postgresOnly, async () => {
  const account = newAccount(8);
  await storage.saveAccount(account);

  const [first, second] = account.account_attributes;
  [first.name, second.name] = [second.name, first.name];
  await storage.saveAccount(account);

  await assertStored(account);
});

test("a weapon handed from one account to another moves in one write", postgresOnly, async () => {
  const giver = newAccount(9, 4);
  const taker = newAccount(10, 2);
  await storage.saveAccounts([giver, taker]);

  const gift = giver.account_items.pop();
  taker.account_items.push({ ...gift, account_id: taker.id });
  await storage.saveAccounts([taker, giver]);

  await assertStored(giver, "giver:");
  await assertStored(taker, "taker:");
});

/**
 * The picture is only trusted while storage is at the version it was taken at.
 * Another thread's save — or a tool's — moves the version on, and a save
 * planned against the old picture has to notice and write everything, or it
 * would leave a mixture of the two.
 */
test("a save made against an out-of-date picture writes the whole account", postgresOnly, async () => {
  const account = newAccount(11, 5);
  await storage.saveAccount(account);

  // Somebody else writes: a weapon is gone, the gold is different, the version moves.
  await admin.query("DELETE FROM account_items WHERE id = $1", [account.account_items[2].id]);
  await admin.query("UPDATE accounts SET basic_currency = 1, version = version + 1 WHERE id = $1", [account.id]);

  account.premium_currency += 1;
  const shape = await sent(() => storage.saveAccount(account));

  assert.ok(shape.some((text) => text.startsWith("INSERT INTO accounts")), "the row is written whole");
  assert.ok(shape.some((text) => text.startsWith("DELETE FROM account_items")), "and its lists are replaced");
  await assertStored(account, "storage is the account again:");
});

test("a save that fails forgets what it knew, and the next one puts things right", postgresOnly, async () => {
  const account = newAccount(12, 5);
  await storage.saveAccount(account);

  // A weapon whose id is already somebody else's cannot be inserted.
  const other = newAccount(13, 2);
  await storage.saveAccount(other);
  const clash = { ...weapon(account.id), id: other.account_items[0].id };
  account.account_items.push(clash);
  account.basic_currency = 4242;
  await assert.rejects(() => storage.saveAccount(account));
  assert.equal(Number((await stored(account.id)).basic_currency), 1000, "nothing of the failed save landed");

  account.account_items = account.account_items.filter((item) => item !== clash);
  await storage.saveAccount(account);
  await assertStored(account);
});

test("a row that leaves a column to its default is not rewritten for it", postgresOnly, async () => {
  const account = newAccount(14, 2);
  account.account_chests = [{ id: rowId(), account_id: account.id, chest_id: 60004 }]; // no is_new
  await storage.saveAccount(account);

  account.basic_currency += 1;
  assert.deepEqual(await sent(() => storage.saveAccount(account)), ["BEGIN", "UPDATE accounts SET", "COMMIT"]);
  assert.equal(Number((await stored(account.id)).account_chests[0].is_new), 0, "the default applied");
});

/**
 * The property the whole thing rests on, tried many ways: whatever is done to
 * an account between saves, storage afterwards equals it.
 */
test("after any sequence of changes and saves, storage equals the account", postgresOnly, async () => {
  let seed = 20261002;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];

  const accounts = [newAccount(20, 8), newAccount(21, 8)];
  await storage.saveAccounts(accounts);

  const changes = [
    (account) => { account.basic_currency += Math.floor(random() * 50); },
    (account) => { pick(account.account_avatars).experience += Math.floor(random() * 30); },
    (account) => { account.account_items.push(weapon(account.id, { power: Math.floor(random() * 99) })); },
    (account) => { if (account.account_items.length > 2) account.account_items.splice(1 + Math.floor(random() * (account.account_items.length - 1)), 1); },
    (account) => { const item = pick(account.account_items); item.power += 1; item.is_new = 0; },
    (account) => { pick(account.account_stackables).count = Math.floor(random() * 20); },
    (account) => { account.account_chests.push({ id: rowId(), account_id: account.id, chest_id: 60004, is_new: 1 }); },
    (account) => { account.account_chests.pop(); },
    (account) => { pick(account.account_attributes).value = String(Math.floor(random() * 1000)); },
    (account) => { account.infinite_progress = { 50150: { [pick(account.account_avatars).id]: { score: Math.floor(random() * 40), claimed: [] } } }; },
    (account) => { account.friend_requests = random() < 0.5 ? [] : [{ account_id: 5, name: "x" }]; },
    (account, other) => {
      if (account.account_items.length < 3) return;
      const [moved] = account.account_items.splice(account.account_items.length - 1, 1);
      other.account_items.push({ ...moved, account_id: other.id, avatar_id: null, avatar_slot: null });
    },
  ];

  for (let step = 0; step < 120; step++) {
    const [account, other] = random() < 0.5 ? accounts : [...accounts].reverse();
    for (let count = 1 + Math.floor(random() * 3); count > 0; count--) pick(changes)(account, other);

    // Sometimes one account, sometimes both; sometimes with nothing remembered.
    if (random() < 0.15) storage.forgetAccountSnapshots([account.id]);
    if (random() < 0.5) await storage.saveAccounts(accounts);
    else {
      await storage.saveAccount(account);
      await storage.saveAccount(other);
    }
    if (step % 10 === 9) {
      await assertStored(accounts[0], `step ${step}, first:`);
      await assertStored(accounts[1], `step ${step}, second:`);
      // A fresh read replaced the pictures; keep saving against those too.
    }
  }
  await assertStored(accounts[0], "at the end, first:");
  await assertStored(accounts[1], "at the end, second:");
});

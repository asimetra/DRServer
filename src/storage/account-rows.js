/**
 * An account as rows, and what a save of it has to write.
 *
 * The rest of the server hands storage a whole account — the object the client
 * is sent — and a save used to answer by emptying every list the account has
 * and writing each row back, one statement a row. An account with a hundred
 * weapons cost about a hundred and twenty-five round trips, and a dungeon did
 * that for every coin and star its player walked over: measured on a player's
 * own recordings, a third of a save a second each, several a second in a
 * fight. The account after a coin differed from the one in storage by one
 * number.
 *
 * So a save is planned here against a picture of what storage holds, taken
 * when the account was read or last written, and only the difference is sent.
 * The meaning of a save does not change — "make storage equal this object" —
 * and no caller has to say what it changed, which is the part that would go
 * wrong: a change somebody forgot to declare would simply never be written.
 * The plan leaves out the rows that already are what they should be, and
 * nothing else.
 *
 * Nothing in this file talks to a database. `postgres.js` takes the pictures,
 * checks before it trusts one that storage has not moved on since — every
 * account row carries a version — and runs the plans.
 */

/**
 * Tables whose rows hang off an account, keyed by the payload field name.
 *
 * Exported so a test can hold it against db/schema.sql. A list that is in the
 * payload and missing from here is not an error anything reports — it simply
 * never reaches storage and comes back empty, which is how every chest a player
 * owned was lost on this backend.
 */
export const CHILD_TABLES = {
  account_avatars: [
    "id", "account_id", "avatar_id", "skin_type", "experience",
    "completed_mapnode_mask", "statupgrade1", "statupgrade2", "statupgrade3",
    "statupgrade4", "consumable1_id", "consumable1_count", "consumable2_id",
    "consumable2_count", "created",
  ],
  account_items: [
    "id", "account_id", "item_id", "power", "avatar_id", "avatar_slot",
    "is_new", "requiredlevel", "rarity", "modifier1", "modifier2",
    "legendarymodifier", "created",
  ],
  account_stackables: ["id", "account_id", "stack_id", "count", "is_new"],
  account_chests: ["id", "account_id", "chest_id", "is_new"],
  account_pets: ["id", "account_id", "npc_id", "equipped_hero", "is_new"],
  account_skins: ["id", "account_id", "skin_type"],
  account_attributes: ["id", "account_id", "name", "value"],
  /*
   * Weapons that are up for sale, held here rather than in `account_items`.
   *
   * A child of the account on purpose: that is what makes listing a weapon one
   * write instead of an account write and a market write with a crash-shaped
   * gap in between. The row's id is the weapon's own, so the buyer receives the
   * instance that was put up rather than a copy of it.
   */
  market_listings: [
    "id", "account_id", "item_id", "price", "listed_at", "sold_to", "sold_at", "tax", "proceeds",
    "power", "requiredlevel", "rarity", "modifier1", "modifier2",
    "legendarymodifier", "created",
  ],
};

/**
 * Sold listings are stored apart from the open ones, keyed by account and id
 * (see db/schema.sql): the buyer can list the weapon again under the same id
 * before the seller claims. In the account they stay one list.
 */
export const SOLD_LISTINGS = "market_sold_listings";
export const isSold = (listing) => listing?.sold_to !== undefined && listing?.sold_to !== null;
export const saleKey = (row) => `${row.id}|${row.sold_at}`;

export const ACCOUNT_COLUMNS = [
  "id", "name", "campaign", "ancestor_campaign", "demographic", "trophies",
  "completed_mapnode_mask", "basic_currency", "premium_currency", "basic_keys",
  "uncommon_keys", "rare_keys", "legendary_keys", "highest_avatar",
  "buckets_weapon", "buckets_other", "active_avatar", "admin_flags",
  "ingame_friends", "ignore_friends", "friend_requests", "infinite_progress", "gifts", "gift_sends",
  "account_flags", "market_barred", "completed_dungeons", "matchmaker_group", "concurrent_days",
  "last_reward_date", "last_login", "created", "restriction", "sanctions", "web_client",
];

/**
 * A map mask as text can hold it, and back.
 *
 * `completed_mapnode_mask` is one character a byte (see map-progress.js), and
 * a byte in which no node is cleared is a zero — a character PostgreSQL does
 * not store in text. A hero whose first cleared node sits past the first eight
 * has one at the front of its mask, and its save failed outright, and went on
 * failing every time it was retried.
 *
 * A zero is written as U+0100. No mask holds that — every byte is under 256 —
 * so it can only ever mean zero, masks already in storage read exactly as they
 * did, and the mask's own arithmetic takes the low eight bits of a character,
 * so even one read back undecoded counts as the zero it stands for.
 */
const MASK_COLUMN = "completed_mapnode_mask";
const EMPTY_BYTE = "\u0100";
export const storedMask = (mask) =>
  typeof mask === "string" ? mask.replaceAll("\u0000", EMPTY_BYTE) : mask;
export const loadedMask = (mask) =>
  typeof mask === "string" ? mask.replaceAll(EMPTY_BYTE, "\u0000") : mask;

/** Every table a save may touch, in the order rows have to be written. */
export const ROW_TABLES = [...Object.keys(CHILD_TABLES), SOLD_LISTINGS];

/** The columns of a table by its storage name; the sold table has the listings'. */
export const columnsOf = (table) =>
  table === SOLD_LISTINGS ? CHILD_TABLES.market_listings : CHILD_TABLES[table];

/**
 * Tables whose changed rows are taken out and written again instead of updated.
 *
 * `account_attributes` is unique on (account, name): two rows trading names
 * cannot be updated one after the other without the first colliding with the
 * second. The sold table has no key of its own to update by. Nothing references
 * either, so removing a row costs nothing — which is exactly what is not true
 * of a hero, whose removal unequips everything it wears, and why the rest are
 * updated in place.
 */
const REWRITTEN_ON_CHANGE = new Set(["account_attributes", SOLD_LISTINGS]);

/**
 * The JSONB fields go as JSON text. Handed a JavaScript array, the driver
 * writes a PostgreSQL array literal — `{...}` — which JSONB refuses, so the
 * first pending friend request made the whole save fail, and an empty list
 * was stored as the object `{}`.
 */
const asJsonList = (value) => JSON.stringify(Array.isArray(value) ? value : []);

/** The account's own row, as the values that are written for it. */
export const accountRowOf = (account) => ({
  ...Object.fromEntries(ACCOUNT_COLUMNS.map((column) => [column, account[column]])),
  [MASK_COLUMN]: storedMask(account[MASK_COLUMN]),
  ingame_friends: account.ingame_friends ?? "[]",
  ignore_friends: account.ignore_friends ?? "[]",
  friend_requests: asJsonList(account.friend_requests),
  gifts: asJsonList(account.gifts),
  gift_sends: asJsonList(account.gift_sends),
  infinite_progress: JSON.stringify(
    account.infinite_progress && typeof account.infinite_progress === "object"
      ? account.infinite_progress
      : {}
  ),
  // Nullable, so absent stays absent: the column's default, which is none.
  restriction:
    account.restriction && typeof account.restriction === "object"
      ? JSON.stringify(account.restriction)
      : account.restriction === undefined ? undefined : null,
  sanctions:
    account.sanctions && typeof account.sanctions === "object"
      ? JSON.stringify(account.sanctions)
      : account.sanctions === undefined ? undefined : null,
  web_client:
    account.web_client && typeof account.web_client === "object"
      ? JSON.stringify(account.web_client)
      : account.web_client === undefined ? undefined : null,
});

/**
 * A value as something two of them can be compared by.
 *
 * A column a row does not carry is left to the table's default, and what the
 * default came to is not known here — so "left to the default" is its own
 * value, equal only to itself. A row written that way compares equal to the
 * same row offered again, which is all that is asked of it.
 */
const DEFAULTED = "\u0000default";
const comparable = (value) => {
  if (value === undefined) return DEFAULTED;
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
};

const rowText = (columns, row) => columns.map((column) => comparable(row[column])).join("\u0001");

/** Which column of a table names one of the account's heroes, and what goes with it. */
const HERO_REFERENCES = {
  account_items: ["avatar_id", "avatar_slot"],
  account_pets: ["equipped_hero"],
};

/**
 * The account's lists as rows by table and key, copied so later changes do not
 * reach them.
 *
 * A weapon or a pet that names a hero the account does not hold is written as
 * unequipped, and counted. The hero is a foreign key, so the database will not
 * keep such a row as it stands: written whole the account failed to save at
 * all, and written as a difference, removing a hero let the database clear the
 * reference itself while the picture went on holding the old one. Writing the
 * row the way the database would leave it keeps the two the same.
 */
const childRowsOf = (account) => {
  const tables = new Map();
  const heroes = new Set((account.account_avatars ?? []).map((avatar) => String(avatar.id)));
  let unheld = 0;
  for (const field of Object.keys(CHILD_TABLES)) {
    for (const row of account[field] ?? []) {
      const table = field === "market_listings" && isSold(row) ? SOLD_LISTINGS : field;
      const key = table === SOLD_LISTINGS ? saleKey(row) : String(row.id);
      if (!tables.has(table)) tables.set(table, new Map());
      const copy = { ...row, account_id: account.id };
      if (MASK_COLUMN in copy) copy[MASK_COLUMN] = storedMask(copy[MASK_COLUMN]);
      const [hero, ...withIt] = HERO_REFERENCES[table] ?? [];
      if (hero && copy[hero] !== null && copy[hero] !== undefined && !heroes.has(String(copy[hero]))) {
        for (const column of [hero, ...withIt]) copy[column] = null;
        unheld += 1;
      }
      tables.get(table).set(key, copy);
    }
  }
  return { tables, unheld };
};

/** What identifies a row that is in storage and no longer in the account. */
const removalOf = (table, key) => {
  if (table !== SOLD_LISTINGS) return { id: Number(key) };
  const at = key.indexOf("|");
  const soldAt = key.slice(at + 1);
  return { id: Number(key.slice(0, at)), sold_at: soldAt === "undefined" || soldAt === "null" ? null : soldAt };
};

const push = (map, table, value) => {
  if (!map.has(table)) map.set(table, []);
  map.get(table).push(value);
};

/**
 * What has to be written for storage to equal this account.
 *
 * `snapshot` is what storage is believed to hold, or null when nothing is
 * known — then everything is written, as it always was. The account is read
 * once, here, and the plan carries its own copies: a session's account goes on
 * changing while its save is on the way, and a save assembled over several
 * round trips from a moving object would write a state the account was never
 * in.
 *
 * `next` is the picture storage will match once the plan has run.
 */
export const planWrite = (snapshot, account) => {
  const accountRow = accountRowOf(account);
  const accountText = ACCOUNT_COLUMNS.map((column) => comparable(accountRow[column]));
  const { tables: rows, unheld } = childRowsOf(account);

  const next = { account: accountText, tables: new Map() };
  for (const [table, byKey] of rows) {
    const columns = columnsOf(table);
    next.tables.set(table, new Map([...byKey].map(([key, row]) => [key, rowText(columns, row)])));
  }

  const plan = {
    full: !snapshot,
    version: snapshot?.version ?? null,
    id: account.id,
    unheld,
    accountRow,
    accountColumns: null,
    removes: new Map(),
    inserts: new Map(),
    updates: new Map(),
    next,
  };

  if (!snapshot) {
    for (const table of ROW_TABLES) {
      for (const row of rows.get(table)?.values() ?? []) push(plan.inserts, table, row);
    }
    return plan;
  }

  plan.accountColumns = ACCOUNT_COLUMNS.filter(
    (column, index) => snapshot.account[index] !== accountText[index]
  );

  for (const table of ROW_TABLES) {
    const before = snapshot.tables.get(table) ?? new Map();
    const after = next.tables.get(table) ?? new Map();
    for (const key of before.keys()) {
      if (!after.has(key)) push(plan.removes, table, removalOf(table, key));
    }
    for (const [key, text] of after) {
      const row = rows.get(table).get(key);
      if (!before.has(key)) push(plan.inserts, table, row);
      else if (before.get(key) !== text) {
        if (REWRITTEN_ON_CHANGE.has(table)) {
          push(plan.removes, table, removalOf(table, key));
          push(plan.inserts, table, row);
        } else push(plan.updates, table, row);
      }
    }
  }
  return plan;
};

/** The picture of an account as storage holds it, at a version. */
export const snapshotOf = (account, version) => ({ ...planWrite(null, account).next, version });

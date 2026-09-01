import pg from "pg";
import { config } from "../config.js";
import { info } from "../log.js";
import { ACCOUNT_OBJECT_ID_FLOOR } from "../account-object-ids.js";

/**
 * Postgres-backed account storage.
 *
 * The rest of the server passes accounts around as the exact object the client
 * receives, so this module's whole job is to take that object apart into rows
 * on the way in and put it back together on the way out. Nothing above it needs
 * to know which backend is in use.
 *
 * Reads are one round trip per table rather than a join: the payload is a set
 * of independent lists, and stitching a join back into them costs more than the
 * extra queries save at this size.
 */

/**
 * node-postgres hands back BIGINT as a string, since int8 can hold more than a
 * JavaScript number can represent exactly. Nothing here comes close to that:
 * account ids sit around 10^9 and currencies far below, all well inside the
 * 2^53 a Number represents exactly. The client, meanwhile, expects numbers —
 * given strings it fails to resolve the active avatar and dies on the loading
 * screen. So int8 is parsed as a number.
 */
pg.types.setTypeParser(20, Number);

let pool = null;

const connect = () => {
  pool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
  return pool;
};

export const close = async () => {
  await pool?.end();
  pool = null;
};

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

const ACCOUNT_COLUMNS = [
  "id", "name", "campaign", "ancestor_campaign", "demographic", "trophies",
  "completed_mapnode_mask", "basic_currency", "premium_currency", "basic_keys",
  "uncommon_keys", "rare_keys", "legendary_keys", "highest_avatar",
  "buckets_weapon", "buckets_other", "active_avatar", "admin_flags",
  "account_flags", "market_barred", "completed_dungeons", "matchmaker_group", "concurrent_days",
  "last_reward_date", "last_login", "created",
];

/**
 * Timestamps come back as Date objects but the client expects the ISO strings
 * it was originally sent, so they are normalised on the way out.
 */
const fromRow = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ])
  );

const insert = async (client, table, columns, row) => {
  const values = columns.map((column) => row[column] ?? null);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    values
  );
};

/** The same, for a row that has to keep its identity across a rewrite. */
const upsert = async (client, table, columns, row) => {
  const values = columns.map((column) => row[column] ?? null);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const assignments = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ");
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${assignments}`,
    values
  );
};

export const loadAccount = async (id) => {
  const db = connect();
  const { rows } = await db.query("SELECT * FROM accounts WHERE id = $1", [id]);
  if (!rows.length) return null;

  const account = fromRow(rows[0]);

  for (const [field, columns] of Object.entries(CHILD_TABLES)) {
    const child = await db.query(
      `SELECT ${columns.join(", ")} FROM ${field} WHERE account_id = $1 ORDER BY id`,
      [id]
    );
    account[field] = child.rows.map(fromRow);
  }

  // Still unmodelled: nothing in this server writes a booster row, so there is
  // no shape to store (see db/schema.sql). Chests used to be lumped in with
  // this and were silently dropped on every load — they have their own table.
  account.account_boosters = [];

  return account;
};

/**
 * One account and its lists, on a caller's transaction. Children are replaced
 * wholesale: the caller hands over a complete account, and diffing rows to save
 * a few writes would be a lot of machinery for an object this size.
 */
export const writeAccount = async (client, account) => {
  /**
   * Updated in place, never removed and remade.
   *
   * This began as the file backend's shape — rewrite the whole document — and
   * inside this server the two read alike, because the children cascade away
   * and are written again in the same breath.
   *
   * Outside it they do not. The website's `web.users.account_id` references
   * this row with ON DELETE SET NULL, so every save detached a player's login
   * from their character. One finished dungeon was enough, and what the site
   * then said was "confirm your email address first" to somebody who had
   * confirmed it days before.
   */
  await upsert(client, "accounts", ACCOUNT_COLUMNS, account);

  /**
   * The children are cleared, which the account row cannot be: they are lists
   * and a save has to be able to shorten one — a weapon that was sold would
   * otherwise come back on the next write. Nothing outside this server points
   * at them, so removing them costs nothing.
   */
  for (const field of Object.keys(CHILD_TABLES)) {
    await client.query(`DELETE FROM ${field} WHERE account_id = $1`, [account.id]);
  }

  // Avatars first: items and pets reference them.
  for (const [field, columns] of Object.entries(CHILD_TABLES)) {
    for (const row of account[field] ?? []) {
      await insert(client, field, columns, { ...row, account_id: account.id });
    }
  }
};

/**
 * Several accounts as one transaction, so a move between two of them cannot
 * half-happen.
 *
 * Saving each account on its own transaction is only safe while the accounts
 * are independent, and the interesting writes are the ones that are not: a
 * gift takes a stackable off one account and puts it on another, and two
 * commits mean a crash in between leaves the item on neither or on both. The
 * lock pair callers already take (`withTwoAccountLocks`) stops two writers
 * interleaving; it does nothing about a writer that stops halfway.
 */
export const saveAccounts = async (accounts) => {
  const db = connect();
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    for (const account of accounts) await writeAccount(client, account);
    await client.query("COMMIT");
    return accounts;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const saveAccount = async (account) => {
  await saveAccounts([account]);
  return account;
};

/**
 * Every account id this server holds.
 *
 * The file backend answers this by listing its directory and this backend had
 * no answer at all, so `listAccountIds` returned an empty population here: the
 * friends and leaderboard endpoints saw nobody, and allocating an id for a new
 * account would have handed out one already taken.
 */
export const listAccountIds = async () => {
  const { rows } = await connect().query("SELECT id FROM accounts ORDER BY id");
  return rows.map((row) => Number(row.id));
};

/**
 * Who holds a name, if anybody.
 *
 * Takes the already-folded key and folds the column the same way, which is the
 * expression `accounts_name_unique` is built on — so this is an index lookup
 * rather than a scan, and it agrees with the constraint that would refuse the
 * insert. If the two ever disagree, the constraint wins and the caller sees a
 * violation instead of a sentence.
 */
export const accountIdWithName = async (key) => {
  const { rows } = await connect().query(
    "SELECT id FROM accounts WHERE lower(translate(name, 'ıİI', 'iii')) = $1 LIMIT 1",
    [key]
  );
  return rows.length ? Number(rows[0].id) : null;
};

let accountObjectSequenceReady = null;

const ensureAccountObjectSequence = () => {
  accountObjectSequenceReady ??= connect().query(
    `SELECT setval(
       'account_object_id',
       GREATEST((SELECT last_value FROM account_object_id), $1),
       true
     )`,
    [ACCOUNT_OBJECT_ID_FLOOR]
  );
  return accountObjectSequenceReady;
};

/** Server-assigned ids, from the shared sequence in the schema. */
export const nextId = async () => {
  await ensureAccountObjectSequence();
  const { rows } = await connect().query("SELECT nextval('account_object_id') AS id");
  return Number(rows[0].id);
};

export const ping = async () => {
  await connect().query("SELECT 1");
  info(`storage: connected to ${config.databaseUrl.replace(/:[^:@]*@/, ":***@")}`);
};

/**
 * Finished runs, and the boards folded out of them.
 *
 * One transaction: the history row and the standing it changes belong together,
 * and a board that disagrees with the run behind it is worse than a missing
 * one. Neither table references `accounts`, so this never contends with the
 * account write path.
 */
const BOARD_FOLD = {
  speedrun: "LEAST(dungeon_bests.value, EXCLUDED.value)",
  experience: "dungeon_bests.value + EXCLUDED.value",
  clears: "dungeon_bests.value + EXCLUDED.value",
};

export const recordRuns = async (runs, boards) => {
  const client = await connect().connect();
  try {
    await client.query("BEGIN");
    for (const run of runs) {
      await client.query(
        `INSERT INTO dungeon_runs
           (account_id, name, trophies, avatar_id, hero_id, map_node_id, party_size,
            started_at, finished_at, duration_ms, success, floors, kills, damage, gold, xp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          run.account_id, run.name, run.trophies ?? 0, run.avatar_id, run.hero_id,
          run.map_node_id, run.party_size, run.started_at, run.finished_at,
          run.duration_ms, run.success, run.floors, run.kills, run.damage, run.gold, run.xp,
        ]
      );

      for (const { key, metric, value } of boards(run)) {
        await client.query(
          `INSERT INTO dungeon_bests (board_key, account_id, name, trophies, hero_id, value, achieved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (board_key, account_id) DO UPDATE
             SET value = ${BOARD_FOLD[metric]},
                 name = EXCLUDED.name,
                 trophies = EXCLUDED.trophies,
                 hero_id = EXCLUDED.hero_id,
                 achieved_at = CASE
                   WHEN ${BOARD_FOLD[metric]} <> dungeon_bests.value
                   THEN EXCLUDED.achieved_at ELSE dungeon_bests.achieved_at END`,
          [key, run.account_id, run.name, run.trophies ?? 0, run.hero_id ?? null, value, run.finished_at]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

/** One board, already ordered by the caller's direction. */
export const boardRows = async (key, { ascending = true, limit = 20 } = {}) => {
  const { rows } = await connect().query(
    `SELECT account_id, name, trophies, hero_id, value, achieved_at
       FROM dungeon_bests WHERE board_key = $1
      ORDER BY value ${ascending ? "ASC" : "DESC"} LIMIT $2`,
    [key, limit]
  );
  return rows.map((row) => ({
    account_id: Number(row.account_id),
    name: row.name,
    trophies: Number(row.trophies ?? 0),
    hero_id: row.hero_id === null ? null : Number(row.hero_id),
    value: Number(row.value),
    at: row.achieved_at instanceof Date ? row.achieved_at.toISOString() : row.achieved_at,
  }));
};

/**
 * One completed sale. Append-only: nothing updates or deletes these, which is
 * what makes the history worth trusting when it is read as evidence.
 */
export const recordSale = async (sale) => {
  await connect().query(
    `INSERT INTO market_sales
       (listing_id, at, seller_id, seller_name, buyer_id, buyer_name,
        item_id, rarity, power, requiredlevel, price, tax, proceeds, listed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      sale.listing_id, sale.at, sale.seller_id, sale.seller_name, sale.buyer_id,
      sale.buyer_name, sale.item_id, sale.rarity, sale.power, sale.requiredlevel,
      sale.price, sale.tax, sale.proceeds, sale.listed_at,
    ]
  );
};

/** Both sides of one account's market history, newest first. */
export const salesFor = async (accountId, limit) => {
  const { rows } = await connect().query(
    `SELECT listing_id, at, seller_id, seller_name, buyer_id, buyer_name,
            item_id, rarity, power, requiredlevel, price, tax, proceeds, listed_at
       FROM market_sales
      WHERE seller_id = $1 OR buyer_id = $1
      ORDER BY at DESC LIMIT $2`,
    [accountId, limit]
  );
  return rows.map((row) => ({
    ...row,
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    listed_at: row.listed_at instanceof Date ? row.listed_at.toISOString() : row.listed_at,
  }));
};

/** How many runs finished since a moment, for the front page's counter. */
export const runsSince = async (since) => {
  const { rows } = await connect().query(
    "SELECT count(*)::int AS runs FROM dungeon_runs WHERE finished_at >= $1",
    [since]
  );
  return rows[0]?.runs ?? 0;
};

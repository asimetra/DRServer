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
  account_chests: ["id", "account_id", "chest_id"],
  account_pets: ["id", "account_id", "npc_id", "equipped_hero", "is_new"],
  account_skins: ["id", "account_id", "skin_type"],
  account_attributes: ["id", "account_id", "name", "value"],
};

const ACCOUNT_COLUMNS = [
  "id", "name", "campaign", "ancestor_campaign", "demographic", "trophies",
  "completed_mapnode_mask", "basic_currency", "premium_currency", "basic_keys",
  "uncommon_keys", "rare_keys", "legendary_keys", "highest_avatar",
  "buckets_weapon", "buckets_other", "active_avatar", "admin_flags",
  "account_flags", "completed_dungeons", "matchmaker_group", "concurrent_days",
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
 * Writes the account and its lists as one transaction. Children are replaced
 * wholesale: the caller hands over a complete account, and diffing rows to save
 * a few writes would be a lot of machinery for an object this size.
 */
export const saveAccount = async (account) => {
  const db = connect();
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM accounts WHERE id = $1", [account.id]);
    await insert(client, "accounts", ACCOUNT_COLUMNS, account);

    // Avatars first: items and pets reference them.
    for (const [field, columns] of Object.entries(CHILD_TABLES)) {
      for (const row of account[field] ?? []) {
        await insert(client, field, columns, { ...row, account_id: account.id });
      }
    }

    await client.query("COMMIT");
    return account;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

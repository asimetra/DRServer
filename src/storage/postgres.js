import pg from "pg";
import { isMainThread } from "node:worker_threads";
import { MAIN_THREAD_CONNECTIONS, WORKER_THREAD_CONNECTIONS } from "./connections.js";
import { config } from "../config.js";
import { info, warn } from "../log.js";
import { ProcessLockHeldError } from "../process-lock.js";
import { count } from "../metrics.js";
import { ACCOUNT_OBJECT_ID_FLOOR } from "../account-object-ids.js";
import {
  CHILD_TABLES,
  ROW_TABLES,
  SOLD_LISTINGS,
  isSold,
  loadedMask,
  planWrite,
  saleKey,
  snapshotOf,
} from "./account-rows.js";
import { runPlans } from "./account-writes.js";

export { CHILD_TABLES };

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
 *
 * Writes send only what changed. What an account's rows are, and which of them
 * a save has to touch, is account-rows.js; this file keeps the picture of what
 * storage holds, checks it is still true before trusting it, and runs the plan.
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
let processLockClient = null;

/**
 * A pool that says when it loses a connection instead of throwing it.
 *
 * node-postgres reports a connection closed from the other end as an `error`
 * event, and an `error` event nobody listens for is thrown at the process. So
 * restarting the database — an image update, `npm run db:down`, the container
 * running out of memory — took the game server down with it, and every dungeon
 * in it. The pool already drops the dead connection and opens another for the
 * next query; all that was missing was somebody to hear about it.
 */
const connect = () => {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: isMainThread ? MAIN_THREAD_CONNECTIONS : WORKER_THREAD_CONNECTIONS,
    });
    pool.on("error", (problem) => {
      count("database_connections_lost");
      warn(`postgres: lost an idle connection (${problem.message}); it will be reopened on demand`);
    });
    /**
     * And every connection, for as long as it lives. The pool listens only
     * while a connection is idle; one checked out for a transaction has nobody
     * listening, so a database restart in the middle of a save was still
     * thrown at the process. The save itself is told through the query that
     * was in flight, which rejects — this only has to keep the event from
     * being a crash as well.
     */
    pool.on("connect", (client) => client.on("error", () => {}));
  }
  return pool;
};

export const close = async () => {
  await pool?.end();
  pool = null;
};

/**
 * What is wrong with the database right now, or null; see storageProblem. One
 * round trip, which is also what proves the pool can still open a connection.
 */
export const connectionProblem = async () => {
  if (!processLockClient) return "this server does not hold the database lock";
  try {
    await connect().query("SELECT 1");
    return null;
  } catch (problem) {
    return `the database does not answer: ${problem.message}`;
  }
};

const PROCESS_LOCK = [0x0d55_3e7, 0x5345_5256];

/** How often, and for how long, a lost lock connection is tried again. */
const LOCK_RETRY_MS = 1_000;
const LOCK_RETRY_FOR_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A connection of its own holding the session lock, or a refusal. */
const takeProcessLock = async () => {
  const client = await connect().connect();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      PROCESS_LOCK
    );
    if (!rows[0]?.acquired) {
      throw new ProcessLockHeldError(
        "storage is already in use by another server or maintenance tool"
      );
    }
    return client;
  } catch (problem) {
    // A failed setup may already hold the session advisory lock. Destroying
    // the connection releases it; returning it to the pool would not.
    client.release(true);
    throw problem;
  }
};

/**
 * Holds one dedicated advisory-lock connection for the process lifetime.
 * Account locks and match state are process-local, so a second server sharing
 * this database would make their guarantees false even though SQL itself is
 * transactional.
 *
 * The lock is the connection: when the connection goes, PostgreSQL has let the
 * lock go with it. That is tried again for a short while — a database restart
 * is over in seconds, and nobody else is likely to have asked in between — and
 * `onLost` is called when it cannot be had back: another server holds it now,
 * or the database stayed away. The caller stops; two servers writing the same
 * accounts is the thing this exists to prevent.
 */
export const acquireServerProcessLock = async ({
  onLost = null,
  retryMs = LOCK_RETRY_MS,
  retryForMs = LOCK_RETRY_FOR_MS,
} = {}) => {
  if (processLockClient) throw new Error("Postgres process lock is already held here");

  let released = false;
  let dropped = null;

  const hold = (client) => {
    processLockClient = client;
    dropped = (problem) => void retake(client, problem);
    client.once("error", dropped);
  };

  const retake = async (client, problem) => {
    if (released || processLockClient !== client) return;
    processLockClient = null;
    client.release(true);
    count("database_connections_lost");
    warn(
      `postgres: lost the connection holding this server's storage lock (${problem.message}); ` +
        "taking the lock again"
    );
    const deadline = Date.now() + retryForMs;
    for (;;) {
      if (released) return;
      try {
        const again = await takeProcessLock();
        if (released) {
          again.release(true);
          return;
        }
        hold(again);
        info("postgres: storage lock taken again");
        return;
      } catch (failure) {
        // Released while this attempt was out: nothing is lost that was wanted.
        if (released) return;
        if (failure instanceof ProcessLockHeldError || Date.now() >= deadline) {
          onLost?.(failure);
          return;
        }
        await sleep(retryMs);
      }
    }
  };

  hold(await takeProcessLock());

  return async () => {
    if (released) return;
    released = true;
    const held = processLockClient;
    processLockClient = null;
    if (!held) return;
    held.off("error", dropped);
    try {
      await held.query("SELECT pg_advisory_unlock($1, $2)", PROCESS_LOCK);
      held.release();
    } catch {
      // The connection had already gone, and the lock went with it: there is
      // nothing left to give back, only a dead connection to throw away.
      held.release(true);
    }
  };
};

/** One logical sale, even if a failed migration left it in either table twice. */
export const mergeMarketListings = (listings, soldListings) => {
  const uniqueSold = [
    ...new Map(soldListings.map((row) => [saleKey(row), row])).values(),
  ];
  const moved = new Set(uniqueSold.map(saleKey));
  return [
    ...listings.filter((row) => !isSold(row) || !moved.has(saleKey(row))),
    ...uniqueSold,
  ];
};

/**
 * Timestamps come back as Date objects but the client expects the ISO strings
 * it was originally sent, so they are normalised on the way out.
 */
const fromRow = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      // A map mask's empty bytes are stored as something text can hold.
      key === "completed_mapnode_mask"
        ? loadedMask(value)
        : value instanceof Date
          ? value.toISOString()
          : value,
    ])
  );

/**
 * What storage is believed to hold for an account: its version and its rows as
 * comparable text, taken when it was read or last written here.
 *
 * Trusted only as far as the version goes. A save planned against a picture
 * names the version the picture was taken at, and storage refuses it when the
 * row has moved on — another thread wrote the account, or a tool did — and the
 * save falls back to writing everything, as every save used to. So a stale
 * picture costs a full write and can never cost a wrong one. A picture is a
 * few kilobytes; the least recently used go when there are too many.
 */
const SNAPSHOT_LIMIT = 2000;
const snapshots = new Map();

const remember = (id, snapshot) => {
  const key = Number(id);
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  if (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value);
};

/** Test seam, and what a failed write does: nothing is assumed about storage. */
export const forgetAccountSnapshots = (ids = null) => {
  if (!ids) return snapshots.clear();
  for (const id of ids) snapshots.delete(Number(id));
};

export const loadAccount = async (id) => {
  const db = connect();
  const { rows } = await db.query("SELECT * FROM accounts WHERE id = $1", [id]);
  if (!rows.length) return null;

  // The version is storage's own bookkeeping and no part of the account. Read
  // with the account row, before the lists: a save that lands between the two
  // leaves this picture a version behind, which is refused rather than trusted.
  const { version, ...account } = fromRow(rows[0]);

  for (const [field, columns] of Object.entries(CHILD_TABLES)) {
    const child = await db.query(
      `SELECT ${columns.join(", ")} FROM ${field} WHERE account_id = $1 ORDER BY id`,
      [id]
    );
    account[field] = child.rows.map(fromRow);
  }
  const sold = await db.query(
    `SELECT ${CHILD_TABLES.market_listings.join(", ")} FROM ${SOLD_LISTINGS} WHERE account_id = $1 ORDER BY id`,
    [id]
  );
  /**
   * One sale is one listing, whichever table it was read from. A sold row
   * written by a server that predates the sold table, while this one runs or
   * after it moved it, is the same sale — and counted twice it is paid twice.
   */
  account.market_listings = mergeMarketListings(
    account.market_listings,
    sold.rows.map(fromRow)
  );

  remember(id, snapshotOf(account, Number(version ?? 0)));

  // Still unmodelled: nothing in this server writes a booster row, so there is
  // no shape to store (see db/schema.sql). Chests used to be lumped in with
  // this and were silently dropped on every load — they have their own table.
  account.account_boosters = [];

  return account;
};

/**
 * One account and its lists, whole, on a caller's transaction.
 *
 * For a caller that is moving accounts in bulk and knows nothing about what
 * storage held before. Whatever picture this thread had of the account is
 * dropped: the caller's transaction may yet be rolled back, and a picture of
 * rows that were never committed would be trusted on the next save.
 */
export const writeAccount = async (client, account) => {
  forgetAccountSnapshots([account.id]);
  await runPlans(client, [account], [planWrite(null, account)]);
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
 *
 * Each account is planned before the first round trip, against the picture
 * this thread holds of it, and the pictures are replaced only once the
 * transaction has committed. A write that fails leaves none: what storage
 * holds after a failure is not something to guess at.
 */
export const saveAccounts = async (accounts) => {
  const db = connect();
  const plans = accounts.map((account) =>
    planWrite(snapshots.get(Number(account.id)) ?? null, account)
  );
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await runPlans(client, accounts, plans);
    await client.query("COMMIT");
    for (const plan of plans) {
      remember(plan.id, { ...plan.next, version: plan.written });
      if (plan.unheld) {
        warn(
          `account ${plan.id}: ${plan.unheld} weapon(s) or pet(s) named a hero the account ` +
            "does not hold, and were written as unequipped"
        );
      }
    }
    return accounts;
  } catch (err) {
    forgetAccountSnapshots(accounts.map((account) => account.id));
    // On a connection that has gone there is nothing to roll back, and a
    // failure here must not replace the error that says what went wrong.
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

/** Caller supplies a transaction; the lock keeps the cleanup/index gap closed. */
export const deduplicateSoldListings = async (client) => {
  await client.query(`LOCK TABLE ${SOLD_LISTINGS} IN SHARE ROW EXCLUSIVE MODE`);
  const removed = await client.query(
    `DELETE FROM ${SOLD_LISTINGS} AS duplicate
     USING ${SOLD_LISTINGS} AS original
     WHERE duplicate.ctid > original.ctid
       AND duplicate.account_id = original.account_id
       AND duplicate.id = original.id
       AND duplicate.sold_at IS NOT DISTINCT FROM original.sold_at`
  );
  return removed.rowCount;
};

/**
 * Puts sold listings where they belong, on a caller's client. Run at startup.
 *
 * Sold listings written before `market_sold_listings` existed sit among the
 * open ones, where the weapon's id still blocks its buyer from listing it
 * again until the seller's account happens to be saved. This moves them now.
 * It also drops the (account_id, id) key the table's first version carried,
 * which refused a seller who sold one weapon twice before claiming. Returns
 * how many rows moved; a second run finds none.
 */
export const moveSoldListingsOut = async (client) => {
  const columns = CHILD_TABLES.market_listings.join(", ");
  await client.query("BEGIN");
  try {
    await client.query(`ALTER TABLE ${SOLD_LISTINGS} DROP CONSTRAINT IF EXISTS ${SOLD_LISTINGS}_pkey`);
    await deduplicateSoldListings(client);
    // A sale already there — written by this version and again by an older
    // one — is one sale, not two.
    await client.query(
      `INSERT INTO ${SOLD_LISTINGS} (${columns})
       SELECT ${columns}
       FROM market_listings AS source
       WHERE source.sold_to IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM ${SOLD_LISTINGS} AS destination
           WHERE destination.account_id = source.account_id
             AND destination.id = source.id
             AND destination.sold_at IS NOT DISTINCT FROM source.sold_at
         )
       ON CONFLICT DO NOTHING`
    );
    const moved = await client.query("DELETE FROM market_listings WHERE sold_to IS NOT NULL");
    await client.query("COMMIT");
    return moved.rowCount;
  } catch (problem) {
    // On a connection that has gone there is nothing to roll back, and a
    // failure here must not replace the error that says what went wrong.
    await client.query("ROLLBACK").catch(() => undefined);
    throw problem;
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

const OBJECT_ID_TABLES = ROW_TABLES;

/**
 * Brings the sequence above its floor and every persisted child id.
 *
 * The caller owns the server-wide process lock and invokes this before match
 * workers exist. `setval` is deliberately absent from the hot allocation path:
 * sequences are concurrency-safe, resetting one beside concurrent `nextval`
 * calls is not.
 */
export const initializeAccountObjectSequence = async (client) => {
  const assignedIds = OBJECT_ID_TABLES
    .map((table) => `SELECT MAX(id) AS id FROM ${table}`)
    .join(" UNION ALL ");
  await client.query(
    `SELECT setval(
       'account_object_id',
       GREATEST(
         (SELECT last_value FROM account_object_id),
         $1,
         COALESCE((SELECT MAX(id) FROM (${assignedIds}) AS assigned), $1)
       ),
       true
     )`,
    [ACCOUNT_OBJECT_ID_FLOOR]
  );
};

/** Initializes shared PostgreSQL state after schema repair, on the lock connection. */
export const initializeServerStorage = async () => {
  if (!processLockClient) {
    throw new Error("Postgres process lock must be held before storage initialization");
  }
  await initializeAccountObjectSequence(processLockClient);
};

/** Server-assigned ids, from the shared sequence in the schema. */
export const nextId = async (client = connect()) => {
  const { rows } = await client.query("SELECT nextval('account_object_id') AS id");
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
/**
 * A standing carries the hero that set it, and keeps carrying it while it
 * stands. The hero used to be taken from every run: a best set on one hero was
 * shown under whichever hero the account played last, however badly.
 */
const BOARD_FOLD = {
  speedrun: "LEAST(dungeon_bests.value, EXCLUDED.value)",
  hero_experience: "GREATEST(dungeon_bests.value, EXCLUDED.value)",
  trophies: "GREATEST(dungeon_bests.value, EXCLUDED.value)",
  clears: "dungeon_bests.value + EXCLUDED.value",
};

/** Every standing under one board key, gone — startup's answer to a board whose meaning changed. */
export const purgeBoard = async (key) => {
  await connect().query("DELETE FROM dungeon_bests WHERE board_key = $1", [key]);
};

/**
 * One seeded standing, never lowering one a run set.
 *
 * Startup lifts what the accounts already hold into the player-scoped boards;
 * this is the same fold `recordRuns` applies, fed from the accounts rather
 * than from a run.
 */
export const seedStanding = async (
  key,
  accountId,
  // `hero_id`, as the entry carries it. It was read as `heroId`, which no caller
  // passes, so every standing seeded from an account named no hero at all.
  { value, at, name, trophies, hero_id: heroId }
) => {
  await connect().query(
    `INSERT INTO dungeon_bests (board_key, account_id, name, trophies, hero_id, value, achieved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (board_key, account_id) DO UPDATE
       SET value = GREATEST(dungeon_bests.value, EXCLUDED.value),
           name = EXCLUDED.name,
           trophies = EXCLUDED.trophies,
           hero_id = CASE
             WHEN EXCLUDED.value > dungeon_bests.value
             THEN EXCLUDED.hero_id ELSE dungeon_bests.hero_id END,
           achieved_at = CASE
             WHEN GREATEST(dungeon_bests.value, EXCLUDED.value) <> dungeon_bests.value
             THEN EXCLUDED.achieved_at ELSE dungeon_bests.achieved_at END`,
    [key, accountId, name, trophies ?? 0, heroId ?? null, value, at]
  );
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
                 hero_id = CASE
                   WHEN ${BOARD_FOLD[metric]} <> dungeon_bests.value
                   THEN EXCLUDED.hero_id ELSE dungeon_bests.hero_id END,
                 achieved_at = CASE
                   WHEN ${BOARD_FOLD[metric]} <> dungeon_bests.value
                   THEN EXCLUDED.achieved_at ELSE dungeon_bests.achieved_at END`,
          [key, run.account_id, run.name, run.trophies ?? 0, run.hero_id ?? null, value, run.finished_at]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    // On a connection that has gone there is nothing to roll back, and a
    // failure here must not replace the error that says what went wrong.
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

/** A rename on the boards: the account's standings take its new name (leaderboard.js). */
export const renameStandings = async (accountId, name) => {
  await connect().query("UPDATE dungeon_bests SET name = $2 WHERE account_id = $1", [accountId, name]);
};

/** One board, already ordered by the caller's direction. */
export const boardRows = async (key, { ascending = true, limit = 20 } = {}) => {
  const { rows } = await connect().query(
    // A restricted account is off the board while it lasts (restrictions.js).
    `SELECT b.account_id, b.name, b.trophies, b.hero_id, b.value, b.achieved_at
       FROM dungeon_bests b
      WHERE b.board_key = $1
        AND NOT EXISTS (
          SELECT 1 FROM accounts a
           WHERE a.id = b.account_id
             AND a.restriction IS NOT NULL
             AND (a.restriction->>'until' IS NULL OR (a.restriction->>'until')::timestamptz > now())
        )
      ORDER BY b.value ${ascending ? "ASC" : "DESC"} LIMIT $2`,
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
        item_id, rarity, power, requiredlevel, price, tax, proceeds, listed_at,
        modifier1, modifier2, legendarymodifier)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      sale.listing_id, sale.at, sale.seller_id, sale.seller_name, sale.buyer_id,
      sale.buyer_name, sale.item_id, sale.rarity, sale.power, sale.requiredlevel,
      sale.price, sale.tax, sale.proceeds, sale.listed_at,
      sale.modifier1 ?? null, sale.modifier2 ?? null, sale.legendarymodifier ?? null,
    ]
  );
};

/** Both sides of one account's market history, newest first. */
export const salesFor = async (accountId, limit) => {
  const { rows } = await connect().query(
    `SELECT listing_id, at, seller_id, seller_name, buyer_id, buyer_name,
            item_id, rarity, power, requiredlevel, price, tax, proceeds, listed_at,
            modifier1, modifier2, legendarymodifier
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

/** One record a game mode keeps. Written once; see src/modes/records.js. */
export const recordModeEntry = async (mode, record) => {
  await connect().query(
    `INSERT INTO mode_records (mode, id, at, accounts, record)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)
     ON CONFLICT (mode, id) DO NOTHING`,
    [mode, record.id, record.at, record.accounts, record]
  );
};

/** Every record a mode keeps, oldest first. */
export const modeEntries = async (mode) => {
  const { rows } = await connect().query("SELECT record FROM mode_records WHERE mode = $1 ORDER BY at, id", [mode]);
  return rows.map((row) => row.record);
};

/** The records a mode keeps about one account, newest first. */
export const modeEntriesFor = async (mode, accountId, limit) => {
  const { rows } = await connect().query(
    `SELECT record FROM mode_records
      WHERE mode = $1 AND accounts @> ARRAY[$2]::BIGINT[]
      ORDER BY at DESC, id DESC LIMIT $3`,
    [mode, accountId, limit]
  );
  return rows.map((row) => row.record);
};

/** Something that changes whenever a mode's records do: they are only ever added to. */
export const modeEntriesVersion = async (mode) => {
  const { rows } = await connect().query(
    `SELECT count(*)::text AS n, coalesce(extract(epoch FROM max(at)), 0)::text AS latest
       FROM mode_records WHERE mode = $1`,
    [mode]
  );
  return `${rows[0].n}:${rows[0].latest}`;
};

/** One decided ranked pairing. Written once; see src/ranked/records.js. */
export const recordRankedMatch = async (record) => {
  const [first, second] = record.players;
  await connect().query(
    `INSERT INTO ranked_matches (id, decided_at, state, first_id, second_id, winner_id, record)
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [record.id, record.decidedAt, record.state, first, second, record.winner ?? null, record]
  );
};

/** Every ranked match, oldest first: what ratings are replayed from. */
export const rankedMatches = async () => {
  const { rows } = await connect().query("SELECT record FROM ranked_matches ORDER BY decided_at, id");
  return rows.map((row) => row.record);
};

/**
 * Something that changes whenever the log does, without reading it: the log is
 * only ever appended to, so its length and its latest decision are enough.
 */
export const rankedMatchesVersion = async () => {
  const { rows } = await connect().query(
    "SELECT count(*)::text AS n, coalesce(extract(epoch FROM max(decided_at)), 0)::text AS latest FROM ranked_matches"
  );
  return `${rows[0].n}:${rows[0].latest}`;
};

/** One account's ranked matches, newest first. */
export const rankedMatchesFor = async (accountId, limit) => {
  const { rows } = await connect().query(
    `SELECT record FROM ranked_matches
      WHERE first_id = $1 OR second_id = $1
      ORDER BY decided_at DESC, id DESC LIMIT $2`,
    [accountId, limit]
  );
  return rows.map((row) => row.record);
};

/** How many runs finished since a moment, for the front page's counter. */
export const runsSince = async (since) => {
  const { rows } = await connect().query(
    "SELECT count(*)::int AS runs FROM dungeon_runs WHERE finished_at >= $1",
    [since]
  );
  return rows[0]?.runs ?? 0;
};

/**
 * Token revocations (see src/auth.js): every account's generation, and a
 * revocation as one statement, so that two made at once both count.
 */
export const tokenGenerationStore = {
  load: async () => {
    const { rows } = await connect().query("SELECT account_id, generation FROM token_generations");
    return Object.fromEntries(rows.map((row) => [String(row.account_id), Number(row.generation)]));
  },
  bump: async (accountId) => {
    const { rows } = await connect().query(
      `INSERT INTO token_generations (account_id, generation) VALUES ($1, 1)
       ON CONFLICT (account_id) DO UPDATE
         SET generation = token_generations.generation + 1, revoked_at = now()
       RETURNING generation`,
      [accountId]
    );
    return Number(rows[0].generation);
  },
};

/**
 * Revocations from the file a server kept before they were stored here. Only
 * ever raises a generation, so it can be done on every start; returns how many
 * it raised.
 */
export const importTokenGenerations = async (values) => {
  const entries = Object.entries(values ?? {});
  if (!entries.length) return 0;
  const { rowCount } = await connect().query(
    `INSERT INTO token_generations (account_id, generation)
     SELECT * FROM unnest($1::bigint[], $2::int[])
     ON CONFLICT (account_id) DO UPDATE SET generation = EXCLUDED.generation
       WHERE token_generations.generation < EXCLUDED.generation`,
    [entries.map(([id]) => Number(id)), entries.map(([, generation]) => Number(generation))]
  );
  return rowCount;
};

/** One of the server's own documents, or null when it has never been written. */
export const readServerState = async (key) => {
  const { rows } = await connect().query("SELECT value FROM server_state WHERE key = $1", [key]);
  return rows.length ? rows[0].value : null;
};

export const writeServerState = async (key, value) => {
  await connect().query(
    `INSERT INTO server_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
};

/** One administrative action (src/admin-actions.js). Append-only. */
export const recordAdminAction = async ({ at, actor, action, target, detail }) => {
  await connect().query(
    "INSERT INTO admin_actions (at, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)",
    [at, actor, action, target, JSON.stringify(detail ?? {})]
  );
};

export const adminActions = async ({ limit, target }) => {
  const { rows } = await connect().query(
    `SELECT at, actor, action, target, detail FROM admin_actions
      WHERE $2::bigint IS NULL OR target = $2
      ORDER BY id DESC LIMIT $1`,
    [limit, target]
  );
  return rows.map((row) => ({
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    actor: Number(row.actor),
    action: row.action,
    target: row.target === null ? null : Number(row.target),
    detail: row.detail ?? {},
  }));
};

/** The accounts restricted now (src/restrictions.js), the most recently restricted first. */
export const restrictedAccounts = async () => {
  const { rows } = await connect().query(
    `SELECT id, name, restriction FROM accounts
      WHERE restriction IS NOT NULL
        AND (restriction->>'until' IS NULL OR (restriction->>'until')::timestamptz > now())
      ORDER BY restriction->>'at' DESC`
  );
  return rows.map((row) => ({ account_id: Number(row.id), name: row.name, restriction: row.restriction }));
};

/**
 * An account deleted at its player's request (src/account-deletion.js): its row
 * and, by cascade, every child of it; its standings and run history; and its
 * name from the market history, whose sales stay for the other side.
 */
export const deleteAccountEverywhere = async (accountId) => {
  const client = await connect().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    await client.query("DELETE FROM dungeon_bests WHERE account_id = $1", [accountId]);
    await client.query("DELETE FROM dungeon_runs WHERE account_id = $1", [accountId]);
    await client.query("UPDATE market_sales SET seller_name = NULL WHERE seller_id = $1", [accountId]);
    await client.query("UPDATE market_sales SET buyer_name = NULL WHERE buyer_id = $1", [accountId]);
    await client.query("COMMIT");
  } catch (problem) {
    await client.query("ROLLBACK").catch(() => {});
    throw problem;
  } finally {
    client.release();
  }
  forgetAccountSnapshots([accountId]);
};


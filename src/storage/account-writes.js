/**
 * A planned write, carried out on a connection.
 *
 * account-rows.js says what has to be written for storage to equal an account;
 * this turns that into statements. It knows nothing about pools, transactions
 * or what storage is believed to hold — the caller brings the connection, has
 * opened the transaction, and decides afterwards what the result lets it
 * remember.
 */
import {
  ACCOUNT_COLUMNS,
  ROW_TABLES,
  SOLD_LISTINGS,
  columnsOf,
  planWrite,
} from "./account-rows.js";

/** PostgreSQL takes 65535 parameters a statement; this stays well inside it. */
const MAX_PARAMETERS = 20_000;

/**
 * Rows into one table, as few statements as their shapes allow.
 *
 * A field a row does not carry is left out of the statement, so the column's
 * own DEFAULT applies. Naming it as null instead is what `?? null` did, and an
 * explicit null does not fall back to a DEFAULT — it violates the NOT NULL
 * beside it. Six child tables carry such columns (`is_new` on four, `power` and
 * the modifier set on `account_items`, `count` on the stackables), so any
 * writer that built a row without one produced a save that worked against the
 * file backend and threw against PostgreSQL. Buying a chest from the store did
 * exactly that.
 *
 * `undefined` and `null` stop meaning the same thing here, which is the point:
 * absent is "the column decides", null is "the value is null". A nullable
 * column that is deliberately cleared — `account_items.avatar_id`, when a
 * weapon is unequipped — is assigned null rather than deleted, so it still
 * travels.
 *
 * Rows that carry the same columns go together, which is nearly all of them:
 * a hundred weapons were a hundred statements and are one.
 */
const insertRows = async (client, table, rows) => {
  const columns = columnsOf(table);
  const shapes = new Map();
  for (const row of rows) {
    const present = columns.filter((column) => row[column] !== undefined);
    if (!present.length) continue;
    const shape = present.join(", ");
    if (!shapes.has(shape)) shapes.set(shape, { present, rows: [] });
    shapes.get(shape).rows.push(row);
  }

  for (const [shape, { present, rows: alike }] of shapes) {
    const perStatement = Math.max(1, Math.floor(MAX_PARAMETERS / present.length));
    for (let at = 0; at < alike.length; at += perStatement) {
      const values = [];
      const tuples = alike.slice(at, at + perStatement).map((row) => {
        const places = present.map((column) => {
          values.push(row[column]);
          return `$${values.length}`;
        });
        return `(${places.join(", ")})`;
      });
      await client.query(`INSERT INTO ${table} (${shape}) VALUES ${tuples.join(", ")}`, values);
    }
  }
};

/** One changed row, in place. A field it does not carry goes back to DEFAULT. */
const updateRow = async (client, table, row) => {
  const values = [];
  const assignments = columnsOf(table)
    .filter((column) => column !== "id" && column !== "account_id")
    .map((column) => {
      if (row[column] === undefined) return `${column} = DEFAULT`;
      values.push(row[column]);
      return `${column} = $${values.length}`;
    });
  values.push(row.account_id, row.id);
  await client.query(
    `UPDATE ${table} SET ${assignments.join(", ")}
      WHERE account_id = $${values.length - 1} AND id = $${values.length}`,
    values
  );
};

/** Rows that are in storage and no longer in the account. */
const deleteRows = async (client, table, accountId, removals) => {
  if (table !== SOLD_LISTINGS) {
    await client.query(`DELETE FROM ${table} WHERE account_id = $1 AND id = ANY($2::bigint[])`, [
      accountId,
      removals.map(({ id }) => id),
    ]);
    return;
  }
  // No key of its own: one seller may hold two sales of one weapon.
  for (const { id, sold_at: soldAt } of removals) {
    await client.query(
      `DELETE FROM ${SOLD_LISTINGS}
        WHERE account_id = $1 AND id = $2 AND sold_at IS NOT DISTINCT FROM $3`,
      [accountId, id, soldAt]
    );
  }
};

const versionOf = (result) => Number(result?.rows?.[0]?.version ?? 0);

/**
 * The account's own row, whole, and its new version.
 *
 * Updated in place, never removed and remade. This began as the file backend's
 * shape — rewrite the whole document — and inside this server the two read
 * alike, because the children cascade away and are written again in the same
 * breath. Outside it they do not. The website's `web.users.account_id`
 * references this row with ON DELETE SET NULL, so every save detached a
 * player's login from their character. One finished dungeon was enough, and
 * what the site then said was "confirm your email address first" to somebody
 * who had confirmed it days before.
 *
 * A field the account does not carry is DEFAULT, not null, like the child
 * rows': a brand-new account (the template carries no `market_barred`) could
 * not be saved at all against PostgreSQL with a null there. `EXCLUDED` then
 * carries the default into the update as well, so an absent field means the
 * column's default whether the row is new or not — as it would read back from
 * a file that never had it.
 */
const upsertAccountRow = async (client, row) => {
  const values = [];
  const placeholders = ACCOUNT_COLUMNS.map((column) => {
    if (row[column] === undefined) return "DEFAULT";
    values.push(row[column]);
    return `$${values.length}`;
  }).join(", ");
  const assignments = ACCOUNT_COLUMNS.filter((column) => column !== "id")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ");
  return versionOf(
    await client.query(
      `INSERT INTO accounts (${ACCOUNT_COLUMNS.join(", ")}, version) VALUES (${placeholders}, 1)
       ON CONFLICT (id) DO UPDATE SET ${assignments}, version = accounts.version + 1
       RETURNING version`,
      values
    )
  );
};

/**
 * Only the columns that changed, and only if storage is still at the version
 * the plan was made against. Null when it is not: the row has moved on, or is
 * gone, and the caller writes everything instead.
 *
 * The version moves on every save, changed columns or none, because that is
 * what tells every other picture of this account that it is out of date.
 */
const advanceAccountRow = async (client, plan) => {
  const values = [];
  const assignments = plan.accountColumns.map((column) => {
    if (plan.accountRow[column] === undefined) return `${column} = DEFAULT`;
    values.push(plan.accountRow[column]);
    return `${column} = $${values.length}`;
  });
  values.push(plan.id, plan.version);
  const result = await client.query(
    `UPDATE accounts SET ${[...assignments, "version = version + 1"].join(", ")}
      WHERE id = $${values.length - 1} AND version = $${values.length}
      RETURNING version`,
    values
  );
  return result?.rows?.length ? versionOf(result) : null;
};

/**
 * The three passes of a write, each over every account in it before the next.
 *
 * Rows first: the account's own, which is also where a plan made against a
 * picture learns whether the picture still holds. One that does not becomes a
 * plan to write everything.
 *
 * Then everything that has to go, for every account, before anything is
 * written for any of them. Child ids are global keys, so a weapon moving from
 * the second account to the first is inserted under the first while the second
 * still holds its old row — and a trade the second party gave something in
 * failed on the duplicate key, every time.
 *
 * Then what is new and what changed, heroes before the weapons and pets that
 * reference them.
 */
export const runPlans = async (client, accounts, plans) => {
  for (const [index, plan] of plans.entries()) {
    const advanced = plan.full ? null : await advanceAccountRow(client, plan);
    if (advanced !== null) {
      plan.written = advanced;
      continue;
    }
    if (!plan.full) plans[index] = planWrite(null, accounts[index]);
    plans[index].written = await upsertAccountRow(client, plans[index].accountRow);
  }

  for (const plan of plans) {
    if (plan.full) {
      /**
       * The children are cleared, which the account row cannot be: they are
       * lists and a save has to be able to shorten one — a weapon that was
       * sold would otherwise come back on the next write.
       */
      for (const table of ROW_TABLES) {
        await client.query(`DELETE FROM ${table} WHERE account_id = $1`, [plan.id]);
      }
      continue;
    }
    for (const [table, removals] of plan.removes) await deleteRows(client, table, plan.id, removals);
  }

  for (const table of ROW_TABLES) {
    for (const plan of plans) {
      if (plan.inserts.has(table)) await insertRows(client, table, plan.inserts.get(table));
      for (const row of plan.updates.get(table) ?? []) await updateRow(client, table, row);
    }
  }
};

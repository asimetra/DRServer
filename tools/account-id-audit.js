#!/usr/bin/env node
/** Finds persistent row IDs owned by more than one account/table. Read-only. */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { CLIENT_PERSISTENT_OBJECT_ID_MAX } from "../src/account-object-ids.js";

const loadRawAccounts = async () => {
  if (config.storage === "postgres") {
    const storage = await import("../src/storage/postgres.js");
    const ids = await storage.listAccountIds();
    return Promise.all(ids.map((id) => storage.loadAccount(id)));
  }

  let names = [];
  try {
    names = await fs.readdir(config.dataDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const accounts = [];
  for (const name of names.sort()) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(config.dataDir, name);
    accounts.push(JSON.parse(await fs.readFile(file, "utf8")));
  }
  return accounts;
};

export const auditAccountObjectIds = (accounts) => {
  const owners = new Map();
  const invalid = [];
  for (const account of accounts.filter(Boolean)) {
    for (const [table, rows] of Object.entries(account)) {
      if (!Array.isArray(rows)) continue;
      rows.forEach((row, index) => {
        if (!Object.hasOwn(row ?? {}, "id")) return;
        const id = Number(row.id);
        const owner = { accountId: Number(account.id), table, index };
        if (!Number.isSafeInteger(id) || id <= 0) {
          invalid.push({ id: row.id, ...owner });
          return;
        }
        const entries = owners.get(id) ?? [];
        entries.push(owner);
        owners.set(id, entries);
      });
    }
  }
  const collisions = [...owners]
    .filter(([, entries]) => entries.length > 1)
    .map(([id, entries]) => ({ id, entries }));
  return { accounts: accounts.length, rows: owners.size, collisions, invalid };
};

/**
 * Repairs only duplicate attribute-row IDs. Those are internal primary keys
 * with no account payload pointing back to them. Avatar/item IDs have live
 * references and deliberately stop this tool for a purpose-built migration.
 */
export const reassignDuplicateAttributeIds = (accounts) => {
  const audit = auditAccountObjectIds(accounts);
  const unsupported = audit.collisions.flatMap(({ id, entries }) =>
    entries.slice(1).filter((entry) => entry.table !== "account_attributes")
      .map((entry) => ({ id, ...entry }))
  );
  if (unsupported.length || audit.invalid.length) {
    throw new Error(
      "automatic repair is limited to duplicate account_attributes IDs; " +
      "referenced/invalid rows need a dedicated migration"
    );
  }

  let next = 0;
  for (const account of accounts) {
    for (const rows of Object.values(account)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (Number.isSafeInteger(Number(row?.id))) next = Math.max(next, Number(row.id));
      }
    }
  }

  const byAccount = new Map(accounts.map((account) => [Number(account.id), account]));
  const changed = [];
  for (const { id, entries } of audit.collisions) {
    for (const entry of entries.slice(1)) {
      next += 1;
      if (next > CLIENT_PERSISTENT_OBJECT_ID_MAX) {
        throw new RangeError("persistent object id space exhausted during repair");
      }
      const account = byAccount.get(entry.accountId);
      const row = account?.[entry.table]?.[entry.index];
      if (!row || Number(row.id) !== id) throw new Error(`row ${id} changed during audit`);
      row.id = next;
      changed.push({ oldId: id, newId: next, ...entry });
    }
  }
  return changed;
};

const backupAndSaveFileAccounts = async (accounts, changed) => {
  if (config.storage !== "file") {
    throw new Error("--repair currently requires file storage");
  }
  const affected = [...new Set(changed.map(({ accountId }) => accountId))]
    .map((id) => accounts.find((account) => Number(account.id) === id));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const account of affected) {
    const file = path.join(config.dataDir, `${account.id}.json`);
    await fs.copyFile(file, `${file}.before-id-repair-${stamp}`);
  }
  const { saveAccounts } = await import("../src/accounts.js");
  await saveAccounts(affected);
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const repairing = process.argv.includes("--repair");
  const releaseProcessLock = repairing
    ? await (await import("../src/process-lock.js")).acquireProcessLock()
    : null;
  try {
    const accounts = await loadRawAccounts();
    const before = auditAccountObjectIds(accounts);
    if (repairing) {
      const changed = reassignDuplicateAttributeIds(accounts);
      if (changed.length) await backupAndSaveFileAccounts(accounts, changed);
      console.log(`Reassigned ${changed.length} duplicate attribute row(s).`);
      for (const row of changed) {
        console.log(`  account ${row.accountId} ${row.table}[${row.index}]: ${row.oldId} -> ${row.newId}`);
      }
    }
    const result = auditAccountObjectIds(accounts);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.accounts} account(s), ${result.rows} unique persistent row id(s)`);
      for (const collision of result.collisions) {
        console.log(`COLLISION ${collision.id}`);
        for (const entry of collision.entries) {
          console.log(`  account ${entry.accountId} ${entry.table}[${entry.index}]`);
        }
      }
      for (const entry of result.invalid) {
        console.log(`INVALID ${entry.id} account ${entry.accountId} ${entry.table}[${entry.index}]`);
      }
      if (!result.collisions.length && !result.invalid.length) console.log("No persistent row ID conflicts.");
    }
    if (!repairing && (before.collisions.length || before.invalid.length)) {
      process.exitCode = 1;
    } else if (result.collisions.length || result.invalid.length) {
      process.exitCode = 1;
    }
  } finally {
    await releaseProcessLock?.();
  }
}

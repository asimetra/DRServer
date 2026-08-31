import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-save-accounts-"));
process.env.ODS_DATA_DIR = dataDir;

const { loadAccount, saveAccount, saveAccounts } = await import("../src/accounts.js");

after(async () => {
  delete process.env.ODS_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

const readStored = async (id) =>
  JSON.parse(await readFile(path.join(dataDir, `${id}.json`), "utf8"));

/**
 * Moving something from one account to another, written down once.
 *
 * `withTwoAccountLocks` stops a second writer interleaving with this one. It
 * says nothing about this writer stopping halfway, which is what two separate
 * saves are: the sender's file lands, the process dies, and the item is on
 * neither account. Gifting already had that shape, and trading between players
 * will be nothing but that shape.
 */
test("both sides of a transfer are written together", async () => {
  const sender = await loadAccount(9001);
  const recipient = await loadAccount(9002);
  sender.basic_currency = 100;
  recipient.basic_currency = 0;
  await saveAccounts([sender, recipient]);

  sender.basic_currency = 40;
  recipient.basic_currency = 60;
  await saveAccounts([sender, recipient]);

  assert.equal((await readStored(9001)).basic_currency, 40);
  assert.equal((await readStored(9002)).basic_currency, 60);
});

/**
 * A sender and a recipient who turn out to be one person.
 *
 * The registry hands every holder the object already in play, so gifting
 * yourself arrives here as the same object twice. The caller used to have to
 * notice — `if (recipient !== sender)` — and a caller who forgets writes the
 * account, deletes it, and writes it again.
 */
test("the same account offered twice is written once", async () => {
  const account = await loadAccount(9003);
  account.basic_currency = 7;
  await saveAccounts([account, account]);

  assert.equal((await readStored(9003)).basic_currency, 7);
});

/**
 * Two different objects for one id are the divergence the registry exists to
 * prevent. Whichever were written last would silently discard the other, which
 * is the loss this function was added to stop, so it is refused instead.
 */
test("two different objects for one account are refused", async () => {
  const account = await loadAccount(9004);
  const stale = { ...account, basic_currency: 999 };

  await assert.rejects(
    () => saveAccounts([account, stale]),
    /two different objects offered for account 9004/
  );
});

/**
 * The file backend cannot make two renames one operation, so it does the next
 * thing: nothing is renamed until every file has been written. A save that
 * cannot produce one of its files leaves all of them alone rather than landing
 * the half it managed.
 */
test("a save that fails partway leaves the earlier account untouched", async () => {
  const first = await loadAccount(9005);
  const second = await loadAccount(9006);
  first.basic_currency = 5;
  second.basic_currency = 6;
  await saveAccounts([first, second]);

  // Both are changed, and the second cannot be written: JSON.stringify throws
  // on a cycle. Neither change may reach disk.
  first.basic_currency = 500;
  second.basic_currency = 600;
  second.self = second;
  await assert.rejects(() => saveAccounts([first, second]));

  assert.equal((await readStored(9005)).basic_currency, 5);
  assert.equal((await readStored(9006)).basic_currency, 6);
  assert.ok(!(await readdir(dataDir)).some((name) => name.endsWith(".tmp")));
});

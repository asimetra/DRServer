import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-last-login-"));

const { config } = await import("../src/config.js");
// Who is asking is not what is under test; see rpc-caller.test.js for that.
config.authEnabled = false;
const { routes } = await import("../src/routes.js");
const { loadAccount, saveAccount, withAccountLock } = await import("../src/accounts.js");


/**
 * These read or damage the account files themselves, or keep a record in a
 * shape only a file can hold, so they have nothing to say about PostgreSQL —
 * test/postgres-save.test.js is where that backend is held to the same things.
 */
const fileOnly = process.env.ODS_STORAGE === "postgres" && "file storage only";

/**
 * When an account was last here.
 *
 * The client reads nothing from `last_login`, which is how it came to be
 * written once at creation and never again: four days of launches answered the
 * same stale value. The official moves it to the current day — nineteen
 * distinct dates on one account across its recordings — and whoever looks after
 * a server wants the same thing, to tell an account that left in the spring
 * from one that was on last night.
 *
 * It moves on the question every launch opens with, and by the day, as the
 * official's does: the first launch of a day writes, the rest only read.
 */

const ME = 1000400001;
// Wherever the server keeps it: the suite's runner names its own directory.
const accountFile = path.join(config.dataDir, `${ME}.json`);
const details = routes.find((route) => route.pattern === "/api/dbAccountInfo/accountdetails");
const launch = async () => JSON.parse((await details.handler({ headers: { "x-account-id": String(ME) } })).body);

const today = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
};

test("launching the game moves last_login to today", async () => {
  const account = await loadAccount(ME);
  account.last_login = "2026-03-02T19:44:10.000Z";
  await saveAccount(account);

  const answered = await launch();

  assert.equal(answered.last_login, today(), "the launch itself is told the new date");
  assert.equal((await loadAccount(ME)).last_login, today(), "and it is written down");
});

test("a second launch the same day writes nothing", { skip: fileOnly }, async () => {
  await launch();
  const written = async () => (await fs.stat(accountFile)).mtimeMs;
  const before = await written();

  await new Promise((resolve) => setTimeout(resolve, 20));
  const answered = await launch();

  assert.equal(await written(), before, "the account file is not rewritten");
  assert.equal(answered.last_login, today());
});

test("an account that never had one gets it", async () => {
  const account = await loadAccount(ME);
  delete account.last_login;
  await saveAccount(account);

  assert.equal((await launch()).last_login, today());
});

/**
 * The stamp is a write, and writes to an account go one at a time. A launch
 * that lands while a purchase is being settled waits for it rather than saving
 * a copy read from before it.
 */
test("the stamp waits its turn behind a change already under way", async () => {
  const account = await loadAccount(ME);
  account.last_login = "2026-03-02T00:00:00.000Z";
  account.basic_currency = 100;
  await saveAccount(account);

  let release;
  const purchase = withAccountLock(ME, async () => {
    const mine = await loadAccount(ME);
    await new Promise((resolve) => { release = resolve; });
    mine.basic_currency = 40;
    await saveAccount(mine);
  });
  const launching = launch();
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await Promise.all([purchase, launching]);

  const after = await loadAccount(ME);
  assert.equal(after.basic_currency, 40, "the purchase is not undone by the launch");
  assert.equal(after.last_login, today());
});

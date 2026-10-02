import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ods-run-saves-"));
process.env.ODS_DATA_DIR = dataDir;

const { acquireAccount, loadAccount, saveAccount, withAccountLock, waitForAccountWrites } =
  await import("../src/accounts.js");
const { heldAccount } = await import("../src/account-registry.js");
const { queueAccountSave } = await import("../src/socket/rewards.js");
const { leaveDungeon } = await import("../src/socket/dungeon.js");
const { transitionsOf } = await import("../src/socket/session-transitions.js");
const {
  configureRunSaves,
  finishRunSaves,
  followRunSave,
  resumeRunSaves,
  runSavesFailing,
  waitForRunSaves,
  whenRunSaved,
} = await import("../src/socket/run-saves.js");

// Retries in milliseconds rather than seconds, so the tests can wait for them.
configureRunSaves({ delays: [15] });

// A retry's wait does not keep a process alive, and here it is all there is.
const alive = setInterval(() => {}, 1000);

test.after(() => {
  clearInterval(alive);
  delete process.env.ODS_DATA_DIR;
  fs.chmodSync(dataDir, 0o755);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stored = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, `${id}.json`), "utf8"));
const until = async (condition, what, withinMs = 3000) => {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`never happened: ${what}`);
    await sleep(5);
  }
};


/**
 * These read or damage the account files themselves, or keep a record in a
 * shape only a file can hold, so they have nothing to say about PostgreSQL —
 * test/postgres-save.test.js is where that backend is held to the same things.
 */
const fileOnly = process.env.ODS_STORAGE === "postgres" && "file storage only";

/** A session the way dungeon entry leaves it: the account loaded and held. */
const enter = async (id, overrides = {}) => {
  const account = await acquireAccount(id);
  return {
    account,
    session: {
      id: 1,
      dungeonActive: true,
      areaDoid: 4001,
      dungeonZone: 10,
      mapNodeId: 50002,
      actors: new Map(),
      objects: new Map(),
      allocateDoid: () => 5001,
      send: () => {},
      dungeonAccount: account,
      dungeonAvatar: account.account_avatars[0],
      ...overrides,
    },
  };
};

/**
 * A save that fails is not the end of the matter.
 *
 * It was: a line in the log, and then the run's own copy of the account was
 * let go when the player walked out, so whatever storage had not taken was
 * gone — shown to the player, and not kept.
 */
test("a save that fails is retried until it lands", async () => {
  let attempts = 0;
  const save = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("storage is away");
  };

  const first = Promise.resolve().then(save);
  followRunSave(9001, first, save);
  await assert.rejects(first, /storage is away/, "the first attempt still says what happened");
  assert.equal(runSavesFailing(), 1, "and the account is known to be unsaved");

  await whenRunSaved(9001);
  assert.equal(attempts, 3);
  assert.equal(runSavesFailing(), 0);
});

test("a later save that lands is the whole account: the retry has nothing left to do", async () => {
  let failing = true;
  let writes = 0;
  const save = async () => {
    if (failing) throw new Error("storage is away");
    writes += 1;
  };

  const failed = Promise.resolve().then(save);
  followRunSave(9002, failed, save);
  await failed.catch(() => undefined);
  assert.equal(runSavesFailing(), 1);

  failing = false;
  const next = Promise.resolve().then(save);
  followRunSave(9002, next, save);
  await whenRunSaved(9002);
  assert.equal(writes, 1, "written once, by the save that worked");
  assert.equal(runSavesFailing(), 0);
});

/**
 * The reproduction, with the server's own save, registry and teardown: the
 * last reward of a run cannot be written, the player leaves, and storage comes
 * back a moment later.
 */
test("progress the storage refused is kept in memory and written when the storage is back", { skip: fileOnly }, async () => {
  const id = 1000000101;
  const { account, session } = await enter(id);
  const start = account.basic_currency;

  account.basic_currency += 500;
  await queueAccountSave(session);
  assert.equal(stored(id).basic_currency - start, 500);

  fs.chmodSync(dataDir, 0o555);
  account.basic_currency += 300;
  await queueAccountSave(session).catch(() => undefined);
  leaveDungeon(session);
  await sleep(40);

  assert.equal(heldAccount(id), account, "the account is still the one in play");
  assert.equal((await loadAccount(id)).basic_currency - start, 800, "so nobody reads the stale one");
  assert.ok(runSavesFailing() >= 1);

  fs.chmodSync(dataDir, 0o755);
  await whenRunSaved(id);
  assert.equal(stored(id).basic_currency - start, 800, "nothing the player was shown is lost");
  await until(() => heldAccount(id) === null, "the account is let go once it is written");
});

/**
 * The same account, read by a request in the moment between the player
 * leaving and the last save landing. It used to get a second copy from
 * storage, and then one of the two overwrote the other.
 */
test("a request arriving while the last save is still landing changes the same account", { skip: fileOnly }, async () => {
  for (const [what, saveDelay, requestThinks] of [
    ["a slow save and a quick request", 60, 0],
    ["a request that reads first and writes last", 20, 80],
  ]) {
    const id = 1000000200 + saveDelay;
    const { account, session } = await enter(id, {
      persistDungeonAccount: async (value) => {
        await sleep(saveDelay);
        return saveAccount(value);
      },
    });
    const start = { gold: account.basic_currency, gems: account.premium_currency ?? 0 };

    account.basic_currency += 300;
    leaveDungeon(session);
    await withAccountLock(id, async () => {
      const fresh = await loadAccount(id);
      await sleep(requestThinks);
      fresh.premium_currency = (fresh.premium_currency ?? 0) + 7;
      await saveAccount(fresh);
    });
    await waitForRunSaves();
    await waitForAccountWrites();

    const disk = stored(id);
    assert.equal(disk.basic_currency - start.gold, 300, `${what}: the run's last reward`);
    assert.equal((disk.premium_currency ?? 0) - start.gems, 7, `${what}: the request's change`);
    await until(() => heldAccount(id) === null, "released afterwards");
  }
});

test("a run that was already written down lets its account go at once, as before", async () => {
  const id = 1000000301;
  const { session } = await enter(id);
  await queueAccountSave(session);
  await waitForRunSaves();
  session.accountSettled = true;

  leaveDungeon(session);
  assert.equal(heldAccount(id), null);
});

/**
 * A server that cannot write is not somewhere to start a run. The player who
 * is already inside keeps playing and is kept; the one in town is told the
 * game cannot be entered, rather than let in to play for nothing.
 */
test("nobody is let into a dungeon while a save is waiting to reach storage", async () => {
  const answers = [];
  const connection = { id: 7, accountId: 1000000401, matchMakerDoid: 1, send: (frame) => answers.push(frame) };
  let admitted = 0;
  const admit = async () => {
    admitted += 1;
    return { match: null, error: "bad_map_node" };
  };

  let failing = true;
  const save = async () => {
    if (failing) throw new Error("storage is away");
  };
  const first = Promise.resolve().then(save);
  followRunSave(9003, first, save);
  await first.catch(() => undefined);

  assert.equal(transitionsOf(connection).requestEntry({ mapNodeId: 50002 }, { admit }), null);
  assert.equal(admitted, 0, "refused before anything is loaded");
  assert.equal(answers.length, 1, "and the client is answered");

  failing = false;
  await whenRunSaved(9003);
  await transitionsOf(connection).requestEntry({ mapNodeId: 50002 }, { admit });
  assert.equal(admitted, 1, "admission is asked again once storage is taking saves");
});

test("at shutdown a waiting save gets one more attempt, and is then given up on", async () => {
  configureRunSaves({ delays: [60_000] });
  let attempts = 0;
  const save = async () => {
    attempts += 1;
    throw new Error("storage is away");
  };
  const first = Promise.resolve().then(save);
  followRunSave(9004, first, save);
  await first.catch(() => undefined);

  const began = Date.now();
  await finishRunSaves();
  assert.ok(Date.now() - began < 1000, "it does not sit out the backoff");
  assert.equal(attempts, 2, "tried again once, at once");
  assert.equal(runSavesFailing(), 0, "and no longer waited for");
  resumeRunSaves();
  configureRunSaves({ delays: [15] });
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * The client's own admin console (src/magic-words.js): backtick asks
 * AskIfAdmin, the console's words post doMagicWord, and the client reloads
 * from AskForAccountDetails. The admin rule is the chat commands' own.
 */
process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-magic-"));
const ADMIN = 1000000005;
const PLAYER = 1000000006;
process.env.ODS_ADMIN_ACCOUNTS = String(ADMIN);

const { dispatch, hasHandler } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { getMapNodeBit } = await import("../src/map-progress.js");
const { loadGameMaster } = await import("../src/gamemaster.js");
const { adminActions } = await import("../src/admin-actions.js");
const { MAGIC_WORDS } = await import("../src/magic-words.js");

const withHero = async (id) => {
  const account = await loadAccount(id);
  account.account_avatars = [{ id: 1, avatar_id: 1, experience: 0, completed_mapnode_mask: "" }];
  account.active_avatar = 1;
  account.premium_currency = 5;
  account.basic_currency = 100;
  await saveAccount(account);
  return account;
};

const word = (id, ...args) => dispatch("webMagicWord", "doMagicWord", [id, "token", args, "{}"], id);

test("the three calls the console makes are registered, and the words are the client's", async () => {
  for (const method of ["AskIfAdmin", "AskForAccountDetails", "doMagicWord", "getWebServerTimestamp"]) {
    assert.ok(hasHandler("webMagicWord", method), `webMagicWord/${method}`);
  }
  assert.deepEqual([...MAGIC_WORDS], ["Test", "UnlockAllMapNodes", "LockAllMapNodes", "UnlockMapNodes", "GiveGems", "GiveCoins", "GiveXp"]);
});

test("backtick: an admin is told so, a player is not, and a player's words are refused", async () => {
  await withHero(ADMIN);
  await withHero(PLAYER);
  assert.equal(await dispatch("webMagicWord", "AskIfAdmin", [ADMIN, "token", "{}"], ADMIN), 1);
  assert.equal(await dispatch("webMagicWord", "AskIfAdmin", [PLAYER, "token", "{}"], PLAYER), 0);
  await assert.rejects(word(PLAYER, "GiveGems", 100), /not an admin/);
  assert.equal((await loadAccount(PLAYER)).premium_currency, 5, "and nothing changed");
  await assert.rejects(
    dispatch("webMagicWord", "doMagicWord", [ADMIN, "token", ["GiveGems", 1], "{}"], PLAYER),
    /may not act for another/,
    "a player cannot speak in the admin's name either"
  );
});

test("the currency and experience words add to the caller's own account, within bounds, and are recorded", async () => {
  await withHero(ADMIN);
  assert.deepEqual(await word(ADMIN, "Test"), ["ok"]);
  assert.deepEqual(await word(ADMIN, "GiveGems", 100), ["gems: 105"]);
  assert.deepEqual(await word(ADMIN, "GiveCoins", 50), ["coins: 150"]);
  assert.deepEqual(await word(ADMIN, "GiveXp", 1, 1234), ["hero 1 experience: 1234"]);
  await assert.rejects(word(ADMIN, "GiveGems", -5), /whole number/);
  await assert.rejects(word(ADMIN, "GiveGems", 1e9), /whole number/);
  await assert.rejects(word(ADMIN, "GiveXp", 9, 10), /no hero 9/);
  await assert.rejects(word(ADMIN, "Frobnicate"), /unknown magic word/);

  const account = await loadAccount(ADMIN);
  account.sanctions = [];
  await saveAccount(account);
  assert.equal(account.premium_currency, 105);
  assert.equal(account.basic_currency, 150);
  assert.equal(account.account_avatars[0].experience, 1234);

  const details = await dispatch("webMagicWord", "AskForAccountDetails", [ADMIN, "token", "{}"], ADMIN);
  assert.equal(details.premium_currency, 105, "the client reloads itself from this");
  assert.equal(details.sanctions, undefined, "without the server's own fields (server-only-fields.js)");

  const recorded = (await adminActions({ account: ADMIN })).map((row) => row.action);
  assert.ok(recorded.includes("console.GiveGems") && recorded.includes("console.GiveXp"), `recorded: ${recorded}`);
});

test("the map words set and clear the hero's node bits by node id", async () => {
  await withHero(ADMIN);
  const gm = await loadGameMaster();
  const nodes = (gm.raw.MapPage ?? []).slice().sort((a, b) => a.Id - b.Id);
  const [first, second] = nodes;

  const mask = async () => (await loadAccount(ADMIN)).account_avatars[0].completed_mapnode_mask;
  await word(ADMIN, "UnlockMapNodes", 1, first.Id, second.Id);
  assert.ok(getMapNodeBit(await mask(), first.BitIndex) && getMapNodeBit(await mask(), second.BitIndex));
  assert.ok(!getMapNodeBit(await mask(), nodes.at(-1).BitIndex), "only the range asked for");

  const [line] = await word(ADMIN, "UnlockAllMapNodes", 1);
  assert.match(line, new RegExp(`unlocked ${nodes.length} map nodes`));
  const all = await mask();
  assert.ok(nodes.every((node) => getMapNodeBit(all, node.BitIndex)));

  await word(ADMIN, "LockAllMapNodes", 1);
  assert.equal(await mask(), "");
  await assert.rejects(word(ADMIN, "UnlockMapNodes", 1, 1, 2), /no map nodes/);
});

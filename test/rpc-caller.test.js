import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * A token proves which account is calling. It has to also decide which account
 * is acted on.
 *
 * The header is what carries the proof — `JSONRPCService` sets `X-Account-Id`
 * and `X-Validation-Token` once for every POST — but the handlers read the
 * account out of `params`, and those are two different numbers. Checking only
 * the header left a player with a perfectly good token of their own able to
 * name somebody else in the body and act as them: alter their preferences,
 * spend their gold, sell their weapons, open their chests.
 *
 * Which position holds it is per-method and not guessable: first on most,
 * second on the three avatarrecord calls because the token goes ahead of it,
 * fifth on a friend request. So each handler says where its own is.
 */

process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-caller-"));

const { dispatch, register } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount } = await import("../src/accounts.js");

const ME = 1000000005;
const SOMEBODY_ELSE = 1000000006;

test("a caller may not name another account in the body", async () => {
  await assert.rejects(
    () => dispatch("account", "AlterAttribute", [SOMEBODY_ELSE, "t", "PWNED", "yes"], ME),
    /account/i,
    "the call is refused rather than quietly applied to the other account"
  );

  const victim = await loadAccount(SOMEBODY_ELSE);
  assert.equal(
    victim.account_attributes?.some((row) => row.name === "PWNED"),
    false,
    "and nothing reached them"
  );
});

test("a caller acting on itself is allowed", async () => {
  await dispatch("account", "AlterAttribute", [ME, "t", "COLOUR", "green"], ME);
  const mine = await loadAccount(ME);
  assert.equal(mine.account_attributes.find((row) => row.name === "COLOUR")?.value, "green");
});

/**
 * The three avatarrecord methods put the token first and the account second,
 * so a check that assumed the first position would have waved them through
 * while refusing every legitimate call.
 */
test("the account is found where each method actually puts it", async () => {
  await assert.rejects(
    () => dispatch("avatarrecord", "setActiveAvatar", ["token", SOMEBODY_ELSE, 1], ME),
    /account/i,
    "second position, on a method that leads with the token"
  );

  await assert.rejects(
    () => dispatch("friendrequests", "DRFriendRequest", [0, 0, 0, 0, SOMEBODY_ELSE, "x"], ME),
    /account/i,
    "fifth position, on a friend request"
  );
});

test("a method that acts on no account needs no caller", async () => {
  const stamp = await dispatch("storeGetWebServerTimestamp", "getWebServerTimestamp", [], ME);
  assert.ok(Array.isArray(stamp) && stamp.length === 3, "public data is still served");
});

/**
 * With the check off there is no caller to compare against, and the server
 * accepts whatever it is told — the behaviour every configuration had before
 * tokens existed.
 */
test("no caller means no comparison", async () => {
  await dispatch("account", "AlterAttribute", [SOMEBODY_ELSE, "t", "LEGACY", "yes"], null);
  const victim = await loadAccount(SOMEBODY_ELSE);
  assert.equal(victim.account_attributes.find((row) => row.name === "LEGACY")?.value, "yes");
});

test("a handler registered without saying where its account is defaults to the first", async () => {
  register("test/echo", async ([accountId]) => ({ accountId }));
  assert.deepEqual(await dispatch("test", "echo", [ME], ME), { accountId: ME });
  await assert.rejects(() => dispatch("test", "echo", [SOMEBODY_ELSE], ME), /account/i);
});

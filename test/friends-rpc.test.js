import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * The friend panel's endpoints, through the dispatcher rather than the module.
 *
 * All of add, block, unblock, remove and report were reachable in the client and
 * answered by nothing here — and the one that was registered decoded the wrong
 * kind of value, so adding somebody from the dungeon summary quietly failed.
 */
process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-friends-"));

const { dispatch, hasHandler } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { friendCodeOf, friendIdsOf, ignoredIdsOf } = await import("../src/social.js");

const ME = 1000000005;
const THEM = 1000000006;

/** Both accounts exist and neither knows the other. */
const reset = async () => {
  for (const id of [ME, THEM]) {
    const account = await loadAccount(id);
    account.ingame_friends = "[]";
    account.ignore_friends = "[]";
    await saveAccount(account);
  }
};

const addFriend = (value) =>
  dispatch("friendrequests", "DRFriendRequest", ["Me", 0, 0, null, ME, value, {}, "token"]);

test("every endpoint the friend and report screens call is registered", () => {
  for (const [service, method] of [
    ["friendrequests", "DRFriendRequest"],
    ["friendrequests", "DRFriendRemove"],
    ["friendrequests", "DRFriendRequestPending"],
    ["friendrequests", "DRFriendRequestUpdate"],
    ["friendrequests", "IgnoreFriend"],
    ["friendrequests", "UnblockFriend"],
    ["report", "ReportPlayer"],
    ["leaderboard", "getFriendData"],
    ["leaderboard", "getIgnoreFriendData"],
  ]) {
    assert.ok(hasHandler(service, method), `${service}/${method} is not registered`);
  }
});

test("a friend code typed into the invite box adds that player", async () => {
  await reset();
  const answer = await addFriend(friendCodeOf(THEM));

  assert.equal(answer.to_account_id, THEM, "the panel is told who it reached");
  assert.equal(answer.friend_code, friendCodeOf(THEM));
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [THEM]);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [ME], "and both sides have it");
});

test("an account id from the dungeon summary adds that player too", async () => {
  await reset();
  /**
   * `DistributedDungeonSummary.addFriend` sends `personId` as a number. Read as
   * a base 32 code it decodes to something in the trillions, which is a valid
   * code for an account nobody has — so this used to answer "not found".
   */
  const answer = await addFriend(THEM);

  assert.notDeepEqual(answer, [], "a number is an account, not a code");
  assert.equal(answer.to_account_id, THEM);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [THEM]);
});

test("the ten-digit account id is what a player can actually type", async () => {
  await reset();
  /**
   * `UIInvite.inviteViaEmail` tests `^1[0-9]{9}$` before anything else and
   * sends a match through untouched. Everything else has to pass
   * `isValidSteamId` or the box clears itself, so this string is the only
   * friend code that reaches this server from that screen.
   */
  assert.match(String(THEM), /^1[0-9]{9}$/, "the ids this server hands out fit that branch");

  const answer = await addFriend(String(THEM));
  assert.equal(answer.to_account_id, THEM);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [THEM]);
});

test("the outcomes the invite panel distinguishes", async () => {
  await reset();
  assert.deepEqual(await addFriend("73YVTZZZ"), [], "an unheard-of code is not found");
  assert.equal(await addFriend(friendCodeOf(ME)), null, "your own code is not an invitation");

  await addFriend(friendCodeOf(THEM));
  assert.equal(await addFriend(friendCodeOf(THEM)), null, "and twice is already a friend");
});

test("removing a friend removes it from both sides", async () => {
  await reset();
  await addFriend(friendCodeOf(THEM));

  const answer = await dispatch("friendrequests", "DRFriendRemove", [ME, [THEM], "token"]);

  assert.equal(answer.removed, 1);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), []);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [], "not left holding a friend");
});

test("blocking drops the friendship and is not visible to the blocked", async () => {
  await reset();
  await addFriend(friendCodeOf(THEM));

  const answer = await dispatch("friendrequests", "IgnoreFriend", [ME, THEM, "token"]);

  assert.equal(answer.blocked, true);
  assert.deepEqual(ignoredIdsOf(await loadAccount(ME)), [THEM]);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [], "and the friendship with it");
  assert.deepEqual(
    ignoredIdsOf(await loadAccount(THEM)),
    [],
    "the other account is not told anything"
  );

  const undo = await dispatch("friendrequests", "UnblockFriend", [ME, [THEM], "token"]);
  assert.equal(undo.unblocked, 1);
  assert.deepEqual(ignoredIdsOf(await loadAccount(ME)), []);
});

test("blocking yourself does nothing", async () => {
  await reset();
  const answer = await dispatch("friendrequests", "IgnoreFriend", [ME, ME, "token"]);
  assert.equal(answer.blocked, false);
  assert.deepEqual(ignoredIdsOf(await loadAccount(ME)), []);
});

test("accepting a pending request befriends, declining does not", async () => {
  await reset();
  // State 2 is the decline: `UIPending` logs DRFriendDecline against it.
  const declined = await dispatch("friendrequests", "DRFriendRequestUpdate", [
    ME,
    [1],
    [THEM],
    2,
    "token",
  ]);
  assert.equal(declined.accepted, 0);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), []);

  const accepted = await dispatch("friendrequests", "DRFriendRequestUpdate", [
    ME,
    [1],
    [THEM],
    1,
    "token",
  ]);
  assert.equal(accepted.accepted, 1);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [THEM]);
});

test("a report is taken and answered", async () => {
  const answer = await dispatch("report", "ReportPlayer", [
    {
      reportingPlayerId: ME,
      reportingPlayerName: "Me",
      reportedPlayerId: THEM,
      reportedPlayerName: "Them",
      reportReasons: ["CHEATING"],
      matchPlayers: [ME, THEM],
    },
  ]);
  // Recorded, not acted on: acting would be a way to take an account by
  // accusing it.
  assert.equal(answer.received, true);
});

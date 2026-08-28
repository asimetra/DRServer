import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Shapes here are the recorded responses of the official server, not guesses.
 * The failure they guard against is specific: before these handlers existed
 * every one of these calls fell through to the permissive empty-array reply,
 * and three of them are supposed to answer with an object — so the client was
 * indexing fields on an array.
 */
process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-social-"));

const { dispatch, hasHandler } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");

const ACCOUNT = 1000000005;
const FRIEND = 1000000006;
const IGNORED = 1000000007;

const withAccount = async (id, overrides = {}) => {
  const account = await loadAccount(id);
  Object.assign(account, overrides);
  await saveAccount(account);
  return account;
};

test("every social endpoint the client calls is registered, under its recorded service", async () => {
  // Not all of these live under the service you would guess, and a wrong path
  // is indistinguishable from a missing handler: both answer [].
  for (const [service, method] of [
    ["leaderboard", "getFriendRecord"],
    ["leaderboard", "getFriendData"],
    ["leaderboard", "getIgnoreFriendData"],
    ["friendrequests", "DRFriendRequestPending"],
    ["store", "GetAllGifts"],
    ["store", "GetLimitedOfferStatus"],
    ["championsboard", "getAllMapnodeScores"],
    ["championsboard", "getTopTwenty"],
    ["modrpc", "getmod"],
  ]) {
    assert.ok(hasHandler(service, method), `${service}/${method} is not registered`);
  }
});

test("the friend record carries the five fields the live one carries", async () => {
  await withAccount(ACCOUNT, {
    ingame_friends: JSON.stringify([FRIEND]),
    ignore_friends: JSON.stringify([IGNORED]),
  });

  const result = await dispatch("leaderboard", "getFriendRecord", [ACCOUNT, "token"]);

  assert.deepEqual(Object.keys(result).sort(), [
    "account_id",
    "friends_hash",
    "ignore_friends",
    "ingame_friends",
    "network_friends",
  ]);
  assert.equal(result.account_id, ACCOUNT);
  assert.equal(result.network_friends, null);
  assert.equal(result.friends_hash, null, "DBAccountInfo.parseFriendResponse only reads this");
  // The lists cross the wire as JSON strings, not arrays.
  assert.equal(typeof result.ingame_friends, "string");
  assert.deepEqual(JSON.parse(result.ingame_friends), [FRIEND]);
  assert.deepEqual(JSON.parse(result.ignore_friends), [IGNORED]);
});

test("friend data resolves against the accounts this server actually holds", async () => {
  await withAccount(FRIEND, { name: "Harrow", trophies: 126 });
  await withAccount(ACCOUNT, {
    // The second id is nobody: the official server answers about a population
    // this one does not have, so unknown ids are dropped rather than faked.
    ingame_friends: JSON.stringify([FRIEND, 1000000999]),
    ignore_friends: "[]",
  });

  const result = await dispatch("leaderboard", "getFriendData", [ACCOUNT, {}, "token"]);

  assert.equal(result.length, 1, "the stranger is not invented");
  /**
   * The last four are not read by this client and are here on purpose:
   * `FriendInfo` takes online state and the dungeon a friend is in from
   * `PresenceManager` over the socket, and builds its picture from a network
   * avatar rather than a URL. Anyone modding the client later looks here first,
   * so the same answers are written here too.
   */
  assert.deepEqual(Object.keys(result[0]).sort(), [
    "account_id",
    "active_skin",
    "avatar_url",
    "current_dungeon",
    "friend_code",
    "identifier",
    "is_ingame_friend",
    "is_online",
    "name",
    "trophies",
  ]);
  assert.equal(result[0].account_id, FRIEND);
  assert.equal(result[0].name, "Harrow");
  assert.equal(result[0].trophies, 126);
  assert.equal(result[0].is_ingame_friend, true);
  assert.equal(result[0].identifier, `3_${FRIEND}`, "network and account joined");
  assert.equal(result[0].is_online, false, "nobody is connected in a test");
  assert.equal(result[0].current_dungeon, 0, "so nobody is anywhere");
  assert.ok(result[0].friend_code, "and everyone has a code");
});

test("mod-facing friend JSON reports the live match host's current dungeon", async (t) => {
  const {
    clearPresence,
    enterPresence,
    setPresenceLocation,
  } = await import("../src/socket/presence.js");
  clearPresence();
  t.after(clearPresence);
  await withAccount(FRIEND, { name: "Harrow" });
  await withAccount(ACCOUNT, { ingame_friends: JSON.stringify([FRIEND]) });

  const connected = { accountId: FRIEND, send: () => {} };
  enterPresence(connected);
  setPresenceLocation({ member: connected }, 50082);

  const [row] = await dispatch("leaderboard", "getFriendData", [ACCOUNT, {}, "token"]);
  assert.equal(row.is_online, true);
  assert.equal(row.current_dungeon, 50082);
});

test("the ignore list is the same row with the flag turned round", async () => {
  await withAccount(IGNORED, { name: "Blocked" });
  await withAccount(ACCOUNT, {
    ingame_friends: "[]",
    ignore_friends: JSON.stringify([IGNORED]),
  });

  const result = await dispatch("leaderboard", "getIgnoreFriendData", [ACCOUNT, "token"]);

  assert.equal(result.length, 1);
  assert.equal(result[0].account_id, IGNORED);
  assert.equal(result[0].is_ingame_friend, false);
});

test("a missing or malformed friend list is an empty one, not a crash", async () => {
  await withAccount(ACCOUNT, { ingame_friends: undefined, ignore_friends: "not json" });

  const record = await dispatch("leaderboard", "getFriendRecord", [ACCOUNT, "token"]);
  assert.deepEqual(JSON.parse(record.ingame_friends), []);
  assert.deepEqual(JSON.parse(record.ignore_friends), []);

  assert.deepEqual(await dispatch("leaderboard", "getFriendData", [ACCOUNT, {}, "token"]), []);
});

test("the boards answer with their objects rather than a bare array", async () => {
  await withAccount(ACCOUNT, { ingame_friends: "[]" });

  const scores = await dispatch("championsboard", "getAllMapnodeScores", [ACCOUNT, [], "token"]);
  // parseScoreResponse reads both of these; a bare [] gave it neither.
  assert.ok(Array.isArray(scores.top_scores), "II_AccountTopScoreInfo reads top_scores");
  assert.ok(Array.isArray(scores.avatar_scores), "and the player's own avatar_scores");

  const top = await dispatch("championsboard", "getTopTwenty", [ACCOUNT, 50162, "token"]);
  assert.ok(Array.isArray(top), "the top twenty is a bare array");
});

test("the gift inbox answers with both fields the client reads", async () => {
  await withAccount(ACCOUNT, {});

  const result = await dispatch("store", "GetAllGifts", [ACCOUNT, "token"]);

  assert.ok(Array.isArray(result.gifts));
  assert.ok(Array.isArray(result.excludeIds), "offers the client should not send again");
});

test("moderation and limited offers answer empty, which is what the live server does", async () => {
  assert.deepEqual(await dispatch("modrpc", "getmod", [3]), []);
  assert.deepEqual(await dispatch("store", "GetLimitedOfferStatus", [ACCOUNT]), []);
  assert.deepEqual(
    await dispatch("friendrequests", "DRFriendRequestPending", [ACCOUNT, "token"]),
    []
  );
});

/**
 * `UIInvite` reads the answer as an outcome rather than as data, and there are
 * exactly four: null is "already a friend", an empty array is "not found" and
 * offers an email instead, false is "invite sent", and an object is "request
 * sent to X". So every edge case has somewhere to go without inventing a fifth.
 */
test("a friend code adds the person it names, and only them", async () => {
  const { friendCodeOf, accountIdFromCode, friendIdsOf } = await import("../src/social.js");

  await withAccount(FRIEND, { name: "Harrow", ingame_friends: "[]", ignore_friends: "[]" });
  await withAccount(ACCOUNT, { name: "Me", ingame_friends: "[]", ignore_friends: "[]" });

  // The code is derived from the id, so it round-trips and nothing allocates.
  const code = friendCodeOf({ id: FRIEND });
  assert.equal(accountIdFromCode(code), FRIEND, "a code names one account");
  assert.equal(accountIdFromCode(code.toLowerCase()), FRIEND, "however it is typed");

  const invite = (value) =>
    dispatch("friendrequests", "DRFriendRequest", [
      "Me", 0, 0, null, ACCOUNT, value, {}, "token",
    ]);

  // Nobody's code at all.
  assert.deepEqual(await invite("!!!!!!"), [], "an unreadable code is not found");
  assert.deepEqual(await invite(friendCodeOf({ id: 1_000_000_999 })), [], "nor a stranger's");

  /**
   * Your own. Answered as "already a friend" rather than "not found", because
   * "not found" opens a modal offering to email an invitation to your own
   * address — a worse thing to do to somebody who mistyped their own code.
   */
  assert.equal(await invite(friendCodeOf({ id: ACCOUNT })), null, "you cannot add yourself");

  // And the real thing, both ways at once.
  const sent = await invite(code);
  assert.equal(sent.to_account_id, FRIEND, "the request names who it reached");
  assert.equal(sent.name, "Harrow");

  const { loadAccount } = await import("../src/accounts.js");
  assert.deepEqual(friendIdsOf(await loadAccount(ACCOUNT)), [FRIEND], "mine has him");
  assert.deepEqual(friendIdsOf(await loadAccount(FRIEND)), [ACCOUNT], "and his has me");

  // Twice is not twice.
  assert.equal(await invite(code), null, "already a friend");
  assert.deepEqual(friendIdsOf(await loadAccount(ACCOUNT)), [FRIEND], "and not listed twice");
});

/**
 * Two accounts must never share a code, and the client does not check — it just
 * sends what was typed. The mapping is base 32 of the account id, which is
 * unique by construction, and this is here to keep it that way.
 */
test("a friend code names exactly one account", async () => {
  const { friendCodeOf, accountIdFromCode } = await import("../src/social.js");

  // Across the ranges accounts actually live in: legacy ids, the client-local
  // floor, and the range new account rows are allocated from.
  const seen = new Map();
  const lengths = new Set();
  for (const [from, to] of [
    [1, 20_000],
    [1_000_000_000, 1_000_020_000],
    [1_100_000_000, 1_100_020_000],
    [1_200_000_000, 1_200_020_000],
  ]) {
    for (let id = from; id < to; id++) {
      const code = friendCodeOf({ id });
      lengths.add(code.length);
      assert.equal(seen.has(code), false, `${code} would be both ${seen.get(code)} and ${id}`);
      seen.set(code, id);
      assert.equal(accountIdFromCode(code), id, `${code} reads back as ${id}`);
    }
  }
  assert.equal(seen.size, 80_000 - 1, "every id got its own");

  // Codes are 6 or 7 characters here; nothing depends on them being one length.
  assert.deepEqual([...lengths].sort(), [6, 7]);
});

/**
 * Base 32 runs out of exact arithmetic at eleven characters, and past it two
 * different codes read as the same number — which would be one code naming two
 * accounts, or two naming one.
 */
test("a code too long to count exactly is refused", async () => {
  const { accountIdFromCode, friendCodeOf } = await import("../src/social.js");

  assert.equal(accountIdFromCode("99999999999999"), null, "past exact arithmetic");
  assert.equal(accountIdFromCode("9999999999999A"), null, "and its twin");
  assert.equal(accountIdFromCode(""), null, "nothing names nobody");
  assert.equal(accountIdFromCode("AAAAAA"), null, "nor does zero");
  assert.equal(accountIdFromCode("hello!"), null, "nor does a word with no code in it");

  // What a real one does still works, however it is typed.
  const code = friendCodeOf({ id: 1_200_000_007 });
  assert.equal(accountIdFromCode(code), 1_200_000_007);
  assert.equal(accountIdFromCode(` ${code.toLowerCase()} `), 1_200_000_007, "spacing and case");
  assert.equal(accountIdFromCode(`AA${code}`), 1_200_000_007, "and one A too many is still him");
});

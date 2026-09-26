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
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-friends-"));

const { dispatch, hasHandler } = await import("../src/rpc.js");
await import("../src/rpc-handlers.js");
const { listAccountIds, loadAccount, loadExistingAccount, saveAccount } = await import("../src/accounts.js");
const {
  befriend,
  friendCodeOf,
  friendIdsOf,
  ignoredIdsOf,
  pendingFriendRequestsOf,
} = await import("../src/social.js");

const ME = 1000000005;
const THEM = 1000000006;

/** Both accounts exist and neither knows the other. */
const reset = async () => {
  for (const id of [ME, THEM]) {
    const account = await loadAccount(id);
    account.ingame_friends = "[]";
    account.ignore_friends = "[]";
    account.friend_requests = [];
    await saveAccount(account);
  }
};

const addFriend = (value) =>
  dispatch("friendrequests", "DRFriendRequest", ["Me", 0, 0, null, ME, value, {}, "token"]);

const acceptRequest = async () => {
  const [request] = await dispatch("friendrequests", "DRFriendRequestPending", [THEM, "token"]);
  assert.ok(request, "the recipient has no pending request to accept");
  return dispatch("friendrequests", "DRFriendRequestUpdate", [
    THEM,
    [request.id],
    [request.account_id],
    1,
    "token",
  ]);
};

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

test("a friend code typed into the invite box creates an approval request", async () => {
  await reset();
  const answer = await addFriend(friendCodeOf(THEM));

  assert.equal(answer.to_account_id, THEM, "the panel is told who it reached");
  assert.equal(answer.account_id, ME, "the request itself, as the live server answered");
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), []);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [], "a request is not a friendship");
  const [pending] = pendingFriendRequestsOf(await loadAccount(THEM));
  assert.equal(pending.account_id, ME);
  assert.equal(pending.name, `Player${ME}`);
});

test("an account id from the dungeon summary creates the same request", async () => {
  await reset();
  /**
   * `DistributedDungeonSummary.addFriend` sends `personId` as a number. Read as
   * a base 32 code it decodes to something in the trillions, which is a valid
   * code for an account nobody has — so this used to answer "not found".
   */
  const answer = await addFriend(THEM);

  assert.notDeepEqual(answer, [], "a number is an account, not a code");
  assert.equal(answer.to_account_id, THEM);
  assert.equal(pendingFriendRequestsOf(await loadAccount(THEM))[0].account_id, ME);
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
  assert.equal(pendingFriendRequestsOf(await loadAccount(THEM)).length, 1);
});

test("the outcomes the invite panel distinguishes", async () => {
  await reset();
  assert.deepEqual(await addFriend("73YVTZZZ"), [], "an unheard-of code is not found");
  assert.equal(await addFriend(friendCodeOf(ME)), null, "your own code is not an invitation");

  await addFriend(friendCodeOf(THEM));
  assert.equal(await addFriend(friendCodeOf(THEM)), null, "and the same request is not duplicated");
});

test("removing a friend removes it from both sides", async () => {
  await reset();
  await addFriend(friendCodeOf(THEM));
  await acceptRequest();

  const answer = await dispatch("friendrequests", "DRFriendRemove", [ME, [THEM], "token"]);

  assert.deepEqual(answer.map((row) => row.account_id), [THEM]);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), []);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [], "not left holding a friend");
});

test("blocking drops the friendship and is not visible to the blocked", async () => {
  await reset();
  await addFriend(friendCodeOf(THEM));
  await acceptRequest();

  const answer = await dispatch("friendrequests", "IgnoreFriend", [ME, THEM, "token"]);

  assert.equal(answer, `[${THEM}]`);
  assert.deepEqual(ignoredIdsOf(await loadAccount(ME)), [THEM]);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [], "and the friendship with it");
  assert.deepEqual(
    ignoredIdsOf(await loadAccount(THEM)),
    [],
    "the other account is not told anything"
  );

  const undo = await dispatch("friendrequests", "UnblockFriend", [ME, [THEM], "token"]);
  assert.ok(Array.isArray(undo), "the friend list, for refreshFriendData");
  assert.deepEqual(ignoredIdsOf(await loadAccount(ME)), []);
});

test("blocking yourself does nothing", async () => {
  await reset();
  const answer = await dispatch("friendrequests", "IgnoreFriend", [ME, ME, "token"]);
  assert.equal(answer, null);
  assert.deepEqual(ignoredIdsOf(await loadAccount(ME)), []);
});

test("accepting a pending request befriends, declining does not", async () => {
  await reset();
  await addFriend(THEM);
  let [request] = pendingFriendRequestsOf(await loadAccount(THEM));
  // A forged id cannot decline somebody else's request.
  const declined = await dispatch("friendrequests", "DRFriendRequestUpdate", [
    THEM,
    [request.id + 1],
    [ME],
    2,
    "token",
  ]);
  assert.deepEqual(declined, []);
  assert.equal(pendingFriendRequestsOf(await loadAccount(THEM)).length, 1, "still waiting");
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), []);

  // State 2 is the real decline: `UIPending` logs DRFriendDecline against it.
  const realDecline = await dispatch("friendrequests", "DRFriendRequestUpdate", [
    THEM, [request.id], [ME], 2, "token",
  ]);
  assert.deepEqual(realDecline, []);
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(THEM)), []);

  await addFriend(THEM);
  [request] = pendingFriendRequestsOf(await loadAccount(THEM));
  const accepted = await dispatch("friendrequests", "DRFriendRequestUpdate", [
    THEM,
    [request.id],
    [ME],
    1,
    "token",
  ]);
  assert.deepEqual(accepted.map((row) => row.account_id), [ME]);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [THEM]);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [ME]);
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(THEM)), []);
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

/**
 * What the client does with each answer, from its own code — so an answer that
 * compiles on this side and crashes the game on the other is caught here.
 *
 * `DBAccountInfo.addFriendCallback`, `removeFriendCallback` and
 * `refreshFriendData` each take the answer, and if it is truthy, treat it as an
 * array and read `.account_id` off every entry. An object there is `null` once
 * cast in the native build, and reading its length is a crash — which is what
 * accepting a request did.
 */
const clientReadsFriendRows = (answer, what) => {
  if (!answer) return;
  assert.ok(Array.isArray(answer), `${what}: the client casts this to an array`);
  for (const row of answer) {
    assert.ok(Number.isSafeInteger(Number(row?.account_id)), `${what}: every entry needs account_id`);
  }
};

/** The official friend row, as `getFriendData` recorded it. */
const OFFICIAL_FRIEND_ROW = ["account_id", "name", "trophies", "active_skin", "is_ingame_friend", "identifier"];

/** The official request row, as `DRFriendRequestPending` recorded it. */
const OFFICIAL_REQUEST_ROW = [
  "id", "name", "trophies", "active_skin", "facebook_id", "account_id", "to_account_id", "curr_state", "created",
];

const hasFields = (row, fields, what) => {
  for (const field of fields) assert.ok(field in row, `${what} has no ${field}`);
};

test("accepting answers with the new friends as friend rows, which UIPending hands to addFriendCallback", async () => {
  await reset();
  await addFriend(THEM);
  const [request] = pendingFriendRequestsOf(await loadAccount(THEM));
  const answer = await dispatch("friendrequests", "DRFriendRequestUpdate", [THEM, [request.id], [ME], 1, "token"]);
  clientReadsFriendRows(answer, "accept");
  assert.equal(answer.length, 1);
  assert.equal(answer[0].account_id, ME);
  assert.equal(answer[0].is_ingame_friend, true);
  hasFields(answer[0], OFFICIAL_FRIEND_ROW, "the accepted friend");
});

test("declining answers with nothing to add", async () => {
  await reset();
  await addFriend(THEM);
  const [request] = pendingFriendRequestsOf(await loadAccount(THEM));
  const answer = await dispatch("friendrequests", "DRFriendRequestUpdate", [THEM, [request.id], [ME], 2, "token"]);
  clientReadsFriendRows(answer, "decline");
  assert.deepEqual(answer, []);
});

test("removing answers with the removed friends, which removeFriendCallback takes off the list", async () => {
  await reset();
  await addFriend(THEM);
  await acceptRequest();
  const answer = await dispatch("friendrequests", "DRFriendRemove", [ME, [THEM], "token"]);
  clientReadsFriendRows(answer, "remove");
  assert.deepEqual(answer.map((row) => row.account_id), [THEM]);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), []);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), []);
  clientReadsFriendRows(await dispatch("friendrequests", "DRFriendRemove", [ME, [THEM], "token"]), "remove again");
});

test("unblocking answers with the friend list, which refreshFriendData reads", async () => {
  await reset();
  await dispatch("friendrequests", "IgnoreFriend", [ME, THEM, "token"]);
  const answer = await dispatch("friendrequests", "UnblockFriend", [ME, [THEM], "token"]);
  clientReadsFriendRows(answer, "unblock");
  assert.deepEqual(ignoredIdsOf(await loadAccount(ME)), []);
});

test("blocking answers with the block list as text, which the summary screen slices an id out of", async () => {
  await reset();
  const answer = await dispatch("friendrequests", "IgnoreFriend", [ME, THEM, "token"]);
  // DistributedDungeonSummary: length > 0, then `substr(1, length - 2)`.
  assert.equal(typeof answer, "string");
  assert.equal(answer, `[${THEM}]`);
  assert.equal(await dispatch("friendrequests", "IgnoreFriend", [ME, ME, "token"]), null, "nothing blocked");
});

test("a request answers with the request itself, in the recorded shape", async () => {
  await reset();
  const answer = await addFriend(THEM);
  hasFields(answer, OFFICIAL_REQUEST_ROW, "the request");
  assert.equal(answer.account_id, ME);
  assert.equal(answer.to_account_id, THEM);
  assert.equal(answer.curr_state, 0);
  const [pending] = await dispatch("friendrequests", "DRFriendRequestPending", [THEM, "token"]);
  hasFields(pending, OFFICIAL_REQUEST_ROW, "the pending request");
});

test("a request to somebody who has not asked you is only a request", async () => {
  await reset();
  await addFriend(THEM);
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [], "no friendship yet");
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), []);
  assert.equal(pendingFriendRequestsOf(await loadAccount(THEM)).length, 1, "it waits for them");
});

test("asking somebody who already asked you makes the friendship at once", async () => {
  await reset();
  // They asked first.
  await dispatch("friendrequests", "DRFriendRequest", ["Them", 0, 0, null, THEM, String(ME), {}, "token"]);
  const [theirs] = pendingFriendRequestsOf(await loadAccount(ME));
  assert.equal(theirs.account_id, THEM);

  const answer = await addFriend(THEM);
  // [[the new friend's row], the request that was waiting]. The live server put
  // the asker's own row first, which `addFriendCallback` then files under the
  // asker's own id: the new friend never reached the panel until a refetch.
  assert.ok(Array.isArray(answer) && answer.length === 2, "the two-part answer UIInvite.parseJson recognises");
  clientReadsFriendRows(answer[0], "the friendship's rows");
  assert.deepEqual(answer[0].map((row) => row.account_id), [THEM], "the friend the panel gains");
  hasFields(answer[0][0], OFFICIAL_FRIEND_ROW, "the friend row");
  hasFields(answer[1], OFFICIAL_REQUEST_ROW, "the request");
  assert.equal(answer[1].id, theirs.id);
  assert.equal(answer[1].account_id, THEM);
  assert.equal(answer[1].to_account_id, ME);

  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [THEM]);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [ME]);
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(ME)), [], "their request is used up");
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(THEM)), [], "and no second one is left behind");
});

/**
 * Friendships made and ended reach the other side's panel.
 *
 * The client learns of a new friend only one way: `PresenceManager.friendState`
 * saying somebody is online who is not on its list makes `friendlistUpdate`
 * fetch the list again. So the one who asked is told the one who accepted is
 * online, the moment it happens. An ended friendship stops presence both ways:
 * an ex-friend is no longer told where you are.
 */
const presence = await import("../src/socket/presence.js");
const { PacketReader } = await import("../src/socket/packet.js");

/** A connected player, recording every presence line it is told. */
const online = (accountId, presenceDoid) => {
  const told = [];
  const session = {
    accountId,
    presenceDoid,
    send: (frame) => {
      const reader = new PacketReader(Buffer.from(frame).subarray(2));
      reader.u16();
      if (reader.u32() !== presenceDoid || reader.u16() !== 188) return;
      told.push({ online: reader.u8() === 1, who: reader.u32(), where: reader.u32() });
    },
  };
  presence.enterPresence(session);
  return { session, told };
};

test("the one who asked is told of the new friend as soon as the request is accepted", async (t) => {
  await reset();
  presence.clearPresence();
  t.after(presence.clearPresence);
  const asker = online(ME, 701);
  online(THEM, 702);
  await addFriend(THEM);
  const [request] = pendingFriendRequestsOf(await loadAccount(THEM));
  await dispatch("friendrequests", "DRFriendRequestUpdate", [THEM, [request.id], [ME], 1, "token"]);
  assert.deepEqual(asker.told, [{ online: true, who: THEM, where: 0 }]);
  assert.equal(asker.session.watchedFriends.has(THEM), true, "and follows them from now on");
});

test("asking back makes the friendship and tells the first asker too", async (t) => {
  await reset();
  presence.clearPresence();
  t.after(presence.clearPresence);
  const first = online(THEM, 703);
  online(ME, 704);
  await dispatch("friendrequests", "DRFriendRequest", ["Them", 0, 0, null, THEM, String(ME), {}, "token"]);
  await addFriend(THEM);
  assert.deepEqual(first.told, [{ online: true, who: ME, where: 0 }]);
});

test("an ended friendship stops presence both ways", async (t) => {
  await reset();
  presence.clearPresence();
  t.after(presence.clearPresence);
  const me = online(ME, 705);
  const them = online(THEM, 706);
  await addFriend(THEM);
  const [request] = pendingFriendRequestsOf(await loadAccount(THEM));
  await dispatch("friendrequests", "DRFriendRequestUpdate", [THEM, [request.id], [ME], 1, "token"]);
  them.told.length = 0;

  await dispatch("friendrequests", "DRFriendRemove", [ME, [THEM], "token"]);
  assert.deepEqual(them.told, [{ online: false, who: ME, where: 0 }], "shown offline to the one removed");
  assert.equal(them.session.watchedFriends.has(ME), false);
  assert.equal(me.session.watchedFriends?.has(THEM) ?? false, false);

  // And no longer told where the other goes.
  them.told.length = 0;
  presence.setPresenceLocation(me.session, 50002);
  assert.deepEqual(them.told, []);
});

test("blocking ends it the same way", async (t) => {
  await reset();
  presence.clearPresence();
  t.after(presence.clearPresence);
  online(ME, 707);
  const them = online(THEM, 708);
  await addFriend(THEM);
  const [request] = pendingFriendRequestsOf(await loadAccount(THEM));
  await dispatch("friendrequests", "DRFriendRequestUpdate", [THEM, [request.id], [ME], 1, "token"]);
  them.told.length = 0;
  await dispatch("friendrequests", "IgnoreFriend", [ME, THEM, "token"]);
  assert.deepEqual(them.told, [{ online: false, who: ME, where: 0 }]);
  assert.equal(them.session.watchedFriends.has(ME), false);
});

/**
 * A block holds whichever way a friendship would otherwise come back: a new
 * request, one that was already waiting, or asking back.
 */
const requestFrom = (from, to) =>
  dispatch("friendrequests", "DRFriendRequest", ["", 0, 0, null, from, String(to), {}, "token"]);
const block = (owner, other) => dispatch("friendrequests", "IgnoreFriend", [owner, other, "token"]);
const accept = async (owner, requester) => {
  const waiting = pendingFriendRequestsOf(await loadAccount(owner)).find(
    (row) => Number(row.account_id) === requester
  );
  return dispatch("friendrequests", "DRFriendRequestUpdate", [
    owner, [waiting?.id ?? 1], [requester], 1, "token",
  ]);
};
const strangers = async () => {
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), [], "not friends");
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [], "not friends");
};

test("a blocked player's request reaches nobody, and looks sent", async () => {
  await reset();
  await block(ME, THEM);
  const answer = await requestFrom(THEM, ME);
  hasFields(answer, OFFICIAL_REQUEST_ROW, "what the blocked player sees");
  assert.equal(answer.to_account_id, ME);
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(ME)), [], "nothing waits for the blocker");
  await strangers();
});

test("the blocker asking the blocked makes nothing either", async () => {
  await reset();
  await block(ME, THEM);
  await requestFrom(ME, THEM);
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(THEM)), []);
  await strangers();
});

test("blocking clears the requests waiting between the two, both ways", async () => {
  await reset();
  await requestFrom(THEM, ME);
  await block(ME, THEM);
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(ME)), [], "theirs to me");
  assert.deepEqual(await accept(ME, THEM), [], "so there is nothing left to accept");
  await strangers();

  await reset();
  await requestFrom(ME, THEM);
  await block(ME, THEM);
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(THEM)), [], "and mine to them");
  assert.deepEqual(ignoredIdsOf(await loadAccount(THEM)), [], "without telling them of the block");
});

test("a request still held from before a block is neither shown nor accepted", async () => {
  await reset();
  await requestFrom(THEM, ME);
  // A block written before blocking cleared requests: the request survived it.
  const me = await loadAccount(ME);
  me.ignore_friends = `[${THEM}]`;
  await saveAccount(me);

  assert.deepEqual(await dispatch("friendrequests", "DRFriendRequestPending", [ME, "token"]), []);
  assert.deepEqual(await accept(ME, THEM), []);
  await strangers();
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(ME)), [], "used up rather than left");
  // Asking back is not a way round it either.
  const second = await loadAccount(ME);
  second.friend_requests = [{ id: 77, account_id: THEM, name: "Them" }];
  await saveAccount(second);
  await requestFrom(ME, THEM);
  await strangers();
});

test("befriending refuses a pair where either side has blocked the other", async () => {
  await reset();
  const me = await loadAccount(ME);
  me.ignore_friends = `[${THEM}]`;
  await saveAccount(me);
  assert.equal(await befriend(await loadAccount(THEM), await loadAccount(ME)), false);
  assert.equal(await befriend(await loadAccount(ME), await loadAccount(THEM)), false);
  await strangers();
});

/** Ids the client typed that no account holds. The first login makes an account; nothing else may. */
const NOBODY = [1999950101, 1999950102, 1999950103, 1999950104];

test("social calls naming an account nobody holds create no account", async () => {
  await reset();
  const before = new Set(await listAccountIds());
  const [first, second, third, fourth] = NOBODY;

  assert.equal(await block(ME, first), null, "nobody to block");
  assert.deepEqual(await dispatch("friendrequests", "DRFriendRemove", [ME, [second], "token"]), []);
  assert.deepEqual(
    await dispatch("friendrequests", "DRFriendRequestUpdate", [ME, [5], [third], 1, "token"]),
    []
  );
  // A request that is really held, from an account since gone.
  const me = await loadAccount(ME);
  me.friend_requests = [{ id: 88, account_id: fourth, name: "Gone" }];
  await saveAccount(me);
  assert.deepEqual(
    await dispatch("friendrequests", "DRFriendRequestUpdate", [ME, [88], [fourth], 1, "token"]),
    []
  );
  assert.deepEqual(pendingFriendRequestsOf(await loadAccount(ME)), [], "used up");
  assert.deepEqual(friendIdsOf(await loadAccount(ME)), []);

  const after = await listAccountIds();
  assert.deepEqual(after.filter((id) => !before.has(id)), [], "no account was made");
  for (const id of NOBODY) assert.equal(await loadExistingAccount(id), null);
});

test("removing somebody who is not a friend does not reach for their account", async () => {
  await reset();
  const them = await loadAccount(THEM);
  // One-sided, as a legacy import can leave it: they list me, I do not list them.
  them.ingame_friends = `[${ME}]`;
  await saveAccount(them);
  assert.deepEqual(await dispatch("friendrequests", "DRFriendRemove", [ME, [THEM], "token"]), []);
  assert.deepEqual(friendIdsOf(await loadAccount(THEM)), [ME], "their list is theirs");
});

test("an existing account reads the same through the no-create path", async () => {
  const account = await loadExistingAccount(ME);
  assert.equal(account.id, ME);
  assert.equal(await loadExistingAccount(0), null);
  assert.equal(await loadExistingAccount(-5), null);
  assert.equal(await loadExistingAccount("abc"), null);
});

test("rows for somebody who is not a friend say nothing of where they are", async (t) => {
  await reset();
  presence.clearPresence();
  t.after(presence.clearPresence);
  const them = online(THEM, 709);
  presence.setPresenceLocation(them.session, 50082);
  await requestFrom(ME, THEM);
  await accept(THEM, ME);

  const [removed] = await dispatch("friendrequests", "DRFriendRemove", [ME, [THEM], "token"]);
  assert.equal(removed.account_id, THEM);
  assert.deepEqual([removed.is_online, removed.current_dungeon], [false, 0], "an ex-friend");

  await block(ME, THEM);
  const [blockedRow] = await dispatch("leaderboard", "getIgnoreFriendData", [ME, "token"]);
  assert.equal(blockedRow.account_id, THEM);
  assert.deepEqual([blockedRow.is_online, blockedRow.current_dungeon], [false, 0], "a blocked player");
});

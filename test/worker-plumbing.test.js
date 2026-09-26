import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageChannel } from "node:worker_threads";

/**
 * The small pieces that let a match run in a worker, each on its own: doid
 * lanes, the account ownership policy, RPC forwarding, the presence copy, the
 * adopted match record and the request/answer channel.
 */
process.env.ODS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-worker-plumbing-"));

const { createDistributedObjectIdAllocator } = await import("../src/socket/doids.js");
const accounts = await import("../src/accounts.js");
const { dispatch, register, installRpcForwarder } = await import("../src/rpc.js");
const presence = await import("../src/socket/presence.js");
const { DungeonMatchRegistry } = await import("../src/socket/matches.js");
const { createWorkerChannel } = await import("../src/socket/worker-channel.js");

test("doid lanes never meet, and each skips the client's range in its own lane", () => {
  const stride = 5;
  const lanes = Array.from({ length: stride }, (_, offset) =>
    createDistributedObjectIdAllocator({ start: 999_000, offset, stride })
  );
  const seen = new Set();
  for (let round = 0; round < 400; round++) {
    lanes.forEach((allocate, offset) => {
      const doid = allocate();
      assert.equal(seen.has(doid), false, `doid ${doid} issued twice`);
      seen.add(doid);
      assert.equal((doid - 999_000) % stride, offset);
      assert.ok(doid < 1_000_000 || doid > 1_099_999, `${doid} is the client's`);
    });
  }
  assert.throws(() => createDistributedObjectIdAllocator({ offset: 2, stride: 2 }), /invalid doid offset/);
});

test("an account leased elsewhere cannot be locked, saved or read as live here", async (t) => {
  const leased = new Set([1000000201]);
  const previous = accounts.installAccountOwnership({
    lock: (id, work, local) => {
      if (leased.has(id)) throw new accounts.AccountLeasedError(id, 3);
      return local(id, work);
    },
    beforeSave: (ids) => {
      for (const id of ids) if (leased.has(id)) throw new accounts.AccountLeasedError(id, 3);
    },
    load: async (id) => (leased.has(id) ? { id, copy: true } : null),
  });
  t.after(() => accounts.installAccountOwnership(previous));

  await assert.rejects(accounts.withAccountLock(1000000201, async () => "ran"), (problem) =>
    problem instanceof accounts.AccountLeasedError && problem.owner === 3
  );
  assert.equal(await accounts.withAccountLock(1000000202, async () => "ran"), "ran");
  await assert.rejects(
    accounts.withTwoAccountLocks(1000000202, 1000000201, async () => "ran"),
    accounts.AccountLeasedError
  );
  await assert.rejects(accounts.saveAccount({ id: 1000000201 }), accounts.AccountLeasedError);
  assert.deepEqual(await accounts.loadAccount(1000000201), { id: 1000000201, copy: true });
});

test("a worker's object ids come from the thread that keeps the counter", {
  // Only in file mode is there a counter in a thread; PostgreSQL's sequence
  // serves every thread directly.
  skip: process.env.ODS_STORAGE === "postgres" && "the database sequence serves every thread",
}, async (t) => {
  const asked = [];
  const previous = accounts.installAccountOwnership({
    nextObjectIdAbove: async (floor) => {
      asked.push(floor);
      return 1_234_567_890;
    },
  });
  t.after(() => accounts.installAccountOwnership(previous));
  assert.equal(await accounts.nextObjectId({ items: [{ id: 1_200_000_500 }] }), 1_234_567_890);
  assert.deepEqual(asked, [1_200_000_500]);
});

test("an RPC is sent to the worker holding its account, or holding the other one it reaches for", async (t) => {
  register("test/own", async ([accountId]) => `ran here for ${accountId}`);
  register(
    "test/pair",
    async ([accountId, otherId]) =>
      accounts.withTwoAccountLocks(accountId, otherId, async () => "ran here"),
    { locks: false }
  );
  const forwarded = [];
  const previousOwnership = accounts.installAccountOwnership({
    lock: (id, work, local) => {
      if (id === 1000000302) throw new accounts.AccountLeasedError(id, 1);
      return local(id, work);
    },
  });
  const previousForwarder = installRpcForwarder({
    ownerOf: (accountId) => (accountId === 1000000301 ? "worker-0" : null),
    forward: async (owner, service, method, params, details) => {
      forwarded.push({ owner, key: `${service}/${method}`, ...details });
      return "ran there";
    },
  });
  t.after(() => {
    accounts.installAccountOwnership(previousOwnership);
    installRpcForwarder(previousForwarder);
  });

  assert.equal(await dispatch("test", "own", [1000000301]), "ran there");
  assert.equal(await dispatch("test", "own", [1000000303]), "ran here for 1000000303");
  assert.equal(await dispatch("test", "pair", [1000000303, 1000000302]), "ran there");
  // Forwarded calls run where they land, whatever that thread's policy says.
  assert.equal(await dispatch("test", "own", [1000000301], null, { forwarded: true }), "ran here for 1000000301");
  assert.deepEqual(forwarded, [
    { owner: "worker-0", key: "test/own", accountId: 1000000301, own: true },
    { owner: 1, key: "test/pair", accountId: 1000000302, own: false },
  ]);
});

test("presence tells an observer every change and a copy answers from what it was told", (t) => {
  const seen = [];
  const previous = presence.observePresence((accountId, where) => seen.push([accountId, where]));
  t.after(() => {
    presence.observePresence(previous);
    presence.clearPresence();
  });
  const session = { accountId: 1000000401, send: () => {} };
  presence.enterPresence(session);
  presence.setPresenceLocation(session, 50002);
  presence.leavePresence(session);
  assert.deepEqual(seen, [
    [1000000401, 0],
    [1000000401, 50002],
    [1000000401, null],
  ]);

  presence.mirrorPresence(1000000402, 50010);
  assert.equal(presence.isOnline(1000000402), true);
  assert.equal(presence.dungeonOf(1000000402), 50010);
  presence.mirrorPresence(1000000402, null);
  assert.equal(presence.isOnline(1000000402), false);
});

test("an adopted match keeps its id, stays out of public search, and closes when emptied", () => {
  const registry = new DungeonMatchRegistry();
  const match = registry.adopt({ id: 77, mapNodeId: 50002, floorIndex: 2 });
  assert.equal(registry.adopt({ id: 77, mapNodeId: 1 }), match, "adopted once");
  assert.equal(match.state, "active");
  assert.equal(match.floorIndex, 2);
  const member = { id: 1, accountId: 1000000501 };
  registry.attach(match, member, { privileged: true });
  assert.equal(member.dungeonMatch, match);
  assert.equal(match.privilegedMembers.has(member), true);
  assert.equal(registry.publicMatch({ mapNodeId: 50002 }), undefined);
  assert.equal(registry.explicitTarget({ friendId: 1000000501 }), match);
  registry.remove(member);
  assert.equal(match.state, "closed");
  assert.equal(registry.matches.has(77), false);
});

test("a channel answers calls both ways and rebuilds a leased-account refusal", async (t) => {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  const flushed = [];
  const one = createWorkerChannel({
    port: port1,
    handle: async (op, args) => {
      if (op === "double") return args * 2;
      throw new accounts.AccountLeasedError(args, 4);
    },
    beforePost: () => flushed.push("one"),
  });
  const other = [];
  const two = createWorkerChannel({
    port: port2,
    handle: async () => "unused",
    onMessage: (message) => other.push(message),
  });
  port1.on("message", one.receive);
  port2.on("message", two.receive);

  assert.equal(await two.call("double", 21), 42);
  await assert.rejects(two.call("refuse", 1000000601), (problem) =>
    problem instanceof accounts.AccountLeasedError && problem.accountId === 1000000601 && problem.owner === 4
  );
  one.post({ t: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(other, [{ t: "hello" }]);
  assert.ok(flushed.length >= 3, "every post from that side flushed first");
});

test("a read whose account is leased before it can save answers with the live object", async (t) => {
  // The read found no account and made one; by the time it saves, a worker
  // holds the account. What it answers with is the worker's object, not the
  // one it made — that one never existed anywhere else.
  const leased = 1000000240;
  const live = { id: leased, live: true };
  let asked = 0;
  const previous = accounts.installAccountOwnership({
    lock: (id, work, local) => local(id, work),
    // Not yet held there when the read starts; held by the time it saves.
    load: async (id) => (id === leased && asked++ > 0 ? live : null),
    inPlayElsewhere: (id) => id === leased,
    beforeSave: (ids) => {
      for (const id of ids) if (id === leased) throw new accounts.AccountLeasedError(id, 2);
    },
  });
  t.after(() => accounts.installAccountOwnership(previous));
  assert.equal(await accounts.loadAccount(leased), live);
});

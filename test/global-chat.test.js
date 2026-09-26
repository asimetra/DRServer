import assert from "node:assert/strict";
import test from "node:test";

import { PacketReader } from "../src/socket/packet.js";
import { enterPresence, leavePresence } from "../src/socket/presence.js";
import {
  admitGlobalLine,
  deliverGlobalLine,
  forgetGlobalAllowances,
  sayGlobally,
} from "../src/socket/global-chat.js";

// Every test starts with a full allowance; see the rate tests at the end.
test.beforeEach(() => forgetGlobalAllowances());

/**
 * A player on a floor, as the global channel sees one.
 *
 * `world.contextFor` is the shape a real session has once it is in a dungeon;
 * outside one there is no context and no objects to speak through, which is
 * exactly the case that must not be spoken to.
 */
const playerOn = (accountId, name, { onFloor = true } = {}) => {
  const sent = [];
  const context = {
    id: accountId,
    accountId,
    dungeonAccount: { id: accountId, name },
    playerDoid: accountId,
    floorDoid: onFloor ? 400 : null,
    areaDoid: 300,
    dungeonZone: 10,
    objects: new Map(),
    speakers: new Map(),
    sent,
    announced: [],
    allocateDoid: (() => {
      let next = accountId * 10;
      return () => ++next;
    })(),
    sendDirect: (frame) => sent.push(frame),
    broadcast: (frame) => context.announced.push(frame),
  };
  const connection = { accountId, world: { contextFor: () => context } };
  connection.context = context;
  return connection;
};

const spoken = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  reader.u16();
  reader.u32();
  reader.u16();
  return reader.utf();
};

const withPresence = (connections, body) => {
  for (const connection of connections) enterPresence(connection);
  try {
    return body();
  } finally {
    for (const connection of connections) leavePresence(connection);
  }
};

test("a line reaches people in other dungeons", () => {
  const speaker = playerOn(1, "Simetra");
  const far = playerOn(2, "Beacon");

  withPresence([speaker, far], () => {
    assert.equal(sayGlobally(speaker.context, "anyone about?"), 1);
  });

  assert.equal(spoken(far.context.sent[0]), "Simetra: anyone about?");
});

/**
 * Their own client drew the line the moment they pressed enter — the same local
 * echo ordinary chat relies on — so sending it back would double it.
 */
test("but not back to whoever said it", () => {
  const speaker = playerOn(1, "Simetra");

  withPresence([speaker], () => {
    assert.equal(sayGlobally(speaker.context, "hello?"), 0, "nobody else heard it");
  });
  assert.equal(speaker.context.sent.length, 0);
});

/**
 * The client only builds its chat log on a floor. Somebody at a loading screen
 * has nowhere to put a line, and counting it as delivered would tell the
 * speaker they were heard when they were not.
 */
test("somebody who is not on a floor is not counted as having heard", () => {
  const speaker = playerOn(1, "Simetra");
  const loading = playerOn(2, "Beacon", { onFloor: false });

  withPresence([speaker, loading], () => {
    assert.equal(sayGlobally(speaker.context, "anyone?"), 0);
  });
  assert.equal(loading.context.sent.length, 0);
});

/**
 * The reason speech.js exists. A player in another dungeon has no object on
 * your client, so there is no name for a line to be attributed to until one is
 * made — and it is made once, not once per sentence.
 */
test("a distant speaker is given a voice on your floor, once", () => {
  const speaker = playerOn(1, "Simetra");
  const far = playerOn(2, "Beacon");

  withPresence([speaker, far], () => {
    sayGlobally(speaker.context, "first");
    sayGlobally(speaker.context, "second");
  });

  assert.equal(far.context.announced.length, 1, "one player object, not two");
  assert.equal(far.context.sent.length, 2, "but both lines");
  assert.equal(spoken(far.context.sent[1]), "Simetra: second");
});

test("everyone on a floor hears it", () => {
  const speaker = playerOn(1, "Simetra");
  const others = [playerOn(2, "Beacon"), playerOn(3, "Thistle"), playerOn(4, "Marrow")];

  withPresence([speaker, ...others], () => {
    assert.equal(sayGlobally(speaker.context, "hello all"), 3);
  });
  for (const other of others) {
    assert.equal(spoken(other.context.sent[0]), "Simetra: hello all");
  }
});

test("an unnamed account still has a name to speak under", () => {
  const speaker = playerOn(7, undefined);
  speaker.context.dungeonAccount = null;
  const far = playerOn(2, "Beacon");

  withPresence([speaker, far], () => sayGlobally(speaker.context, "hm"));
  assert.match(spoken(far.context.sent[0]), /^Player7: /);
});

/**
 * A listener who has blocked the speaker does not hear them. The line comes
 * from a server-made speaker object, so the client has nothing to filter by —
 * and its block list is read only by the blocked panel anyway.
 */
test("somebody who blocked the speaker does not hear them", () => {
  const speaker = playerOn(1, "Simetra");
  const blocker = playerOn(2, "Beacon");
  blocker.context.dungeonAccount.ignore_friends = "[1]";
  const other = playerOn(3, "Quill");

  const heard = deliverGlobalLine({ account: 1, name: "Simetra", text: "hello" }, [blocker, other]);
  assert.equal(heard, 1);
  assert.deepEqual(blocker.context.sent, []);
  assert.equal(spoken(other.context.sent.at(-1)), "Simetra: hello");
});

/** Three lines at once, then one every two seconds; the rest is not said. */
test("the global channel allows three lines at once and one every two seconds after", () => {
  const at = 1_000_000;
  assert.deepEqual([0, 1, 2, 3].map(() => admitGlobalLine(7, at)), [true, true, true, false]);
  assert.equal(admitGlobalLine(7, at + 1_999), false);
  assert.equal(admitGlobalLine(7, at + 2_000), true);
  assert.equal(admitGlobalLine(8, at), true, "and each account has its own");
});

test("a line over the allowance reaches nobody, and the speaker is told", () => {
  const speaker = playerOn(1, "Simetra");
  const far = playerOn(2, "Beacon");
  withPresence([speaker, far], () => {
    for (let line = 0; line < 3; line++) assert.equal(sayGlobally(speaker.context, `line ${line}`), 1);
    assert.equal(sayGlobally(speaker.context, "one too many"), null, "refused, not unheard");
  });
  assert.equal(far.context.sent.filter((frame) => spoken(frame).endsWith("one too many")).length, 0);
});

test("with match workers, the allowance is kept on the main thread", async () => {
  const { MatchWorkerPool } = await import("../src/socket/match-worker-pool.js");
  const asked = [];
  const pool = { workers: [{ alive: true, channel: { call: async (op, args) => asked.push(args) && 1 } }] };
  const say = (text) => MatchWorkerPool.prototype.sayEverywhere.call(pool, { account: 9, name: "N", text });
  for (let line = 0; line < 3; line++) assert.equal(await say(`line ${line}`), 1);
  assert.equal(await say("one too many"), null);
  assert.equal(asked.length, 3, "the fourth never reached a worker");
});

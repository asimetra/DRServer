import assert from "node:assert/strict";
import test from "node:test";

import { updateProximityTriggers } from "../src/socket/triggers.js";
import { transitionsOf } from "../src/socket/session-transitions.js";

/**
 * A threshold is a place you can stand, which is the whole difficulty. The
 * proximity trigger fires once on entry, but a slow or refused transition
 * leaves the player standing in the doorway, and without a guard a stutter
 * becomes two entries.
 */
const sessionAt = (triggers) => {
  const session = {
    id: 4,
    heroDoid: 500,
    playerDoid: 70,
    matchMakerDoid: 9,
    actors: new Map([[500, { position: { x: 0, y: 0 }, collisionRadius: 20 }]]),
    triggers,
    sent: [],
    crossings: [],
    sendDirect: () => {},
    send: () => {},
  };
  return session;
};

const doorway = (extra = {}) => ({
  id: "door",
  constant: "PROXIMITY_TRIGGER",
  x: 500,
  y: 500,
  radius: 100,
  destination: 50009,
  ...extra,
});

test("a crossing asks once, for the place the door names", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const session = { id: 7, matchMakerDoid: 9, send: () => {} };
  const asked = [];

  const crossed = await walkThrough(session, 50009, {
    check: async () => null,
    admit: async (_, request) => {
      asked.push(request.mapNodeId);
      return { match: { mapNodeId: request.mapNodeId } };
    },
    join: async (_session, _result, _request, options) => options.onPlayerReady(),
  });

  assert.equal(crossed, true);
  assert.deepEqual(asked, [50009]);
  assert.equal(transitionsOf(session).current, null, "and the crossing is over");
});

/**
 * Standing in a doorway is not walking through it twice. The proximity loop
 * latches on entry and does nothing while you remain inside, which is what
 * keeps a stutter from becoming two entries — tested without a destination so
 * that this is about the loop and not about a dungeon.
 */
test("the loop fires a threshold on entry and not while you stand in it", () => {
  const session = sessionAt([doorway({ destination: undefined, chatText: "A gap." })]);
  let entries = 0;
  session.sendDirect = () => entries++;

  updateProximityTriggers(session, { x: 480, y: 500 });
  updateProximityTriggers(session, { x: 490, y: 505 });
  updateProximityTriggers(session, { x: 495, y: 500 });
  assert.equal(entries, 1, "once");

  updateProximityTriggers(session, { x: 4000, y: 4000 });
  updateProximityTriggers(session, { x: 480, y: 500 });
  assert.equal(entries, 2, "and again when you come back");
});

test("one party member leaving a proximity zone does not release another member", () => {
  const trigger = doorway({ destination: undefined, chatText: "A shared threshold." });
  const heard = [];
  const actors = new Map([
    [501, { position: { x: 480, y: 500 }, collisionRadius: 20 }],
    [502, { position: { x: 490, y: 500 }, collisionRadius: 20 }],
  ]);
  const shared = {
    actors,
    playerActors: new Set([501, 502]),
    triggers: [trigger],
    signalValues: new Map(),
    signalTargets: new Map(),
    send: () => {},
  };
  const first = {
    ...shared,
    id: 51,
    heroDoid: 501,
    playerDoid: 601,
    sendDirect: () => heard.push(501),
  };
  const second = {
    ...shared,
    id: 52,
    heroDoid: 502,
    playerDoid: 602,
    sendDirect: () => heard.push(502),
  };

  updateProximityTriggers(first, actors.get(501).position);
  updateProximityTriggers(second, actors.get(502).position);
  assert.equal(trigger.on, true);
  assert.deepEqual(heard, [501, 502], "each entrant receives its per-member event");

  actors.get(501).position = { x: 4000, y: 4000 };
  updateProximityTriggers(first, actors.get(501).position);
  assert.equal(trigger.on, true, "the second hero still holds the shared zone high");
  assert.equal(shared.signalValues.get(trigger.id), true);

  actors.get(502).position = { x: 4000, y: 4000 };
  updateProximityTriggers(second, actors.get(502).position);
  assert.equal(trigger.on, false);
  assert.equal(shared.signalValues.get(trigger.id), false);
});

/**
 * A refusal is answered the way a refused map click is, so the client shows the
 * popup it already owns rather than leaving somebody standing in a doorway that
 * does nothing.
 */
test("a refused crossing is answered, not swallowed", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const sent = [];
  const session = { id: 8, matchMakerDoid: 9, send: (frame) => sent.push(frame) };

  const crossed = await walkThrough(session, 50009, {
    check: async () => null,
    admit: async () => ({ match: null, error: "map_full", source: "map" }),
    join: async () => {
      throw new Error("a refused crossing must not join anything");
    },
  });

  assert.equal(crossed, false);
  assert.equal(sent.length, 1, "the client is told");
  assert.equal(transitionsOf(session).current, null, "and the doorway is usable again");
});

test("a failed doorway join does not replace the connection's matchmaking cohort", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const session = {
    id: 18,
    accountId: 18,
    matchMakerDoid: 19,
    matchMakerGroup: "stable-group",
    send: () => {},
  };

  assert.equal(
    await walkThrough(session, 50009, {
      check: async () => null,
      admit: async () => ({ match: { mapNodeId: 50009, group: "failed-group" } }),
      join: async () => {
        throw new Error("fixture join failed");
      },
    }),
    false
  );
  assert.equal(session.matchMakerGroup, "stable-group");
});

/**
 * The crossing belongs to the connection rather than the floor context,
 * because a successful crossing takes the floor — and its triggers — away,
 * and a second context on the same connection is the same player.
 */
test("one crossing at a time, held where it outlives the floor", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const connection = { id: 5, matchMakerDoid: 9, send: () => {} };
  let answer;
  const first = walkThrough({ id: 5, member: connection }, 50009, {
    check: () => new Promise((resolve) => {
      answer = resolve;
    }),
  });
  const untouched = () => assert.fail("a crossing already under way began another");

  assert.equal(
    await walkThrough({ id: 5, member: connection }, 50009, {
      check: untouched, leave: untouched, admit: untouched, join: untouched,
    }),
    false,
    "already crossing"
  );
  assert.equal(transitionsOf(connection).phase, "checking", "and the first crossing still holds it");
  answer("content_not_completed");
  assert.equal(await first, false);
  assert.equal(transitionsOf(connection).current, null);
});

test("a door to somewhere this hero may not go leaves them where they stand", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const sent = [];
  const connection = { id: 8, matchMakerDoid: 9, send: (frame) => sent.push(frame) };
  const untouched = () => assert.fail("the old floor was touched for a door that goes nowhere");

  for (const refusal of ["content_not_completed", "bad_map_node"]) {
    const crossed = await walkThrough({ id: 8, member: connection }, 50009, {
      check: async () => refusal,
      leave: untouched,
      admit: untouched,
      join: untouched,
    });
    assert.equal(crossed, false);
  }
  assert.deepEqual(sent, [], "nothing said on the old floor that would read as an entry");
  assert.equal(transitionsOf(connection).current, null, "and the doorway can be tried again");
});

test("a locked door is said so on the floor, and the crossing is never asked for", async () => {
  const { crossDoor } = await import("../src/socket/triggers.js");
  const told = [];
  const session = { id: 9, accountId: 1, playerDoid: 70, sendDirect: (frame) => told.push(frame) };
  const crossed = await crossDoor(session, 50009, {
    check: async () => "content_not_completed",
    walkThrough: () => assert.fail("asked to cross a locked door"),
  });
  assert.equal(crossed, false);
  assert.equal(told.length, 1, "one line, to the one who walked into it");

  const open = await crossDoor(session, 50009, {
    check: async () => null,
    walkThrough: async () => true,
  });
  assert.equal(open, true);
});

test("a destination that is not a place is refused before anything else", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const session = { id: 6, matchMakerDoid: 9, send: () => {} };

  assert.equal(await walkThrough(session, 0), false);
  assert.equal(await walkThrough(session, "nowhere"), false);
  assert.equal(await walkThrough(session, -1), false);
  assert.equal(transitionsOf(session).generation, 0, "and nothing was begun");
});

test("a refusal raised once the new run holds the account keeps its own message", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const { EntryRefusedError } = await import("../src/socket/match-entry.js");
  const { ENTRY_ERROR } = await import("../src/socket/matchmaker.js");
  const { PacketReader } = await import("../src/socket/packet.js");
  const sent = [];
  const session = { id: 10, matchMakerDoid: 9, send: (frame) => sent.push(frame) };
  const crossed = await walkThrough(session, 50009, {
    check: async () => null,
    leave: async () => {},
    admit: async () => ({ match: { mapNodeId: 50009 } }),
    join: async () => {
      throw new EntryRefusedError("content_not_completed");
    },
  });
  assert.equal(crossed, false);
  const reader = new PacketReader(sent.at(-1).subarray(2));
  reader.u16();
  reader.u32();
  reader.u16();
  assert.equal(reader.u16(), ENTRY_ERROR.UNAUTHORIZED_MAP);
});

import assert from "node:assert/strict";
import test from "node:test";

import { updateProximityTriggers } from "../src/socket/triggers.js";

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
    resolve: async (_, request) => {
      asked.push(request.mapNodeId);
      return { match: { mapNodeId: request.mapNodeId } };
    },
    join: async () => {},
  });

  assert.equal(crossed, true);
  assert.deepEqual(asked, [50009]);
  assert.equal(session.walkingThrough, false, "and the guard is released");
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
    resolve: async () => ({ match: null, error: "map_full", source: "map" }),
    join: async () => {
      throw new Error("a refused crossing must not join anything");
    },
  });

  assert.equal(crossed, false);
  assert.equal(sent.length, 1, "the client is told");
  assert.equal(session.walkingThrough, false, "and the doorway is usable again");
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
      resolve: async () => ({ match: { mapNodeId: 50009, group: "failed-group" } }),
      join: async () => {
        throw new Error("fixture join failed");
      },
    }),
    false
  );
  assert.equal(session.matchMakerGroup, "stable-group");
});

/**
 * The guard lives on the connection rather than the floor context, because a
 * successful crossing takes the floor — and its triggers — away. Clearing it on
 * something that no longer exists would leave the flag set forever.
 */
test("the crossing guard is held where it outlives the floor", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const connection = { id: 5, matchMakerDoid: 9, send: () => {}, walkingThrough: true };
  const context = { id: 5, member: connection };

  assert.equal(await walkThrough(context, 50009), false, "already crossing");
});

test("a destination that is not a place is refused before anything else", async () => {
  const { walkThrough } = await import("../src/socket/doors.js");
  const session = { id: 6, matchMakerDoid: 9, send: () => {} };

  assert.equal(await walkThrough(session, 0), false);
  assert.equal(await walkThrough(session, "nowhere"), false);
  assert.equal(await walkThrough(session, -1), false);
  assert.equal(session.walkingThrough, undefined, "and nothing was begun");
});

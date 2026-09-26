import test from "node:test";
import assert from "node:assert/strict";

import { SessionTransitions, transitionsOf } from "../src/socket/session-transitions.js";
import { DungeonMatchRegistry } from "../src/socket/matches.js";
import { EntryRefusedError } from "../src/socket/match-entry.js";
import { ENTRY_ERROR, FLID } from "../src/socket/entry-protocol.js";
import { PacketReader } from "../src/socket/packet.js";

/**
 * One connection, one transition at a time: the phases it passes through, and
 * what happens when an exit, a door or a disconnect meets one under way.
 * Admission is a real registry's; the run is a stand-in the test drives.
 */
let nextId = 1000001000;
const connect = () => {
  const sent = [];
  return { id: nextId, accountId: nextId++, matchMakerDoid: 9, sent, send: (frame) => sent.push(frame) };
};

const answersIn = ({ sent }) =>
  sent.map((frame) => {
    const reader = new PacketReader(frame.subarray(2));
    reader.u16();
    reader.u32();
    const field = reader.u16();
    return field === FLID.ClientExitComplete ? "exit" : `entry:${reader.u16()}`;
  });

const gate = () => {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** A run the test lets through step by step, leaving as the registry's leave does. */
const stage = (registry) => {
  const steps = { admitted: gate(), joined: gate() };
  const calls = [];
  const executor = {
    join: async (session, reservation, request, { onPlayerReady }) => {
      calls.push("join");
      onPlayerReady();
      await steps.joined.promise;
    },
    leave: async (session, { notifyClient = false } = {}) => {
      calls.push(notifyClient ? "leave:notify" : "leave:quiet");
      registry.remove(session);
    },
  };
  const admit = async (session, request) => {
    await steps.admitted.promise;
    return registry.reserve({ session, mapNodeId: request.mapNodeId || 50002 });
  };
  return { steps, calls, executor, admit };
};

test("an entry passes admitting and loading, and is active once its reservation is used", async () => {
  const registry = new DungeonMatchRegistry();
  const { steps, executor, admit } = stage(registry);
  const session = connect();
  const transitions = transitionsOf(session);
  assert.equal(transitions.phase, "town");

  const entering = transitions.requestEntry({ mapNodeId: 50002 }, { admit, executor });
  assert.equal(transitions.phase, "admitting");
  steps.admitted.open();
  while (transitions.phase === "admitting") await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transitions.phase, "loading");
  steps.joined.open();
  assert.equal(await entering, true);

  assert.equal(transitions.phase, "active");
  assert.deepEqual(answersIn(session), ["entry:0"]);
  assert.equal(registry.matchByAccount.get(session.accountId).members.has(session), true);
});

test("nothing begins while an entry is under way, and a second entry is refused", async () => {
  const registry = new DungeonMatchRegistry();
  const { steps, executor, admit } = stage(registry);
  const session = connect();
  const transitions = transitionsOf(session);
  const entering = transitions.requestEntry({ mapNodeId: 50002 }, { admit, executor });

  assert.equal(transitions.requestEntry({ mapNodeId: 50002 }, { admit, executor }), null);
  assert.equal(await transitions.walkThrough(50009, { check: () => assert.fail("door during an entry") }), false);
  assert.deepEqual(answersIn(session), [`entry:${ENTRY_ERROR.GAME_NOT_ENTERABLE}`]);
  steps.admitted.open();
  steps.joined.open();
  await entering;
});

test("a disconnect during admission gives the reserved place back and says nothing", async () => {
  const registry = new DungeonMatchRegistry();
  const { steps, calls, executor, admit } = stage(registry);
  const session = connect();
  const transitions = transitionsOf(session);
  const entering = transitions.requestEntry({ mapNodeId: 50002 }, { admit, executor });

  transitions.disconnect({ executor });
  steps.admitted.open();
  assert.equal(await entering, false);

  assert.deepEqual(calls, ["leave:quiet"], "never joined");
  assert.equal(registry.matchByAccount.get(session.accountId), undefined, "the reservation was aborted");
  assert.equal(registry.matches.size, 0, "and the match it made closed with it");
  assert.deepEqual(answersIn(session), []);
});

test("an exit that cancels an entry holds the connection until that entry has finished", async () => {
  const registry = new DungeonMatchRegistry();
  const { steps, executor, admit } = stage(registry);
  const session = connect();
  const transitions = transitionsOf(session);
  transitions.requestEntry({ mapNodeId: 50002 }, { admit, executor });
  steps.admitted.open();
  while (transitions.phase !== "loading") await new Promise((resolve) => setImmediate(resolve));

  const exiting = transitions.requestExit({ executor });
  while (!answersIn(session).includes("exit")) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transitions.requestEntry({ mapNodeId: 50002 }, { admit, executor }), null, "refused while it finishes");

  steps.joined.open();
  await exiting;
  await transitions.idle();
  assert.equal(transitions.phase, "town");
  assert.deepEqual(answersIn(session), ["entry:0", "exit", `entry:${ENTRY_ERROR.GAME_NOT_ENTERABLE}`]);
  assert.equal(registry.matches.size, 0);
});

test("an exit during a door crossing: the exit answers and the door goes nowhere", async () => {
  const registry = new DungeonMatchRegistry();
  const { executor } = stage(registry);
  const session = connect();
  registry.reserve({ session, mapNodeId: 50002 }).reservation.commit();
  const transitions = transitionsOf(session);
  assert.equal(transitions.phase, "active");

  const asked = gate();
  const crossing = transitions.walkThrough(50009, {
    check: () => asked.promise,
    admit: () => assert.fail("admitted after the exit"),
    join: executor.join,
    leave: executor.leave,
  });
  assert.equal(transitions.phase, "checking");
  const exiting = transitions.requestExit({ executor });
  asked.open(null);

  assert.equal(await crossing, false);
  await exiting;
  assert.deepEqual(answersIn(session), ["exit"]);
  assert.equal(transitions.phase, "town");
  assert.equal(registry.matches.size, 0);
});

test("a refusal once the account is held tears down, gives the place back, and names the reason", async () => {
  const registry = new DungeonMatchRegistry();
  const { calls, admit, steps } = stage(registry);
  steps.admitted.open();
  const executor = {
    join: async () => {
      throw new EntryRefusedError("content_not_completed");
    },
    leave: async (session, { notifyClient = false } = {}) => {
      calls.push(notifyClient ? "leave:notify" : "leave:quiet");
    },
  };
  const session = connect();
  const transitions = transitionsOf(session);
  assert.equal(await transitions.requestEntry({ mapNodeId: 50002 }, { admit, executor }), false);

  assert.deepEqual(calls, ["leave:notify"]);
  assert.equal(registry.matchByAccount.get(session.accountId), undefined, "aborted even though leave did not remove it");
  assert.deepEqual(answersIn(session), [`entry:${ENTRY_ERROR.UNAUTHORIZED_MAP}`]);
});

test("a floor context and its connection share one controller", () => {
  const connection = connect();
  assert.equal(transitionsOf({ member: connection }), transitionsOf(connection));
  assert.ok(transitionsOf(connection) instanceof SessionTransitions);
});

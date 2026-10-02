import assert from "node:assert/strict";
import test from "node:test";

import { readPlacements } from "../src/socket/floors.js";
import { emitSignal, initialTargetState, trackTriggers } from "../src/socket/triggers.js";

/**
 * A logic gate that authors `triggerOnce` stays on once something turns it on.
 *
 * The maps wire their treasure rooms through them. A room's buttons are timed
 * — stand on one and it holds for a few seconds — and all of them feed an AND
 * that says `triggerOnce`: press them together and the door is open for good.
 * The treasure itself sits in a small zone feeding an OR that says the same:
 * reach it and the room's traps are off for good.
 *
 * The flag was carried and never read, so both were only true while their
 * inputs were. A door closed behind the player when the first button timed
 * out, and a recorded run shows the rest: the hero steps into the treasure
 * zone and six spike beds drop, steps 41 units out of it 1.2 seconds later and
 * they are back, standing where the treasure is.
 *
 * Only AND, OR and NOT, and only where the map says so. A gate without the
 * flag follows its inputs as before, a TOGGLE still toggles, and what
 * `triggerOnce` means on a RESET_TIMER_GATE is not settled and is not touched.
 */

const PRISON = "Resources/Levels/castle/prison/tiles.json";
const CATACOMBS = "Resources/Levels/castle/catacombs/tiles.json";

const room = async (library, tileId) => {
  const tiles = [{ x: 0, y: 0, tileId }];
  const floor = { ...(await readPlacements(library, tiles)), tiles };
  const session = { id: 1, floorDoid: 5, dungeonActive: true, floorSettled: false, send: () => {} };
  trackTriggers(session, floor);
  session.floorSettled = true;

  const zones = floor.placements.trigger.filter((entry) => entry.constant === "PROXIMITY_TRIGGER");
  const named = (pattern) =>
    floor.placements.triggerable
      .filter((entry) => pattern.test(entry.constant))
      .map((entry) => (initialTargetState(session, entry.id) ? 1 : 0));
  return {
    session,
    buttons: zones.filter((zone) => zone.radius <= 30),
    reward: zones.filter((zone) => zone.radius > 30),
    press: (list) => {
      for (const zone of list) emitSignal(session, zone.id, true);
      for (const zone of list) emitSignal(session, zone.id, false);
    },
    named,
  };
};

test("a door three timed buttons opened stays open when the buttons time out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const { buttons, press, named } = await room(PRISON, "817.1342464421192");
  assert.equal(buttons.length, 3);
  assert.deepEqual(named(/EXITGATE/), [1], "shut to begin with");

  press(buttons);
  assert.deepEqual(named(/EXITGATE/), [0], "all three together open it");

  t.mock.timers.tick(60_000); // each button holds for twenty seconds
  assert.deepEqual(named(/EXITGATE/), [0], "and the player inside is not shut in");
  assert.deepEqual(named(/TRAP_TRIGGER/), [1, 1, 1], "the buttons stay down with it");
});

test("pressing only some of the buttons opens nothing and latches nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const { buttons, press, named } = await room(PRISON, "817.1342464421192");

  press(buttons.slice(0, 2));
  assert.deepEqual(named(/EXITGATE/), [1]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(named(/TRAP_TRIGGER/), [0, 0, 0], "and two lone buttons come back up, to be tried again");
});

test("four timed buttons put the spikes away for good", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const { buttons, press, named } = await room(CATACOMBS, "496.1343067980625");
  assert.equal(buttons.length, 4);
  assert.deepEqual(named(/SPIKES/), [1]);

  press(buttons);
  t.mock.timers.tick(60_000); // seven seconds each
  assert.deepEqual(named(/SPIKES/), [0]);
});

/**
 * The recorded run, on the tile it was recorded on: in at 61.2s, out at 62.4s.
 */
test("reaching the treasure turns the room's traps off, not standing on it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const { reward, named, session } = await room(PRISON, "12.1342039274723");
  assert.equal(reward.length, 2, "two small zones where the treasure lies");
  const armed = named(/TRAP_SPIKE/);
  assert.ok(armed.every((state) => state === 1) && armed.length > 5, "a room full of raised spikes");

  emitSignal(session, reward[0].id, true);
  assert.ok(named(/TRAP_SPIKE/).every((state) => state === 0), "stepping in drops them all");

  emitSignal(session, reward[0].id, false);
  t.mock.timers.tick(60_000);
  assert.ok(named(/TRAP_SPIKE/).every((state) => state === 0), "and stepping out does not raise them");
  assert.ok(named(/TRAP_TRIGGER/).every((state) => state === 1), "nor the buttons");
});

/** A gate that does not author the flag is what it always was. */
test("a gate without the flag still follows its inputs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const { buttons, press, named } = await room(PRISON, "12.1342039274723");
  const before = named(/TRAP_SPIKE/);

  press(buttons);
  assert.notDeepEqual(named(/TRAP_SPIKE/), before, "the buttons move some spikes");
  t.mock.timers.tick(60_000);
  assert.deepEqual(named(/TRAP_SPIKE/), before, "for as long as they are held, and no longer");
});

/**
 * How a floor rests is not something happening. A `NOT` that is on because its
 * generator has not started yet must still go off when it does — latching the
 * resting state would hold a door open that the room means to shut.
 */
test("a gate that merely rests on is not latched until something turns it on", () => {
  const session = { id: 2, floorDoid: 5, dungeonActive: true, floorSettled: false, send: () => {} };
  trackTriggers(session, {
    placements: {
      heroSpawn: [], npc: [], collectable: [], generator: [],
      trigger: [{ id: "watch", constant: "PROXIMITY_TRIGGER", x: 0, y: 0, radius: 100 }],
      logicGate: [{ id: "not", constant: "NOT_GATE", triggerOnce: true }],
      triggerable: [],
    },
    wiring: new Map([["watch", ["not"]]]),
  });
  session.floorSettled = true;
  const on = () => session.signalValues.get("not");

  assert.equal(on(), true, "on at rest, with nothing in the zone");
  emitSignal(session, "watch", true);
  assert.equal(on(), false, "and off when somebody walks in — it was not latched");
  emitSignal(session, "watch", false);
  assert.equal(on(), true, "on again, and this time because something happened");
  emitSignal(session, "watch", true);
  assert.equal(on(), true, "so now it holds");
});

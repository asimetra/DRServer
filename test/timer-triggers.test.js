import test from "node:test";
import assert from "node:assert/strict";

import { buildFloor } from "../src/socket/floors.js";
import { emitSignal, startTimerTriggers } from "../src/socket/triggers.js";

/**
 * Traps that run on their own clock.
 *
 * Two constants author one, and reading only the symmetric one left every mace,
 * crusher, blade, log and slicer in the game hanging off a source that never
 * moved — 113 triggers across the nine themes, and the two the ice caves use
 * for its swinging maces and its crushers.
 */

/** A session with nothing wired to the timer, so only its own state moves. */
const timedSession = (triggers) => {
  const session = {
    id: "timer-test",
    triggers: triggers.map((trigger) => ({ ...trigger })),
    signalTargets: new Map(),
    signalIncoming: new Map(),
    signalValues: new Map(),
    logicGates: new Map(),
    logicGateTimers: new Map(),
    triggerableDoids: new Map(),
    navigation: { triggerGroups: new Map() },
    send: () => {},
  };
  return { session, stop: startTimerTriggers(session) };
};

test("an asymmetric timer holds its two halves for different lengths", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // A timer rests on, so the trap it drives is already going when the floor is
  // built — see trackTriggers.
  const { session, stop } = timedSession([
    { id: "mace", constant: "ASYM_AUTO_TIMER_TRIGGER", onTime: 3.5, offTime: 0.5, on: true },
  ]);
  const trigger = session.triggers[0];

  assert.equal(trigger.on, true, "it starts swinging");

  t.mock.timers.tick(3499);
  assert.equal(trigger.on, true, "and stays up for its whole on time");

  t.mock.timers.tick(1);
  assert.equal(trigger.on, false);

  t.mock.timers.tick(500);
  assert.equal(trigger.on, true, "a 4 second cycle, 3.5 of it swinging");

  stop();
});

test("a symmetric timer still splits one interval evenly", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const { session, stop } = timedSession([
    { id: "arrows", constant: "AUTO_TIMER_TRIGGER", intervalTime: 2, startDelay: 0 },
  ]);
  const trigger = session.triggers[0];

  t.mock.timers.tick(0);
  assert.equal(trigger.on, true, "no delay means it fires at once");

  t.mock.timers.tick(2000);
  assert.equal(trigger.on, false);

  t.mock.timers.tick(2000);
  assert.equal(trigger.on, true, "so the gargoyle emitters shoot every 4 seconds");

  stop();
});

/**
 * The ice caves are the case that was reported: 23 of its 25 maces and all 5 of
 * its crushers hang off asymmetric timers, and floors.js dropped their timing on
 * the way in, so the trap had a source that could never move.
 */
test("an ice caves layout keeps the timing of every timer it places", async () => {
  const floor = await buildFloor("Resources/Levels/nordic/caves/tiles.json", {
    tier: 3,
    tileCount: 14,
    seed: 7,
  });

  const timers = floor.placements.trigger.filter((trigger) =>
    trigger.constant.endsWith("AUTO_TIMER_TRIGGER")
  );
  assert.ok(
    timers.some(({ constant }) => constant === "ASYM_AUTO_TIMER_TRIGGER"),
    "the caves lay out asymmetric timers"
  );

  for (const trigger of timers) {
    const authored =
      trigger.constant === "ASYM_AUTO_TIMER_TRIGGER"
        ? Number.isFinite(trigger.onTime) && Number.isFinite(trigger.offTime)
        : Number.isFinite(trigger.intervalTime);
    assert.ok(authored, `${trigger.constant} ${trigger.id} lost its timing in floors.js`);
  }
});

/**
 * A reset gate's pulse waits before it starts.
 *
 * `startDelay` was parsed off the tile and then dropped, which matters because
 * these gates are chained: the ice caves' wall emitters hang off a cascade four
 * and five deep, each link meant to hold the signal a fraction of a second so
 * the effect runs along the wall. Without the delay every link fires at the
 * same instant. 75 of the caves' 77 reset gates carry one.
 */
test("a reset gate holds its pulse back by its start delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = { id: "ripple", constant: "RESET_TIMER_GATE", resetTime: 2, startDelay: 0.4 };
  const session = {
    id: "gate-test",
    // A button feeding the gate, and the gate feeding nothing further.
    signalTargets: new Map([["button", ["ripple"]]]),
    signalIncoming: new Map([["ripple", ["button"]]]),
    signalValues: new Map(),
    logicGates: new Map([["ripple", gate]]),
    logicGateTimers: new Map(),
    triggerableDoids: new Map(),
    navigation: { triggerGroups: new Map() },
    send: () => {},
  };
  const pulse = () => session.signalValues.get("ripple");

  emitSignal(session, "button", true);
  assert.notEqual(pulse(), true, "nothing yet — the pulse is still waiting");

  t.mock.timers.tick(400);
  assert.equal(pulse(), true, "then it opens");

  t.mock.timers.tick(1999);
  assert.equal(pulse(), true, "and holds for its reset time");

  t.mock.timers.tick(1);
  assert.equal(pulse(), false);
});

/**
 * A timer rests **on** while it is already running, so a trap wired straight to
 * one is up when the floor is built — and a trap that is up hurts whatever
 * walks into it, triggered or not.
 *
 * The captures settle it twice over. The official damages from 98 traps that
 * never received a single state change, 65 of those hits from one catacomb
 * spike bed. And of the traps fed by nothing but an AUTO_TIMER it generates 76
 * raised against 18 retracted — the unanimous cases being
 * CASTLE_ARENA_TRAP_SPIKES_I at 17 of 17 and NORDIC_CAVE_GARGOYLE_EMITTER_C at
 * 18 of 18.
 *
 * `startDelay` is what separates the 76 from the 18, and both unanimous cases
 * are fed by timers that carry none. Replaying an ARENA_C floor of the
 * official's own layout reads the rest: delay 0 opens on, and 0.3, 0.5, 1.0 and
 * 1.5 all open off. A timer that has not ticked yet has not switched anything.
 */
test("a trap wired to a running timer starts the floor switched on", async () => {
  const { trackTriggers, initialTargetState } = await import("../src/socket/triggers.js");

  const floor = await buildFloor("Resources/Levels/castle/arena/tiles.json", {
    tier: 10,
    tileCount: 25,
    seed: 14,
  });
  const session = { navigation: { triggerGroups: new Map() } };
  trackTriggers(session, floor);

  const timerIds = new Set(
    floor.placements.trigger
      .filter(({ constant }) => constant.endsWith("AUTO_TIMER_TRIGGER"))
      .map(({ id }) => id)
  );
  const drivenByTimerAlone = floor.placements.triggerable.filter((placement) => {
    const sources = session.signalIncoming.get(placement.id) ?? [];
    return sources.length > 0 && sources.every((id) => timerIds.has(id));
  });

  assert.ok(drivenByTimerAlone.length, "the arena wires traps straight to timers");

  const delayOf = new Map(
    floor.placements.trigger.map(({ id, startDelay }) => [id, Number(startDelay ?? 0)])
  );

  /**
   * Only the plain case: a trap whose timers are fed by nothing themselves.
   * A timer can be wired to as well — thirteen arena spikes hang off one that
   * an unsatisfiable AND holds shut — and those are the subject of the replay
   * comparison rather than of this rule.
   */
  const plain = drivenByTimerAlone.filter((placement) =>
    (session.signalIncoming.get(placement.id) ?? []).every(
      (id) => !(session.signalIncoming.get(id) ?? []).length
    )
  );
  assert.ok(plain.length, "the arena wires traps straight to unfed timers");

  let running = 0;
  let waiting = 0;
  for (const placement of plain) {
    const sources = session.signalIncoming.get(placement.id) ?? [];
    const anyRunning = sources.some((id) => (delayOf.get(id) ?? 0) <= 1e-6);
    assert.equal(
      initialTargetState(session, placement.id),
      anyRunning,
      `${placement.constant} opened the wrong way for timers delayed ` +
        sources.map((id) => delayOf.get(id)).join("/")
    );
    if (anyRunning) running += 1; else waiting += 1;
  }
  assert.ok(running > 0, "the arena has traps on timers that are already going");
  assert.ok(waiting > 0, "and traps waiting on a delayed one");
});

/**
 * A `resetTime` of zero is not a pulse of no width.
 *
 * 192 of the game's 740 reset gates author zero, and taking that literally
 * scheduled the close on the next turn of the event loop: 3329 of this server's
 * recorded trigger pulses lasted between nought and four milliseconds, which is
 * a spike bed the client is told about and never has time to draw — the
 * reported "the spikes come up and vanish instantly".
 *
 * The official never sends one that short. Not one of its 3737 recorded spike
 * pulses is under twenty milliseconds, and its sub-400ms pulses cluster at a
 * tenth of a second: 30 of 52 between 60 and 149, median 117.
 */
test("a reset gate with no authored duration still holds for one tick", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = { id: "flat", constant: "RESET_TIMER_GATE", resetTime: 0, startDelay: 0 };
  const session = {
    id: "gate-tick",
    signalTargets: new Map([["button", ["flat"]]]),
    signalIncoming: new Map([["flat", ["button"]]]),
    signalValues: new Map(),
    logicGates: new Map([["flat", gate]]),
    logicGateTimers: new Map(),
    triggerableDoids: new Map(),
    navigation: { triggerGroups: new Map() },
    send: () => {},
  };
  const pulse = () => session.signalValues.get("flat");

  emitSignal(session, "button", true);
  assert.equal(pulse(), true, "it opens at once, having no delay to wait out");

  t.mock.timers.tick(99);
  assert.equal(pulse(), true, "and is still up a tick later, which is what makes it visible");

  t.mock.timers.tick(1);
  assert.equal(pulse(), false, "then closes");
});

/**
 * And a zero that survived a spreadsheet is still a zero: one gate in the game
 * authors 2.78e-17, which as a duration is 28 femtoseconds.
 */
test("a reset time of almost exactly zero is read as zero", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const gate = { id: "epsilon", constant: "RESET_TIMER_GATE", resetTime: 2.77555756156289e-17 };
  const session = {
    id: "gate-epsilon",
    signalTargets: new Map([["button", ["epsilon"]]]),
    signalIncoming: new Map([["epsilon", ["button"]]]),
    signalValues: new Map(),
    logicGates: new Map([["epsilon", gate]]),
    logicGateTimers: new Map(),
    triggerableDoids: new Map(),
    navigation: { triggerGroups: new Map() },
    send: () => {},
  };

  emitSignal(session, "button", true);
  t.mock.timers.tick(99);
  assert.equal(session.signalValues.get("epsilon"), true, "not a femtosecond pulse");
  t.mock.timers.tick(1);
  assert.equal(session.signalValues.get("epsilon"), false);
});

/**
 * The two puzzles in the game that ask for more than one thing at once.
 *
 * The catacombs author a `COUNTER_GATE` on tiles 286 and 408, both with
 * `threshold: 8` and `triggerOnce`, each fed by eight proximity zones and each
 * driving NPC generators — two behind one, four behind the other. The runtime
 * has always read a threshold when it had one; the floor parser was not keeping
 * it, so `gate.threshold ?? 1` came out as one and the first zone anybody stood
 * on released the room.
 */
test("a counter gate waits for all eight of its zones", async () => {
  const { trackTriggers, emitSignal, initialTargetState } = await import(
    "../src/socket/triggers.js"
  );
  const { loadFloor } = await import("../src/socket/floors.js");

  // Grown until the tile carrying the puzzle comes up; it is one of 109.
  let floor = null;
  let gate = null;
  for (let seed = 1; seed <= 40 && !gate; seed += 1) {
    const candidate = await buildFloor("Resources/Levels/castle/catacombs/tiles.json", {
      tier: 10,
      tileCount: 30,
      seed,
    });
    const found = (candidate.placements.logicGate ?? []).find(
      ({ constant }) => constant === "COUNTER_GATE"
    );
    if (found) { floor = candidate; gate = found; }
  }
  assert.ok(gate, "no layout in forty seeds carried a counter gate");
  assert.equal(gate.threshold, 8, "the authored threshold survives the parser");

  const session = { navigation: { triggerGroups: new Map() }, floorGenerated: true };
  trackTriggers(session, floor);

  const sources = session.signalIncoming.get(gate.id) ?? [];
  assert.equal(sources.length, 8, "eight zones feed it");

  // Seven of them is not eight.
  for (const source of sources.slice(0, 7)) emitSignal(session, source, true);
  assert.equal(
    session.signalValues.get(gate.id),
    false,
    "seven zones leave the gate shut"
  );

  emitSignal(session, sources[7], true);
  assert.equal(session.signalValues.get(gate.id), true, "the eighth opens it");

  // And a solved puzzle stays solved when everyone steps off it.
  for (const source of sources) emitSignal(session, source, false);
  assert.equal(
    session.signalValues.get(gate.id),
    true,
    "stepping off does not shut the generators again"
  );
});

/**
 * `NPC_DAMAGE_TRIGGER`: parsed and stored since the wiring was written, and
 * never once published, so every generator behind one stayed asleep.
 *
 * The catacombs put two on the same tile — a statue in front of five FODDER
 * generators and another in front of four BRUISER ones — and name their watched
 * object by placement id, exactly as `NPC_LIFE_TRIGGER` does.
 */
test("hitting a damage-trigger statue wakes what is wired behind it", async () => {
  const { trackTriggers, reportNpcDamage } = await import("../src/socket/triggers.js");

  let floor = null;
  let trigger = null;
  for (let seed = 1; seed <= 40 && !trigger; seed += 1) {
    const candidate = await buildFloor("Resources/Levels/castle/catacombs/tiles.json", {
      tier: 10,
      tileCount: 30,
      seed,
    });
    const found = (candidate.placements.trigger ?? []).find(
      ({ constant }) => constant === "NPC_DAMAGE_TRIGGER"
    );
    if (found) { floor = candidate; trigger = found; }
  }
  assert.ok(trigger, "no layout in forty seeds carried a damage trigger");
  assert.ok(trigger.npcId, "it names the object it watches");

  const session = { navigation: { triggerGroups: new Map() }, floorGenerated: true };
  trackTriggers(session, floor);
  assert.notEqual(session.signalValues.get(trigger.id), true, "asleep to begin with");

  // Somebody else being hit is not this statue being hit.
  assert.equal(reportNpcDamage(session, "some-other-placement"), false);
  assert.notEqual(session.signalValues.get(trigger.id), true);

  assert.equal(reportNpcDamage(session, trigger.npcId), true, "the statue was hit");
  assert.equal(session.signalValues.get(trigger.id), true, "and the branch is live");

  // Once. A second swing changes nothing.
  assert.equal(reportNpcDamage(session, trigger.npcId), false, "the second swing is quiet");
});

test("a pressure plate makes a spike bed safe, it does not set one off", async () => {
  /**
   * "You walk over it and it closes — I am not sure the server does that."
   *
   * It does. The plates in this library are not "activate the trap" buttons;
   * they are the way past a dangerous patch, and they work by driving an
   * inverted branch low. The catacombs capture is unambiguous: of the eighteen
   * same-millisecond batches in which a visible `CASTLE_CATACOMB_TRAP_TRIGGER`
   * switches on, six switch spikes **off** in the same millisecond and not one
   * switches a spike on.
   *
   * The authored wiring says the same thing from the other side, and says the
   * plate is somewhere else in the room rather than under the spikes — radius
   * 30, and 118 to 190 units away from the bed it controls, which is well
   * outside anything a hero standing on the spikes could reach.
   */
  const { trackTriggers, emitSignal } = await import("../src/socket/triggers.js");

  let floor = null;
  let spike = null;
  let plate = null;
  for (let seed = 1; seed <= 40 && !plate; seed += 1) {
    const candidate = await buildFloor("Resources/Levels/castle/catacombs/tiles.json", {
      tier: 10,
      tileCount: 30,
      seed,
    });
    const session = { navigation: { triggerGroups: new Map() }, floorGenerated: true };
    trackTriggers(session, candidate);

    for (const placement of candidate.placements.triggerable ?? []) {
      if (placement.constant !== "CASTLE_CATACOMB_TRAP_SPIKES_C") continue;
      const gates = (session.signalIncoming.get(placement.id) ?? []).filter(
        (id) => (candidate.placements.logicGate ?? []).some((g) => g.id === id && g.constant === "NOT_GATE")
      );
      for (const gate of gates) {
        const source = (session.signalIncoming.get(gate) ?? []).find((id) =>
          (candidate.placements.trigger ?? []).some(
            (t) => t.id === id && t.constant.startsWith("PROXIMITY")
          )
        );
        if (source) { floor = candidate; spike = placement; plate = source; break; }
      }
      if (plate) break;
    }
  }
  assert.ok(plate, "no layout in forty seeds put a plate-fed spike bed on the floor");

  /**
   * Read from the packets, because a triggerable has no entry in
   * `signalValues` — that map holds sources and gates. What a bed is doing is
   * whatever field 141 last said about it.
   */
  const states = [];
  const session = {
    navigation: { triggerGroups: new Map() },
    floorGenerated: true,
    triggerableDoids: new Map([[spike.id, 9001]]),
    send: (frame) => {
      const body = frame.subarray(2);
      if (body.length < 9 || body.readUInt16LE(0) !== 124) return;
      if (body.readUInt16LE(6) !== 141 || body.readUInt32LE(2) !== 9001) return;
      states.push(Boolean(body.readUInt8(8)));
    },
  };
  trackTriggers(session, floor);

  const trigger = floor.placements.trigger.find(({ id }) => id === plate);
  assert.ok(trigger.radius <= 60, `a plate is small: radius ${trigger.radius}`);
  assert.ok(
    Math.hypot(trigger.x - spike.x, trigger.y - spike.y) > trigger.radius + 40,
    "and it sits away from the bed, not under it — standing on the spikes cannot reach it"
  );

  const { initialTargetState } = await import("../src/socket/triggers.js");
  assert.equal(initialTargetState(session, spike.id), true, "the bed rests raised");

  emitSignal(session, plate, true);
  assert.equal(states.at(-1), false, "stepping on the plate lowers it");
  emitSignal(session, plate, false);
  assert.equal(states.at(-1), true, "and stepping off raises it again");
});

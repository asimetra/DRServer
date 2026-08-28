import test from "node:test";
import assert from "node:assert/strict";
import { trackTriggers, canEverChange, initialTargetState } from "../src/socket/triggers.js";

/**
 * A door is a wall when nothing on the floor can ever change its input.
 *
 * A laid-out floor takes its wiring from the whole tile library, so it inherits
 * gates whose openers live in tiles that were never placed. Asking whether a
 * gate has *a* source calls those fine — the source exists, it just cannot move
 * — and the player walks up to a doorway they can see through and never pass.
 *
 * Only two kinds of source move on their own: triggers and generators. Anything
 * else is a gate recomputing a value that will never change.
 */

/** A floor with only the wiring the case under test needs. */
const floorWith = ({ triggers = [], generators = [], gates = [], wiring = [] }) => ({
  placements: {
    trigger: triggers,
    generator: generators,
    logicGate: gates,
    triggerable: [{ id: "door", constant: "NORDIC_CAVE_EXIT_GATE_A" }],
    npc: [],
    collectable: [],
    heroSpawn: [],
  },
  wiring: new Map(wiring),
});

const sessionFor = (floor) => {
  const session = { navigation: { triggerGroups: new Map() } };
  trackTriggers(session, floor);
  return session;
};

test("a gate behind a NOT with nothing feeding it can never change", () => {
  const session = sessionFor(
    floorWith({
      gates: [{ id: "not", constant: "NOT_GATE" }],
      wiring: [["not", ["door"]]],
    })
  );

  assert.equal(
    canEverChange(session, "door"),
    false,
    "it is wired, but to a subtree of pure logic"
  );
  /**
   * And it rests open, because a gate nobody powered is off.
   *
   * This asserted "shut" until the official's own layouts were replayed whole.
   * `NOT` was the only gate in the set that came alive on an empty input list —
   * `AND` asks for `values.length > 0` and `OR` is false without any — so every
   * dangling one held its branch high for a run, and the libraries are full of
   * dangling ones.
   *
   * Two measurements, and they agree. Replaying all 24 floors of the catacombs
   * capture, `CASTLE_CATACOMB_TRAP_SPIKES_SKELETONSTATUE` came out raised here
   * 12 times of 191 where the official leaves it flat, and every one of the
   * twelve is wired to exactly `NOT_GATE(nothing)`. And of the gates, almost
   * all sit behind a NOT that *is* fed and stay shut either way; the handful
   * behind an unfed one are the handful the official generates open —
   * `NORDIC_CAVE_EXIT_GATE_A` 46 shut against 2, `NORDIC_TEMPLE_EXIT_GATE_A`
   * 26 against 1.
   *
   * A target nobody wired at all is a different question and still rests on:
   * `CASTLE_ARENA_GATE_D` is generated shut 84 times of 84.
   */
  assert.equal(
    initialTargetState(session, "door"),
    false,
    "a gate nobody powered is off, and an unopenable exit is better open"
  );
});

test("a gate a trigger reaches through two gates can change", () => {
  const session = sessionFor(
    floorWith({
      triggers: [{ id: "near", constant: "PROXIMITY_TRIGGER" }],
      gates: [
        { id: "or", constant: "OR_GATE" },
        { id: "not", constant: "NOT_GATE" },
      ],
      wiring: [
        ["near", ["or"]],
        ["or", ["not"]],
        ["not", ["door"]],
      ],
    })
  );

  assert.equal(canEverChange(session, "door"), true);
});

test("a generator counts as a live source, a lone gate does not", () => {
  const live = sessionFor(
    floorWith({
      generators: [{ id: "wave", constant: "NPC_GENERATOR" }],
      gates: [{ id: "not", constant: "NOT_GATE" }],
      wiring: [
        ["wave", ["not"]],
        ["not", ["door"]],
      ],
    })
  );
  assert.equal(canEverChange(live, "door"), true);

  const dead = sessionFor(
    floorWith({
      gates: [
        { id: "and", constant: "AND_GATE" },
        { id: "not", constant: "NOT_GATE" },
      ],
      wiring: [
        ["and", ["not"]],
        ["not", ["door"]],
      ],
    })
  );
  assert.equal(canEverChange(dead, "door"), false);
});

/** Tile wiring loops back on itself in places; the walk must not hang. */
test("a loop in the wiring terminates", () => {
  const session = sessionFor(
    floorWith({
      gates: [
        { id: "a", constant: "OR_GATE" },
        { id: "b", constant: "OR_GATE" },
      ],
      wiring: [
        ["a", ["b"]],
        ["b", ["a", "door"]],
      ],
    })
  );

  assert.equal(canEverChange(session, "door"), false);
});

test("a gate with no wiring at all can never change either", () => {
  const session = sessionFor(floorWith({}));
  assert.equal(canEverChange(session, "door"), false);
});

/**
 * A trap nothing can ever trigger goes quiet, for the same reason a door
 * nothing can open is not left shut.
 *
 * The reason is stronger for a trap: NPCGameObject switches its navigation
 * colliders on with its trigger state, so a raised trap is a *wall*. One stuck
 * raised is a permanent block that also does permanent damage, and two close
 * together is a pocket with no way out but dying — which is what was reported.
 *
 * Laid out five ways each, this takes the ice caves from 219 armed traps to 120
 * and the catacombs from 296 to 218.
 */
test("a trap nothing can trigger is not left armed for ever", async () => {
  const { buildFloor } = await import("../src/socket/floors.js");
  const { npcForConstant } = await import("../src/gamemaster.js");

  const { isInert } = await import("../src/socket/dungeon.js");

  let wouldHaveBeenArmed = 0;
  let armed = 0;
  for (const seed of [1, 5, 9, 14, 21]) {
    const floor = await buildFloor("Resources/Levels/nordic/caves/tiles.json", {
      tier: 10,
      tileCount: 25,
      seed,
    });
    const session = { navigation: { triggerGroups: new Map() }, floorGenerated: true };
    trackTriggers(session, floor);

    for (const placement of floor.placements.triggerable) {
      const npc = await npcForConstant(placement.constant);
      if (!npc?.Attack1) continue;
      if (canEverChange(session, placement.id)) continue;

      // Stuck, so nothing will ever move it. Its resting state says it would
      // have stood armed; the rule is what stops it.
      if (initialTargetState(session, placement.id)) wouldHaveBeenArmed++;
      if (!isInert(session, placement.id) && initialTargetState(session, placement.id)) armed++;
    }
  }

  assert.ok(wouldHaveBeenArmed > 50, `only ${wouldHaveBeenArmed} stuck traps would have stood armed`);
  assert.equal(armed, 0, "and one of them was left armed for ever");
});

/**
 * A button is pressed with the body, not the feet.
 *
 * An actor's collision circle sits 22 units above its position, and these radii
 * are small enough for that to be the whole of it: a catacomb button carries a
 * radius of 30 and its trigger sits 28 above the prop you can see. Measured
 * from the feet, standing dead centre on the button is 28 away from a 30-unit
 * trigger — it registers with two units to spare and misses on any other step.
 * Measured from the body it is six away, with twenty-four to spare.
 *
 * Which is what "I stand on the button and nothing happens, sometimes" is.
 */
test("standing on a button presses it", async () => {
  const { updateProximityTriggers } = await import("../src/socket/triggers.js");
  const { loadNavigationLibrary } = await import("../src/socket/navigation.js");
  await loadNavigationLibrary();

  // The catacombs' own numbers: the trigger 28 above the prop, radius 30.
  const button = { x: 1979, y: 413 };
  const propYouStandOn = { x: 1978, y: 441 };

  const fired = [];
  const session = {
    id: "button-test",
    heroDoid: 7001,
    actors: new Map([[7001, { constant: "RANGER" }]]),
    triggers: [
      { id: "button", constant: "PROXIMITY_TRIGGER", ...button, radius: 30, targets: [] },
    ],
    signalTargets: new Map(),
    signalIncoming: new Map(),
    signalValues: new Map(),
    logicGates: new Map(),
    logicGateTimers: new Map(),
    triggerableDoids: new Map(),
    navigation: { triggerGroups: new Map() },
    send: () => {},
  };
  const pressed = () => session.signalValues.get("button") === true;

  updateProximityTriggers(session, propYouStandOn);
  assert.equal(pressed(), true, "dead centre on the prop");

  // A step off the middle, still on the button as it is drawn.
  session.triggers[0].on = false;
  session.signalValues.set("button", false);
  updateProximityTriggers(session, { x: 1978, y: 455 });
  assert.equal(pressed(), true, "and a step towards the near edge of it");

  fired.length = 0;
});

import test from "node:test";
import assert from "node:assert/strict";
import { loadFloor } from "../src/socket/floors.js";
import { trackTriggers, reportNpcDeath } from "../src/socket/triggers.js";

/**
 * How a floor actually ends.
 *
 * Not "every enemy is dead" — that was a stand-in. The tile data wires it: an
 * NPC_LIFE_TRIGGER naming the boss feeds the reward generator and, through a
 * reset gate, a FLOOR_COMPLETION_IMMEDIATE triggerable. Those last two name
 * actions rather than NPC rows, and while the server looked for them in the
 * monster table they never built, so the tutorial's boss floor could be cleared
 * of everything and still never finish.
 */

const bossSession = async () => {
  const floor = await loadFloor("tutorial_boss");
  const events = [];
  const session = {
    id: 1,
    send: () => {},
    floorDoid: 42,
    floorNames: ["tutorial", "tutorial_boss"],
    floorIndex: 1,
    completeFloor: () => events.push("complete"),
    showFloorText: (_, triggerable) => events.push(`text:${triggerable.textKey}`),
  };

  trackTriggers(session, floor);
  // Generators announce themselves through this map; stub them so firing one is
  // observable without building the world.
  for (const generator of floor.placements.generator) {
    session.generatorHandlers.set(generator.id, () => events.push("generator"));
  }
  return { floor, session, events };
};

test("the boss floor knows its own completion triggerable", async () => {
  const { floor } = await bossSession();
  const constants = floor.placements.triggerable.map((t) => t.constant);

  assert.ok(constants.includes("FLOOR_COMPLETION_IMMEDIATE"));
  assert.ok(constants.includes("FLOOR_MESSAGE_TRIGGERABLE"));
});

// The trigger names its subject rather than reaching for it: the boss tile's
// NPC_LIFE_TRIGGER sits 216 units from a minotaur it covers with a radius of
// 150, so anything proximity-based would miss.
test("the life trigger names the boss by placement id", async () => {
  const { floor } = await bossSession();
  const trigger = floor.placements.trigger.find((t) => t.constant === "NPC_LIFE_TRIGGER");
  const boss = floor.placements.npc.find((n) => n.constant === "MINOTAUR_TUTORIAL");

  assert.ok(trigger.npcId, "the trigger carries an npcId");
  assert.equal(trigger.npcId, boss.id);
});

/**
 * The signal means "the boss is alive", not "the boss died". It feeds the two
 * BRUTE generators directly — they fight alongside the minotaur — and a NOT_GATE
 * that holds the reward chest back until it drops.
 */
test("the life trigger rests on and drops when the boss dies", async () => {
  const { floor, session, events } = await bossSession();
  const boss = floor.placements.npc.find((n) => n.constant === "MINOTAUR_TUTORIAL");
  const trigger = floor.placements.trigger.find((t) => t.constant === "NPC_LIFE_TRIGGER");

  assert.equal(session.signalValues.get(trigger.id), true, "alive at floor start");
  assert.equal(reportNpcDeath(session, boss.id), true);
  assert.equal(session.signalValues.get(trigger.id), false, "and down afterwards");

  assert.ok(events.includes("generator"), `the inverted branch runs — saw ${events}`);
});

test("an unrelated death fires nothing", async () => {
  const { session } = await bossSession();
  assert.equal(reportNpcDeath(session, "not-a-placement"), false);
  assert.equal(reportNpcDeath(session, undefined), false);
});

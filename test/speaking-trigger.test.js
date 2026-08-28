import assert from "node:assert/strict";
import test from "node:test";

import { PacketReader } from "../src/socket/packet.js";
import { updateProximityTriggers } from "../src/socket/triggers.js";

/**
 * A tavern keeper cannot say anything himself. An NPC has fifteen fields and
 * none of them is a name: `NPCView` builds a nametag when the row asks for a
 * healthbar, but the tag renders `screenName` and nothing ever sets one on an
 * NPC. The floor's `show_text` is no better for this — it carries a *locale
 * key*, and `Locale.getString` answers an unknown one with "mia:" and the key.
 *
 * Chat is the one text channel that needs nothing on the player's side, so a
 * place that speaks speaks through that.
 */
const sessionWith = (triggers) => {
  const sent = [];
  return {
    id: 5,
    heroDoid: 500,
    playerDoid: 70,
    actors: new Map([[500, { position: { x: 0, y: 0 }, collisionRadius: 20 }]]),
    triggers,
    sent,
    sendDirect: (frame) => sent.push(frame),
    broadcast: () => {
      throw new Error("a greeting is for the one who walked in, not for the room");
    },
  };
};

const greeter = (extra = {}) => ({
  id: "keeper",
  constant: "PROXIMITY_TRIGGER",
  x: 500,
  y: 500,
  radius: 150,
  chatText: "The keeper nods.",
  ...extra,
});

/** The text of a field-182 frame. */
const spoken = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  reader.u16();
  reader.u32();
  reader.u16();
  return reader.utf();
};

test("walking up to something that speaks is how it speaks", () => {
  const session = sessionWith([greeter()]);

  updateProximityTriggers(session, { x: 480, y: 500 });
  assert.equal(session.sent.length, 1);
  assert.equal(spoken(session.sent[0]), "The keeper nods.");
});

test("it says it once, not once a frame", () => {
  const session = sessionWith([greeter()]);

  updateProximityTriggers(session, { x: 480, y: 500 });
  updateProximityTriggers(session, { x: 490, y: 510 });
  assert.equal(session.sent.length, 1, "still inside is not walking in again");
});

test("and again when you come back", () => {
  const session = sessionWith([greeter()]);

  updateProximityTriggers(session, { x: 480, y: 500 });
  updateProximityTriggers(session, { x: 4000, y: 4000 });
  updateProximityTriggers(session, { x: 480, y: 500 });
  assert.equal(session.sent.length, 2);
});

test("a trigger with nothing to say says nothing", () => {
  const session = sessionWith([greeter({ chatText: undefined })]);

  updateProximityTriggers(session, { x: 480, y: 500 });
  assert.equal(session.sent.length, 0);
});

/**
 * The corpse rule that already governs proximity: a dead hero is not standing
 * anywhere, so it cannot walk into anything.
 */
test("a dead hero is not greeted", () => {
  const session = sessionWith([greeter()]);
  session.actors.get(500).dead = true;

  updateProximityTriggers(session, { x: 480, y: 500 });
  assert.equal(session.sent.length, 0);
});

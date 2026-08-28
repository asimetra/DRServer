import assert from "node:assert/strict";
import test from "node:test";

import { handleChat, handleTyping } from "../src/socket/chat.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

/**
 * The wire carries the sender's own name inside the message.
 * `PlayerGameObjectOwner.handleOutgoingChat` builds `screenName + ": " + text`
 * before `send_Chat` ever sees it, which the captures confirm on both
 * directions: every recorded line arrives with its sender's name already
 * prefixed. The names below are invented, because the recorded ones belong to
 * people who did not agree to appear here.
 *
 * The dispatcher has already read the doid and the field id by the time a
 * handler runs, so these readers start where it left off.
 */
const saying = (line) => new PacketReader(new PacketWriter().utf(line).body());
const typing = (on) => new PacketReader(new PacketWriter().u8(on).body());

const sessionWith = (overrides = {}) => ({
  id: 7,
  playerDoid: 70,
  dungeonAccount: { name: "Simetra" },
  sent: [],
  relayed: [],
  sendDirect(frame) {
    this.sent.push(frame);
  },
  broadcast(frame, options) {
    overrides.relayed?.push({ frame, options });
  },
  ...overrides,
});

const withRelay = (overrides = {}) => {
  const relayed = [];
  return sessionWith({ relayed, ...overrides });
};

/** Reads back a field frame: length prefix, opcode, doid, field, then the body. */
const frameOf = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  reader.u16();
  return { doid: reader.u32(), field: reader.u16(), reader };
};

test("a line is relayed to the rest of the room", async () => {
  const session = withRelay();
  await handleChat(session, saying("Simetra: hehe"));

  assert.equal(session.relayed.length, 1, "one relay");
  const { doid, field, reader } = frameOf(session.relayed[0].frame);
  assert.equal(doid, 70, "on the speaker's own player object");
  assert.equal(field, 182);
  assert.equal(reader.utf(), "Simetra: hehe", "verbatim, name and all");
});

/**
 * `PlayerGameObjectOwner.sendChat` calls `this.Chat(text)` on itself before
 * sending, so the speaker has already drawn their own line; echoing it would
 * double it.
 *
 * The captures agree without exception. Across 104 outbound chat and typing
 * frames on this account's own player doid, not one came back inbound — every
 * inbound frame carried somebody else's doid.
 */
test("but never back to whoever said it", async () => {
  const session = withRelay();
  await handleChat(session, saying("Simetra: hehe"));

  assert.equal(session.relayed[0].options?.except, session, "the speaker is excluded");
  assert.equal(session.sent.length, 0, "and nothing goes to them directly");
});

test("the typing light is relayed the same way", async () => {
  const session = withRelay();
  await handleTyping(session, typing(1));

  assert.equal(session.relayed.length, 1);
  assert.equal(session.relayed[0].options?.except, session);
  const { doid, field } = frameOf(session.relayed[0].frame);
  assert.equal(doid, 70);
  assert.equal(field, 183);
});

/**
 * The client's input box stops at 169 characters and the name and ": " go in
 * front of that, so nothing typed arrives much longer. A frame that does was
 * not typed, and relaying it would put it on everybody else's screen.
 */
test("an overlong line is refused rather than relayed", async () => {
  const session = withRelay();
  await handleChat(session, saying(`Simetra: ${"a".repeat(400)}`));

  assert.equal(session.relayed.length, 0);
});

test("an empty line is not worth a packet", async () => {
  const session = withRelay();
  await handleChat(session, saying(""));

  assert.equal(session.relayed.length, 0);
});

test("a player with no account name still gets heard", async () => {
  const session = withRelay({ dungeonAccount: null });
  await handleChat(session, saying("Player9: hello"));

  assert.equal(session.relayed.length, 1);
  assert.equal(frameOf(session.relayed[0].frame).reader.utf(), "Player9: hello");
});

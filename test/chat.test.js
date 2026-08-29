import assert from "node:assert/strict";
import test from "node:test";

import { handleChat, handleTyping } from "../src/socket/chat.js";
import { define, resetCommands } from "../src/socket/commands.js";
import { ROLE } from "../src/socket/roles.js";
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


/** A session that can run commands: speakers need somewhere to be allocated. */
const commandSession = () => {
  resetCommands();
  const session = withRelay();
  session.speakers = new Map();
  session.objects = new Map();
  let next = 4242;
  session.allocateDoid = () => next++;
  session.broadcast = () => {};
  return session;
};

/**
 * A command answer is the server talking, not the player.
 *
 * It used to be written on the caller's own player object, which is the same
 * frame an ordinary line uses — so `/who` came back looking exactly as though
 * the player had typed the answer themselves, under their own name.
 *
 * The client will not help beyond this. `chatLogType` decides the colour of a
 * whole log line and only `UINewsFeed` ever sets it, from friend presence; a
 * server has no way to reach it. What a server *can* choose is the speaking
 * object's name, and `UIChatLog` colours the name span with
 * `PlayerSpecialStatus.getSpecialTextColor`, which reads its first character.
 * So the answer arrives under a different name, in green.
 */
test("a command answer does not come from the player's own object", async () => {
  const session = commandSession();
  define({ name: "ping", role: ROLE.PLAYER, summary: "answers", run: ({ reply }) => reply("pong") });

  await handleChat(session, saying("Simetra: /ping"));

  assert.ok(session.sent.length, "the caller is answered");
  const answered = frameOf(session.sent.at(-1));
  assert.notEqual(answered.doid, session.playerDoid, "not on the player's own object");
  assert.equal(answered.field, 182);
  assert.match(answered.reader.utf(), /^★/, "and under a name the client will colour");
});

/**
 * A refusal is orange, an answer is green.
 *
 * `getSpecialTextColor` gives the name span one of two colours from its first
 * character and there is no third, so this is the whole palette the client
 * offers a server. Spending it on "did what you asked" against "did not" is the
 * distinction a player most needs at a glance.
 */
test("a refused command answers in the warning voice", async () => {
  const session = commandSession();

  await handleChat(session, saying("Simetra: /nonsense"));

  const answered = frameOf(session.sent.at(-1));
  assert.match(answered.reader.utf(), /^⚡/, "an unknown command is a refusal");
});

test("the two voices are separate objects, so both keep their colour", async () => {
  const session = commandSession();
  define({ name: "ping", role: ROLE.PLAYER, summary: "answers", run: ({ reply }) => reply("pong") });

  await handleChat(session, saying("Simetra: /nonsense"));
  await handleChat(session, saying("Simetra: /ping"));

  const spoken = session.sent.map((frame) => frameOf(frame).reader.utf());
  assert.ok(spoken.some((line) => line.startsWith("⚡")), "the refusal stayed orange");
  assert.ok(spoken.some((line) => line.startsWith("★")), "and the answer green");
});

/**
 * The name is a deployment's own, not a constant in here.
 *
 * It belongs in `server.defaults.json` rather than being env-only, because it
 * is identity a server keeps: the file is where somebody looks to find out what
 * their server calls itself. The environment still overrides it for one
 * process, which is the layering every other setting already uses — the two are
 * not alternatives.
 *
 * The colour is prepended rather than configured. It is the mechanism, not a
 * preference: `getSpecialTextColor` reads the first character, so a name that
 * chose its own would silently be uncoloured, and one that already began with a
 * star would be doubled.
 */
test("the server answers under the configured name", async () => {
  const { serverVoiceNameFor } = await import("../src/socket/chat.js");

  assert.equal(serverVoiceNameFor("Meydan", false), "★Meydan");
  assert.equal(serverVoiceNameFor("Meydan", true), "⚡Meydan");
  assert.equal(serverVoiceNameFor("★Meydan", false), "★Meydan", "not doubled");
  assert.equal(serverVoiceNameFor("⚡Meydan", false), "★Meydan", "and recoloured, not kept");
  assert.equal(serverVoiceNameFor("   ", false), "★Server", "an empty name is not a bare colour");
  assert.equal(serverVoiceNameFor(undefined, true), "⚡Server");
});

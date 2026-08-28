import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_PREFIX, define, resetCommands, runCommand } from "../src/socket/commands.js";
import { ROLE, roleOf, withRole } from "../src/socket/roles.js";

const sessionAs = (rank) => ({
  id: 3,
  accountId: 500,
  dungeonAccount: { id: 500, name: "Simetra", admin_flags: String(withRole(0, rank)) },
});

const said = [];
const run = (session, line) => {
  said.length = 0;
  return runCommand(session, line, (message) => said.push(message));
};

test.beforeEach(() => {
  resetCommands();
  define({
    name: "ping",
    role: ROLE.PLAYER,
    summary: "answer",
    run: ({ reply, args }) => reply(`pong ${args.join(",")}`),
  });
  define({
    name: "smite",
    role: ROLE.ADMIN,
    summary: "for admins",
    run: ({ reply }) => reply("done"),
  });
  define({
    name: "boom",
    role: ROLE.PLAYER,
    summary: "throws",
    run: () => {
      throw new Error("the floor gave way");
    },
  });
});

test("ordinary chat is not a command", async () => {
  assert.equal(await run(sessionAs(ROLE.PLAYER), "hello everyone"), false);
  assert.equal(said.length, 0);
});

test("a command runs and answers only its caller", async () => {
  assert.equal(await run(sessionAs(ROLE.PLAYER), `${COMMAND_PREFIX}ping a b`), true);
  assert.deepEqual(said, ["pong a,b"]);
});

/**
 * Consumed even when it names nothing. Letting an unknown command fall through
 * to the room would publish every typo as chat, and `/tp 4000 4000` typed by
 * somebody without the rank would be broadcast as a sentence.
 */
test("a line that starts with the prefix never reaches the room", async () => {
  assert.equal(await run(sessionAs(ROLE.PLAYER), `${COMMAND_PREFIX}nosuch`), true);
  assert.match(said[0], /unknown command/);
});

test("rank decides, and the refusal says what was missing", async () => {
  assert.equal(await run(sessionAs(ROLE.PLAYER), `${COMMAND_PREFIX}smite`), true);
  assert.match(said[0], /needs admin; you are player/);

  await run(sessionAs(ROLE.ADMIN), `${COMMAND_PREFIX}smite`);
  assert.deepEqual(said, ["done"]);
});

test("a command that throws answers with the reason and keeps the session", async () => {
  assert.equal(await run(sessionAs(ROLE.PLAYER), `${COMMAND_PREFIX}boom`), true);
  assert.match(said[0], /the floor gave way/);
});

/**
 * The rank shares a column with the dungeon-entry override, which is bit zero.
 * They have to be able to coexist, because an admin who cannot enter a dungeon
 * is not much of one.
 */
test("a rank rides in admin_flags without disturbing the override bit", () => {
  assert.equal(roleOf({ admin_flags: 0 }), ROLE.PLAYER);
  assert.equal(roleOf({ admin_flags: 1 }), ROLE.PLAYER, "the override bit is not a rank");

  const both = withRole(1, ROLE.ADMIN);
  assert.equal(roleOf({ admin_flags: both }), ROLE.ADMIN);
  assert.equal(BigInt(both) & 1n, 1n, "and the override survived");
});

test("a rank this server does not know is not a licence", () => {
  assert.equal(roleOf({ admin_flags: BigInt(99) << 8n }), ROLE.PLAYER);
  assert.equal(roleOf({ admin_flags: -5 }), ROLE.PLAYER);
  assert.equal(roleOf({ admin_flags: "not a number" }), ROLE.PLAYER);
  assert.equal(roleOf(null), ROLE.PLAYER);
});

import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import { COMMAND_PREFIX, commands, resetCommands, runCommand } from "../src/socket/commands.js";
import { registerBuiltinCommands } from "../src/socket/command-set.js";
import { ROLE, withRole } from "../src/socket/roles.js";

/**
 * `/help` is a list short enough to read, and `/help <name>` is the sentence.
 *
 * It used to answer with a line for every command, each sent as its own chat
 * message: fifteen commands were fifteen messages, which pushed a third of the
 * client's fifty-line log off the top and drew every one of them as a balloon.
 * Nobody asking what exists wants every description at once. So the bare
 * command names them, in one message, and the description is asked for by name.
 */

const sessionAs = (rank) => ({
  id: 3,
  accountId: 500,
  dungeonAccount: { id: 500, name: "Simetra", admin_flags: String(withRole(0, rank)) },
});

let said = [];
const run = async (session, line) => {
  said = [];
  const reply = (message) => said.push(message);
  reply.warn = (message) => said.push(`! ${message}`);
  await runCommand(session, `${COMMAND_PREFIX}${line}`, reply);
  return said.join("\n");
};

test.beforeEach(() => {
  resetCommands();
  registerBuiltinCommands();
});

test("help is one message that names every command the caller may run", async () => {
  const text = await run(sessionAs(ROLE.PLAYER), "help");

  assert.equal(said.length, 1, "one chat entry, however many commands there are");
  assert.ok(text.split("\n").length <= 3, "and short enough to read at a glance");
  for (const command of commands().filter((entry) => entry.role === ROLE.PLAYER)) {
    assert.ok(text.includes(`${COMMAND_PREFIX}${command.name}`), `${command.name} is listed`);
  }
  assert.doesNotMatch(text, /\/hp|\/complete/, "a player is not shown what a player cannot run");
  assert.match(text, /\/help <command>/, "and it says how to ask about one");
});

test("an admin's commands are listed apart from everybody's", async () => {
  const text = await run(sessionAs(ROLE.ADMIN), "help");

  assert.equal(said.length, 1);
  const admin = text.split("\n").find((line) => line.startsWith("admin:"));
  assert.ok(admin, text);
  assert.match(admin, /\/hp/);
  assert.match(admin, /\/complete/);
  assert.doesNotMatch(admin, /\/where/, "what everybody has is not repeated under a rank");
});

test("help with a name says what that command does and how it is written", async () => {
  assert.equal(
    await run(sessionAs(ROLE.PLAYER), "help near"),
    `${COMMAND_PREFIX}near [reach] — list the monsters and props around you`
  );
  // With the prefix too, which is how somebody who has just read the list types it.
  assert.match(await run(sessionAs(ROLE.PLAYER), "help /where"), /^\/where — /);
});

test("help does not describe what the caller cannot run, or what does not exist", async () => {
  assert.match(await run(sessionAs(ROLE.PLAYER), "help hp"), /! \/hp needs admin/);
  assert.match(await run(sessionAs(ROLE.PLAYER), "help nonsense"), /! unknown command "nonsense"/);
  assert.match(await run(sessionAs(ROLE.ADMIN), "help hp"), /^\/hp \[amount\] — /);
});

/**
 * docs/chat-commands.md lists the commands for somebody who has not started
 * the server yet. A list kept by hand goes stale the day a command is added,
 * so it is held against the registry: every command is in a table row, written
 * the way `/help <command>` writes it, and every row is a command that exists.
 */
test("the commands page lists exactly the commands the server has, the ranked mode's apart", async () => {
  const page = await readFile(new URL("../docs/chat-commands.md", import.meta.url), "utf8");
  const rows = [...page.matchAll(/^\| `(\/[^`]+)` \|/gm)].map((match) => match[1]);

  // A mode's commands are on the page under the mode, and in the registry
  // only while the mode is on.
  const { installRankedCommands } = await import("../src/ranked/commands.js");
  const uninstall = installRankedCommands({ bookWords: { part: (k) => k }, loadExistingAccount: async () => null });
  try {
    const expected = commands().map(
      (command) => `${COMMAND_PREFIX}${command.name}${command.usage ? ` ${command.usage}` : ""}`
    );
    assert.deepEqual([...rows].sort(), [...expected].sort());
  } finally {
    uninstall();
  }
});

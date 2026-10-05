import assert from "node:assert/strict";
import test from "node:test";

import { commands, resetCommands, runCommand } from "../src/socket/commands.js";
import { installRankedCommands } from "../src/ranked/commands.js";
import { installRankedHooks } from "../src/ranked/hooks.js";

const session = { accountId: 7, dungeonAccount: { name: "Ash", rank: 0 } };
const part = (key) => key;

test("the ranked mode's commands come with the mode and go with it", async () => {
  resetCommands();
  const uninstall = installRankedCommands({ bookWords: { part }, loadExistingAccount: async () => null });
  assert.deepEqual(commands().map((c) => [c.name, c.mode]), [["rank", "ranked"], ["draw", "ranked"]]);
  uninstall();
  assert.deepEqual(commands(), [], "a mode that stopped left its commands behind");
});

test("/draw outside a race is refused, inside one it reaches the mode", async () => {
  resetCommands();
  const uninstall = installRankedCommands({ bookWords: { part }, loadExistingAccount: async () => null });
  const replies = [];
  const reply = (line) => replies.push(line);
  reply.warn = (line) => replies.push(`warn: ${line}`);
  try {
    await runCommand(session, "/draw", reply);
    assert.match(replies.at(-1), /warn: you are not in a ranked race/);

    let offered = 0;
    const unhook = installRankedHooks({ drawOffered: () => (offered++, true) });
    await runCommand(session, "/draw", reply);
    unhook();
    assert.equal(offered, 1);
    assert.match(replies.at(-1), /^offered/);
  } finally {
    uninstall();
  }
});

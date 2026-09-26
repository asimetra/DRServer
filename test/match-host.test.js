import test from "node:test";
import assert from "node:assert/strict";

import { installMatchHost, localMatchHost, matchHost } from "../src/socket/match-host.js";

const recordingHost = (calls) =>
  Object.fromEntries(
    Object.keys(localMatchHost)
      .filter((key) => key !== "kind")
      .map((key) => [key, (...args) => calls.push([key, ...args])])
  );

test("a thread starts with the local host", () => {
  assert.equal(matchHost(), localMatchHost);
  assert.equal(matchHost().kind, "local");
});

test("a host missing any service is refused before it is installed", () => {
  const partial = recordingHost([]);
  delete partial.saveAccount;
  assert.throws(() => installMatchHost(partial), /missing saveAccount/);
  assert.equal(matchHost(), localMatchHost);
});

test("an installed host receives what the match asks for, and can be put back", async () => {
  const calls = [];
  const previous = installMatchHost(recordingHost(calls));
  try {
    const { queueAccountSave } = await import("../src/socket/rewards.js");
    const account = { id: 1000000077 };
    await queueAccountSave({ id: 1, dungeonAccount: account });
    assert.deepEqual(calls, [["saveAccount", account]]);
  } finally {
    installMatchHost(previous);
  }
  assert.equal(matchHost(), localMatchHost);
});

test("a session's own persistence still wins over the host", async () => {
  const calls = [];
  const previous = installMatchHost(recordingHost(calls));
  try {
    const { queueAccountSave } = await import("../src/socket/rewards.js");
    const saved = [];
    await queueAccountSave({
      id: 2,
      dungeonAccount: { id: 1000000078 },
      persistDungeonAccount: (account) => saved.push(account.id),
    });
    assert.deepEqual(saved, [1000000078]);
    assert.deepEqual(calls, []);
  } finally {
    installMatchHost(previous);
  }
});

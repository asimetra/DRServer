import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYER_REQUEST_ENTRY,
  PLAYER_REQUEST_HERO,
  clearEntryHandshake,
  noteEntryHandshake,
  waitForEntryHandshake,
} from "../src/socket/entry-handshake.js";

test("an early loading signal is consumed by the later waiter", async () => {
  const session = {};
  assert.equal(noteEntryHandshake(session, PLAYER_REQUEST_ENTRY), true);
  assert.equal(await waitForEntryHandshake(session, PLAYER_REQUEST_ENTRY, 1000), true);
  assert.equal(session.entryHandshake, undefined);
});

test("entry and hero readiness wake only their own phase", async () => {
  const session = {};
  const entry = waitForEntryHandshake(session, PLAYER_REQUEST_ENTRY, 1000);
  const hero = waitForEntryHandshake(session, PLAYER_REQUEST_HERO, 1000);

  noteEntryHandshake(session, PLAYER_REQUEST_ENTRY);
  assert.equal(await entry, true);
  let heroSettled = false;
  hero.then(() => (heroSettled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heroSettled, false);

  noteEntryHandshake(session, PLAYER_REQUEST_HERO);
  assert.equal(await hero, true);
});

test("teardown releases a pending handshake without waiting for its timeout", async () => {
  const session = {};
  const waiting = waitForEntryHandshake(session, PLAYER_REQUEST_ENTRY, 60_000);
  clearEntryHandshake(session);
  assert.equal(await waiting, false);
  assert.equal(session.entryHandshake, undefined);
});

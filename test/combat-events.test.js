import assert from "node:assert/strict";
import test from "node:test";

import { installModeHooks } from "../src/modes/hooks.js";
import { tellDowned, tellHit, tellRevived } from "../src/socket/combat-events.js";

/** A mode that keeps what it hears. */
const listening = (t) => {
  const heard = [];
  const uninstall = installModeHooks("listener", { combatEvent: (session, event) => heard.push([session, event]) });
  t.after(uninstall);
  return heard;
};

test("a credited hit is heard with its target and amount, and the last one as a kill", (t) => {
  const heard = listening(t);
  const session = { id: "s" };
  tellHit(session, 40, { constant: "SKELETON" }, 12, false);
  tellHit(session, 40, { constant: "SKELETON" }, 3, true);
  assert.deepEqual(heard.map(([, event]) => event), [
    { type: "hit", target: { doid: 40, constant: "SKELETON" }, amount: 12 },
    { type: "hit", target: { doid: 40, constant: "SKELETON" }, amount: 3 },
    { type: "killed", target: { doid: 40, constant: "SKELETON" } },
  ]);
  assert.ok(heard.every(([who]) => who === session), "to whoever was credited");
});

test("a hit that took nothing is not a hit, but a kill still is", (t) => {
  const heard = listening(t);
  tellHit({}, 41, { constant: "BAT" }, 0, true);
  assert.deepEqual(heard.map(([, event]) => event.type), ["killed"]);
});

test("down and up go to the hero's own player when the world knows them, else to the context that ran it", (t) => {
  const heard = listening(t);
  const context = { id: "ran-it" };
  tellDowned(context, 9);
  tellRevived(context, 9, "ally");
  assert.deepEqual(heard.map(([, event]) => event), [
    { type: "downed", hero: 9 },
    { type: "revived", hero: 9, by: "ally" },
  ]);
  assert.ok(heard.every(([who]) => who === context));
});

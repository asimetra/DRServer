import assert from "node:assert/strict";
import test from "node:test";

import { declaredCapabilities, declares } from "../src/socket/capabilities.js";
import { memberSnapshot } from "../src/socket/match-worker-pool.js";

test("a client's capabilities are read from its Demographics, as a string of JSON or the object", () => {
  assert.deepEqual(declaredCapabilities({ capabilities: ["ranked.notices@1"] }), ["ranked.notices@1"]);
  assert.deepEqual(
    declaredCapabilities(JSON.stringify({ contentPacks: ["knight@1"], capabilities: ["ranked.entry@1", "ranked.notices@2"] })),
    ["ranked.entry@1", "ranked.notices@2"]
  );
  assert.deepEqual(declaredCapabilities({ capabilities: ["a@1", "a@1"] }), ["a@1"], "once each");
});

test("anything that is not a name and a version is not a capability", () => {
  for (const junk of [undefined, null, "", "{not json", "x".repeat(5000), { capabilities: "ranked.notices@1" }, { capabilities: [7] }]) {
    assert.deepEqual(declaredCapabilities(junk), []);
  }
  assert.deepEqual(
    declaredCapabilities({ capabilities: ["ranked.notices", "Ranked.Notices@1", "ranked..notices@1", "ranked.notices@0", "../x@1", "ok@1"] }),
    ["ok@1"]
  );
  assert.equal(declaredCapabilities({ capabilities: Array.from({ length: 50 }, (_, i) => `f${i}@1`) }).length, 32, "bounded");
});

test("declaring is exact, version and all, and travels with the player to a match worker", () => {
  const session = { accountId: 7, capabilities: declaredCapabilities({ capabilities: ["ranked.notices@1"] }) };
  assert.equal(declares(session, "ranked.notices@1"), true);
  assert.equal(declares(session, "ranked.notices@2"), false);
  assert.equal(declares({}, "ranked.notices@1"), false);
  assert.deepEqual(memberSnapshot(session).capabilities, ["ranked.notices@1"]);
  assert.deepEqual(memberSnapshot({ accountId: 7 }).capabilities, []);
});

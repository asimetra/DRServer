import assert from "node:assert/strict";
import test from "node:test";

import { isMemberSession, MemberSession } from "../src/socket/member-session.js";
import { memberSessionOf } from "../src/socket/match-world.js";

test("MemberSession marks connection-owned state without changing its public shape", () => {
  const member = new MemberSession({
    id: 7,
    accountId: 1000000005,
    objects: new Map(),
  });

  assert.equal(isMemberSession(member), true);
  assert.equal(isMemberSession({ id: 7 }), false);
  assert.equal(memberSessionOf(member), member);
  assert.deepEqual(Object.keys(member), ["id", "accountId", "objects"]);
});

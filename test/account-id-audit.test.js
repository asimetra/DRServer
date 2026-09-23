import assert from "node:assert/strict";
import test from "node:test";

import {
  auditAccountObjectIds,
  reassignDuplicateAttributeIds,
} from "../tools/account-id-audit.js";

test("persistent object ID audit reports cross-account and cross-table collisions", () => {
  const result = auditAccountObjectIds([
    { id: 1, account_items: [{ id: 100 }], account_avatars: [{ id: 101 }] },
    { id: 2, account_items: [{ id: 101 }], account_attributes: [{ id: 0 }] },
  ]);

  assert.deepEqual(result.collisions, [{
    id: 101,
    entries: [
      { accountId: 1, table: "account_avatars", index: 0 },
      { accountId: 2, table: "account_items", index: 0 },
    ],
  }]);
  assert.deepEqual(result.invalid, [
    { id: 0, accountId: 2, table: "account_attributes", index: 0 },
  ]);
});

test("automatic repair changes only later duplicate attribute rows", () => {
  const accounts = [
    { id: 1, account_attributes: [{ id: 100 }] },
    { id: 2, account_attributes: [{ id: 100 }], account_items: [{ id: 200 }] },
  ];

  assert.deepEqual(reassignDuplicateAttributeIds(accounts), [{
    oldId: 100,
    newId: 201,
    accountId: 2,
    table: "account_attributes",
    index: 0,
  }]);
  assert.equal(accounts[0].account_attributes[0].id, 100);
  assert.equal(accounts[1].account_attributes[0].id, 201);
  assert.equal(accounts[1].account_items[0].id, 200);
  assert.equal(auditAccountObjectIds(accounts).collisions.length, 0);
});

test("automatic repair refuses referenced item collisions", () => {
  const accounts = [
    { id: 1, account_items: [{ id: 100 }] },
    { id: 2, account_items: [{ id: 100 }] },
  ];
  assert.throws(
    () => reassignDuplicateAttributeIds(accounts),
    /limited to duplicate account_attributes/
  );
});

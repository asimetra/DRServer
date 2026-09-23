import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_OBJECT_ID_FLOOR,
  CLIENT_LOCAL_OBJECT_ID_MAX,
  CLIENT_LOCAL_OBJECT_ID_MIN,
} from "../src/account-object-ids.js";
import { createDistributedObjectIdAllocator } from "../src/socket/doids.js";

test("distributed ids skip the complete client-local object range", () => {
  const skips = [];
  const allocate = createDistributedObjectIdAllocator({
    start: CLIENT_LOCAL_OBJECT_ID_MIN - 1,
    onLocalRangeSkipped: (event) => skips.push(event),
  });

  assert.equal(allocate(), CLIENT_LOCAL_OBJECT_ID_MIN - 1);
  assert.equal(allocate(), CLIENT_LOCAL_OBJECT_ID_MAX + 1);
  assert.deepEqual(skips, [{
    from: CLIENT_LOCAL_OBJECT_ID_MIN,
    to: CLIENT_LOCAL_OBJECT_ID_MAX + 1,
  }]);
});

test("an allocator restored inside the client-local range skips its remainder", () => {
  const allocate = createDistributedObjectIdAllocator({
    start: CLIENT_LOCAL_OBJECT_ID_MAX,
  });

  assert.equal(allocate(), CLIENT_LOCAL_OBJECT_ID_MAX + 1);
});

test("distributed ids cannot enter the persistent account object range", () => {
  const allocateLast = createDistributedObjectIdAllocator({
    start: ACCOUNT_OBJECT_ID_FLOOR - 1,
  });
  assert.equal(allocateLast(), ACCOUNT_OBJECT_ID_FLOOR - 1);
  assert.throws(() => allocateLast(), /object id space exhausted/);

  const allocatePastEnd = createDistributedObjectIdAllocator({
    start: ACCOUNT_OBJECT_ID_FLOOR,
  });
  assert.throws(() => allocatePastEnd(), /object id space exhausted/);
});

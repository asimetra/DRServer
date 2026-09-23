import {
  ACCOUNT_OBJECT_ID_FLOOR,
  CLIENT_LOCAL_OBJECT_ID_MAX,
  isClientLocalObjectId,
} from "../account-object-ids.js";

/**
 * Creates the process-wide allocator for ephemeral distributed objects.
 *
 * The native client owns 1,000,000..1,099,999 for objects it creates locally,
 * while persistent heroes/items begin at 1.2 billion. Server objects may use
 * neither range: sharing a number makes the client's GameObject lookup return
 * the wrong instance.
 */
export const createDistributedObjectIdAllocator = ({
  start = 1000,
  onLocalRangeSkipped = () => {},
} = {}) => {
  let next = Number(start);

  return () => {
    if (!Number.isSafeInteger(next) || next <= 0) {
      throw new RangeError(`invalid distributed object id ${next}`);
    }
    if (isClientLocalObjectId(next)) {
      const skippedFrom = next;
      next = CLIENT_LOCAL_OBJECT_ID_MAX + 1;
      onLocalRangeSkipped({ from: skippedFrom, to: next });
    }
    if (next >= ACCOUNT_OBJECT_ID_FLOOR) {
      throw new RangeError(
        `distributed object id space exhausted before persistent range ${ACCOUNT_OBJECT_ID_FLOOR}`
      );
    }
    return next++;
  };
};

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
  offset = 0,
  stride = 1,
  onLocalRangeSkipped = () => {},
} = {}) => {
  /**
   * `stride` and `offset` split one id space between threads that allocate at
   * once: with matches in workers, thread k of n takes every n-th id from its
   * own offset, so no two threads can hand out the same doid and none of them
   * runs out before the others.
   */
  const step = Number(stride);
  const lane = Number(offset);
  if (!Number.isSafeInteger(step) || step < 1) throw new RangeError(`invalid doid stride ${stride}`);
  if (!Number.isSafeInteger(lane) || lane < 0 || lane >= step) {
    throw new RangeError(`invalid doid offset ${offset} for stride ${stride}`);
  }
  const first = Number(start) + lane;
  let next = first;

  /** The first id at or after `value` that belongs to this lane. */
  const inLane = (value) => value + ((((first - value) % step) + step) % step);

  return () => {
    if (!Number.isSafeInteger(next) || next <= 0) {
      throw new RangeError(`invalid distributed object id ${next}`);
    }
    if (isClientLocalObjectId(next)) {
      const skippedFrom = next;
      next = inLane(CLIENT_LOCAL_OBJECT_ID_MAX + 1);
      onLocalRangeSkipped({ from: skippedFrom, to: next });
    }
    if (next >= ACCOUNT_OBJECT_ID_FLOOR) {
      throw new RangeError(
        `distributed object id space exhausted before persistent range ${ACCOUNT_OBJECT_ID_FLOOR}`
      );
    }
    const id = next;
    next += step;
    return id;
  };
};

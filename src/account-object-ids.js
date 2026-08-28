/**
 * `LocalUniqueID` in the native client reserves this range for client-created
 * GameObjects. An account avatar id is also used as its in-dungeon hero doid,
 * so putting persistent rows in this range makes the hero collide with a local
 * object before it can be attached to its dungeon floor.
 */
export const CLIENT_LOCAL_OBJECT_ID_MIN = 1_000_000;
export const CLIENT_LOCAL_OBJECT_ID_MAX = 1_099_999;

/** New persistent account rows live well above the client's local id range. */
export const ACCOUNT_OBJECT_ID_FLOOR = 1_200_000_000;

/** Native collection lookups coerce distributed ids through signed Int keys. */
export const CLIENT_PERSISTENT_OBJECT_ID_MAX = 0x7fffffff;

/**
 * Legacy file/Postgres sequences started at 1,000,000. Moving an old avatar by
 * this fixed offset is deterministic, preserves references across restarts and
 * leaves a gap before newly allocated account rows.
 */
export const LEGACY_AVATAR_ID_OFFSET = 1_100_000_000;

export const isClientLocalObjectId = (id) =>
  Number.isInteger(id) &&
  id >= CLIENT_LOCAL_OBJECT_ID_MIN &&
  id <= CLIENT_LOCAL_OBJECT_ID_MAX;

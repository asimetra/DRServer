/**
 * Every dungeon save still on its way to storage, in this thread.
 *
 * A run announces its saves on `session.rewardSavePromise`, and for as long as
 * the session is in the dungeon that is the place to look. Leaving is where it
 * stops being: the teardown runs synchronously, starts the settle, and deletes
 * the field along with everything else the run owned. Shutdown closes every
 * session and *then* asks what is still being written — by which point the
 * sessions no longer know.
 *
 * So the saves are also kept here, by the promise rather than by the session,
 * and forgotten only when they have landed or failed.
 */
const inFlight = new Set();

export const trackRunSave = (pending) => {
  inFlight.add(pending);
  const forget = () => inFlight.delete(pending);
  pending.then(forget, forget);
  return pending;
};

/** Waits until no dungeon save is in flight, including any queued meanwhile. */
export const waitForRunSaves = async () => {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
};

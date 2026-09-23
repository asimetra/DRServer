export const PLAYER_REQUEST_HERO = 184;
export const PLAYER_REQUEST_ENTRY = 185;

const stateOf = (session) => {
  const member = session?.member ?? session;
  member.entryHandshake ??= { pending: new Set(), waiters: new Map() };
  return { member, state: member.entryHandshake };
};

/** Records an owner-player readiness field, waking its current waiter if any. */
export const noteEntryHandshake = (session, fieldId) => {
  if (fieldId !== PLAYER_REQUEST_ENTRY && fieldId !== PLAYER_REQUEST_HERO) return false;
  const { state } = stateOf(session);
  const waiting = state.waiters.get(fieldId);
  if (waiting) waiting(true);
  else state.pending.add(fieldId);
  return true;
};

/**
 * Waits for one readiness field, with the old fixed delay as compatibility
 * fallback for clients/probes that do not implement the handshake.
 */
export const waitForEntryHandshake = (session, fieldId, timeoutMs) => {
  const { member, state } = stateOf(session);
  if (state.pending.delete(fieldId)) {
    if (!state.waiters.size && !state.pending.size) delete member.entryHandshake;
    return Promise.resolve(true);
  }
  const previous = state.waiters.get(fieldId);
  if (previous) {
    previous(false);
    return waitForEntryHandshake(session, fieldId, timeoutMs);
  }

  return new Promise((resolve) => {
    let timer;
    const finish = (received) => {
      if (state.waiters.get(fieldId) !== finish) return;
      state.waiters.delete(fieldId);
      clearTimeout(timer);
      if (!state.waiters.size && !state.pending.size) delete member.entryHandshake;
      resolve(received);
    };
    state.waiters.set(fieldId, finish);
    timer = setTimeout(() => finish(false), Math.max(0, Number(timeoutMs) || 0));
  });
};

/** Cancels entry waits when a session leaves or its socket disappears. */
export const clearEntryHandshake = (session) => {
  const member = session?.member ?? session;
  const state = member?.entryHandshake;
  if (!state) return;
  for (const finish of state.waiters.values()) finish(false);
  delete member.entryHandshake;
};

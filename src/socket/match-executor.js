/**
 * Where a match runs, behind the two calls the MatchMaker and doors make.
 *
 * This one runs it here, in this thread, by calling the dungeon runtime
 * directly. match-worker-pool.js has the other, which runs it in a worker; the
 * callers hold `matchExecutor` (match-runtime.js) and never learn which.
 */
export class LocalMatchExecutor {
  constructor({ joinRuntime, leaveRuntime } = {}) {
    if (typeof joinRuntime !== "function" || typeof leaveRuntime !== "function") {
      throw new Error("LocalMatchExecutor needs join and leave runtime functions");
    }
    this.joinRuntime = joinRuntime;
    this.leaveRuntime = leaveRuntime;
  }

  join(session, result, request, options = {}) {
    return this.joinRuntime(session, result, request, options);
  }

  leave(session, options = {}) {
    return this.leaveRuntime(session, options);
  }
}

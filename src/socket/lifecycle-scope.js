import { error as logError } from "../log.js";

/**
 * Owns asynchronous resources that must end with one gameplay lifetime.
 *
 * A scope can own timers, arbitrary cleanup callbacks, and child scopes. Timer
 * callbacks remove themselves after firing, so a long run does not retain a
 * history of already completed work. Disposal is idempotent and always tries
 * every cleanup even when one of them fails.
 *
 * A timer callback that throws is contained here. A timer is the one place
 * gameplay runs with nothing above it: the throw went to the process, and with
 * every dungeon in one thread a single buff expiring badly ended all of them.
 * It is reported — to `onTimerError`, or the log when nobody asked — and the
 * scope carries on; an interval keeps its later ticks.
 */
export class LifecycleScope {
  constructor(label = "scope", { onError = null, onTimerError = null, parent = null } = {}) {
    this.label = String(label);
    this.onError = onError;
    this.onTimerError = onTimerError;
    this.parent = parent;
    this.disposed = false;
    this.resources = new Map();
    this.children = new Set();
  }

  get activeResourceCount() {
    return this.resources.size;
  }

  get activeChildCount() {
    return this.children.size;
  }

  /** Registers an arbitrary cleanup and returns a function that only unregisters it. */
  defer(cleanup) {
    if (typeof cleanup !== "function") throw new TypeError("scope cleanup must be a function");
    if (this.disposed) {
      this.runCleanup(cleanup);
      return () => false;
    }
    const token = Symbol(this.label);
    this.resources.set(token, cleanup);
    return () => this.resources.delete(token);
  }

  timeout(callback, delay, { unref = true } = {}) {
    if (this.disposed) return null;
    let handle;
    handle = setTimeout((...args) => {
      this.resources.delete(handle);
      if (!this.disposed) this.runTimer(callback, args);
    }, Math.max(0, Number(delay) || 0));
    this.resources.set(handle, () => clearTimeout(handle));
    if (unref) handle?.unref?.();
    return handle;
  }

  interval(callback, delay, { unref = true } = {}) {
    if (this.disposed) return null;
    const handle = setInterval((...args) => {
      if (!this.disposed) this.runTimer(callback, args);
    }, Math.max(1, Number(delay) || 1));
    this.resources.set(handle, () => clearInterval(handle));
    if (unref) handle?.unref?.();
    return handle;
  }

  cancel(handle) {
    const cleanup = this.resources.get(handle);
    if (!cleanup) return false;
    this.resources.delete(handle);
    this.runCleanup(cleanup);
    return true;
  }

  child(label) {
    const child = new LifecycleScope(label, {
      onError: this.onError,
      onTimerError: this.onTimerError,
      parent: this,
    });
    if (this.disposed) {
      child.dispose();
      return child;
    }
    this.children.add(child);
    return child;
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    this.parent?.children.delete(this);

    for (const child of [...this.children].reverse()) child.dispose();
    this.children.clear();
    for (const [token, cleanup] of [...this.resources].reverse()) {
      // A later cleanup may have explicitly cancelled this resource already.
      if (!this.resources.delete(token)) continue;
      this.runCleanup(cleanup);
    }
    return true;
  }

  runTimer(callback, args) {
    try {
      callback(...args);
    } catch (problem) {
      if (this.onTimerError) this.onTimerError(problem, this);
      else reportTimerFailure(this.label, problem);
    }
  }

  runCleanup(cleanup) {
    try {
      cleanup();
    } catch (error) {
      this.onError?.(error, this);
    }
  }
}

/**
 * Says a timer failed, without saying it fifty times a second.
 *
 * An interval that throws once usually throws every time, and the projectile
 * tick runs every twenty milliseconds: a full stack per tick fills a disk
 * faster than anybody reads it. The first failure of a kind is logged whole;
 * after that it is counted, and the count is reported every ten seconds.
 */
const REPORT_EVERY_MS = 10_000;
const reported = new Map();

const reportTimerFailure = (label, problem, now = Date.now()) => {
  const key = `${label}|${problem?.message ?? problem}`;
  const seen = reported.get(key);
  if (!seen) {
    if (reported.size > 500) reported.clear();
    reported.set(key, { at: now, repeats: 0 });
    logError(`${label}: timer callback failed: ${problem?.stack ?? problem}`);
    return;
  }
  seen.repeats += 1;
  if (now - seen.at < REPORT_EVERY_MS) return;
  logError(
    `${label}: timer callback failed ${seen.repeats} more time(s): ${problem?.message ?? problem}`
  );
  seen.at = now;
  seen.repeats = 0;
};

/** Cancels a scoped timer, with a native-timer fallback for fixture sessions. */
export const cancelScopedTimer = (scope, handle, clear = clearTimeout) => {
  if (handle == null) return false;
  if (scope?.cancel(handle)) return true;
  clear(handle);
  return true;
};

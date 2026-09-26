/**
 * Owns asynchronous resources that must end with one gameplay lifetime.
 *
 * A scope can own timers, arbitrary cleanup callbacks, and child scopes. Timer
 * callbacks remove themselves after firing, so a long run does not retain a
 * history of already completed work. Disposal is idempotent and always tries
 * every cleanup even when one of them fails.
 */
export class LifecycleScope {
  constructor(label = "scope", { onError = null, parent = null } = {}) {
    this.label = String(label);
    this.onError = onError;
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
      if (!this.disposed) callback(...args);
    }, Math.max(0, Number(delay) || 0));
    this.resources.set(handle, () => clearTimeout(handle));
    if (unref) handle?.unref?.();
    return handle;
  }

  interval(callback, delay, { unref = true } = {}) {
    if (this.disposed) return null;
    const handle = setInterval((...args) => {
      if (!this.disposed) callback(...args);
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
    const child = new LifecycleScope(label, { onError: this.onError, parent: this });
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

  runCleanup(cleanup) {
    try {
      cleanup();
    } catch (error) {
      this.onError?.(error, this);
    }
  }
}

/** Cancels a scoped timer, with a native-timer fallback for fixture sessions. */
export const cancelScopedTimer = (scope, handle, clear = clearTimeout) => {
  if (handle == null) return false;
  if (scope?.cancel(handle)) return true;
  clear(handle);
  return true;
};

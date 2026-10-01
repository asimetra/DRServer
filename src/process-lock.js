import fs from "node:fs/promises";
import { constants as fsConstants, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { info } from "./log.js";

export class ProcessLockHeldError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessLockHeldError";
  }
}

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (problem) {
    return problem.code !== "ESRCH";
  }
};

/**
 * Which boot of the machine this is, where the kernel says. Null elsewhere, and
 * then the checks that need it are skipped rather than guessed.
 */
const currentBootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
};

/**
 * When a process started, as the kernel counts it: field 22 of its stat line,
 * in clock ticks since boot. The command name before it may itself hold spaces
 * and brackets, so the fields are counted from the last closing one.
 */
const processStartOf = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

/** Which pid namespace this process is in; ids only mean anything within one. */
const currentPidNamespace = () => {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
};

/**
 * Whether the process a lock names still holds it.
 *
 * An id being in use says very little: ids are handed out again. The server
 * found its own id in a lock its predecessor left — every start in a container
 * has the same one — took the storage to be in use, and refused to start until
 * the file was deleted by hand. After a power cut on a host, the same happened
 * whenever the old id had gone to some other daemon.
 *
 * So the lock records which boot it was written in, which pid namespace, and
 * when its writer started. Where this process shares both with the writer, it
 * can see for itself: no such process, or one that started at another time, is
 * not the writer.
 *
 * Where it does not share them, what it sees means nothing. A server in a
 * container is process 1 there, and from the host process 1 is init — alive,
 * and started at a different time, which reads exactly like an id that was
 * handed on. A different boot id is another machine on the same directory as
 * easily as a reboot. Those are `unseen`, and are settled by the one thing
 * visible from anywhere: whether the holder is still touching its lock.
 *
 * A lock written before any of this was recorded is judged the way it used to
 * be, except that this process's own id is no longer taken for a live owner.
 */
const GONE = "gone";
const ALIVE = "alive";
const UNSEEN = "unseen";

const ownerState = (owner, { pid, isAlive, bootId, pidNamespace, startOf }) => {
  const recorded = owner.bootId != null || owner.pidNamespace != null;
  const sameView = recorded
    ? owner.bootId === bootId && owner.pidNamespace === pidNamespace
    : // An old lock, or a system with no /proc on either side: ids are all there is.
      owner.heartbeatMs != null && bootId == null && pidNamespace == null;

  if (sameView) {
    // Not this process — it is still asking — and ids are unique in one view.
    if (owner.pid === pid) return GONE;
    if (!isAlive(owner.pid)) return GONE;
    const startedNow = owner.processStart ? startOf(owner.pid) : null;
    return startedNow && startedNow !== owner.processStart ? GONE : ALIVE;
  }
  if (recorded || owner.heartbeatMs != null) return UNSEEN;
  if (owner.pid === pid) return UNSEEN;
  return isAlive(owner.pid) ? ALIVE : GONE;
};

/**
 * How often a holder touches its lock, and how long an unseen holder's lock is
 * watched for that before it is taken for abandoned.
 *
 * Only an unseen holder waits on this. It costs a container restarted straight
 * after a crash up to this long at startup, and it is what keeps a new
 * container from taking the storage while the old one is still writing.
 */
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lock files this process holds, by the id that took them. */
const heldHere = new Map();

/**
 * Claims a file store for one process. A crashed owner's file is moved aside
 * atomically before retrying, so two replacements cannot both delete the new
 * owner's lock.
 *
 * `onLost` is called, once, if the lock stops being this process's while it
 * believes it holds it — taken by somebody who judged it abandoned, or deleted
 * by hand. The storage then has no owner, or another one.
 */
export const acquireFileProcessLock = async (
  dataDir,
  {
    pid = process.pid,
    isAlive = processIsAlive,
    bootId = currentBootId(),
    pidNamespace = currentPidNamespace(),
    startOf = processStartOf,
    heartbeatMs = HEARTBEAT_MS,
    staleAfterMs = STALE_AFTER_MS,
    onLost = null,
  } = {}
) => {
  await fs.mkdir(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, ".server.lock");
  const token = randomUUID();

  // Checked here because the file cannot tell: a lock naming this process's
  // own id reads as a predecessor's, which is right unless it is this one's.
  if (heldHere.get(lockFile) === pid) {
    throw new ProcessLockHeldError(`this process already holds the storage lock (${lockFile})`);
  }

  /**
   * Watches an unseen holder's lock for as long as a live one would take to
   * touch it several times over. Judged by whether the time on it *changes*,
   * not by what it says: two clocks need not agree, and a lock stamped an hour
   * ahead would otherwise look fresh for an hour.
   */
  const abandoned = async (owner) => {
    const touched = async () => (await fs.stat(lockFile)).mtimeMs;
    const first = await touched();
    const age = Date.now() - first;
    if (age > staleAfterMs) return true;

    info(
      `storage lock ${lockFile} belongs to a process this one cannot see (id ${owner.pid}); ` +
        `watching it for up to ${Math.ceil(staleAfterMs / 1000)}s to be sure it is not still running`
    );
    const until = Date.now() + staleAfterMs;
    while (Date.now() < until) {
      await sleep(Math.min(250, staleAfterMs));
      if ((await touched()) !== first) {
        throw new ProcessLockHeldError(
          `storage lock ${lockFile} is being kept fresh by process ${owner.pid}, which this one ` +
            "cannot see; is another server using this storage from a container or another machine?"
        );
      }
    }
    return true;
  };

  for (;;) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid,
            token,
            startedAt: new Date().toISOString(),
            bootId,
            pidNamespace,
            processStart: startOf(pid),
            heartbeatMs,
          })}\n`
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      heldHere.set(lockFile, pid);

      let released = false;
      let lost = false;
      const heartbeat = setInterval(async () => {
        try {
          const owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
          if (owner.token !== token) throw new Error("another token");
          const now = new Date();
          await fs.utimes(lockFile, now, now);
        } catch {
          if (released || lost) return;
          lost = true;
          clearInterval(heartbeat);
          heldHere.delete(lockFile);
          onLost?.(new Error(`storage lock ${lockFile} was taken by another process or removed`));
        }
      }, heartbeatMs);
      heartbeat.unref?.();

      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        heldHere.delete(lockFile);
        try {
          const owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
          if (owner.token === token) await fs.rm(lockFile);
        } catch (problem) {
          if (problem.code !== "ENOENT" && !(problem instanceof SyntaxError)) throw problem;
        }
      };
    } catch (problem) {
      if (problem.code !== "EEXIST") throw problem;
    }

    let owner;
    try {
      owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
    } catch (problem) {
      if (problem.code === "ENOENT") continue;
      throw new ProcessLockHeldError(
        `storage lock ${lockFile} is unreadable; refusing to risk a second writer. ` +
          "If no server or maintenance tool is running on this storage, delete the file"
      );
    }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) {
      throw new ProcessLockHeldError(
        `storage lock ${lockFile} has no valid owner; inspect it before starting another writer`
      );
    }
    const state = ownerState(owner, { pid, isAlive, bootId, pidNamespace, startOf });
    if (state === ALIVE) {
      throw new ProcessLockHeldError(
        `storage is already in use by process ${owner.pid} (${lockFile})`
      );
    }
    if (state === UNSEEN) {
      try {
        await abandoned(owner);
      } catch (problem) {
        if (problem.code === "ENOENT") continue;
        throw problem;
      }
    }

    const stale = `${lockFile}.stale-${owner.pid}-${randomUUID()}`;
    try {
      await fs.rename(lockFile, stale);
      await fs.rm(stale, { force: true });
    } catch (problem) {
      if (problem.code !== "ENOENT") throw problem;
    }
  }
};

/**
 * Claims whichever account backend this process is configured to mutate.
 *
 * `onLost` is called if the claim is taken away while this process still
 * believes it has it: the database connection that was the lock is gone for
 * good, or the lock file now names somebody else.
 */
export const acquireProcessLock = async ({ onLost = null } = {}) => {
  if (config.storage === "postgres") {
    const storage = await import("./storage/postgres.js");
    return storage.acquireServerProcessLock({ onLost });
  }
  return acquireFileProcessLock(config.dataDir, { onLost });
};

/**
 * What is wrong with the storage right now, or null. For the health check: a
 * server whose storage cannot be written, or whose claim on it has gone, is up
 * and answering and losing everything players do.
 */
export const storageProblem = async () => {
  if (config.storage === "postgres") {
    const storage = await import("./storage/postgres.js");
    return storage.connectionProblem();
  }
  try {
    await fs.access(config.dataDir, fsConstants.W_OK);
  } catch (problem) {
    return `data directory ${config.dataDir} cannot be written: ${problem.code ?? problem.message}`;
  }
  return heldHere.has(path.join(config.dataDir, ".server.lock"))
    ? null
    : "this server does not hold the storage lock";
};

/** Initializes backend state that requires both the current schema and ownership lock. */
export const initializeProcessStorage = async () => {
  if (config.storage !== "postgres") return;
  const storage = await import("./storage/postgres.js");
  await storage.initializeServerStorage();
};

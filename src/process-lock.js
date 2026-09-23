import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

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
 * Claims a file store for one process. A crashed owner's file is moved aside
 * atomically before retrying, so two replacements cannot both delete the new
 * owner's lock.
 */
export const acquireFileProcessLock = async (
  dataDir,
  { pid = process.pid, isAlive = processIsAlive } = {}
) => {
  await fs.mkdir(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, ".server.lock");
  const token = randomUUID();

  for (;;) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid, token, startedAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
          if (owner.token === token) await fs.rm(lockFile);
        } catch (problem) {
          if (problem.code !== "ENOENT") throw problem;
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
        `storage lock ${lockFile} is unreadable; refusing to risk a second writer`
      );
    }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) {
      throw new ProcessLockHeldError(
        `storage lock ${lockFile} has no valid owner; inspect it before starting another writer`
      );
    }
    if (isAlive(owner.pid)) {
      throw new ProcessLockHeldError(
        `storage is already in use by process ${owner.pid} (${lockFile})`
      );
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

/** Claims whichever account backend this process is configured to mutate. */
export const acquireProcessLock = async () => {
  if (config.storage === "postgres") {
    const storage = await import("./storage/postgres.js");
    return storage.acquireServerProcessLock();
  }
  return acquireFileProcessLock(config.dataDir);
};

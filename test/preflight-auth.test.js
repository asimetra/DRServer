import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { config } from "../src/config.js";
import { ensureSafeTransport, ensureTokenSecret } from "../src/preflight.js";

test("an existing signing-secret file is restricted to its owner", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions are not available");

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ods-secret-mode-"));
  const file = path.join(directory, "token-secret");
  await fs.writeFile(file, `${"s".repeat(32)}\n`, { mode: 0o644 });

  const previousDir = config.dataDir;
  const previousSecret = config.tokenSecret;
  config.dataDir = directory;
  config.tokenSecret = "";
  try {
    assert.equal(ensureTokenSecret(), "s".repeat(32));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    config.dataDir = previousDir;
    config.tokenSecret = previousSecret;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cleartext services refuse an accidental remote bind", () => {
  const previousHost = config.host;
  const previousAllowance = config.allowInsecureRemote;
  try {
    config.host = "0.0.0.0";
    config.allowInsecureRemote = false;
    assert.throws(() => ensureSafeTransport(), /refusing cleartext remote bind/);

    config.allowInsecureRemote = true;
    assert.equal(ensureSafeTransport(), false, "an explicit acknowledgement permits it");

    config.host = "127.0.0.1";
    config.allowInsecureRemote = false;
    assert.equal(ensureSafeTransport(), true);
  } finally {
    config.host = previousHost;
    config.allowInsecureRemote = previousAllowance;
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Not load-env.js: importing that one applies the developer's own .env to this
// process, which is the thing these functions exist to be tested without.
import { applyEnvFile, unreadEnvSettings } from "../src/env-file.js";

const envFileWith = async (t, text) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ods-env-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".env");
  await fs.writeFile(file, text);
  return { root, file };
};

test("the environment wins over the file, and the file fills in the rest", async (t) => {
  const { file } = await envFileWith(t, "ODS_STORAGE=postgres\nODS_PORT=9000\n");
  const environment = { ODS_PORT: "9100" };

  applyEnvFile(file, environment);
  assert.deepEqual(environment, { ODS_PORT: "9100", ODS_STORAGE: "postgres" });
});

/**
 * `.env.example` suggests `ODS_DATA_DIR=data`. The server, started by npm from
 * the repository, read that as the repository's `data/`. A tool run from any
 * other directory read the same line as `<that directory>/data`: an empty
 * store with a lock of its own, which it then wrote to and reported success.
 */
test("a relative path in the file means the same place wherever the tool is run from", async (t) => {
  const { root, file } = await envFileWith(
    t,
    "ODS_DATA_DIR=data\nDR_RESOURCES_DIR=../shared/Resources\nODS_CAPTURE_DIR=/var/captures\nODS_SERVER_NAME=relative/looking\n"
  );
  const environment = {};

  applyEnvFile(file, environment);
  assert.equal(environment.ODS_DATA_DIR, path.join(root, "data"));
  assert.equal(environment.DR_RESOURCES_DIR, path.resolve(root, "../shared/Resources"));
  assert.equal(environment.ODS_CAPTURE_DIR, "/var/captures", "an absolute path is left alone");
  assert.equal(environment.ODS_SERVER_NAME, "relative/looking", "and so is anything that is not a path");
});

test("a relative path given in the environment is the caller's, and is not rewritten", async (t) => {
  const { file } = await envFileWith(t, "ODS_DATA_DIR=data\n");
  const environment = { ODS_DATA_DIR: "elsewhere" };

  applyEnvFile(file, environment);
  assert.equal(environment.ODS_DATA_DIR, "elsewhere");
});

test("no file is no change", () => {
  const environment = { KEEP: "1" };
  assert.equal(applyEnvFile(path.join(os.tmpdir(), "ods-no-such-dir", ".env"), environment), false);
  assert.deepEqual(environment, { KEEP: "1" });
});

/**
 * Only `npm start` reads `.env`. Started any other way — `node src/index.js`
 * in a service file is the usual one — the server came up on the defaults,
 * file storage included, beside a `.env` that said PostgreSQL, and said nothing.
 */
test("a .env the server was started without is noticed", async (t) => {
  const { file } = await envFileWith(t, "# a comment\nODS_STORAGE=postgres\nODS_PORT=9000\n");

  assert.deepEqual(unreadEnvSettings(file, { ODS_PORT: "9000" }), ["ODS_STORAGE"]);
  assert.deepEqual(unreadEnvSettings(file, { ODS_PORT: "9000", ODS_STORAGE: "file" }), []);
  assert.deepEqual(unreadEnvSettings(path.join(os.tmpdir(), "ods-no-such-dir", ".env"), {}), []);
});

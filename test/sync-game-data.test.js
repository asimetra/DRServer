import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const tool = fileURLToPath(new URL("../tools/sync-game-data.js", import.meta.url));
const manifest = JSON.parse(
  await fs.readFile(new URL("../game-data/manifest.json", import.meta.url), "utf8")
);

/** A client tree holding every file the manifest names, with made-up contents. */
const clientWith = async (t, { without = [] } = {}) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "ods-client-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "ods-local-data-"));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  for (const entry of manifest.files) {
    if (without.includes(entry.source)) continue;
    const file = path.join(source, entry.source);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `{"made up for": ${JSON.stringify(entry.source)}}\n`);
  }
  const call = (...args) =>
    run(process.execPath, [tool, "--target", path.join(target, "Resources"), ...args], {
      env: { PATH: process.env.PATH },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (problem) => ({ code: problem.code, stdout: problem.stdout, stderr: problem.stderr })
    );
  return { source, target, call };
};

const STACK_FRAME = /^\s+at /m;

/**
 * The manifest records what each file hashed to in the client this server was
 * written against. Nothing compared against it: data from another version of
 * the client imported in silence, and the first sign was a dungeon behaving
 * differently from the one the server had been built to run.
 */
test("data that differs from the version the server was written against is pointed out", async (t) => {
  const { source, target, call } = await clientWith(t);

  const { code, stdout, stderr } = await call("--source", source);
  assert.equal(code, 0, "a different version is still importable");
  assert.match(stdout, new RegExp(`Imported ${manifest.files.length} compatibility-data files`));
  assert.match(stderr, new RegExp(`${manifest.files.length} of ${manifest.files.length} files differ`));
  assert.match(stderr, /DB_GameMaster\.json/);

  const copied = await fs.readFile(path.join(target, "Resources", "Levels", "DB_GameMaster.json"));
  const recorded = JSON.parse(await fs.readFile(path.join(target, "manifest.json"), "utf8"));
  assert.equal(
    recorded.files.find((entry) => entry.source === "Resources/Levels/DB_GameMaster.json").sha256,
    createHash("sha256").update(copied).digest("hex")
  );
  assert.equal((await call("--check")).code, 0, "and what was imported verifies");
});

test("a client missing some of the files is named file by file, and nothing is imported", async (t) => {
  const missing = ["Resources/Levels/DB_GameMaster.json", "Resources/Combat/AttackTimeline.json"];
  const { source, target, call } = await clientWith(t, { without: missing });

  const { code, stderr } = await call("--source", source);
  assert.equal(code, 1);
  for (const file of missing) assert.match(stderr, new RegExp(file.replace(/[.]/g, "\\.")));
  assert.match(stderr, /2 of \d+ files are missing/);
  assert.doesNotMatch(stderr, STACK_FRAME);
  assert.deepEqual(await fs.readdir(target), [], "a partial import is worse than none");
});

test("checking before anything was imported says so once", async (t) => {
  const { call } = await clientWith(t);

  const { code, stderr } = await call("--check");
  assert.equal(code, 1);
  assert.match(stderr, /Nothing has been imported/);
  assert.equal(stderr.trim().split("\n").length <= 3, true, stderr);
});

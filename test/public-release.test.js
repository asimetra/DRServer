import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const checker = new URL("../tools/check-public-release.js", import.meta.url);

/** A committed repository holding the files the gate requires, plus `extra`. */
const releaseFixture = async (t, { readme = "test\n", extra = {} } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ods-public-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "game-data"));
  await Promise.all([
    fs.writeFile(path.join(root, "LICENSE"), "test\n"),
    fs.writeFile(path.join(root, "NOTICE.md"), "test\n"),
    fs.writeFile(path.join(root, "README.md"), readme),
    fs.writeFile(path.join(root, "game-data", "manifest.json"), "{}\n"),
    ...Object.entries(extra).map(([name, text]) => fs.writeFile(path.join(root, name), text)),
  ]);
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
};

const check = (root) =>
  run(process.execPath, [checker.pathname], {
    env: { ...process.env, ODS_PUBLIC_RELEASE_ROOT: root },
  });

// Assembled, so that this file does not itself hold what the gate looks for.
const gameName = ["Dungeon", "Rampage"].join(" ");

test("the README may say which game this server is compatible with", async (t) => {
  const root = await releaseFixture(t, { readme: `A compatibility server for ${gameName}.\n` });
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "add fixture"], { cwd: root });

  const { stdout } = await check(root);
  assert.match(stdout, /Public-release check passed/);
});

test("the game's name is still refused everywhere but the README", async (t) => {
  const root = await releaseFixture(t, { extra: { "notes.md": `Ported from ${gameName}.\n` } });
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "add fixture"], { cwd: root });

  await assert.rejects(check(root), (problem) => {
    assert.match(problem.stderr, /FAIL notes\.md: contains legacy product name/);
    assert.match(problem.stderr, /git history blob notes\.md: contains legacy product name/);
    assert.doesNotMatch(problem.stderr, /README\.md/);
    return true;
  });
});

test("the README is still checked for everything except the game's name", async (t) => {
  const token = `${"1234567890"}:${"b".repeat(64)}`;
  const root = await releaseFixture(t, { readme: `${gameName}\n${token}\n` });
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "add fixture"], { cwd: root });

  await assert.rejects(check(root), (problem) => {
    assert.match(problem.stderr, /FAIL README\.md: contains validation token/);
    assert.match(problem.stderr, /git history blob README\.md: contains validation token/);
    assert.doesNotMatch(problem.stderr, /legacy product name/);
    return true;
  });
});

test("the public-release gate finds forbidden text deleted from the checkout", async (t) => {
  const root = await releaseFixture(t);

  const token = `${"1234567890"}:${"a".repeat(64)}`;
  await fs.writeFile(path.join(root, "leaked.txt"), `${token}\n`);
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "add fixture"], { cwd: root });
  await fs.rm(path.join(root, "leaked.txt"));
  await run("git", ["add", "-u"], { cwd: root });
  await run("git", ["commit", "-qm", "remove fixture"], { cwd: root });

  await assert.rejects(check(root), (problem) => {
    assert.match(problem.stderr, /git history blob leaked\.txt: contains validation token/);
    return true;
  });
});

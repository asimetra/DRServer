import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("the public-release gate finds forbidden text deleted from the checkout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ods-public-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "game-data"));
  await Promise.all([
    fs.writeFile(path.join(root, "LICENSE"), "test\n"),
    fs.writeFile(path.join(root, "NOTICE.md"), "test\n"),
    fs.writeFile(path.join(root, "README.md"), "test\n"),
    fs.writeFile(path.join(root, "game-data", "manifest.json"), "{}\n"),
  ]);
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Test"], { cwd: root });

  const token = `${"1234567890"}:${"a".repeat(64)}`;
  await fs.writeFile(path.join(root, "leaked.txt"), `${token}\n`);
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "add fixture"], { cwd: root });
  await fs.rm(path.join(root, "leaked.txt"));
  await run("git", ["add", "-u"], { cwd: root });
  await run("git", ["commit", "-qm", "remove fixture"], { cwd: root });

  const checker = new URL("../tools/check-public-release.js", import.meta.url);
  await assert.rejects(
    run(process.execPath, [checker.pathname], {
      env: { ...process.env, ODS_PUBLIC_RELEASE_ROOT: root },
    }),
    (problem) => {
      assert.match(problem.stderr, /git history blob leaked\.txt: contains validation token/);
      return true;
    }
  );
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const tool = fileURLToPath(new URL("../tools/token.js", import.meta.url));

/** The tool as an operator runs it, against a data directory of its own. */
const tokenTool = async (t, { secret = "s".repeat(64) } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ods-token-tool-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  if (secret) await fs.writeFile(path.join(dataDir, "token-secret"), `${secret}\n`, { mode: 0o600 });
  const call = (...args) =>
    run(process.execPath, [tool, ...args], {
      env: { PATH: process.env.PATH, ODS_DATA_DIR: dataDir, ODS_TOKEN_SECRET: "" },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (problem) => ({ code: problem.code, stdout: problem.stdout, stderr: problem.stderr })
    );
  return { dataDir, call };
};

/**
 * `--days 90 1000000005` issued a token for account 90: the flag's value was
 * read as the account, because it was the first argument without two dashes.
 * It printed a pair that looked right and belonged to nobody.
 */
test("a flag's value is never mistaken for the account", async (t) => {
  const { call } = await tokenTool(t);

  for (const args of [["--days", "90", "1000000005"], ["1000000005", "--days", "90"]]) {
    const { code, stdout } = await call(...args);
    assert.equal(code, 0);
    assert.match(stdout, /^Account 1000000005, valid until /);
    const until = Date.parse(/valid until (\S+)/.exec(stdout)[1]);
    const days = (until - Date.now()) / 86_400_000;
    assert.ok(days > 89.9 && days < 90.1, `${days} days`);
  }
});

test("an account id the game cannot carry is refused wherever it is given", async (t) => {
  const { call } = await tokenTool(t);

  for (const id of ["1.5", "99999999999", "0", "-5", "abc"]) {
    for (const args of [[id], ["--revoke", id], ["--check", id, "1:abc"]]) {
      const { code, stdout, stderr } = await call(...args);
      assert.equal(code, 1, args.join(" "));
      assert.equal(stdout, "");
      assert.match(stderr, /Usage:/);
    }
  }
  assert.equal((await call()).code, 1);
  assert.equal((await call("1000000005", "--days", "soon")).code, 1, "a duration that is not one");
});

test("a token it issues is one it accepts, and says where the secret came from", async (t) => {
  const { call, dataDir } = await tokenTool(t);

  const issued = await call("1000000005");
  assert.match(issued.stdout, new RegExp(`signing secret: ${dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const token = /"API_ValidationToken": "([^"]+)"/.exec(issued.stdout)[1];
  assert.match((await call("--check", "1000000005", token)).stdout, /valid for account 1000000005/);
  assert.equal((await call("--check", "1000000006", token)).code, 1);
});

/**
 * Run against the wrong data directory — the server's is set in a service file,
 * the tool is run from a shell — it used to write a fresh secret there and
 * print a token signed with it, which the real server then refused.
 */
test("the tool never makes a signing secret of its own", async (t) => {
  const { call, dataDir } = await tokenTool(t, { secret: null });

  const { code, stderr } = await call("1000000005");
  assert.equal(code, 1);
  assert.match(stderr, /No signing secret/);
  assert.match(stderr, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(await fs.readdir(dataDir), [], "nothing was written");
});

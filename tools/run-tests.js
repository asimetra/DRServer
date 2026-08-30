#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Runs the test suite against a throwaway account directory.
 *
 * Storage defaults to `data/`, which on a developer's machine is where their
 * real accounts live. Tests load accounts freely, and `loadAccount` writes an
 * account it has never seen before — so a plain `node --test` litters that
 * directory with invented ids and an `undefined.json`, next to accounts
 * somebody actually plays. Nothing warns about it, and the two are only
 * distinguishable by knowing which ids are real.
 *
 * Worse than the litter is what it implies: a test that saves under an id an
 * operator happens to use would overwrite their account. Nothing today does —
 * the fixtures that borrow real-looking ids only read — but that is luck rather
 * than a rule, and this makes it structural instead.
 *
 * `ODS_DATA_DIR` is set rather than `DR_DATA_DIR` because the former takes
 * precedence, and a test file that wants its own directory sets `ODS_DATA_DIR`
 * itself before importing the config — which still wins, because the config
 * reads the environment when it is first imported inside that file's process.
 *
 * An existing `ODS_DATA_DIR` is left alone, so CI or a developer can still
 * point the suite somewhere deliberate.
 */

const borrowed = process.env.ODS_DATA_DIR;
const scratch = borrowed ?? mkdtempSync(path.join(tmpdir(), "ods-test-data-"));

const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, ODS_DATA_DIR: scratch } }
);

const cleanUp = () => {
  if (!borrowed) rmSync(scratch, { recursive: true, force: true });
};

child.on("exit", (code, signal) => {
  cleanUp();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Node's test runner starts each test file in its own child process. Give that
 * child its own account directory before any application module is imported,
 * so one file's accounts, boards and token generations cannot affect another.
 */
if (process.env.NODE_TEST_CONTEXT && !process.env.ODS_DATA_DIR) {
  const scratch = mkdtempSync(path.join(tmpdir(), "ods-test-file-"));
  process.env.ODS_DATA_DIR = scratch;
  process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
}

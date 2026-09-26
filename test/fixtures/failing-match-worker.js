/**
 * A match worker that cannot start, for tests of what the pool does about one.
 * ODS_TEST_WORKER_FAILURE picks how: `boot` always fails, `replacement` fails
 * every thread after the pool's first, and `hang` never finishes starting.
 */
import { workerData } from "node:worker_threads";

const mode = process.env.ODS_TEST_WORKER_FAILURE;
if (mode === "boot") throw new Error("boot failure for test");
if (mode === "replacement" && Number(workerData?.attempt ?? 1) > 1) {
  throw new Error("replacement boot failure for test");
}
if (mode === "hang") {
  for (;;) {
    // Never gets as far as saying it is ready.
  }
}
await import("../../src/socket/match-worker-thread.js");

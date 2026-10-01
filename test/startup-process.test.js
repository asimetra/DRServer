import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The entry point, run as the process an operator runs.
 *
 * Everything else in the suite imports modules; none of it starts the server.
 * So the order things happen in at boot — what is checked before the storage
 * is claimed, what is left behind when a start is refused — was only ever read
 * off the source, and the first person to find out it was wrong was somebody
 * following the README.
 */
const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Starts the server with nothing inherited but PATH, so no ODS_* leaks in. */
const boot = async (t, settings = {}, { nodeArguments = [] } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ods-boot-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();

  const child = spawn(process.execPath, [...nodeArguments, entry], {
    env: {
      PATH: process.env.PATH,
      ODS_DATA_DIR: dataDir,
      ODS_STORAGE: "file",
      ODS_PORT: String(port),
      ODS_SOCKET_PORT: String(await freePort()),
      ...settings,
    },
  });
  t.after(() => child.kill("SIGKILL"));

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal }))
  );
  const said = async (pattern, withinMs = 15000) => {
    const deadline = Date.now() + withinMs;
    while (!pattern.test(output)) {
      if (child.exitCode !== null || Date.now() > deadline) {
        assert.fail(`the server never logged ${pattern}:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  return { child, dataDir, port, exited, said, output: () => output };
};

const present = (file) =>
  fs.access(file).then(
    () => true,
    () => false
  );

const STACK_FRAME = /^\s+at /m;

test("a refused remote bind is one line and leaves nothing behind", async (t) => {
  const server = await boot(t, { ODS_HOST: "0.0.0.0" });

  assert.equal((await server.exited).code, 1);
  assert.match(server.output(), /ERROR.*refusing cleartext remote bind on 0\.0\.0\.0/);
  assert.match(server.output(), /ODS_ALLOW_INSECURE_REMOTE=1/);
  assert.doesNotMatch(server.output(), STACK_FRAME, "an operator's mistake is not a stack trace");
  assert.equal(
    await present(path.join(server.dataDir, ".server.lock")),
    false,
    "the storage was never claimed"
  );
  assert.equal(
    await present(path.join(server.dataDir, "token-secret")),
    false,
    "nothing is written for a server that was never going to start"
  );
});

test("settings that do not mean anything are refused by name, all of them at once", async (t) => {
  const server = await boot(t, { ODS_STORAGE: "postgresql", ODS_SOCKET_PORT: "abc", ODS_STRICT: "true" });

  assert.equal((await server.exited).code, 1);
  assert.match(server.output(), /ODS_STORAGE must be "file" or "postgres", not "postgresql"/);
  assert.match(server.output(), /ODS_SOCKET_PORT must be a port number/);
  assert.match(server.output(), /ODS_STRICT must be 0 or 1/);
  assert.doesNotMatch(server.output(), STACK_FRAME);
  assert.equal(await present(path.join(server.dataDir, ".server.lock")), false);
});

test("a refused internal API bind is caught before the storage is claimed", async (t) => {
  const server = await boot(t, {
    ODS_INTERNAL_TOKEN: "t".repeat(32),
    ODS_INTERNAL_HOST: "0.0.0.0",
  });

  assert.equal((await server.exited).code, 1);
  assert.match(server.output(), /ERROR.*refusing cleartext internal API bind on 0\.0\.0\.0/);
  assert.doesNotMatch(server.output(), STACK_FRAME);
  assert.equal(await present(path.join(server.dataDir, ".server.lock")), false);
});

test("a start that fails after claiming the storage gives the claim back", async (t) => {
  const server = await boot(t);
  // A directory where the signing secret belongs: unreadable as a file, and
  // only discovered once the storage lock is already held.
  await fs.mkdir(path.join(server.dataDir, "token-secret"));

  assert.equal((await server.exited).code, 1);
  assert.match(server.output(), /cannot read signing secret/);
  assert.equal(
    await present(path.join(server.dataDir, ".server.lock")),
    false,
    "a failed start does not block the next one"
  );
});

test("the server starts without compatibility data, as it says it does", async (t) => {
  const emptyResources = await fs.mkdtemp(path.join(os.tmpdir(), "ods-no-data-"));
  t.after(() => fs.rm(emptyResources, { recursive: true, force: true }));
  // No content directory either: a developer's own checkout may hold one, and
  // its GameMaster would stand in for the data this test says is missing.
  const server = await boot(t, { ODS_RESOURCES_DIR: emptyResources, ODS_CONTENT_DIR: "" });

  await server.said(/compatibility data incomplete/);
  await server.said(/game socket listening/);
  assert.doesNotMatch(server.output(), STACK_FRAME);

  server.child.kill("SIGTERM");
  assert.equal((await server.exited).code, 0);
  assert.equal(await present(path.join(server.dataDir, ".server.lock")), false);
});

/**
 * The compatibility data is beside the point for everything below, and absent
 * on a fresh clone, so these start the way that clone would.
 */
const bootWithoutData = async (t, options) => {
  const emptyResources = await fs.mkdtemp(path.join(os.tmpdir(), "ods-no-data-"));
  t.after(() => fs.rm(emptyResources, { recursive: true, force: true }));
  const server = await boot(t, { ODS_RESOURCES_DIR: emptyResources, ODS_CONTENT_DIR: "" }, options);
  await server.said(/game socket listening/);
  return server;
};

const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms}ms`)), ms)),
  ]);

test("the terminal going away stops the server as cleanly as a signal", async (t) => {
  const server = await bootWithoutData(t);

  server.child.kill("SIGHUP");
  assert.deepEqual(await server.exited, { code: 0, signal: null });
  assert.match(server.output(), /shutdown: SIGHUP/);
  assert.equal(await present(path.join(server.dataDir, ".server.lock")), false);
});

test("one connection that stalled mid-request cannot hold the shutdown open", async (t) => {
  const server = await bootWithoutData(t);

  const stalled = net.connect(server.port, "127.0.0.1");
  t.after(() => stalled.destroy());
  await new Promise((resolve) => stalled.once("connect", resolve));
  stalled.on("error", () => {});
  stalled.write("POST /rpc/account/get HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{");
  await new Promise((resolve) => setTimeout(resolve, 200));

  server.child.kill("SIGTERM");
  assert.deepEqual(await within(server.exited, 8000, "shutdown"), { code: 0, signal: null });
  assert.equal(await present(path.join(server.dataDir, ".server.lock")), false);
});

test("an exception nothing caught ends the server deliberately, and as a failure", async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ods-fault-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const fault = path.join(scratch, "fault.mjs");
  await fs.writeFile(
    fault,
    'setTimeout(() => { throw new Error("a timer nobody guarded"); }, 1500);\n'
  );
  const server = await bootWithoutData(t, { nodeArguments: ["--import", fault] });

  assert.deepEqual(await within(server.exited, 8000, "shutdown"), { code: 1, signal: null });
  assert.match(server.output(), /uncaught exception: Error: a timer nobody guarded/);
  assert.match(server.output(), /shutdown: uncaught exception/);
  assert.equal(
    await present(path.join(server.dataDir, ".server.lock")),
    false,
    "the storage is given back even on the way down"
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { forgetOverrides, isOverridden, serveContent } from "../src/content.js";
import { config } from "../src/config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dr-content-"));
fs.mkdirSync(path.join(root, "Levels"), { recursive: true });
fs.writeFileSync(path.join(root, "Levels", "lobby.json"), '{"LETiles":[]}');
fs.writeFileSync(path.join(root, "art.swf"), Buffer.from([0x46, 0x57, 0x53]));
// A file next to the content root, which is what traversal would be reaching for.
fs.writeFileSync(path.join(root, "..", "dr-content-secret.txt"), "not yours");

const get = (rest) => serveContent({ contentDir: root }, [rest]);

test("serves a file under the content root", async () => {
  const answer = await get("Levels/lobby.json");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["Content-Type"], "application/json");
  assert.equal(answer.body.toString(), '{"LETiles":[]}');
});

test("serves binary as bytes, not as text", async () => {
  const answer = await get("art.swf");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["Content-Type"], "application/x-shockwave-flash");
  assert.ok(Buffer.isBuffer(answer.body));
  assert.deepEqual([...answer.body], [0x46, 0x57, 0x53]);
});

/**
 * The whole point of a directory this server hands out on request is that it
 * hands out that directory. Every one of these resolves outside it, and a
 * server that answers any of them is serving the machine it runs on.
 */
test("refuses to climb out of the content root", async () => {
  for (const attempt of [
    "../dr-content-secret.txt",
    "Levels/../../dr-content-secret.txt",
    "..%2Fdr-content-secret.txt",
    "....//dr-content-secret.txt",
    "/etc/passwd",
    "Levels/../../../../../../etc/passwd",
  ]) {
    const answer = await get(attempt);
    assert.equal(answer.status, 404, attempt);
    assert.ok(!String(answer.body).includes("not yours"), attempt);
  }
});

test("a missing file is a miss, not a crash", async () => {
  assert.equal((await get("Levels/nothing.json")).status, 404);
  assert.equal((await get("")).status, 404);
});

/** A directory is not a file, and listing one is not this server's business. */
test("a directory is not served", async () => {
  assert.equal((await get("Levels")).status, 404);
});

test("no content directory configured means nothing is served", async () => {
  const answer = await serveContent({ contentDir: "" }, ["Levels/lobby.json"]);
  assert.equal(answer.status, 404);
});

/**
 * The override rule, which is the reason any of this is worth having. Sending
 * the client to this server for every asset is easy and wrong: it would fetch
 * forty sprite sheets and sound banks it already has, and each one becomes a
 * request this server must answer or the floor does not draw.
 *
 * So a path is overridden when, and only when, there is a file here for it —
 * which makes putting the file there the whole act of overriding.
 */
test("only what this server actually holds counts as overridden", () => {
  const previous = config.contentDir;
  try {
    config.contentDir = root;
    forgetOverrides();

    assert.equal(isOverridden("Levels/lobby.json"), true);
    assert.equal(isOverridden("Levels/nothing.json"), false, "not held, so not ours");
    assert.equal(isOverridden("Levels"), false, "a directory is not an asset");
    assert.equal(isOverridden("../dr-content-secret.txt"), false, "and never outside");
  } finally {
    config.contentDir = previous;
    forgetOverrides();
  }
});

/**
 * Reading the file per request is the wrong shape at any scale worth having.
 * A thousand players launching after a rules change — which is exactly when
 * they all launch — would each be handed their own copy of a four-megabyte
 * table. Bandwidth was never the constraint; identical buffers were.
 */
test("the same file is read once and handed out from memory", async () => {
  const big = path.join(root, "big.json");
  fs.writeFileSync(big, JSON.stringify({ padding: "x".repeat(20000) }));

  const first = await get("big.json");
  const second = await get("big.json");
  assert.equal(first.body, second.body, "the very same buffer, not an equal one");

  // And a changed file is not served from a stale buffer.
  fs.writeFileSync(big, JSON.stringify({ padding: "y".repeat(20000) }));
  const third = await get("big.json");
  assert.notEqual(third.body, first.body);
  assert.ok(third.body.toString().includes("yyy"));
});

/**
 * Compression is asked for, never assumed. The game's own loader is a Flash
 * URLRequest and may not understand it, and sending gzip to a client that did
 * not ask for it is not an optimisation.
 */
test("compressed only for a client that said it understands compression", async () => {
  const big = path.join(root, "rules.json");
  fs.writeFileSync(big, JSON.stringify({ rows: Array.from({ length: 900 }, (_, i) => ({ i })) }));

  const plain = await serveContent({ contentDir: root }, ["rules.json"]);
  assert.equal(plain.headers["Content-Encoding"], undefined);
  assert.match(plain.body.toString(), /"rows"/);

  const asked = await serveContent({ contentDir: root }, ["rules.json"], {
    headers: { "accept-encoding": "gzip, deflate" },
  });
  assert.equal(asked.headers["Content-Encoding"], "gzip");
  assert.ok(asked.body.length < plain.body.length, "and it is actually smaller");
  assert.equal(asked.headers["Content-Length"], String(asked.body.length));
});

test("already-compressed formats are not compressed again", async () => {
  const answer = await serveContent({ contentDir: root }, ["art.swf"], {
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(answer.headers["Content-Encoding"], undefined);
});

test("nothing is overridden when no content directory is set", () => {
  const previous = config.contentDir;
  try {
    config.contentDir = "";
    forgetOverrides();
    assert.equal(isOverridden("Levels/lobby.json"), false);
  } finally {
    config.contentDir = previous;
    forgetOverrides();
  }
});

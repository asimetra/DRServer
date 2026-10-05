import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REACHES_EVERYTHING, referencesOf, relatedTests, reverseGraph } from "../tools/related-tests.js";

/**
 * tools/related-tests.js: the tests a change reaches, read from the files'
 * own references — nothing guessed, nothing named in prose.
 */
const tree = (t, files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dr-related-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
};

test("a reference is a static or bare import, a re-export, a dynamic import or a URL beside the module; a package is not", () => {
  const source = `
    import a from "./a.js";
    import { b } from "../lib/b.js";
    export { c } from "./c.js";
    import pg from "pg";
    import fs from "node:fs";
    const d = await import("./d.js");
    const e = new URL("../../config/e.json", import.meta.url);
    import "./side.js";
    const f = new URL("https://example.test/", import.meta.url);
  `;
  assert.deepEqual(referencesOf("/r", "src/x/y.js", source).sort(), ["config/e.json", "src/lib/b.js", "src/x/a.js", "src/x/c.js", "src/x/d.js", "src/x/side.js"]);
});

test("the tests reached are the ones whose imports lead to the change, through any depth", (t) => {
  const root = tree(t, {
    "src/a.js": `export const a = 1;`,
    "src/b.js": `import { a } from "./a.js"; export const b = a;`,
    "src/c.js": `export const c = 3;`,
    "src/book.js": `const F = new URL("../config/book.json", import.meta.url); export const book = F;`,
    "config/book.json": `{}`,
    "test/b.test.js": `import { b } from "../src/b.js";`,
    "test/c.test.js": `import { c } from "../src/c.js";`,
    "test/book.test.js": `import { book } from "../src/book.js";`,
    "test/fixture-user.test.js": `const w = new URL("./fixtures/worker.js", import.meta.url);`,
    "test/fixtures/worker.js": `import "../../src/c.js";`,
  });
  const graph = reverseGraph(root);
  const allTests = ["test/b.test.js", "test/c.test.js", "test/book.test.js", "test/fixture-user.test.js"];
  const reach = (...changed) => relatedTests({ changed, graph, allTests }).tests;

  assert.deepEqual(reach("src/a.js"), ["test/b.test.js"], "through b.js");
  assert.deepEqual(reach("src/c.js"), ["test/c.test.js", "test/fixture-user.test.js"], "through a fixture too");
  assert.deepEqual(reach("config/book.json"), ["test/book.test.js"], "a config file read by URL");
  assert.deepEqual(reach("test/c.test.js"), ["test/c.test.js"], "a changed test is its own");
  assert.deepEqual(reach("docs/page.md"), [], "nothing reads it");
  assert.deepEqual(reach("src/a.js", "src/c.js"), ["test/b.test.js", "test/c.test.js", "test/fixture-user.test.js"]);

  const direct = (...changed) => relatedTests({ changed, graph, allTests, direct: true }).tests;
  assert.deepEqual(direct("src/a.js"), [], "nothing imports a.js itself");
  assert.deepEqual(direct("src/b.js"), ["test/b.test.js"]);
  assert.deepEqual(direct("src/c.js"), ["test/c.test.js"], "the fixture's user is a hop away");
  assert.deepEqual(direct("test/c.test.js"), ["test/c.test.js"]);
});

test("the runner, the test environment and package.json reach every test, and say so", () => {
  const allTests = ["test/z.test.js", "test/a.test.js"];
  for (const file of REACHES_EVERYTHING) {
    const { tests, everything } = relatedTests({ changed: [file], graph: new Map(), allTests });
    assert.deepEqual(tests, ["test/a.test.js", "test/z.test.js"]);
    assert.equal(everything, file);
  }
});

test("on this repository the graph knows the reads the scan cannot see", () => {
  const graph = reverseGraph();
  assert.ok(graph.get("config/server.defaults.json")?.has("src/config.js"));
  assert.ok(graph.get("src/modes/hooks.js")?.has("src/socket/run-rules.js"), "a static import");
  assert.ok(graph.get("config/ui-effects.json")?.has("src/socket/ui-effects.js"), "a URL read");
});

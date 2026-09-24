import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { config } from "../src/config.js";
import { readPlacements } from "../src/socket/floors.js";

test("concurrent floors share one immutable tile-library preparation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ods-floor-cache-"));
  const directory = path.join(root, "Resources", "Levels", "cache-test");
  const file = path.join(directory, "tiles.json");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      LETiles: [{ id: "EMPTY", LEObjects: [] }],
      LETriggers: [],
    })
  );

  const previousContentDir = config.contentDir;
  const originalReadFile = fsPromises.readFile;
  let libraryReads = 0;
  fsPromises.readFile = async (...args) => {
    if (path.resolve(String(args[0])) === file) libraryReads += 1;
    return originalReadFile(...args);
  };

  try {
    config.contentDir = root;
    const tiles = [{ x: 0, y: 0, tileId: "EMPTY" }];
    const [first, second] = await Promise.all([
      readPlacements("Resources/Levels/cache-test/tiles.json", tiles),
      readPlacements("Resources/Levels/cache-test/tiles.json", tiles),
    ]);

    assert.equal(libraryReads, 1, "concurrent entries read the same library more than once");
    assert.notEqual(first.placements, second.placements, "floors shared mutable placement output");
    first.placements.npc.push({ id: "only-first" });
    assert.equal(second.placements.npc.length, 0);
  } finally {
    fsPromises.readFile = originalReadFile;
    config.contentDir = previousContentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

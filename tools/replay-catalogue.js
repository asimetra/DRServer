#!/usr/bin/env node
/**
 * Turns the official's own floors into floors this server can serve.
 *
 *   node tools/replay-catalogue.js <logs-dir>
 *   node tools/replay-catalogue.js <logs-dir> --theme nordic/caves
 *   DR_FLOOR_CATALOG=config/floors.replay.json npm start
 *
 * `trap-map.js` builds floors that hold one of everything: it searches layouts
 * for the smallest set of tiles covering every placed kind. That is the right
 * shape for asking "does this trap work at all" and the wrong shape for
 * everything else, because the rooms it picks are not the rooms the game lays.
 * A corridor of three flame jets, a hall of ice blocks with a pack waiting
 * behind them — those are particular tiles in particular arrangements, and a
 * coverage search has no reason to choose them.
 *
 * So the bugs were being hunted on maps that could not contain them.
 *
 * The official's recordings carry the real thing. A floor generate holds its
 * whole layout as `DungeonTileUsage` records, and 1173 of the 1191 tiles it
 * laid across the corpus exist in this repository's libraries. Writing those
 * layouts back out as authored floors gives a catalogue of rooms the official
 * actually served — the same corridors, the same halls, tile for tile.
 *
 * What that buys is not coverage but *fidelity*: anything wrong on one of these
 * floors is wrong on a floor the game itself built, and `tools/replay-floor.js`
 * can diff it against the recording it came from.
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const levels = path.join(root, "local-data", "Resources", "Levels");
const outputDir = path.join(levels, "replay");

/** Which node the catalogue puts the whole sequence on. */
const MAP_NODE = "50002";

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

/** Every floor layout in a capture, in the order the official served them. */
const layoutsIn = async (file) => {
  const found = [];
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const b = Buffer.from(record.hex ?? "", "hex");
    if (b.length < 16) continue;
    const op = b.readUInt16LE(0);
    if ((op !== 134 && op !== 135) || b.readUInt16LE(10) !== 32) continue;

    let at = 16;
    const mapNodeId = b.readUInt32LE(at); at += 4;
    let length = b.readUInt16LE(at); at += 2;
    const tier = b.toString("utf8", at, at + length); at += length;
    length = b.readUInt16LE(at); at += 2;
    const library = b.toString("utf8", at, at + length); at += length;

    const bytes = b.readUInt16LE(at); at += 2;
    const end = at + bytes;
    const tiles = [];
    while (at < end) {
      const x = b.readInt32LE(at); at += 4;
      const y = b.readInt32LE(at); at += 4;
      const idLength = b.readUInt16LE(at); at += 2;
      tiles.push({ x, y, tileId: b.toString("utf8", at, at + idLength) });
      at += idLength;
    }
    if (tiles.length) found.push({ mapNodeId, tier, library, tiles });
  }
  return found;
};

/** The tile ids this repository actually holds, so a layout can be judged. */
const knownTiles = async () => {
  const known = new Set();
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["trap-test", "replay"].includes(entry.name)) await walk(full);
      } else if (entry.name === "tiles.json") {
        const library = JSON.parse(await fs.readFile(full, "utf8"));
        for (const tile of library.LETiles ?? []) known.add(String(tile.id));
      }
    }
  };
  await walk(levels);
  return known;
};

const main = async () => {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node tools/replay-catalogue.js <logs-dir> [--theme t]");
    process.exit(2);
  }
  const onlyTheme = argument("theme");

  /** Validate input before replacing the tracked/generated output catalogue. */
  const input = await fs.stat(dir).catch(() => null);
  if (!input?.isDirectory()) {
    throw new Error(`logs input is not a directory: ${dir}`);
  }

  const known = await knownTiles();
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const catalogue = { defaultFloor: "arena_gauntlet", floors: {}, mapNodes: {} };
  const sequence = [];
  const seen = new Set();
  let skippedIncomplete = 0;
  let skippedDuplicate = 0;

  const files = (await fs.readdir(dir)).filter((n) => n.startsWith("socket-") && n.endsWith(".jsonl")).sort();
  for (const file of files) {
    for (const layout of await layoutsIn(path.join(dir, file))) {
      const theme = layout.library.replace(/^Resources\/Levels\//, "").replace(/\/tiles\.json$/, "");
      if (onlyTheme && theme !== onlyTheme) continue;

      /**
       * A layout is only worth serving whole. One missing tile is a hole in the
       * floor rather than a smaller floor, and the corpus has 18 of those, all
       * from the tutorial's own library which this repository does not carry.
       */
      const missing = layout.tiles.filter((tile) => !known.has(tile.tileId)).length;
      if (missing) { skippedIncomplete += 1; continue; }

      // The same run replayed twice lays the same rooms; keep one of each.
      const fingerprint = layout.tiles.map((t) => `${t.x},${t.y},${t.tileId}`).sort().join("|");
      if (seen.has(fingerprint)) { skippedDuplicate += 1; continue; }
      seen.add(fingerprint);

      const slug = `${theme.replace("/", "_")}_${String(sequence.length + 1).padStart(2, "0")}`;
      const relative = `replay/db_floor_REPLAY_${slug.toUpperCase()}.json`;
      await fs.writeFile(
        path.join(levels, relative),
        `${JSON.stringify({
          _comment:
            `replayed from ${file} — node ${layout.mapNodeId}, tier ${layout.tier || "(none)"}; ` +
            "the layout the official served, tile for tile",
          tileLibrary: layout.library,
          tiles: layout.tiles.map(({ x, y, tileId }) => ({ type: "LEFloorTile", tileId, x, y })),
        }, null, 1)}\n`
      );
      catalogue.floors[`replay_${slug}`] = relative;
      sequence.push(relative);
    }
  }

  catalogue.mapNodes[MAP_NODE] = sequence;
  catalogue._note =
    "Generated by tools/replay-catalogue.js from the official's own recordings. " +
    `Every floor is a layout it actually served. Sequenced on map node ${MAP_NODE}; ` +
    "run with DR_FLOOR_CATALOG=config/floors.replay.json, and DR_START_FLOOR to pick one.";

  await fs.writeFile(
    path.join(root, "config", "floors.replay.json"),
    `${JSON.stringify(catalogue, null, 2)}\n`
  );

  const byTheme = new Map();
  for (const file of sequence) {
    const theme = file.match(/REPLAY_([A-Z_]+)_\d+\.json$/)?.[1] ?? "?";
    byTheme.set(theme, (byTheme.get(theme) ?? 0) + 1);
  }
  console.log(`${sequence.length} floors written from ${files.length} recordings`);
  for (const [theme, count] of [...byTheme].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(3)}  ${theme.toLowerCase()}`);
  }
  if (skippedDuplicate) console.log(`\n${skippedDuplicate} repeated layout(s) kept once`);
  if (skippedIncomplete) {
    console.log(`${skippedIncomplete} layout(s) skipped for tiles this repository does not have`);
  }
  console.log(`\nwrote config/floors.replay.json — run with\n  DR_FLOOR_CATALOG=config/floors.replay.json npm start`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

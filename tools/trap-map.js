#!/usr/bin/env node
/**
 * Builds a dungeon that contains every placeable in the game.
 *
 * Traps are the hardest thing here to check, because seeing one means being in
 * the right theme, on the right tile, at the moment it fires. A mace turns up in
 * one ice-caves run out of several, and the Jurassic slicers need a Jurassic
 * map. That is a slow way to answer "does the crusher still hit".
 *
 * Nothing is authored by hand. A floor is a set of tiles from one library, and
 * `tilegen` already knows how to lay a connected one out; this only searches its
 * seeds for the layout that carries the most of whatever is being covered, and
 * writes the winner out as an ordinary authored floor. Floors run in sequence,
 * so walking the dungeon walks past all of them.
 *
 *   node tools/trap-map.js                  every distinct placed kind
 *   node tools/trap-map.js --cover tiles    every tile in every library
 *   node tools/trap-map.js --theme nordic/caves
 *   node tools/trap-map.js --only FIREBOMB_PLACEABLE_ALL
 *   node tools/trap-map.js --only A,B,C --theme nordic/temple --name frostgaard
 *   DR_FLOOR_CATALOG=config/floors.trap-test.json npm start
 *
 * `--only` cuts a small floor around named constants instead of covering
 * everything, for when the question is "let me stand in front of these and watch
 * them". It searches for the layout carrying the most of them, breaks ties
 * towards the smaller floor, and writes its own directory and catalogue so a
 * focused map never costs the coverage set the ordinary run wipes and rebuilds.
 *
 * Several constants and a `--theme` is usually what a bug report wants, because
 * a report is about a *place*: the flames, mines and Loki statues that came back
 * from Frostgaard are one library between them, and chasing them across four
 * themed floors was answering a question nobody asked. `--name` says what to
 * call the result when the joined constants would make an unreadable directory.
 *
 * What counts as covered used to be a trap attack, and that quietly left holes:
 * a barrel is an `LENPC` and not an `LETriggerable`, so no amount of searching
 * ever asked for the tiles that hold one — the reported "the barrel tiles are
 * not in test9". Reward chests are the same shape, and that is the same mistake
 * the trap census made before it learned to filter by library type.
 *
 * So the default unit is now a *kind*: every distinct constant placed as an
 * `LETriggerable`, `LENPC` or `LENPCGenerator`. `--cover tiles` is the stronger
 * and much longer answer — 1210 tiles across nine themes — for when the question
 * is about the tiles themselves rather than what stands on them.
 *
 * The catalogue it writes is separate, so normal play is untouched and the whole
 * thing is reverted by not setting the variable.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateFloor } from "../src/socket/tilegen.js";
import { loadGameMaster } from "../src/gamemaster.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const levels = path.join(root, "local-data", "Resources", "Levels");
/** Which node the test catalogue puts this dungeon on. */
const MAP_NODE = "50002";

/** How many seeds to try per size, and the sizes to try. */
const SEEDS = 400;
const TILE_COUNTS = [9, 16, 25];

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

/**
 * `--only` writes its own directory and catalogue.
 *
 * A focused map answers "let me stand in front of this one thing and watch it",
 * which is a different question from coverage and must not cost the coverage
 * floors: an ordinary run wipes its output directory first, so sharing one
 * would mean every focused map deleted the set it was cut from.
 */
const ONLY = (() => {
  const at = process.argv.indexOf("--only");
  if (at === -1 || !process.argv[at + 1]) return null;
  return new Set(process.argv[at + 1].split(",").map((name) => name.trim()).filter(Boolean));
})();
const ONLY_CONSTANT = ONLY ? [...ONLY][0] : null;
const OUTPUT_SLUG = ONLY
  ? `focus-${(argument("name") ?? [...ONLY].join("-")).toLowerCase()}`
  : "trap-test";
const outputDir = path.join(levels, OUTPUT_SLUG);
const catalogueFile = `config/floors.${OUTPUT_SLUG}.json`;


/**
 * What a floor is searched for. `kinds` asks for every distinct thing placed on
 * a tile, `tiles` for the tiles themselves.
 */
const COVER = ONLY ? "kinds" : (argument("cover") ?? "kinds");
const ONLY_THEME = argument("theme");

/**
 * The library types that put something on the floor with a doid.
 *
 * `LEProp` is deliberately absent: it is scenery the client draws from its own
 * tile art and the server never generates, so covering it would pad every floor
 * without testing anything this server does.
 */
const PLACED_TYPES = new Set(["LETriggerable", "LENPC", "LENPCGenerator"]);

/**
 * Which tile categories a layout may draw on, tried in order.
 *
 * `tilegen` grows an ordinary floor from BASIC, TRAP and PUZZLE tiles, which is
 * right for play and leaves four ice-caves kinds unreachable: the iron cage,
 * both yetis and the floor-message triggerable live on BOSS tiles, and secret
 * rooms are their own category. A test floor has no reason to observe that
 * line, so when the ordinary set stops gaining, the search asks for the rest.
 */
const CATEGORY_SETS = [
  ["BASIC_TILE", "TRAP_TILE", "PUZZLE_TILE"],
  ["BASIC_TILE", "TRAP_TILE", "PUZZLE_TILE", "SECRET_TILE", "BOSS_TILE", "FILLER_TILE"],
];

const themesUnder = async (dir, found = []) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await themesUnder(full, found);
    else if (entry.name === "tiles.json") found.push(path.relative(levels, path.dirname(full)));
  }
  return found;
};

const run = async () => {
  const gameMaster = await loadGameMaster();

  /** The attack a placement fires, or null if it is not a trap. */
  const trapAttackOf = (constant) => {
    const npc = gameMaster.npcByConstant.get(constant);
    if (!npc || npc.CharType !== "PROP" || !npc.Attack1) return null;
    return gameMaster.attacksByConstant.has(npc.Attack1) ? npc.Attack1 : null;
  };

  /**
   * Written fresh each run. A previous run's floors are not overwritten when
   * this one needs fewer or names them differently, and a stale file in here
   * reads exactly like a current one — the ice caves briefly had a four-floor
   * directory describing a three-floor catalogue.
   */
  await fs.rm(outputDir, { recursive: true, force: true });

  const themes = (await themesUnder(levels))
    .sort()
    .filter((theme) => !ONLY_THEME || theme === ONLY_THEME);
  if (!themes.length) {
    console.error(`no theme matched ${ONLY_THEME}`);
    process.exitCode = 2;
    return;
  }
  await fs.mkdir(outputDir, { recursive: true });

  const catalogue = { defaultFloor: "arena_gauntlet", floors: {}, mapNodes: {} };
  const sequence = [];
  const covered = new Set();
  const floorsToWrite = [];
  const everything = new Set();

  for (const theme of themes) {
    const libraryPath = path.join(levels, theme, "tiles.json");
    const library = JSON.parse(await fs.readFile(libraryPath, "utf8"));
    const tilesById = new Map(library.LETiles.map((tile) => [tile.id, tile]));

    /**
     * What this tile is worth to the search: itself under `--cover tiles`, and
     * otherwise every distinct kind standing on it.
     */
    const coveredBy = (tileId) => {
      if (COVER === "tiles") return new Set([`${theme}#${tileId}`]);
      const kinds = new Set();
      for (const object of tilesById.get(tileId)?.LEObjects ?? []) {
        if (!PLACED_TYPES.has(object.type) || !object.constant) continue;
        if (ONLY && !ONLY.has(object.constant)) continue;
        kinds.add(object.constant);
      }
      return kinds;
    };

    /** How many of `--only` stand on a tile, so the search can prefer a crowd. */
    const instancesOn = (tileId) => {
      if (!ONLY) return 0;
      let n = 0;
      for (const object of tilesById.get(tileId)?.LEObjects ?? []) {
        if (PLACED_TYPES.has(object.type) && ONLY.has(object.constant)) n += 1;
      }
      return n;
    };

    const available = new Set();
    for (const tile of library.LETiles) for (const unit of coveredBy(tile.id)) available.add(unit);
    for (const unit of available) everything.add(unit);
    if (!available.size) continue;

    /**
     * No single layout need hold a theme's whole set — the tribal library has
     * eleven traps and its best twenty-five tile floor carries ten, because the
     * two that are left never fit the same room. So take layouts greedily until
     * nothing new turns up: whichever adds the most traps not yet seen, ties to
     * the smaller floor, and another floor for the remainder.
     */
    const wanted = new Set(available);
    const chosen = [];

    while (wanted.size) {
      let best = null;
      for (const categories of CATEGORY_SETS) {
      for (const tileCount of TILE_COUNTS) {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const layout = generateFloor(library, { tier: 10, tileCount, seed, categories });
          // A floor with no exit cannot be left, and the rest is behind it.
          if (!layout.hasExit) continue;

          const found = new Set();
          for (const tile of layout.tiles) {
            for (const unit of coveredBy(tile.tileId)) found.add(unit);
          }
          const gain = [...found].filter((unit) => wanted.has(unit)).length;
          if (!gain) continue;
          const crowd = layout.tiles.reduce((n, tile) => n + instancesOn(tile.tileId), 0);
          const better =
            !best ||
            gain > best.gain ||
            (gain === best.gain && crowd > best.crowd) ||
            (gain === best.gain && crowd === best.crowd &&
              layout.tiles.length < best.layout.tiles.length);
          if (better) best = { layout, found, gain, seed, crowd };
          if (best.gain === wanted.size) break;
        }
        if (best?.gain === wanted.size) break;
      }
      // Only widen when the ordinary tiles have nothing left to give.
      if (best) break;
      }
      if (!best) break;

      for (const unit of best.found) wanted.delete(unit);
      chosen.push(best);
    }

    if (!chosen.length) {
      console.log(`${theme.padEnd(17)} no layout with an exit — skipped`);
      continue;
    }

    for (const unit of available) if (!wanted.has(unit)) covered.add(unit);

    chosen.forEach((pick, index) => {
      const suffix = chosen.length > 1 ? `_${index + 1}` : "";
      const slug = theme.replace("/", "_");
      const file = `${OUTPUT_SLUG}/db_floor_TRAPS_${slug.toUpperCase()}${suffix}.json`;
      floorsToWrite.push({
        file,
        body: {
          _comment: `generated by tools/trap-map.js — ${theme}, seed ${pick.seed}`,
          tileLibrary: `Resources/Levels/${theme}/tiles.json`,
          tiles: pick.layout.tiles.map(({ x, y, tileId }) => ({
            type: "LEFloorTile",
            tileId,
            x,
            y,
          })),
        },
      });
      catalogue.floors[`traps_${slug}${suffix}`] = file;
      sequence.push(file);
    });

    const tiles = chosen.reduce((sum, pick) => sum + pick.layout.tiles.length, 0);
    console.log(
      `${theme.padEnd(17)} ${String(available.size - wanted.size).padStart(2)}/${available.size}` +
        ` ${COVER} in ${String(tiles).padStart(3)} tiles across ${chosen.length} floor(s)` +
        (wanted.size ? `  missing ${[...wanted].join(", ")}` : "")
    );
  }

  for (const { file, body } of floorsToWrite) {
    await fs.writeFile(path.join(levels, file), `${JSON.stringify(body, null, 1)}\n`);
  }

  /**
   * Served on the nodes the theme actually belongs to, as well as the default.
   *
   * A catalogue that only answers for 50002 is a test map you can only reach by
   * entering Proving Grounds, and a report about Frostgaard is answered by
   * walking into Frostgaard. Putting the same sequence on every node whose tier
   * draws on this library means the door in the UI leads to the floor under
   * test — which is the difference between "the traps are broken" and "I was
   * never on that map".
   */
  catalogue.mapNodes[MAP_NODE] = sequence;
  const tileSets = new Set(themes.map((theme) => `Resources/Levels/${theme}/tiles.json`));
  const tiers = new Set(
    (gameMaster.raw?.ColiseumTiers ?? [])
      .filter((tier) => tileSets.has(String(tier.TileSet)))
      .map((tier) => tier.Constant)
  );
  const themeNodes = (gameMaster.raw?.MapPage ?? []).filter((node) => tiers.has(node.TierRank));
  for (const node of themeNodes) catalogue.mapNodes[String(node.Id)] = sequence;
  if (themeNodes.length) {
    console.log(
      `\nalso served on ${themeNodes.length} node(s) of these themes: ` +
        themeNodes.map((node) => `${node.Id} ${node.Name}`).slice(0, 6).join(", ")
    );
  }
  catalogue._note =
    "Generated by tools/trap-map.js. Every floor is one theme's traps, in " +
    `sequence on map node ${MAP_NODE}. Run with DR_FLOOR_CATALOG=${catalogueFile}.`;

  await fs.writeFile(
    path.join(root, catalogueFile),
    `${JSON.stringify(catalogue, null, 2)}\n`
  );

  const missed = [...everything].filter((attack) => !covered.has(attack)).sort();
  console.log(
    `\n${covered.size}/${everything.size} ${COVER} across ${sequence.length} floors`
  );
  if (missed.length) {
    // Under --cover tiles this is a list of ids and can run to hundreds, so it
    // is summarised rather than dumped; a kind that never places is the
    // interesting case and stays named.
    console.log(
      COVER === "tiles"
        ? `never placed: ${missed.length} tiles`
        : `never placed: ${missed.join(", ")}`
    );
  }
  console.log(`\nwrote ${catalogueFile} — run with\n  DR_FLOOR_CATALOG=${catalogueFile} npm start`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

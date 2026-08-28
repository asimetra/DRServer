/**
 * Does this server lose any wiring the tile data actually states?
 *
 * The question behind every "this one trap never fires" report is which of two
 * things it is:
 *
 *   - the tile authors no connection for it, which is content and is common —
 *     4 of the temple's 8 Loki statues, 171 of the caves' 527 spike beds — and
 *     the official ships the same silence;
 *   - or the tile authors one and we fail to carry it, which is a bug, and
 *     always a bug in one place rather than in one trap.
 *
 * Reading the library twice settles it. The source count is what the JSON says;
 * the built count is what buildFloor produced. A gap between them is ours. A
 * trap that is unwired in both is the game's.
 *
 *   node tools/wiring-audit.js                 # every library
 *   node tools/wiring-audit.js castle/arena    # one
 */
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../src/config.js";
import { attackForConstant, npcForConstant } from "../src/gamemaster.js";
import { buildFloor } from "../src/socket/floors.js";

const LAYOUTS = [1, 5, 9, 14, 21, 34];

const walk = function* (node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
  } else if (node && typeof node === "object") {
    yield node;
    for (const value of Object.values(node)) yield* walk(value);
  }
};

/** What the JSON says, before anything here has touched it. */
const readSource = (library) => {
  const objects = [...walk(library)];
  const byId = new Map(objects.filter((o) => o.id !== undefined).map((o) => [o.id, o]));
  const wired = new Set((library.LETriggers ?? []).map((link) => link.triggerableId));

  let dangling = 0;
  for (const link of library.LETriggers ?? []) {
    if (!byId.has(link.triggerId) || !byId.has(link.triggerableId)) dangling += 1;
  }

  const unwired = new Map();
  const total = new Map();
  for (const object of objects) {
    if (object.type !== "LETriggerable" || !object.constant) continue;
    total.set(object.constant, (total.get(object.constant) ?? 0) + 1);
    if (!wired.has(object.id)) unwired.set(object.constant, (unwired.get(object.constant) ?? 0) + 1);
  }
  return { total, unwired, dangling, links: (library.LETriggers ?? []).length };
};

/** What survived being laid out and read into placements. */
const readBuilt = async (libraryPath) => {
  const total = new Map();
  const unwired = new Map();
  let unresolved = 0;

  for (const seed of LAYOUTS) {
    const floor = await buildFloor(libraryPath, { tier: 10, tileCount: 25, seed });
    const placed = new Set(
      [
        ...floor.placements.triggerable,
        ...floor.placements.trigger,
        ...floor.placements.logicGate,
        ...floor.placements.generator,
      ].map((placement) => placement.id)
    );
    const incoming = new Set();
    for (const [source, targets] of floor.wiring) {
      for (const target of targets) {
        incoming.add(target);
        if (!placed.has(target) && !placed.has(source)) unresolved += 1;
      }
    }
    for (const placement of floor.placements.triggerable) {
      const npc = await npcForConstant(placement.constant);
      if (!npc?.Attack1 || !(await attackForConstant(npc.Attack1))) continue;
      total.set(placement.constant, (total.get(placement.constant) ?? 0) + 1);
      if (!incoming.has(placement.id))
        unwired.set(placement.constant, (unwired.get(placement.constant) ?? 0) + 1);
    }
  }
  return { total, unwired, unresolved };
};

const share = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

const audit = async (libraryPath) => {
  const file = path.join(config.resourcesDir, libraryPath.replace(/^Resources\//, ""));
  const library = JSON.parse(await fs.readFile(file, "utf8"));
  const source = readSource(library);
  const built = await readBuilt(libraryPath);

  const name = libraryPath.split("/").slice(-3, -1).join("/");
  console.log(`\n${name}`);
  console.log(
    `  source: ${source.links} links, ${source.dangling} naming an id that does not exist`
  );
  console.log(`  built over ${LAYOUTS.length} layouts: ${built.unresolved} link(s) reaching nothing placed`);

  const rows = [...built.total]
    .map(([constant, placed]) => ({
      constant,
      placed,
      unwiredBuilt: built.unwired.get(constant) ?? 0,
      sourceTotal: source.total.get(constant) ?? 0,
      sourceUnwired: source.unwired.get(constant) ?? 0,
    }))
    .filter((row) => row.unwiredBuilt)
    .sort((a, b) => b.unwiredBuilt - a.unwiredBuilt);

  if (!rows.length) return console.log("  every hazard placed had a source.");
  console.log(`  ${"trap".padEnd(38)}${"unwired when built".padStart(20)}${"unwired in the data".padStart(21)}`);
  for (const row of rows) {
    const builtShare = `${row.unwiredBuilt}/${row.placed} (${share(row.unwiredBuilt, row.placed)}%)`;
    const sourceShare = `${row.sourceUnwired}/${row.sourceTotal} (${share(row.sourceUnwired, row.sourceTotal)}%)`;
    // A trap unwired far more often once built than the data says is the only
    // shape worth chasing; the rest is content.
    const suspect = share(row.unwiredBuilt, row.placed) - share(row.sourceUnwired, row.sourceTotal) > 15;
    console.log(
      `  ${row.constant.padEnd(38)}${builtShare.padStart(20)}${sourceShare.padStart(21)}` +
        (suspect ? "   <-- lost by us" : "")
    );
  }
};

const main = async () => {
  const [only] = process.argv.slice(2);
  const levels = path.join(config.resourcesDir, "Levels");
  const found = [];
  for (const theme of await fs.readdir(levels, { withFileTypes: true })) {
    if (!theme.isDirectory()) continue;
    for (const area of await fs.readdir(path.join(levels, theme.name), { withFileTypes: true })) {
      if (!area.isDirectory()) continue;
      const relative = `Resources/Levels/${theme.name}/${area.name}/tiles.json`;
      try {
        await fs.access(path.join(levels, theme.name, area.name, "tiles.json"));
      } catch {
        continue;
      }
      if (only && !relative.includes(only)) continue;
      found.push(relative);
    }
  }
  for (const libraryPath of found) await audit(libraryPath);
};

await main();

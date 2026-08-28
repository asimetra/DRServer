/**
 * What is in the captures, so a question does not need a new session.
 *
 *   node tools/capture-index.js <logs-dir>            one line per capture
 *   node tools/capture-index.js <logs-dir> --node 50081   only runs on that node
 *   node tools/capture-index.js <logs-dir> --party        only runs with company
 *
 * The corpus outgrew anyone's memory of it: 47 recordings, 143MB, 27 map nodes,
 * boss floors, Infinite runs, multi-floor transitions and four heroes on one
 * floor at once. Several things this server treated as unanswerable — what a
 * party bomb does to a party, how a floor hands over to the next one — were
 * already recorded and nobody knew which file to open.
 *
 * That is the whole job here: turn "we would need to capture that" into a
 * filename.
 *
 * Its neighbour tools/capture-inventory.js answers the other half — what is
 * *inside* a set of captures, which biomes and which trap attacks — and the two
 * were written a day apart without either knowing about the other. Reach for
 * this one to choose a file and that one to see what a file contains.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadGameMaster } from "../src/gamemaster.js";
import { readCapture, mapNodeOf } from "./capture-lib.js";
import { CLID } from "../src/socket/opcodes.js";

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? true;
};

/** Interesting enough to index. Everything else is position and heading noise. */
const MARKERS = {
  216: "ending",
  215: "floorEnd",
  217: "failing",
  174: "revive",
  168: "buffFx",
  282: "chest",
};

const summarise = async (file) => {
  const seen = { records: 0, nodes: new Set(), markers: {}, peakHeroes: 0 };
  const aliveHeroes = new Set();
  let first = null;
  let last = null;

  await readCapture(file, (decoded) => {
    seen.records += 1;
    first ??= decoded.ts;
    last = decoded.ts;

    const node = mapNodeOf(decoded);
    if (node) seen.nodes.add(node);

    const marker = MARKERS[decoded.field];
    if (marker) seen.markers[marker] = (seen.markers[marker] ?? 0) + 1;

    // Heroes are counted alive rather than created: a run entered five times
    // makes five hero objects and never a party.
    if (decoded.clid === CLID.HeroGameObject) {
      aliveHeroes.add(decoded.doid);
      seen.peakHeroes = Math.max(seen.peakHeroes, aliveHeroes.size);
    } else if (decoded.opName?.startsWith("CLIENT_OBJECT_DISABLE")) {
      aliveHeroes.delete(decoded.doid);
    }
  });

  const seconds =
    first && last ? (Date.parse(last) - Date.parse(first)) / 1000 : 0;
  return { file: path.basename(file), seconds, ...seen };
};

const main = async () => {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node tools/capture-index.js <logs-dir> [--node ID] [--party]");
    process.exit(2);
  }

  const gm = await loadGameMaster();
  const nodeName = new Map(gm.raw.MapPage.map((row) => [row.Id, row.Name]));
  const wantedNode = argument("node") ? Number(argument("node")) : null;
  const partyOnly = process.argv.includes("--party");

  const files = (await fs.readdir(dir))
    .filter((name) => name.startsWith("socket-") && name.endsWith(".jsonl"))
    .sort();

  const rows = [];
  for (const name of files) rows.push(await summarise(path.join(dir, name)));

  const shown = rows.filter(
    (row) =>
      (!wantedNode || row.nodes.has(wantedNode)) && (!partyOnly || row.peakHeroes > 1)
  );

  console.log(
    `${rows.length} captures, ${shown.length} shown` +
      (wantedNode ? ` on node ${wantedNode}` : "") +
      (partyOnly ? ", with more than one hero on the floor" : "")
  );
  console.log();

  for (const row of shown.sort((a, b) => b.peakHeroes - a.peakHeroes || b.records - a.records)) {
    const nodes = [...row.nodes]
      .map((id) => `${id} ${nodeName.get(id) ?? "?"}`)
      .join("; ");
    const marks = Object.entries(row.markers)
      .map(([key, count]) => `${key}=${count}`)
      .join(" ");
    console.log(
      `${row.file}  ${String(Math.round(row.seconds)).padStart(4)}s  ` +
        `${String(row.records).padStart(7)} rec  heroes=${row.peakHeroes}`
    );
    if (nodes) console.log(`    ${nodes}`);
    if (marks) console.log(`    ${marks}`);
  }
};

main();

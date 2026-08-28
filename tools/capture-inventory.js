/**
 * What a set of captures actually contains.
 *
 * Answers the question worth asking before any trap investigation: is the thing
 * I am about to reason about even in the logs? Absence of a trap from a capture
 * is not evidence about the trap — it is evidence about where the session went.
 *
 *   node tools/capture-inventory.js ~/Documents/logs/socket-*.jsonl
 *   node tools/capture-inventory.js --traps ~/Documents/logs/socket-*.jsonl
 *
 * Its neighbour tools/capture-index.js answers the other half — which file to
 * open, by map node, by party, by what happened in it.
 *
 * Reads the capture in place and prints a summary. Nothing is written, and
 * nothing from a capture belongs in this repository — they carry live session
 * tokens and other players' accounts.
 */
import fs from "node:fs";
import readline from "node:readline";
import { loadGameMaster } from "../src/gamemaster.js";

const OP_UPDATE_FIELD = 124;
const OP_GENERATE = new Set([134, 135, 136]);
const FIELD = { state: 141, choreography: 143, npcResult: 144, heroResult: 160 };

/**
 * A generate carries its class fields after the 16-byte header, and an NPC's
 * type is the first of them that names a known NPC. Scanning for it rather than
 * fixing an offset keeps this working across the three generate opcodes, whose
 * headers differ.
 */
const npcTypeOf = (body, npcName) => {
  for (let at = 16; at + 4 <= Math.min(body.length, 40); at += 1) {
    const name = npcName.get(body.readUInt32LE(at));
    if (name) return name;
  }
  return null;
};

const readCapture = async (file, npcName, attackName) => {
  const owner = new Map();
  const npcs = new Set();
  const traps = new Map();
  const attacks = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  for await (const line of rl) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row.hex || row.dir !== "in") continue;
    const body = Buffer.from(row.hex, "hex");

    if (OP_GENERATE.has(row.op) && body.length >= 20) {
      const name = npcTypeOf(body, npcName);
      if (name) {
        owner.set(body.readUInt32LE(12), name);
        npcs.add(name);
      }
      continue;
    }
    if (row.op !== OP_UPDATE_FIELD) continue;

    const doid = body.readUInt32LE(2);
    const field = body.readUInt16LE(6);
    if (field === FIELD.choreography && body.length >= 29) {
      const attack = attackName.get(body.readUInt32LE(10));
      if (attack) attacks.add(attack);
    }
    const name = owner.get(doid);
    if (!name) continue;
    const counts = traps.get(name) ?? { doids: new Set(), state: 0, choreography: 0, result: 0 };
    counts.doids.add(doid);
    if (field === FIELD.state) counts.state += 1;
    if (field === FIELD.choreography) counts.choreography += 1;
    if (field === FIELD.npcResult || field === FIELD.heroResult) counts.result += 1;
    traps.set(name, counts);
  }
  return { npcs, traps, attacks };
};

const main = async () => {
  const args = process.argv.slice(2);
  const wantTraps = args.includes("--traps");
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (!files.length) {
    console.error("usage: node tools/capture-inventory.js [--traps] <socket-*.jsonl>");
    process.exit(2);
  }

  const gm = await loadGameMaster();
  const npcName = new Map([...gm.npcByConstant.values()].map((npc) => [npc.Id, npc.Constant]));
  const attackName = new Map([...gm.attacksByConstant.values()].map((a) => [a.Id, a.Constant]));

  const biomes = new Map();
  const traps = new Map();
  const attacks = new Set();
  for (const file of files) {
    const seen = await readCapture(file, npcName, attackName);
    for (const attack of seen.attacks) attacks.add(attack);
    for (const npc of seen.npcs) {
      const biome = npc.split("_").slice(0, 2).join("_");
      const entry = biomes.get(biome) ?? { npcs: new Set(), files: new Set() };
      entry.npcs.add(npc);
      entry.files.add(file);
      biomes.set(biome, entry);
    }
    for (const [name, counts] of seen.traps) {
      if (!/TRAP|SLICER|GARGOYLE|EMITTER|STATUE/.test(name)) continue;
      const total = traps.get(name) ?? { doids: 0, state: 0, choreography: 0, result: 0 };
      traps.set(name, {
        doids: total.doids + counts.doids.size,
        state: total.state + counts.state,
        choreography: total.choreography + counts.choreography,
        result: total.result + counts.result,
      });
    }
  }

  console.log(`${files.length} capture(s)\n`);
  console.log("biomes visited");
  for (const [biome, entry] of [...biomes].sort((a, b) => b[1].npcs.size - a[1].npcs.size)) {
    if (entry.npcs.size < 5) continue;
    console.log(`  ${biome.padEnd(24)} ${String(entry.npcs.size).padStart(3)} NPCs`);
  }

  console.log("\ntrap attacks the server ever animated");
  for (const attack of [...attacks].filter((a) => /^TRAP|^SLICER/.test(a)).sort()) {
    console.log(`  ${attack}`);
  }

  if (!wantTraps) return;
  console.log("\ntraps present, and what they did");
  console.log(`  ${"trap".padEnd(36)}${"doids".padStart(6)}${"state".padStart(8)}${"anim".padStart(7)}${"result".padStart(8)}`);
  const rank = (t) => t.choreography * 1000 + t.state;
  for (const [name, t] of [...traps].sort((a, b) => rank(b[1]) - rank(a[1]))) {
    console.log(
      `  ${name.padEnd(36)}${String(t.doids).padStart(6)}${String(t.state).padStart(8)}` +
        `${String(t.choreography).padStart(7)}${String(t.result).padStart(8)}`
    );
  }
};

await main();

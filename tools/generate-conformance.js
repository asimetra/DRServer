#!/usr/bin/env node
/**
 * Every field the official sends about a prop, against every value this server
 * could send for it.
 *
 *   node tools/generate-conformance.js <logs-dir>
 *   node tools/generate-conformance.js <logs-dir> --field layer
 *   node tools/generate-conformance.js <logs-dir> --constant NORDIC_CAVE_EMITTER
 *
 * The generate is where a prop's whole appearance is settled — which plane it
 * draws on, which way it faces, how big it is, whether it is switched on — and
 * a wrong field there is a bug you can see without a bug you can catch. The
 * layer rule was exactly that: `DefaultLayer` on an NPC row read as a fallback
 * for a placement that named none, which put two constants under the floor and
 * showed up in play as "the tile looks wrong".
 *
 * Finding it took a hand-run comparison of one prop. This is that comparison
 * for all of them at once, and it is only possible because both halves are
 * knowable ahead of time:
 *
 *   - what the official sent is in the corpus, one generate per placement;
 *   - what *we* would send is a pure function of the NPC row and the tile
 *     object, so every placement in every library can be evaluated without
 *     running a dungeon.
 *
 * So the test is a containment check. Collect the official's observed values
 * for a field, collect the values our rules can produce across every placement
 * of that constant, and report anything the official sent that we cannot. That
 * asymmetry matters: we may legitimately produce values the corpus never
 * happened to show, but a value the official sent and we can never reach is a
 * rule that is wrong.
 *
 * Fields are limited to the ones a placement settles on its own. `hitPoints`
 * and `level` are checked separately, because those depend on the hero rather
 * than the tile, and `state`/`triggerState` depend on wiring this cannot
 * evaluate standing still.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadGameMaster, npcForConstant } from "../src/gamemaster.js";
import { layerFor } from "../src/socket/objects.js";
import { captureFiles, decode, mapNodeOf } from "./capture-lib.js";
import { npcMaxHitPoints } from "../src/npc-stats.js";
import { headingFor } from "../src/socket/dungeon.js";
import { facingOf } from "../src/socket/floors.js";

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const CLID_NPC = 27;

/**
 * The library types that can end up as a distributed actor.
 *
 * `LEProp` looks like client-only scenery and mostly is, but not always: the
 * ice caves place `NORDIC_CAVE_GROUND_ICESTALAGMITE_A` as a prop and the
 * official generates it as an NPC all the same. Leaving it out made this tool
 * report the stalagmite's scales as unreachable when the tile data holds every
 * one of them — a false alarm from the filter, not a bug in the server.
 */
const PLACED_TYPES = new Set(["LETriggerable", "LENPC", "LENPCGenerator", "LEProp"]);

/** Sequential reader; the generate is a stream of fields with no offsets. */
class Reader {
  constructor(buffer) {
    this.b = buffer;
    this.o = 0;
  }
  u8() { return this.b.readUInt8(this.o++); }
  i8() { const v = this.b.readInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  utf() { const n = this.u16(); const s = this.b.toString("utf8", this.o, this.o + n); this.o += n; return s; }
}

/**
 * DistributedNPCGameObject's required block, in the order
 * DistributedNPCGameObjectNetworkComponent.generate reads it.
 */
const decodeNpc = (hex) => {
  const r = new Reader(Buffer.from(hex, "hex"));
  r.u16();                       // opcode
  r.u32();                       // parent
  r.u32();                       // zone
  if (r.u16() !== CLID_NPC) return null;
  r.u32();                       // doid
  const npcType = r.u32();
  const level = r.u8();
  r.f32(); r.f32();              // position
  const heading = r.f32();
  const scale = r.f32();
  const flip = r.u8();
  const hitPoints = r.u32();
  for (let i = 0; i < 4; i += 1) {
    r.u32(); r.u16(); r.u8(); r.u8(); r.u32(); r.u32(); r.u32();
  }
  r.utf();                       // state
  const team = r.i8();
  const layer = r.i8();
  const triggerState = r.u8();
  const masterId = r.u32();
  return { npcType, level, heading, scale, flip, hitPoints, team, layer, triggerState, masterId };
};

/** Every tile object that becomes an actor, by constant. */
const placementsByConstant = async (levelsDir) => {
  const found = new Map();
  const walk = async (dir) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The generated test floors are ours, not the game's.
        if (entry.name !== "trap-test") await walk(full);
        // Floors name twenty libraries and only nine of them are called
        // tiles.json; the rest are the boss rooms and the gauntlets, which is
        // where the Loki statues and the prison props live.
      } else if (entry.name === "tiles.json" || entry.name.startsWith("db_tiles_")) {
        const library = JSON.parse(await fs.promises.readFile(full, "utf8"));
        for (const tile of library.LETiles ?? []) {
          for (const object of tile.LEObjects ?? []) {
            if (!object.constant) continue;
            if (!PLACED_TYPES.has(object.type)) continue;
            if (!found.has(object.constant)) found.set(object.constant, []);
            found.get(object.constant).push(object);
          }
        }
      }
    }
  };
  await walk(levelsDir);
  return found;
};

/**
 * What this server would put on the wire for one placement. Mirrors spawnNpc;
 * anything that reads the session rather than the tile is left out.
 *
 * The heading has to go through `facingOf` first, which is what readPlacements
 * does before spawnNpc ever sees a placement. Handing the raw tile object to
 * `headingFor` asks it for a `heading` property that only exists downstream of
 * that call, so it fell through to zero for every prop in the game — and this
 * tool then reported the official's rotations as values "this server can never
 * produce". Sixty constants, all of them phantoms.
 */
const oursFor = (npc, placement) => ({
  layer: layerFor(npc, placement.layer),
  heading: Math.round(headingFor(npc, { ...placement, heading: facingOf(placement) })),
  scale: Number((placement.scale ?? npc.Scale ?? 1).toFixed(2)),
  // The wire carries a byte, so the tile's boolean is compared as one.
  flip: placement.flip ? 1 : 0,
});

const FIELDS = ["layer", "heading", "scale", "flip"];

/**
 * Health is priced from three things and a generate carries one of them. The
 * level is on the wire; how many players are in the room and how deep an
 * infinite run has gone are session facts a capture cannot be read for. Pricing
 * every generate as a solo first floor made whole dungeons look wrong.
 *
 * How wrong is answerable, though, because the level term is the only thing
 * depth touches. Take the health the official charged, divide out the flat and
 * the per-level rate, and ask what level would have justified it: in every
 * ordinary dungeon in the corpus — ICE_CAVES_5, CATACOMBS_9, TEMPLE_4,
 * VILLAGE_GRINDER_II, TRIBAL_GRINDER_II, TUTORIAL — the answer is the level on
 * the wire, to three decimal places. `flat + rate * 10 * level^1.5` is exactly
 * what the official charges. Only INFINITE_* runs come out above 1, and they
 * come out above 1 because they are deeper.
 *
 * So the honest comparison is the ordinary floors, where depth is zero by
 * definition and party size is the only unknown left. Infinite runs are counted
 * apart rather than folded in, because a number this tool cannot know is not a
 * disagreement — and reporting it as one is how it spent its life crying wolf.
 */
const healthCache = new Map();
const reachableHealth = (gm, row, level, official) => {
  const key = `${row.Constant}|${level}|${official}`;
  if (healthCache.has(key)) return healthCache.get(key);
  const prices = [1, 2, 3, 4, 5].map((heroes) => npcMaxHitPoints(gm, row, level, heroes));
  /**
   * The dearest price, not the solo one, when nothing matches. An actor met
   * mid-fight in a party of two sits below what a party of two would pay and
   * above what one player would — reporting the solo price would call a wounded
   * pet a disagreement about pets.
   */
  const answer = prices.includes(official) ? official : Math.max(...prices);
  healthCache.set(key, answer);
  return answer;
};

/** INFINITE_* map nodes scale with depth, which no capture states. */
const isInfiniteRun = (gm, mapNodeId) =>
  /^INFINITE/.test(String(gm?.mapNodeById?.get(Number(mapNodeId))?.Constant ?? ""));

const main = async () => {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node tools/generate-conformance.js <logs-dir> [--field F] [--constant C]");
    process.exit(2);
  }
  const onlyField = argument("field");
  const onlyConstant = argument("constant");

  const gm = await loadGameMaster();
  const nameOf = new Map();
  for (const row of Object.values(gm.raw).flat()) {
    if (row && row.Id && row.CharType && row.Constant) nameOf.set(row.Id, row.Constant);
  }

  const levels = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "local-data", "Resources", "Levels");
  const placements = await placementsByConstant(levels);

  /** constant -> field -> Set of values the official sent. */
  const official = new Map();
  const seen = new Map();
  /**
   * Only the recordings of the official server. The client logs its traffic
   * wherever it is pointed and this directory holds both, so without the filter
   * the sweep compares this server against its own past output — which is how
   * the tutorial's knights came to "disagree" 107 times.
   */
  const files = (await captureFiles(dir, { officialOnly: true })).map((f) => path.basename(f));

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, file)),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.op !== 134 && record.op !== 135) continue;
      let npc;
      try { npc = decodeNpc(record.hex); } catch { continue; }
      if (!npc) continue;
      const constant = nameOf.get(npc.npcType);
      if (!constant || (onlyConstant && constant !== onlyConstant)) continue;

      seen.set(constant, (seen.get(constant) ?? 0) + 1);
      if (!official.has(constant)) official.set(constant, { layer: new Map(), heading: new Map(), scale: new Map(), flip: new Map() });
      const row = official.get(constant);
      const tally = (field, value) => row[field].set(value, (row[field].get(value) ?? 0) + 1);
      tally("layer", npc.layer);
      tally("heading", Math.round(npc.heading));
      tally("scale", Number(npc.scale.toFixed(2)));
      tally("flip", npc.flip);
    }
  }

  console.log(
    `${official.size} constants generated across ${files.length} captures, ` +
      `checked against ${placements.size} placed in the tile data\n`
  );

  const findings = [];
  let checked = 0;
  for (const [constant, fields] of official) {
    const npc = await npcForConstant(constant);
    const placed = placements.get(constant);
    // A constant the tile data never places is spawned some other way — a
    // generator's minion, a hero's placeable — and has no placement to compare.
    if (!npc || !placed?.length) continue;
    checked += 1;

    const reachable = { layer: new Set(), heading: new Set(), scale: new Set(), flip: new Set() };
    for (const placement of placed) {
      const mine = oursFor(npc, placement);
      for (const field of FIELDS) reachable[field].add(mine[field]);
    }

    for (const field of FIELDS) {
      if (onlyField && field !== onlyField) continue;
      for (const [value, count] of fields[field]) {
        if (reachable[field].has(value)) continue;
        findings.push({ constant, field, value, count, reachable: [...reachable[field]].sort() });
      }
    }
  }

  console.log(`${checked} constants had both a placement and a generate to compare\n`);
  if (!findings.length) {
    console.log("no field the official sent is out of this server's reach.");
  } else {
    console.log("the official sent a value this server can never produce:\n");
    console.log(`${"constant".padEnd(38)} ${"field".padEnd(8)} ${"sent".padEnd(10)} ours`);
    for (const f of findings.sort((a, b) => b.count - a.count)) {
      console.log(
        `${f.constant.slice(0, 37).padEnd(38)} ${f.field.padEnd(8)} ` +
          `${String(f.value).padEnd(4)} x${String(f.count).padEnd(4)} ${JSON.stringify(f.reachable)}`
      );
    }
  }

  /**
   * Health is not a placement's to settle, so it is checked as a formula: at
   * the level the same generate carried, does npc-stats reproduce the number?
   */
  console.log("\nhealth, priced at the level each generate carried:");
  let agree = 0;
  let skipped = 0;
  let wounded = 0;
  let disagree = [];
  // Every capture, not the first twelve: the ones that disagreed loudest —
  // SKELETON_WARRIOR and STATIONARY_KNIGHT deep in an infinite run — were all
  // in files this never opened.
  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, file)),
      crlfDelay: Infinity,
    });
    const pending = [];
    let infinite = false;
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const node = mapNodeOf(decode(record) ?? {});
      if (node) infinite ||= isInfiniteRun(gm, node);
      if (record.op !== 134 && record.op !== 135) continue;
      let npc;
      try { npc = decodeNpc(record.hex); } catch { continue; }
      if (!npc) continue;
      const constant = nameOf.get(npc.npcType);
      if (!constant || (onlyConstant && constant !== onlyConstant)) continue;
      const row = await npcForConstant(constant);
      if (!row) continue;
      pending.push({ constant, npc, row });
    }
    // The map node arrives with the area, before any monster, but a run is only
    // known to be ordinary once the file has been read to the end.
    if (infinite) { skipped += pending.length; continue; }
    for (const { constant, npc, row } of pending) {
      const mine = reachableHealth(gm, row, npc.level, npc.hitPoints);
      if (mine === npc.hitPoints) agree += 1;
      else if (npc.hitPoints < mine) wounded += 1;
      else disagree.push(`${constant} L${npc.level}: official ${npc.hitPoints}, ours ${mine}`);
    }
  }
  const worst = new Map();
  for (const line of disagree) {
    const key = line.split(" L")[0];
    worst.set(key, (worst.get(key) ?? 0) + 1);
  }
  console.log(`  ${agree} agree, ${disagree.length} differ`);
  /**
   * A generate carries *current* health, not maximum, so an actor the client
   * meets mid-fight arrives below its price and is no disagreement at all. The
   * specters make it plain: RED_SPECTER generates at 0 and is told to die eight
   * milliseconds later, having been killed before this client could see it.
   *
   * Only a value *above* what the formula can reach is a rule that is wrong,
   * which is why the two are counted apart.
   */
  console.log(`  ${wounded} below their price: generated mid-fight, already hurt`);
  console.log(`  ${skipped} not compared: infinite runs, whose depth no capture states`);
  for (const [constant, count] of [...worst].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${constant.padEnd(38)} x${count}   e.g. ${disagree.find((d) => d.startsWith(constant))}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * What each prop *does* over its life, official against ours.
 *
 *   node tools/behaviour-conformance.js <official-logs> [our-logs]
 *   node tools/behaviour-conformance.js <official-logs> logs --constant NORDIC_TEMPLE_TRAP_STATUE_LOKI
 *   node tools/behaviour-conformance.js <official-logs> logs --only-differences
 *
 * `generate-conformance.js` checks the moment a prop arrives — its layer, its
 * facing, its size. That found the layer rule and the rotation field, and it
 * cannot find anything that goes wrong afterwards. Every complaint left over is
 * of the second kind: the flames that are drawn once and never again, the
 * statue that fired a single shot, the button that switches off when you step
 * away from it, the trap that never activates at all.
 *
 * So this reads the same corpus for the other half. For every constant it
 * builds a profile out of the field updates its instances receive:
 *
 *   fires    143, the attack choreography — an animation, one per activation
 *   beat     the median gap between two of them on one instance
 *   toggles  141, remoteTriggerState — switched on and off
 *   shape    the on/off sequence a typical instance takes, "1" or "1010"
 *   states   138, the death state, which a prop should never be sent
 *   aims     133, a heading update after generate: something that turns
 *
 * Given two directories it diffs them, and the asymmetry is deliberate: a
 * constant the corpus never exercised says nothing about ours, but a constant
 * the official animates and we never do is a trap that does not go off, and one
 * we send a field the official never sends is something we invented.
 *
 * The corpus is the official's own play, so counts vary with how long a floor
 * was stood on. Only the *shape* is compared — does it ever fire, does it ever
 * toggle, is its beat within a quarter of theirs — because that is what
 * survives a different session.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadGameMaster } from "../src/gamemaster.js";

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const CLID_NPC = 27;
const FIELD = { state: 138, trigger: 141, fire: 143, aim: 133 };

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);

/** Enough of a generate to learn which constant a doid is. */
const npcTypeOf = (b) => {
  if (b.length < 20 || u16(b, 10) !== CLID_NPC) return null;
  return { doid: u32(b, 12), type: u32(b, 16) };
};

/**
 * One directory of captures, folded into a profile per constant.
 *
 * Instances are followed individually and then summarised, because the
 * interesting numbers are per-instance: a floor with forty spike beds firing
 * once each looks identical in the aggregate to one bed firing forty times.
 */
const profile = async (dir, nameOf, onlyConstant) => {
  const files = (await fs.promises.readdir(dir)).filter(
    (name) => name.startsWith("socket-") && name.endsWith(".jsonl")
  );

  /** constant -> doid -> { fire: [timestamps], trigger: [values], state, aim } */
  const seen = new Map();

  for (const file of files) {
    const doidType = new Map();
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, file)),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const hex = record.hex ?? "";
      if (hex.length < 16) continue;
      const b = Buffer.from(hex, "hex");

      if (record.op === 134 || record.op === 135) {
        const generate = npcTypeOf(b);
        if (generate) doidType.set(generate.doid, generate.type);
        continue;
      }
      if (record.op !== 124) continue;

      const doid = u32(b, 2);
      const type = doidType.get(doid);
      if (type === undefined) continue;
      const constant = nameOf.get(type);
      if (!constant || (onlyConstant && constant !== onlyConstant)) continue;

      const field = u16(b, 6);
      if (!Object.values(FIELD).includes(field)) continue;

      if (!seen.has(constant)) seen.set(constant, new Map());
      const instances = seen.get(constant);
      // Keyed by file as well as doid: two sessions reuse the same numbers.
      const key = `${file}:${doid}`;
      if (!instances.has(key)) {
        instances.set(key, { fire: [], trigger: [], state: 0, aim: 0 });
      }
      const instance = instances.get(key);

      if (field === FIELD.fire) instance.fire.push(Date.parse(record.ts));
      else if (field === FIELD.trigger) instance.trigger.push(b.readUInt8(8));
      else if (field === FIELD.state) instance.state += 1;
      else if (field === FIELD.aim) instance.aim += 1;
    }
  }

  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b2) => a - b2);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const out = new Map();
  for (const [constant, instances] of seen) {
    const gaps = [];
    const fires = [];
    const toggles = [];
    const shapes = new Map();
    let states = 0;
    let aims = 0;

    for (const instance of instances.values()) {
      fires.push(instance.fire.length);
      toggles.push(instance.trigger.length);
      states += instance.state;
      aims += instance.aim;
      instance.fire.sort((a, b2) => a - b2);
      for (let i = 1; i < instance.fire.length; i += 1) {
        gaps.push(instance.fire[i] - instance.fire[i - 1]);
      }
      if (instance.trigger.length) {
        const shape = instance.trigger.join("").slice(0, 6);
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      }
    }

    out.set(constant, {
      instances: instances.size,
      fires: median(fires) ?? 0,
      everFires: fires.some((count) => count > 0),
      beat: median(gaps),
      toggles: median(toggles) ?? 0,
      everToggles: toggles.some((count) => count > 0),
      shape: [...shapes].sort((a, b2) => b2[1] - a[1])[0]?.[0] ?? "",
      states,
      aims,
    });
  }
  return out;
};

/** What separates two profiles of the same constant, in words. */
const differences = (official, ours) => {
  const found = [];
  if (official.everFires && !ours.everFires) {
    found.push("never animates — the official sends it an attack choreography and we send none");
  }
  if (!official.everFires && ours.everFires) {
    found.push("animates when the official never does");
  }
  if (official.beat && ours.beat) {
    const ratio = ours.beat / official.beat;
    if (ratio > 1.25 || ratio < 0.8) {
      found.push(`beat ${Math.round(ours.beat)}ms against ${Math.round(official.beat)}ms`);
    }
  }
  if (official.everFires && ours.everFires && official.fires > 1 && ours.fires <= 1) {
    found.push(`fires once and stops — the official's instances fire ${official.fires} times`);
  }
  if (official.everToggles && !ours.everToggles) {
    found.push("never switches — the official toggles its trigger state");
  }
  if (!official.everToggles && ours.everToggles) {
    found.push("switches when the official leaves it alone");
  }
  if (official.shape && ours.shape && official.shape !== ours.shape) {
    found.push(`switch pattern "${ours.shape}" against "${official.shape}"`);
  }
  if (!official.states && ours.states) {
    found.push("sent a death state the official never sends it");
  }
  if (official.aims && !ours.aims) {
    found.push("never turns — the official sends it heading updates");
  }
  return found;
};

const main = async () => {
  const officialDir = process.argv[2];
  const ourDir = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
  if (!officialDir) {
    console.error(
      "usage: node tools/behaviour-conformance.js <official-logs> [our-logs] [--constant C] [--only-differences]"
    );
    process.exit(2);
  }
  const onlyConstant = argument("constant");
  const onlyDifferences = process.argv.includes("--only-differences");

  const gm = await loadGameMaster();
  const nameOf = new Map();
  for (const row of Object.values(gm.raw).flat()) {
    if (row && row.Id && row.CharType && row.Constant) nameOf.set(row.Id, row.Constant);
  }

  const official = await profile(officialDir, nameOf, onlyConstant);
  console.log(`${official.size} constants exercised in ${officialDir}\n`);

  if (!ourDir) {
    console.log(
      `${"constant".padEnd(38)} ${"n".padStart(4)} ${"fires".padStart(6)} ${"beat".padStart(7)} ` +
        `${"toggles".padStart(8)} ${"shape".padEnd(8)} aims`
    );
    for (const [constant, row] of [...official].sort((a, b) => b[1].instances - a[1].instances)) {
      console.log(
        `${constant.slice(0, 37).padEnd(38)} ${String(row.instances).padStart(4)} ` +
          `${String(row.fires).padStart(6)} ${String(row.beat ?? "-").padStart(7)} ` +
          `${String(row.toggles).padStart(8)} ${row.shape.padEnd(8)} ${row.aims}`
      );
    }
    console.log(
      "\nGive a second directory to diff ours against it:\n" +
        `  DR_CAPTURE_DIR=logs npm start   then   node tools/behaviour-conformance.js ${officialDir} logs`
    );
    return;
  }

  const ours = await profile(ourDir, nameOf, onlyConstant);
  const shared = [...official.keys()].filter((constant) => ours.has(constant));
  console.log(`${ours.size} exercised in ${ourDir}; ${shared.length} in both\n`);

  let flagged = 0;
  for (const constant of shared.sort()) {
    const found = differences(official.get(constant), ours.get(constant));
    if (!found.length) {
      if (!onlyDifferences) console.log(`  ${constant.padEnd(40)} matches`);
      continue;
    }
    flagged += 1;
    console.log(`  ${constant}`);
    for (const line of found) console.log(`      ${line}`);
  }

  const untested = [...official.keys()].filter((constant) => !ours.has(constant));
  console.log(`\n${flagged} of ${shared.length} shared constants differ.`);
  if (untested.length) {
    console.log(
      `${untested.length} the official exercised and our capture did not reach — ` +
        "play those floors, or generate them with tools/trap-map.js."
    );
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

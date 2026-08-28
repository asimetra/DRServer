#!/usr/bin/env node
/**
 * How often things actually swing, on either server.
 *
 *   node tools/cadence.js [<capture-dir>]
 *
 * Attack rate is a gap between two frames and not a field in either, which is
 * why it survived every census this repository has run: both servers send the
 * same message with the same contents, and only the spacing differs. The
 * enemies were half again too quick for a week under a green test suite.
 *
 * Two sides, because they are paced by different machines:
 *
 *   monsters, whose cadence this server owns — `AttackTimer` plus a fresh
 *   uniform roll of `AttackTimeRand` per swing, which is what the official's
 *   distributions show: the p05 of each constant sits on its timer and the
 *   spread matches its rand;
 *
 *   the hero, whose cadence this server does not own at all. The client gates
 *   it on the attack's own timeline divided by
 *   `AttackSpd x speed stat x buff x weapon speed`, and of those four the
 *   server supplies only the weapon's identity. So the hero's row here is not
 *   a thing to fix — it is a thing to compare, and a floor well under the
 *   official's for the same attack means the difference is in the data sent,
 *   not in any pacing decision.
 *
 * Percentiles rather than a mean: the tail is engagements interrupted by
 * chasing, not cadence, and it drags a mean anywhere you like. p05 is the floor
 * the pacing actually enforces and it is the number worth reading.
 */
import fs from "node:fs";
import path from "node:path";
import { framesOf, decodeGenerate, GENERATE_OPS } from "./wire.js";
import { attackById, loadGameMaster } from "../src/gamemaster.js";

const REFERENCE_CAPTURES = process.env.ODS_REFERENCE_CAPTURES ?? "";

/** Below this a percentile describes a handful of swings and nothing else. */
const MIN_SAMPLE = 8;

/** Longer than this is a fight that stopped, not a rhythm. */
const MAX_GAP_MS = 15000;

const FLID_ATTACK_CHOREOGRAPHY = 143; // an NPC swings
const FLID_PROPOSE_ATTACK = 172; // the hero asks to

const percentile = (sorted, at) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))];

const collect = async (dir) => {
  const gm = await loadGameMaster();
  const npcById = new Map((gm.raw.Npc ?? []).map((row) => [row.Id, row]));
  const monsters = new Map();
  const hero = new Map();

  const captures = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("socket-") && name.endsWith(".jsonl"))
    .sort();

  for (const capture of captures) {
    // Per capture: doids are only meaningful inside the session that issued them.
    const constantOf = new Map();
    const lastSwing = new Map();
    const lastAsk = new Map();

    for await (const { body, out, at, truncated } of framesOf(path.join(dir, capture))) {
      const op = body.readUInt16LE(0);
      if (GENERATE_OPS.has(op)) {
        if (truncated) continue;
        const decoded = decodeGenerate(body);
        if (decoded.error || decoded.class !== "DistributedNPCGameObject") continue;
        const constant = npcById.get(decoded.fields.type)?.Constant;
        if (constant) constantOf.set(decoded.doid, constant);
        continue;
      }
      if (op !== 124 || body.length < 8 || !Number.isFinite(at)) continue;
      const field = body.readUInt16LE(6);

      if (field === FLID_ATTACK_CHOREOGRAPHY && !out) {
        const constant = constantOf.get(body.readUInt32LE(2));
        if (!constant) continue;
        note(monsters, constant, body.readUInt32LE(2), at, lastSwing);
        continue;
      }
      // u8 weaponSlot, u8 isConsumable, u32 attackType
      if (field === FLID_PROPOSE_ATTACK && out && body.length >= 14) {
        const attackType = body.readUInt32LE(10);
        note(hero, attackType, attackType, at, lastAsk);
      }
    }
  }
  return { monsters, hero, captures: captures.length, npcById };
};

/** One gap, keyed by whatever the caller groups on and spaced per actor. */
const note = (into, key, actor, at, last) => {
  const previous = last.get(actor);
  last.set(actor, at);
  if (previous === undefined) return;
  const gap = at - previous;
  if (gap <= 0 || gap > MAX_GAP_MS) return;
  const list = into.get(key) ?? [];
  list.push(gap);
  into.set(key, list);
};

const report = (title, rows) => {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log("   nothing swung often enough to have a rhythm.");
    return;
  }
  console.log("     n     p05    p25    p50    p75      authored");
  for (const row of rows) {
    console.log(
      `  ${String(row.n).padStart(5)}  ${String(row.p05).padStart(6)} ${String(row.p25).padStart(6)} ` +
        `${String(row.p50).padStart(6)} ${String(row.p75).padStart(6)}   ${row.authored.padEnd(14)} ${row.name}`
    );
  }
};

const main = async () => {
  const dir = process.argv[2] ?? REFERENCE_CAPTURES;
  if (!dir) {
    console.error("usage: node tools/cadence.js <capture-dir>");
    console.error("or set ODS_REFERENCE_CAPTURES");
    process.exitCode = 2;
    return;
  }
  const { monsters, hero, captures, npcById } = await collect(dir);
  const rows = (map) => [...map].filter(([, list]) => list.length >= MIN_SAMPLE);

  console.log(`${captures} capture(s) from ${dir}`);

  const byConstant = (gm) =>
    rows(monsters)
      .map(([constant, list]) => {
        const sorted = [...list].sort((a, b) => a - b);
        const npc = [...npcById.values()].find((row) => row.Constant === constant);
        return {
          name: constant,
          n: sorted.length,
          p05: percentile(sorted, 0.05),
          p25: percentile(sorted, 0.25),
          p50: percentile(sorted, 0.5),
          p75: percentile(sorted, 0.75),
          authored: `${npc?.AttackTimer ?? "?"}s + ${npc?.AttackTimeRand ?? 0}s`,
        };
      })
      .sort((a, b) => b.n - a.n);

  report("monsters — p05 should sit on AttackTimer, p75-p05 on AttackTimeRand:", byConstant());

  const heroRows = [];
  for (const [type, list] of rows(hero)) {
    const sorted = [...list].sort((a, b) => a - b);
    const attack = await attackById(type);
    heroRows.push({
      name: attack?.Constant ?? String(type),
      n: sorted.length,
      p05: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      authored: `spd ${attack?.AttackSpd ?? "?"} cd ${attack?.CooldownLength ?? 0}`,
    });
  }
  heroRows.sort((a, b) => b.n - a.n);
  report("hero — paced by the client; compare p05 with the official's, per attack:", heroRows);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

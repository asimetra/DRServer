#!/usr/bin/env node
/**
 * Measures the server-owned delay from NPC choreography to CombatResult.
 *
 *   node tools/npc-impact-delay.js <capture-dir>
 *   node tools/npc-impact-delay.js <official-client-log-dir> --official
 *
 * Both endpoints are inbound to the capturing client, so the result does not
 * mix client/server clock directions. Repeated casts are paired FIFO by
 * attacker and attack id; samples beyond ten seconds are discarded.
 */
import { captureFiles } from "./capture-lib.js";
import { framesOf } from "./wire.js";
import { loadGameMaster } from "../src/gamemaster.js";

const target = process.argv[2];
if (!target) {
  console.error("usage: node tools/npc-impact-delay.js <capture-dir> [--official]");
  process.exit(2);
}

const gm = await loadGameMaster();
const attacks = new Map(gm.raw.Attack.map((row) => [Number(row.Id), row]));
const files = await captureFiles(target, { officialOnly: process.argv.includes("--official") });
const samples = new Map();

for (const file of files) {
  const pending = new Map();
  for await (const frame of framesOf(file)) {
    const body = frame.body;
    if (frame.out || body.length < 8 || body.readUInt16LE(0) !== 124) continue;
    const doid = body.readUInt32LE(2);
    const field = body.readUInt16LE(6);

    if (field === 143 && body.length >= 29) {
      const attackType = body.readUInt32LE(10);
      const queue = pending.get(doid) ?? [];
      queue.push({ attackType, at: frame.at });
      pending.set(doid, queue.filter((cast) => frame.at - cast.at < 10_000));
      continue;
    }

    if (![144, 160].includes(field) || body.length < 45) continue;
    const attacker = body.readUInt32LE(8);
    const attackType = body.readUInt32LE(22);
    const queue = pending.get(attacker) ?? [];
    const index = queue.findIndex((cast) => cast.attackType === attackType);
    if (index < 0) continue;
    const [cast] = queue.splice(index, 1);
    pending.set(attacker, queue);

    const delay = frame.at - cast.at;
    if (delay < 0 || delay > 10_000) continue;
    const constant = attacks.get(attackType)?.Constant ?? String(attackType);
    const group = samples.get(constant) ?? [];
    group.push(delay);
    samples.set(constant, group);
  }
}

const percentile = (values, share) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * share)];
};

const paired = [...samples.values()].reduce((count, values) => count + values.length, 0);
console.log(`${files.length} files, ${paired} paired NPC results`);
for (const [constant, values] of [...samples].sort((a, b) => b[1].length - a[1].length)) {
  console.log(
    `${String(values.length).padStart(5)} ${constant.padEnd(42)} ` +
    `p05=${String(percentile(values, 0.05)).padStart(4)} ` +
    `p50=${String(percentile(values, 0.5)).padStart(4)} ` +
    `p95=${String(percentile(values, 0.95)).padStart(4)}`
  );
}

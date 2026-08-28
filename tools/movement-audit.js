#!/usr/bin/env node
/**
 * How fast honest play looks, per sample and averaged.
 *
 *   node tools/movement-audit.js logs/*.jsonl
 *   node tools/movement-audit.js logs/*.jsonl --top-speed 500
 *
 * A speed rule needs a threshold, and a threshold picked by reasoning is a
 * threshold that punishes lag. The recordings settle it instead: they were made
 * by the official client on the official server, so every displacement in them
 * is legitimate, and the highest number this prints is the lowest threshold that
 * would not have accused somebody innocent.
 *
 * It reports the same quantity at several window lengths because that is the
 * whole decision. Per sample the measure is useless — the client's position
 * arrives on the network's schedule, so a delayed packet followed by a prompt
 * one collapses the denominator and the quotient explodes, with the honest p99
 * landing above twice the legal top speed. Averaged over long enough, the
 * jitter cancels and a sustained cheat does not.
 *
 * Floor transitions are excluded: a new floor is a new baseline, not a
 * displacement, and counting one as movement invents a teleport.
 *
 * Companions: `tools/wall-audit.js` scores the geometric rules for correctness,
 * `tools/bench-navigation.js` scores them for cost. This one covers the rules
 * that need no geometry at all.
 */
import path from "node:path";
import { decodeGenerate, framesOf, GENERATE_OPS } from "./wire.js";

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1] ?? fallback;
};

const FLID_POSITION = 147;
const OP_FIELD_UPDATE = 124;

/** Long enough that a delayed packet is a gap, short enough to be a real pause. */
const MAX_GAP_MS = 30000;

const WINDOWS_MS = [0, 1000, 5000, 15000, 30000];

const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

const main = async () => {
  const files = process.argv.slice(2).filter((arg) => arg.endsWith(".jsonl"));
  if (!files.length) {
    console.error("usage: node tools/movement-audit.js <capture.jsonl> [more...]");
    process.exit(1);
  }
  const topSpeed = Number(argument("top-speed", 500));

  const gaps = [];
  const distances = [];
  const speedsByWindow = new Map(WINDOWS_MS.map((w) => [w, []]));

  for (const file of files) {
    let previous = null;
    let accumulated = new Map(WINDOWS_MS.map((w) => [w, { distance: 0, elapsed: 0 }]));
    const reset = () => {
      previous = null;
      accumulated = new Map(WINDOWS_MS.map((w) => [w, { distance: 0, elapsed: 0 }]));
    };

    try {
      for await (const { body, out, at } of framesOf(file)) {
        const op = body.readUInt16LE(0);

        if (GENERATE_OPS.has(op)) {
          const decoded = decodeGenerate(body);
          if (!decoded.error && decoded.class === "DistributedDungeonFloor") reset();
          continue;
        }

        // Only the client's own claims, and only where a position fits.
        if (op !== OP_FIELD_UPDATE || !out || body.length < 16) continue;
        if (body.readUInt16LE(6) !== FLID_POSITION) continue;

        const claim = { x: body.readFloatLE(8), y: body.readFloatLE(12), at };
        if (previous && Number.isFinite(at)) {
          const elapsed = at - previous.at;
          if (elapsed > 0 && elapsed < MAX_GAP_MS) {
            const distance = Math.hypot(claim.x - previous.x, claim.y - previous.y);
            gaps.push(elapsed);
            distances.push(distance);
            for (const window of WINDOWS_MS) {
              // Window zero is the per-sample case, reported for the contrast.
              if (window === 0) {
                speedsByWindow.get(0).push((distance / elapsed) * 1000);
                continue;
              }
              const bucket = accumulated.get(window);
              bucket.distance += distance;
              bucket.elapsed += elapsed;
              if (bucket.elapsed >= window) {
                speedsByWindow.get(window).push((bucket.distance / bucket.elapsed) * 1000);
                bucket.distance = 0;
                bucket.elapsed = 0;
              }
            }
          }
        }
        previous = claim;
      }
    } catch (error) {
      console.error(`${path.basename(file)}: unreadable — ${error.message}`);
    }
  }

  if (!gaps.length) {
    console.error("no position pairs found — are these client-side captures?");
    process.exit(1);
  }

  const row = (label, values, unit) =>
    console.log(
      `  ${label.padEnd(20)} med ${quantile(values, 0.5).toFixed(0).padStart(6)}` +
        `  p90 ${quantile(values, 0.9).toFixed(0).padStart(6)}` +
        `  p99 ${quantile(values, 0.99).toFixed(0).padStart(6)}` +
        `  max ${Math.max(...values).toFixed(0).padStart(8)}  ${unit}`
    );

  console.log(`\n${gaps.length} consecutive position pairs, top speed taken as ${topSpeed}\n`);
  row("sample gap", gaps, "ms");
  row("distance moved", distances, "units");

  console.log("\naverage speed by window (units/s)\n");
  for (const window of WINDOWS_MS) {
    const values = speedsByWindow.get(window);
    if (!values.length) continue;
    const label = window === 0 ? "one sample" : `${window / 1000}s window`;
    const highest = Math.max(...values);
    console.log(
      `  ${label.padEnd(20)} med ${quantile(values, 0.5).toFixed(0).padStart(6)}` +
        `  p99 ${quantile(values, 0.99).toFixed(0).padStart(6)}` +
        `  max ${highest.toFixed(0).padStart(8)}` +
        `   (${(highest / topSpeed).toFixed(1)}x top speed)`
    );
  }

  console.log(
    `\nEvery number here was produced by honest play, so the safe threshold for a\n` +
      `window is above its maximum. A rule that fires below it accuses the innocent.`
  );
};

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

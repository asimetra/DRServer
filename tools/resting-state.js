#!/usr/bin/env node
/**
 * Which traps this server puts on the floor in the wrong state.
 *
 *   node tools/resting-state.js <ours-dir> [<official-dir>]
 *   node tools/resting-state.js --layouts --seeds=20
 *
 * A trap's resting state is the first thing a player sees of it and the last
 * thing a packet census notices. Both servers send the same field on the same
 * object; only the value differs, and only sometimes — so a count of field 141
 * looks identical while a temple room of thirty spikes is flat plates on one
 * side and raised on the other.
 *
 * That was the shape of the last three bugs found by playing:
 *
 *   fires generated lit that the official generates dark;
 *   mines armed the wrong way round in a corpus read with a shifted offset;
 *   thirty stranded spikes forced retracted that the official leaves up.
 *
 * Each of them is one number against another number, and none of them showed up
 * in anything that counted messages. This compares the numbers.
 *
 * The comparison is per constant across whole corpora rather than per object on
 * a matched floor, which is the weaker of the two and honest about it: a rate is
 * meaningful here because the resting state is mostly a property of the row and
 * its wiring, and the official's own rates are stable — NORDIC_TEMPLE_TRAP_SPIKE
 * is raised 730 times against 193 across fifty-four recordings. Where a floor
 * can be matched exactly, `replay-floor.js` is the better oracle.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGenerate, framesOf, GENERATE_OPS } from "./wire.js";
import {
  attackForConstant,
  loadGameMaster,
  npcForConstant,
  projectileForConstant,
} from "../src/gamemaster.js";
import { buildFloor } from "../src/socket/floors.js";
import { loadNavigationLibrary } from "../src/socket/navigation.js";
import { initialTargetState, trackTriggers } from "../src/socket/triggers.js";
import { isInert, restingTriggerState } from "../src/socket/dungeon.js";

const REFERENCE_CAPTURES = process.env.ODS_REFERENCE_CAPTURES ?? "";

/** Below this many sightings a rate is noise; the official's own vary by a few. */
const MIN_SAMPLE = 6;

/** How far two rates may drift before it is worth a person's attention. */
const TOLERANCE = 0.35;

const census = async (dir, { npcById, traps }) => {
  const seen = new Map();
  const captures = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("socket-") && name.endsWith(".jsonl"))
    .sort();

  for (const capture of captures) {
    for await (const { body, truncated } of framesOf(path.join(dir, capture))) {
      if (truncated || !GENERATE_OPS.has(body.readUInt16LE(0))) continue;
      const decoded = decodeGenerate(body);
      if (decoded.error || decoded.trailing !== 0) continue;
      if (decoded.class !== "DistributedNPCGameObject") continue;

      const constant = npcById.get(decoded.fields.type)?.Constant;
      if (!constant || !traps.has(constant)) continue;
      const entry = seen.get(constant) ?? { armed: 0, idle: 0 };
      decoded.fields.remoteTriggerState ? (entry.armed += 1) : (entry.idle += 1);
      seen.set(constant, entry);
    }
  }
  return { seen, captures: captures.length };
};

/**
 * This server's side taken from floors it lays rather than from recordings.
 *
 * A capture only holds the rooms somebody walked through, and the rule that
 * matters most here — what happens to a trap nothing on the floor can switch —
 * only applies to a laid-out floor. Two sessions reached ten constants; twenty
 * seeds across nine libraries reach a hundred and forty, and they are the same
 * decisions the running server would make because they are made by the same
 * code.
 */
const fromLayouts = async ({ seeds, traps }) => {
  await loadNavigationLibrary();
  const levels = path.join(
    path.dirname(fileURLToPath(import.meta.url)), "..", "local-data", "Resources", "Levels"
  );
  const themes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/replay|focus-|trap-test|bench-/.test(entry.name)) walk(full);
      } else if (entry.name === "tiles.json") {
        themes.push(path.relative(levels, path.dirname(full)));
      }
    }
  };
  walk(levels);

  const seen = new Map();
  for (const theme of themes) {
    for (let seed = 1; seed <= seeds; seed += 1) {
      let floor;
      try {
        floor = await buildFloor(`Resources/Levels/${theme}/tiles.json`, { tier: 10, tileCount: 16, seed });
      } catch { continue; }
      const session = { floorGenerated: true };
      trackTriggers(session, floor);
      for (const placement of floor.placements.triggerable ?? []) {
        if (!traps.has(placement.constant)) continue;
        const npc = await npcForConstant(placement.constant);
        const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
        const projectile = attack?.Projectile
          ? await projectileForConstant(attack.Projectile)
          : null;
        const state = restingTriggerState({
          npc,
          attack,
          projectile,
          inert: isInert(session, placement.id),
          wired: initialTargetState(session, placement.id),
        });
        const entry = seen.get(placement.constant) ?? { armed: 0, idle: 0 };
        state ? (entry.armed += 1) : (entry.idle += 1);
        seen.set(placement.constant, entry);
      }
    }
  }
  return { seen, captures: `${themes.length} libraries x ${seeds} layouts` };
};

const main = async () => {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--seeds="));
  const [ours, official = REFERENCE_CAPTURES] = positional;
  if (!ours || !official) {
    console.error("usage: node tools/resting-state.js <ours-dir> [<official-dir>]");
    console.error("or set ODS_REFERENCE_CAPTURES for the second directory");
    process.exit(2);
  }

  const gm = await loadGameMaster();
  const npcById = new Map();
  /** Only things that can be switched: a trap's state is the question here. */
  const traps = new Set();
  for (const row of gm.raw.Npc ?? []) {
    npcById.set(row.Id, row);
    if (row.Attack1 || /TRAP|GATE|SPIKE|PLACEABLE|EMITTER|CAGE|JAIL/.test(row.Constant ?? "")) {
      traps.add(row.Constant);
    }
  }

  const theirs = await census(official, { npcById, traps });
  const seeds = Number((process.argv.find((a) => a.startsWith("--seeds=")) ?? "").split("=")[1]);
  const mine = ours === "--layouts"
    ? await fromLayouts({ seeds: Number.isFinite(seeds) ? seeds : 20, traps })
    : await census(ours, { npcById, traps });

  const rate = (entry) => entry.armed / (entry.armed + entry.idle);
  const total = (entry) => entry.armed + entry.idle;

  const rows = [];
  const thin = [];
  for (const [constant, official_] of theirs.seen) {
    const local = mine.seen.get(constant);
    if (!local) continue;
    if (total(official_) < MIN_SAMPLE || total(local) < MIN_SAMPLE) {
      thin.push(constant);
      continue;
    }
    const drift = Math.abs(rate(official_) - rate(local));
    if (drift > TOLERANCE) rows.push({ constant, official: official_, local, drift });
  }
  rows.sort((a, b) => b.drift - a.drift);

  console.log(
    `${theirs.captures} official capture(s) against ${mine.captures} of ours; ` +
      `${theirs.seen.size} switchable constants there, ${mine.seen.size} here.\n`
  );

  if (!rows.length) {
    console.log("no constant rests differently on the two servers by more than " +
      `${Math.round(TOLERANCE * 100)} points.`);
  } else {
    console.log("   official armed/idle    ours armed/idle    constant");
    for (const row of rows) {
      const say = (entry) =>
        `${String(entry.armed).padStart(5)}/${String(entry.idle).padEnd(5)} ${String(Math.round(rate(entry) * 100)).padStart(3)}%`;
      console.log(`   ${say(row.official)}      ${say(row.local)}     ${row.constant}`);
    }
  }

  if (thin.length) {
    console.log(
      `\n${thin.length} constant(s) seen fewer than ${MIN_SAMPLE} times on one side and left out; ` +
        "play or replay more of them before reading anything into their rates."
    );
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

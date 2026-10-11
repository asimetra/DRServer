#!/usr/bin/env node
/**
 * How the monsters of a set of captures crowd round the hero, counted by
 * tools/crowd-metrics.js — the same counts `tools/ai-sim.js --stats` gives
 * for our AI.
 *
 *   node tools/crowd-corpus.js <logs-dir> [--official] [--all-runs] [--json]
 *
 * Solo runs only, unless `--all-runs`: a solo run is one distinct
 * `playerID` among the heroes generated, whatever the number of floors. The
 * hero is where the client proposed it (its own field 147 going out); a
 * monster is where the server last placed it (field 132), sampled every
 * 250 ms, which is the AI's tick on ours. A swing is a choreography (143),
 * a shot when its attack (the u32 after the weapon slot) throws a
 * projectile; the official sends no target in it, so a swing with a pet
 * nearer the monster than the hero is left out. `hitAgoMs` on a sample is how
 * long since its hit points last fell, for asking whether a hit held it.
 *
 * `readTimeline` and `sampleTimeline` are exported for one-off questions
 * (`createCrowdMetrics`' `onSwing` and `onDue` see every swing and every due
 * sample with what it was decided on).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attackForConstant, loadGameMaster } from "../src/gamemaster.js";
import { authoredBodyRadius } from "../src/socket/body.js";
import { loadNavigationLibrary, navigationEntryFor } from "../src/socket/navigation.js";
import { npcAttackChoices } from "../src/socket/npc-attacks.js";
import { CLID } from "../src/socket/opcodes.js";
import { captureFiles } from "./capture-lib.js";
import { createCrowdMetrics, crowdProfile, describeCrowd, mergeCrowd } from "./crowd-metrics.js";
import { classForClid, classForName, decodeFieldUpdate, decodeGenerate, framesOf, GENERATE_OPS } from "./wire.js";

const TICK_MS = 250;
/** Every hero's body: CollisionSize 22 x Scale 1.176, its middle as far above the feet. */
const HERO_RADIUS = 25.87;
const HERO_BODY_DY = -25.87;

const lastAtOrBefore = (list, t) => {
  let lo = 0;
  let hi = list.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= t) {
      best = list[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
};

/** What a row is to the metrics, apart from where it stands: as npc-spawn.js builds its `ai`. */
const profiles = new Map();
const profileOf = async (row) => {
  if (profiles.has(row.Id)) return profiles.get(row.Id);
  const attacks = await npcAttackChoices(row, null);
  const native = row.Attack1 ? await attackForConstant(row.Attack1) : null;
  const profile = {
    constant: row.Constant,
    ...crowdProfile(
      {
        behavior: row.Aggro_AI_Type,
        moveSpeed: row.IsMover ? Number(row.BaseMove ?? 180) : 0,
        radius: authoredBodyRadius(row, row.Constant),
        attacks,
        keepDistance:
          row.Aggro_AI_Type === "CHASE_AI"
            ? 0
            : Math.max(0, Number(row.MinFleeDistMult ?? 0)) * Math.max(0, Number(native?.Range ?? 0)),
        attackRange: Math.max(20, ...attacks.map((attack) => attack.range)),
        attackTimerMs: Math.max(0, Number(row.AttackTimer ?? 1.5) * 1000),
      },
      HERO_RADIUS
    ),
    cadenceMaxMs: Math.max(0, (Number(row.AttackTimer ?? 1.5) + Number(row.AttackTimeRand ?? 0)) * 1000),
    shape: navigationEntryFor(row.Constant)?.navCollisions?.[0] ?? null,
  };
  profiles.set(row.Id, profile);
  return profile;
};

/** One capture's timeline: the hero, the monsters, the swings. */
export const readTimeline = async (file, rows) => {
  const npcClass = classForClid(CLID.DistributedNPCGameObject);
  const heroClass = classForClid(CLID.HeroGameObject);
  const players = new Set();
  const npcs = new Map();
  const hero = [];
  const heroDoids = new Set();
  for await (const { body, out, at } of framesOf(file)) {
    const op = body.readUInt16LE(0);
    if (GENERATE_OPS.has(op)) {
      if (out) continue;
      const decoded = decodeGenerate(body);
      if (decoded.error) continue;
      if (/^HeroGameObject/.test(decoded.class ?? "")) {
        if (decoded.fields.playerID !== undefined) players.add(decoded.fields.playerID);
        continue;
      }
      if (decoded.class !== "DistributedNPCGameObject") continue;
      const row = rows.get(decoded.fields.type);
      if (!row) continue;
      const [x, y] = decoded.fields.position;
      npcs.set(decoded.doid, {
        row,
        charType: row.CharType,
        scale: Number(decoded.fields.scale) > 0 ? Number(decoded.fields.scale) : Number(row.Scale ?? 1) || 1,
        from: at,
        to: Infinity,
        pos: [[at, x, y]],
        swings: [],
        hits: [],
        hp: Number(decoded.fields.hitPoints ?? 0),
      });
      continue;
    }
    if ((op === 125 || op === 126) && !out && body.length >= 6) {
      const npc = npcs.get(body.readUInt32LE(2));
      if (npc) npc.to = Math.min(npc.to, at);
      continue;
    }
    if (op !== 124 || body.length < 8) continue;
    const doid = body.readUInt32LE(2);
    const field = body.readUInt16LE(6);
    if (out) {
      if (field !== 147) continue;
      const update = decodeFieldUpdate(body, heroClass);
      if (!update.error) hero.push([at, update.value[0], update.value[1]]);
      heroDoids.add(doid);
      continue;
    }
    const npc = npcs.get(doid);
    if (!npc) continue;
    if (field === 143) {
      // i8 weapon slot, u8 consumable, u32 attack, u32 target (combat-wire.js).
      npc.swings.push(at);
      npc.swingDetails ??= [];
      npc.swingDetails.push([at, body.length >= 18 ? body.readUInt32LE(10) : 0, body.length >= 18 ? body.readUInt32LE(14) : 0]);
      continue;
    }
    const update = decodeFieldUpdate(body, npcClass);
    if (update.error) continue;
    if (update.name === "position") npc.pos.push([at, update.value[0], update.value[1]]);
    else if (update.name === "hitPoints") {
      if (update.value < npc.hp) npc.hits.push([at]);
      npc.hp = update.value;
      if (update.value <= 0) npc.to = Math.min(npc.to, at);
    }
    else if (update.name === "state" && update.value === "dead") npc.to = Math.min(npc.to, at);
  }
  return { players, npcs, hero, heroDoids };
};

/** The samples of one timeline, fed to `metrics`. */
export const sampleTimeline = async (timeline, metrics, attacks) => {
  const { npcs, hero } = timeline;
  if (hero.length < 2) return 0;
  const monsters = [];
  const pets = [];
  for (const [doid, npc] of npcs) {
    if (npc.charType === "PET") pets.push(npc);
    if (npc.charType !== "ENEMY") continue;
    const profile = await profileOf(npc.row);
    if (!profile.kind) continue;
    monsters.push({ doid, npc, profile });
  }
  const start = Math.ceil(hero[0][0] / TICK_MS) * TICK_MS;
  const end = hero.at(-1)[0];
  let samples = 0;
  const swingIndex = new Map(monsters.map(({ doid }) => [doid, 0]));
  for (let t = start; t <= end; t += TICK_MS) {
    const h = lastAtOrBefore(hero, t);
    const heroSample = h ? { x: h[1], y: h[2], bx: h[1], by: h[2] + HERO_BODY_DY, r: HERO_RADIUS } : null;
    const living = [];
    const swung = [];
    for (const { doid, npc, profile } of monsters) {
      // A swing in [t, t + tick) is the sample's: decided from where it stood at t.
      const swings = npc.swings;
      let index = swingIndex.get(doid);
      while (index < swings.length && swings[index] < t) index++;
      swingIndex.set(doid, index);
      if (t < npc.from || t >= npc.to) continue;
      if (index < swings.length && swings[index] < t + TICK_MS) {
        const detail = npc.swingDetails.find(([at]) => at >= t && at < t + TICK_MS);
        swung.push({ id: doid, shot: Boolean(attacks.get(detail?.[1])?.Projectile) });
      }
      const p = lastAtOrBefore(npc.pos, t);
      if (!p) continue;
      const shape = profile.shape;
      const bx = p[1] + (shape ? Number(shape.x ?? 0) * npc.scale : 0);
      const by = p[2] + (shape ? Number(shape.y ?? 0) * npc.scale : 0);
      const hit = lastAtOrBefore(npc.hits, t + TICK_MS);
      living.push({ hitAgoMs: hit ? t - hit[0] : Infinity, id: doid, constant: profile.constant, kind: profile.kind, mover: profile.mover, x: p[1], y: p[2], bx, by, r: profile.r, reach: profile.reach, standoffGap: profile.standoffGap, cadenceMs: profile.cadenceMs, cadenceMaxMs: profile.cadenceMaxMs });
    }
    const petsHere = pets
      .filter((pet) => t >= pet.from && t < pet.to)
      .map((pet) => lastAtOrBefore(pet.pos, t))
      .filter(Boolean)
      .map((p) => ({ x: p[1], y: p[2] }));
    metrics.sample(t, heroSample, living, swung, petsHere);
    samples++;
  }
  return samples;
};

const main = async () => {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node tools/crowd-corpus.js <logs-dir> [--official] [--all-runs] [--json]");
    process.exit(2);
  }
  const official = process.argv.includes("--official");
  const allRuns = process.argv.includes("--all-runs");
  const gm = await loadGameMaster();
  await loadNavigationLibrary();
  const rows = new Map(gm.raw.Npc.map((row) => [row.Id, row]));
  const attacks = new Map(gm.raw.Attack.map((attack) => [attack.Id, attack]));
  const files = await captureFiles(target, { officialOnly: official });
  const results = [];
  let used = 0;
  let skipped = 0;
  for (const file of files) {
    const timeline = await readTimeline(file, rows);
    if (!allRuns && timeline.players.size !== 1) {
      skipped++;
      continue;
    }
    const metrics = createCrowdMetrics({ tickMs: TICK_MS });
    const samples = await sampleTimeline(timeline, metrics, attacks);
    if (!samples) continue;
    used++;
    const result = metrics.result();
    results.push(result);
    if (process.argv.includes("--per-file")) {
      console.log(path.basename(file));
      for (const line of describeCrowd(result)) console.log(line);
    }
  }
  const merged = mergeCrowd(results);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(merged));
    return;
  }
  console.log(`${target}: ${used} solo capture(s) of ${files.length}, ${skipped} with more than one player left out`);
  for (const line of describeCrowd(merged)) console.log(line);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((problem) => {
    console.error(problem.stack ?? problem);
    process.exit(1);
  });
}

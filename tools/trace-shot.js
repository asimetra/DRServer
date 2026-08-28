#!/usr/bin/env node
/**
 * What a launcher's shot looks like, in order and with its timings.
 *
 *   node tools/trace-shot.js <logs-dir> [--constant NORDIC_TEMPLE_TRAP_STATUE_LOKI]
 *
 * Every comparison in this repository so far has been a census: how many of a
 * field went out, which values it took. A census answers "is the snapshot
 * right" and this server's snapshots are, essentially, right — forty official
 * floors rebuilt here differ in a handful of fields, and five of the six
 * differences chased this week turned out to be artefacts of the measurement.
 *
 * The bugs that were real were all in the *order*: a statue that aimed on its
 * own clock instead of before its shot, so the flame and the damage ran down
 * two different lines; nine mines that killed each other in three milliseconds
 * because a blast had no notion of sides; a fire generated lit that should have
 * arrived dark. None of those is visible in a count.
 *
 * So this reads a shot as a sequence rather than a total:
 *
 *   aim -> choreography -> (flight) -> combat result
 *
 * and prices the flight against what the projectile's own data says it should
 * be, `distance / ProjSpeed`. A launcher whose damage lands sooner than its
 * fireball could have arrived is one hitting from somewhere the player cannot
 * see it, which is exactly the report this was built to settle.
 *
 * Nothing here counts bytes: field payloads come from `wire.js`, which reads
 * them against the schema and says so when it cannot.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classForClid, decodeFieldUpdate, decodeGenerate, framesOf, GENERATE_OPS } from "./wire.js";
import { loadGameMaster, attackForConstant, projectileForConstant } from "../src/gamemaster.js";

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

/** Field ids this trace is made of, by the name the schema gives them. */
const AIM = 133;
const CHOREOGRAPHY = 143;
const RESULT_NPC = 144;
const RESULT_HERO = 160;

const at = (record) => Date.parse(`${record.ts}Z`);

/**
 * The attacker of a combat result, without counting bytes.
 *
 * A result is `attacker, attackee, damage, Attack{...}, …` and the decoder
 * flattens the nested struct, so the first two values are the two doids
 * whatever the surrounding field was.
 */
const resultPair = (value) => {
  const flat = Array.isArray(value?.[0]) ? value[0] : value;
  return { attacker: flat?.[0], attackee: flat?.[1], damage: flat?.[2] };
};

const traceOne = async (file, { constant, npcById }) => {
  const classes = new Map();
  const launchers = new Map();
  const positions = new Map();
  const shots = [];
  const open = new Map();

  for await (const { body } of framesOf(file)) {
    const op = body.readUInt16LE(0);

    if (GENERATE_OPS.has(op)) {
      const decoded = decodeGenerate(body);
      if (decoded.error || decoded.trailing !== 0) continue;
      classes.set(decoded.doid, classForClid(decoded.clid) ?? null);
      if (decoded.fields?.position) {
        positions.set(decoded.doid, { x: decoded.fields.position[0], y: decoded.fields.position[1] });
      }
      if (decoded.class === "DistributedNPCGameObject") {
        const row = npcById.get(decoded.fields.type);
        if (row?.Constant === constant) launchers.set(decoded.doid, row.Constant);
      }
      continue;
    }
    if (op !== 124) continue;

    const doid = body.readUInt32LE(2);
    const id = body.readUInt16LE(6);

    // Positions move; a shot is priced against where its victim was when hit.
    if (id === 132 || id === 147) {
      const update = decodeFieldUpdate(body, classes.get(doid));
      if (!update.error && Array.isArray(update.value)) {
        positions.set(doid, { x: update.value[0], y: update.value[1] });
      }
      continue;
    }

    if (launchers.has(doid) && (id === AIM || id === CHOREOGRAPHY)) {
      const update = decodeFieldUpdate(body, classes.get(doid));
      if (update.error) continue;
      if (id === AIM) {
        const pending = open.get(doid) ?? {};
        open.set(doid, { ...pending, aimedAt: at(update.record ?? {}) || Date.now(), aim: update.value });
        continue;
      }
      open.set(doid, { ...(open.get(doid) ?? {}), firedAt: Date.now() });
      continue;
    }

    if (id !== RESULT_NPC && id !== RESULT_HERO) continue;
    const update = decodeFieldUpdate(body, classes.get(doid));
    if (update.error) continue;
    const { attacker, attackee, damage } = resultPair(update.value);
    if (!launchers.has(attacker)) continue;

    const from = positions.get(attacker);
    const to = positions.get(attackee) ?? positions.get(doid);
    shots.push({
      attacker,
      attackee,
      damage,
      distance: from && to ? Math.hypot(to.x - from.x, to.y - from.y) : null,
      aimed: open.get(attacker)?.aim !== undefined,
    });
  }
  return shots;
};

const main = async () => {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node tools/trace-shot.js <logs-dir> [--constant NAME]");
    process.exit(2);
  }
  const constant = argument("constant") ?? "NORDIC_TEMPLE_TRAP_STATUE_LOKI";

  const gm = await loadGameMaster();
  const npcById = new Map();
  for (const row of gm.raw.Npc ?? []) npcById.set(row.Id, row);

  const npc = [...npcById.values()].find((row) => row.Constant === constant);
  const attack = npc?.Attack1 ? await attackForConstant(npc.Attack1) : null;
  const projectile = attack?.Projectile ? await projectileForConstant(attack.Projectile) : null;
  if (!projectile) {
    console.error(`${constant} does not fire a projectile`);
    process.exit(2);
  }

  const all = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith("socket-")).sort()) {
    all.push(...(await traceOne(path.join(dir, name), { constant, npcById })));
  }

  const reach = Number(projectile.Range);
  const speed = Number(projectile.ProjSpeed);
  const withDistance = all.filter((shot) => shot.distance !== null);

  console.log(`${constant} — ${all.length} landed shot(s) across ${dir}`);
  console.log(`   the data says: range ${reach}, speed ${speed} (a full flight takes ${(reach / speed).toFixed(2)}s)\n`);

  if (!withDistance.length) {
    console.log("   no shot could be placed: neither the statue nor its victim had a known position");
    return;
  }

  const distances = withDistance.map((shot) => shot.distance).sort((a, b) => a - b);
  const q = (p) => Math.round(distances[Math.floor(p * (distances.length - 1))]);
  console.log(`   distance from the statue when the damage landed, over ${distances.length} shots:`);
  console.log(`      min ${q(0)}   median ${q(0.5)}   p90 ${q(0.9)}   max ${q(1)}`);

  const beyond = withDistance.filter((shot) => shot.distance > reach);
  console.log(
    `\n   landed beyond the projectile's own range: ${beyond.length} of ${withDistance.length}` +
      (beyond.length ? "  <- a hit the fireball could not have carried" : "")
  );

  const aimed = all.filter((shot) => shot.aimed).length;
  console.log(`   preceded by an aim on the same statue: ${aimed} of ${all.length}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

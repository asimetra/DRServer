#!/usr/bin/env node
/**
 * Did the last run still show the things that were fixed?
 *
 *   node tools/verify-run.js                    the newest capture
 *   node tools/verify-run.js --capture <file>
 *   node tools/verify-run.js --since 20260821   every capture from that day
 *
 * Five bugs were reported from play and closed against measurements rather than
 * against the client: scenery the client cannot draw, actors on the ground
 * plane, fires arriving lit, mines detonating each other, and a statue whose
 * flame and damage ran down different lines. Each has a signature in the
 * capture, and each of those signatures is cheaper to read than to play for.
 *
 * This asks all five of one recording, so a session answers "is it still fixed"
 * in one command instead of five investigations. It is a regression check on
 * live traffic, not a conformance oracle: it reports what this server did, and
 * says nothing about what the client made of it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classForClid, decodeFieldUpdate, decodeGenerate, framesOf, GENERATE_OPS } from "./wire.js";
import { loadGameMaster } from "../src/gamemaster.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

/** Where this server writes its own captures. */
const CAPTURES = path.join(root, "logs");

const capturesToRead = () => {
  const one = argument("capture");
  if (one) return [one];
  const since = argument("since");
  const all = fs
    .readdirSync(CAPTURES)
    .filter((name) => name.startsWith("socket-") && name.endsWith(".jsonl"))
    .sort();
  const wanted = since ? all.filter((name) => name.slice(7) >= since) : all.slice(-1);
  return wanted.map((name) => path.join(CAPTURES, name));
};

const RESULT_FIELDS = new Set([144, 160]);

/** Constants in the Npc table with no Prop row: only the server can place them. */
const serverOwnedConstants = (gm) => {
  const props = new Set((gm.raw.Prop ?? []).map((row) => row.Constant));
  return new Set((gm.raw.Npc ?? []).map((row) => row.Constant).filter((c) => !props.has(c)));
};

const read = async (file, { npcById, serverOwned }) => {
  const classes = new Map();
  const named = new Map();
  const state = new Map();
  const fires = new Set();
  const seen = {
    layers: new Map(),
    scenery: 0,
    fireLit: 0,
    fireDark: 0,
    fireSwitchedOn: 0,
    mines: 0,
    mineSelfHits: 0,
    minesDestroyed: 0,
    shots: 0,
    shotsAimedFirst: 0,
  };
  const aimedRecently = new Set();

  for await (const { body } of framesOf(file)) {
    const op = body.readUInt16LE(0);

    if (GENERATE_OPS.has(op)) {
      const decoded = decodeGenerate(body);
      if (decoded.error || decoded.trailing !== 0) continue;
      classes.set(decoded.doid, classForClid(decoded.clid));
      if (decoded.class !== "DistributedNPCGameObject") continue;

      const row = npcById.get(decoded.fields.type);
      if (!row) continue;
      named.set(decoded.doid, row.Constant);
      state.set(decoded.doid, decoded.fields.remoteTriggerState);
      seen.layers.set(decoded.fields.layer, (seen.layers.get(decoded.fields.layer) ?? 0) + 1);

      /**
       * An `LEProp` with no `Prop` row, which the client cannot draw and this
       * server used to skip. Counted rather than judged, because whether a
       * floor has any at all is a property of its theme: the caves author
       * dozens and the temple none, so "none seen" is a fact about the map and
       * not about the fix.
       */
      if (serverOwned.has(row.Constant)) seen.scenery += 1;
      if (row.CharType === "BEAST" && row.Element === "FIRE") {
        fires.add(decoded.doid);
        decoded.fields.remoteTriggerState ? (seen.fireLit += 1) : (seen.fireDark += 1);
      }
      if (row.Constant === "MINE_PLACEABLE_ALL") seen.mines += 1;
      continue;
    }
    if (op === 125 || op === 126) {
      if (named.get(body.readUInt32LE(2)) === "MINE_PLACEABLE_ALL") seen.minesDestroyed += 1;
      continue;
    }
    if (op !== 124) continue;

    const doid = body.readUInt32LE(2);
    const id = body.readUInt16LE(6);
    const constant = named.get(doid);

    if (id === 141 && constant) {
      const update = decodeFieldUpdate(body, classes.get(doid));
      if (update.error) continue;
      // Only a fire counts here; every trap in the game toggles.
      if (fires.has(doid) && update.value === 1 && state.get(doid) === 0) seen.fireSwitchedOn += 1;
      state.set(doid, update.value);
      continue;
    }
    if (id === 133 && constant?.includes("STATUE_LOKI")) { aimedRecently.add(doid); continue; }
    if (id === 143 && constant?.includes("STATUE_LOKI")) {
      seen.shots += 1;
      if (aimedRecently.delete(doid)) seen.shotsAimedFirst += 1;
      continue;
    }
    if (!RESULT_FIELDS.has(id)) continue;

    const update = decodeFieldUpdate(body, classes.get(doid));
    if (update.error || !Array.isArray(update.value)) continue;
    const [attacker, attackee] = update.value;
    if (named.get(attacker) === "MINE_PLACEABLE_ALL" && named.get(attackee) === "MINE_PLACEABLE_ALL") {
      seen.mineSelfHits += 1;
    }
  }
  return seen;
};

const verdict = (ok, text) => `   ${ok ? "ok  " : "BAD "} ${text}`;

const main = async () => {
  const gm = await loadGameMaster();
  const npcById = new Map();
  for (const row of gm.raw.Npc ?? []) npcById.set(row.Id, row);

  const serverOwned = serverOwnedConstants(gm);
  const files = capturesToRead();
  if (!files.length) {
    console.error(`no captures under ${CAPTURES}`);
    process.exit(2);
  }

  const total = {
    layers: new Map(), scenery: 0, fireLit: 0, fireDark: 0, fireSwitchedOn: 0,
    mines: 0, mineSelfHits: 0, minesDestroyed: 0, shots: 0, shotsAimedFirst: 0,
  };
  for (const file of files) {
    const seen = await read(file, { npcById, serverOwned });
    for (const [key, value] of Object.entries(seen)) {
      if (key === "layers") {
        for (const [layer, n] of value) total.layers.set(layer, (total.layers.get(layer) ?? 0) + n);
      } else total[key] += value;
    }
  }

  console.log(`read ${files.length} capture(s), newest ${path.basename(files.at(-1))}\n`);

  const onGround = total.layers.get(5) ?? 0;
  console.log(verdict(onGround === 0, `layer 5: ${onGround} actor(s) on the ground plane (the official never uses it)`));
  console.log(`   --   objects only the server can place: ${total.scenery} generated (a theme may author none)`);
  console.log(
    verdict(total.fireLit === 0, `fires: ${total.fireDark} arrived dark, ${total.fireLit} arrived lit`) +
      `\n        and ${total.fireSwitchedOn} were switched on afterwards` +
      (total.fireSwitchedOn === 0 && total.fireDark > 0 ? "   <- none ever lit: nothing to see" : "")
  );
  console.log(
    verdict(
      total.mineSelfHits === 0,
      `mines: ${total.mines} placed, ${total.mineSelfHits} hit another mine, ${total.minesDestroyed} destroyed`
    )
  );
  console.log(
    verdict(
      total.shots === 0 || total.shotsAimedFirst / total.shots > 0.8,
      `loki: ${total.shotsAimedFirst} of ${total.shots} shots had an aim immediately before them` +
        ` (the official manages 71 of 84)`
    )
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

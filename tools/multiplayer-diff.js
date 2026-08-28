#!/usr/bin/env node
/**
 * Ordered, DOID-independent comparison for one multiplayer client perspective.
 *
 *   node tools/multiplayer-diff.js official.jsonl local-session.jsonl
 *   node tools/multiplayer-diff.js official.jsonl logs/run-directory
 *
 * Raw bytes cannot compare two runs: object ids, timestamps and account ids are
 * expected to differ. Aggregate rates cannot compare multiplayer either: owner
 * and remote creates have different contracts and their order is gameplay.
 * This tool assigns stable per-capture roles, decodes fields through wire.js,
 * drops position/heading noise by default and compares the ordered milestones.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureFiles, mapNodeOf, readCapture } from "./capture-lib.js";
import {
  classForClid,
  classForName,
  decodeFieldUpdate,
  decodeGenerate,
  GENERATE_OPS,
} from "./wire.js";
import { OP, opcodeName } from "../src/socket/opcodes.js";

const NOISY_FIELDS = new Set(["position", "heading"]);
const VALUE_FIELDS = new Set([
  "state",
  "hitPoints",
  "manaPoints",
  "experiencePoints",
  "dungeonBusterPoints",
  "basicCurrency",
  "remoteTriggerState",
  "collectedBy",
  "dungeonEnding",
  "floorFailing",
  "floorEnding",
  "ClientRequestEntryResponce",
  "ClientExitComplete",
]);
const ROLE_REFERENCE_FIELDS = new Set(["collectedBy", "PartyBomb", "affectedActor", "sourceActor"]);

const roundedPosition = (value) =>
  Array.isArray(value) && value.length >= 2
    ? `${Math.round(Number(value[0]))},${Math.round(Number(value[1]))}`
    : null;

const concise = (value) => {
  if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toFixed(3));
  if (typeof value === "string" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) {
    if (value.length > 12) return `[${value.length} items]`;
    return value.map(concise);
  }
  return String(value);
};

const baseIdentity = (generated, objects) => {
  const owner = generated.class.endsWith("Owner");
  const family = generated.class.replace(/Owner$/, "");
  if (family === "PlayerGameObject") return `${owner ? "owner" : "remote"}:player`;
  if (family === "HeroGameObject") return `${owner ? "owner" : "remote"}:hero`;
  if (family === "DistributedDungionArea") return "area";
  if (family === "DistributedDungeonFloor") return "floor";
  if (family === "DistributedDungeonSummary") return "summary";

  const fields = generated.fields ?? {};
  const type = fields.type ?? fields.dooberType ?? fields.buffType ?? fields.mapNodeId ?? "?";
  const position = roundedPosition(fields.position);
  if (family === "DistributedNPCGameObject") return `npc:${type}${position ? `@${position}` : ""}`;
  if (family === "DistributedDooberGameObject") return `doober:${type}${position ? `@${position}` : ""}`;
  if (family === "DistributedBuffGameObject") {
    const affected = objects.get(fields.affectedActor)?.role ?? "actor";
    return `buff:${type}->${affected}`;
  }
  return `${owner ? "owner:" : ""}${family}:${type}`;
};

const eventKey = (event) => {
  const value = event.value === undefined ? "" : `=${JSON.stringify(event.value)}`;
  if (event.type === "create") {
    return `${event.direction} create ${event.role} parent=${event.parent}`;
  }
  if (event.type === "update") {
    return `${event.direction} update ${event.role}.${event.field}${value}`;
  }
  if (event.type === "disable") {
    return `${event.direction} ${event.owner ? "owner-" : ""}disable ${event.role}`;
  }
  if (event.type === "interest") return `${event.direction} interest ${event.role}`;
  return `${event.direction} ${event.type}`;
};

/** One capture reduced to stable, ordered semantic events. */
export const semanticTrace = async (
  file,
  { bothDirections = false, includeNoisy = false } = {}
) => {
  const objects = new Map();
  const counters = new Map();
  const activeHeroes = new Set();
  const nodes = new Set();
  const events = [];
  let peakHeroes = 0;
  let unreadable = 0;

  await readCapture(file, (decoded, record) => {
    if (!bothDirections && decoded.dir !== "in") return;
    if (decoded.op === OP.CLIENT_HEART_BEAT) return;
    const node = mapNodeOf(decoded);
    if (node) nodes.add(node);
    const body = Buffer.from(record.hex ?? "", "hex");
    const direction = decoded.dir;

    if (GENERATE_OPS.has(decoded.op)) {
      const generated = decodeGenerate(body);
      if (generated.error || generated.trailing !== 0) {
        unreadable += 1;
        return;
      }
      const base = baseIdentity(generated, objects);
      const ordinal = (counters.get(base) ?? 0) + 1;
      counters.set(base, ordinal);
      const role = `${base}#${ordinal}`;
      const parent = generated.parent === 0
        ? "root"
        : objects.get(generated.parent)?.role ?? "unresolved";
      const definition = classForName(generated.class) ?? classForClid(generated.clid);
      objects.set(generated.doid, { role, definition, class: generated.class });
      if (generated.class.replace(/Owner$/, "") === "HeroGameObject") {
        activeHeroes.add(generated.doid);
        peakHeroes = Math.max(peakHeroes, activeHeroes.size);
      }
      events.push({ direction, type: "create", role, parent, class: generated.class });
      return;
    }

    if (decoded.op === OP.CLIENT_OBJECT_UPDATE_FIELD) {
      const object = objects.get(decoded.doid);
      const update = decodeFieldUpdate(body, object?.definition);
      const field = update.name ?? `field${decoded.field}`;
      if (!includeNoisy && NOISY_FIELDS.has(field)) return;
      let value;
      if (VALUE_FIELDS.has(field) && !update.error) {
        value = concise(update.value);
        if (ROLE_REFERENCE_FIELDS.has(field) && typeof update.value === "number") {
          value = objects.get(update.value)?.role ?? "unresolved";
        }
      }
      events.push({
        direction,
        type: "update",
        role: object?.role ?? "unresolved",
        field,
        value,
      });
      return;
    }

    if (
      decoded.op === OP.CLIENT_OBJECT_DISABLE_RESP ||
      decoded.op === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP ||
      decoded.op === OP.CLIENT_OBJECT_DELETE_RESP
    ) {
      const object = objects.get(decoded.doid);
      events.push({
        direction,
        type: "disable",
        role: object?.role ?? "unresolved",
        owner: decoded.op === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP,
      });
      activeHeroes.delete(decoded.doid);
      objects.delete(decoded.doid);
      return;
    }

    if (decoded.op === OP.CLIENT_INTEREST_CONTEXT) {
      const doid = body.length >= 8 ? body.readUInt32LE(4) : 0;
      events.push({ direction, type: "interest", role: objects.get(doid)?.role ?? "unresolved" });
      return;
    }

    events.push({ direction, type: opcodeName(decoded.op) });
  });

  return {
    file,
    events: events.map((event) => ({ ...event, key: eventKey(event) })),
    nodes: [...nodes],
    peakHeroes,
    unreadable,
  };
};

/** Greedy bounded alignment: readable and stable for long event streams. */
export const diffSemanticTraces = (expected, actual, { lookahead = 40 } = {}) => {
  const left = expected.events ?? expected;
  const right = actual.events ?? actual;
  const differences = [];
  let i = 0;
  let j = 0;

  while (i < left.length || j < right.length) {
    if (left[i]?.key === right[j]?.key) {
      i += 1;
      j += 1;
      continue;
    }
    if (i >= left.length) {
      differences.push({ type: "extra", actual: right[j++].key });
      continue;
    }
    if (j >= right.length) {
      differences.push({ type: "missing", expected: left[i++].key });
      continue;
    }

    const actualMatch = right.slice(j + 1, j + 1 + lookahead)
      .findIndex((event) => event.key === left[i].key);
    const expectedMatch = left.slice(i + 1, i + 1 + lookahead)
      .findIndex((event) => event.key === right[j].key);
    if (actualMatch >= 0 && (expectedMatch < 0 || actualMatch <= expectedMatch)) {
      for (let count = 0; count <= actualMatch; count += 1) {
        differences.push({ type: "extra", actual: right[j++].key });
      }
      continue;
    }
    if (expectedMatch >= 0) {
      for (let count = 0; count <= expectedMatch; count += 1) {
        differences.push({ type: "missing", expected: left[i++].key });
      }
      continue;
    }
    differences.push({ type: "changed", expected: left[i++].key, actual: right[j++].key });
  }
  return differences;
};

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? true;
};

const main = async () => {
  const positional = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const [officialFile, localTarget] = positional;
  if (!officialFile || !localTarget) {
    console.error("usage: node tools/multiplayer-diff.js <official.jsonl> <local.jsonl|capture-dir> [--both] [--noisy] [--limit N]");
    process.exit(2);
  }

  const options = {
    bothDirections: process.argv.includes("--both"),
    includeNoisy: process.argv.includes("--noisy"),
  };
  const expected = await semanticTrace(officialFile, options);
  const locals = [];
  for (const file of await captureFiles(localTarget)) {
    const trace = await semanticTrace(file, options);
    locals.push({ trace, diff: diffSemanticTraces(expected, trace) });
  }
  locals.sort((a, b) => a.diff.length - b.diff.length);
  const limit = Number(argument("limit") ?? 30);

  console.log(
    `official ${path.basename(officialFile)}: ${expected.events.length} events, ` +
      `party=${expected.peakHeroes}, nodes=${expected.nodes.join(",") || "?"}`
  );
  for (const { trace, diff } of locals) {
    console.log(
      `\nlocal ${path.basename(trace.file)}: ${trace.events.length} events, ` +
        `party=${trace.peakHeroes}, nodes=${trace.nodes.join(",") || "?"}, differences=${diff.length}`
    );
    for (const item of diff.slice(0, limit)) {
      if (item.type === "missing") console.log(`  - missing  ${item.expected}`);
      else if (item.type === "extra") console.log(`  + extra    ${item.actual}`);
      else console.log(`  ~ expected ${item.expected}\n    actual   ${item.actual}`);
    }
    if (diff.length > limit) console.log(`  ... ${diff.length - limit} more`);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

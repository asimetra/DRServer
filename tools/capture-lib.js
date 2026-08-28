/**
 * One decoder for both sides of the wire.
 *
 * The client's logger annotates what it records — `field`, `fieldName`,
 * `clidName` — and `DR_CAPTURE` on our own probe writes only `{ts, dir, op,
 * len, hex}`. Reading the annotations would mean the two streams are compared
 * through different eyes, and the whole point of capturing our own output was
 * to remove that asymmetry. So nothing here trusts them: every record is
 * decoded from `hex`, and a capture from either side reads the same.
 *
 * The layouts are the ones in socket/objects.js, which is the only place they
 * are written down for real:
 *
 *   124 field update  u32 doid, u16 field
 *   125/126/127       u32 doid
 *   134/135 generate  u32 parent, u32 zone, u16 clid, u32 doid
 *   136 owner         u16 clid, u32 doid, u32 parent, u32 zone
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CLID, OP, opcodeName } from "../src/socket/opcodes.js";

const clidName = (id) => Object.keys(CLID).find((key) => CLID[key] === id) ?? `CLID(${id})`;

const GENERATE = new Set([
  OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP,
  OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_RESP,
]);

/** A capture line, decoded. Returns null for anything too short to read. */
export const decode = (record) => {
  const hex = String(record.hex ?? "").replace(/[^0-9a-fA-F]/g, "");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 2) return null;

  const op = bytes.readUInt16LE(0);
  const out = {
    ts: record.ts,
    dir: record.dir ?? "in",
    op,
    opName: opcodeName(op),
    session: record.session ?? null,
    account: record.account ?? null,
    match: record.match ?? null,
    seq: record.seq ?? null,
    elapsedMs: record.elapsed_ms ?? null,
  };

  if (op === OP.CLIENT_OBJECT_UPDATE_FIELD && bytes.length >= 8) {
    out.doid = bytes.readUInt32LE(2);
    out.field = bytes.readUInt16LE(6);
    out.payload = bytes.subarray(8);
  } else if (GENERATE.has(op) && bytes.length >= 16) {
    out.parent = bytes.readUInt32LE(2);
    out.zone = bytes.readUInt32LE(6);
    out.clid = bytes.readUInt16LE(10);
    out.doid = bytes.readUInt32LE(12);
    out.clidName = clidName(out.clid);
    out.owner = false;
    out.payload = bytes.subarray(16);
  } else if (op === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP && bytes.length >= 16) {
    out.clid = bytes.readUInt16LE(2);
    out.doid = bytes.readUInt32LE(4);
    out.parent = bytes.readUInt32LE(8);
    out.zone = bytes.readUInt32LE(12);
    out.clidName = `${clidName(out.clid)}Owner`;
    out.owner = true;
    out.payload = bytes.subarray(16);
  } else if (bytes.length >= 6) {
    out.doid = bytes.readUInt32LE(2);
  }
  return out;
};

/**
 * What a record is, for counting and comparing.
 *
 * Doids and timestamps differ between any two runs and say nothing about
 * whether the two servers agree, so the kind deliberately drops them.
 */
export const kindOf = (decoded) => {
  if (decoded.field !== undefined) return `${decoded.dir} field ${decoded.field}`;
  if (decoded.clidName) return `${decoded.dir} create ${decoded.clidName}`;
  return `${decoded.dir} ${decoded.opName}`;
};

/** Streams a capture without holding it in memory; 18MB files are ordinary here. */
export const readCapture = async (path, onRecord) => {
  const stream = readline.createInterface({
    input: fs.createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const decoded = decode(record);
    if (decoded) onRecord(decoded, record);
  }
};

/** MatchMaker::ClientRequestEntry carries the map node the run was on. */
export const mapNodeOf = (decoded) => {
  if (!decoded.payload) return null;
  if (decoded.field === 297) {
    if (decoded.payload.length < 6 || decoded.payload.readUInt16LE(0) !== 0) return null;
    return decoded.payload.readUInt32LE(2) || null;
  }
  if (decoded.field !== 296) return null;
  const body = decoded.payload;
  if (body.length < 2) return null;
  const nameLength = body.readUInt16LE(0);
  const at = 2 + nameLength + 4;
  return body.length >= at + 4 ? body.readUInt32LE(at) : null;
};

/** Capture files under a target, excluding run manifests and unrelated logs. */
export const captureFiles = async (target, { officialOnly = false } = {}) => {
  const stat = await fs.promises.stat(target);
  if (stat.isFile()) return [target];
  const names = (await fs.promises.readdir(target)).sort();
  const sockets = names.filter((name) => name.startsWith("socket-") && name.endsWith(".jsonl"));
  if (!officialOnly) return sockets.map((name) => path.join(target, name));

  const official = await officialSessions(target, names);
  return sockets
    .filter((name) => official.has(stampOf(name)))
    .map((name) => path.join(target, name));
};

const stampOf = (name) => name.slice(name.indexOf("-") + 1, -".jsonl".length);

/**
 * Which addresses count as ours rather than somebody else's.
 *
 * Loopback by default, because that is where a development server runs. An
 * operator whose own deployment answers on a real hostname lists it in
 * `ODS_SELF_HOSTS` (comma-separated) so their recordings stay recognisable as
 * their own.
 */
const SELF_HOSTED = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

const selfHosts = (process.env.ODS_SELF_HOSTS ?? process.env.DR_SELF_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

const isSelfHosted = (url) =>
  SELF_HOSTED.test(url) || selfHosts.some((host) => url.toLowerCase().includes(host));

/**
 * Which recordings are of a server that is not this one.
 *
 * The client records its traffic wherever it is pointed, so one directory can
 * hold sessions against a third-party service and sessions against a local
 * build side by side, in the same format. Treating the second kind as evidence
 * means comparing this server against itself: the tutorial's knights
 * "disagreed" with npc-stats 107 times and every one of those recordings was
 * ours, from a build that priced them differently.
 *
 * Decided by exclusion rather than by naming a vendor. Anything that is not one
 * of our own addresses belongs to somebody else, which is both the honest test
 * and the one that keeps a third party's infrastructure out of this file. A URL
 * that is missing or unreadable is left out entirely: unknown is not evidence.
 */
const officialSessions = async (target, names) => {
  const rpcs = names.filter((name) => name.startsWith("rpc-") && name.endsWith(".jsonl"));
  const official = new Set();
  const stamps = [];
  for (const name of rpcs) {
    const line = await firstLine(path.join(target, name));
    let url = "";
    try { url = String(JSON.parse(line ?? "{}").url ?? ""); } catch { url = ""; }
    stamps.push({ stamp: stampOf(name), official: url !== "" && !isSelfHosted(url) });
  }
  // Every socket stamp takes the verdict of the newest rpc stamp not after it.
  for (const name of names) {
    if (!name.startsWith("socket-")) continue;
    const stamp = stampOf(name);
    const before = stamps.filter((r) => r.stamp <= stamp).pop();
    if (before?.official) official.add(stamp);
  }
  return official;
};

const firstLine = async (file) => {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { rl.close(); return line; }
  return null;
};

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { OP } from "./opcodes.js";
import { info, warn } from "../log.js";

/**
 * What this server said, in the same shape the client records.
 *
 * `tools/probe.js` could already do this, which was enough to compare a
 * scripted scenario and no use at all for the thing that actually finds bugs:
 * playing. An arrow that never appears, a trap that damages without being
 * drawn — those turn up in a real session, and the only recording of a real
 * session was the client's own, which needs the capture build. That is a
 * rebuild away every time, so in practice ours went unrecorded and every
 * comparison had one side missing.
 *
 * Written here instead, at the two points every packet passes through, so a
 * session played against this server leaves a file whether or not the client
 * is the logging one.
 *
 * The format is the client's, deliberately and exactly: `{ts, dir, op, len,
 * hex}`, one JSON object per line, the frame's length prefix stripped so `hex`
 * starts at the opcode. Every tool written against the official's recordings —
 * capture-index, capture-diff, trap-census, trap-conformance — reads this
 * without knowing which side produced it.
 *
 * Direction is written from the client's point of view for the same reason:
 * what this server sends is the client's `in`, and what it receives is the
 * client's `out`. Anything else would make the two halves incomparable at
 * exactly the moment they are put side by side.
 */
const GLOBAL_SESSION = Symbol("global-capture-session");

const stampOf = (date) => {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
};

/**
 * One packet. `body` starts at the opcode — callers strip the length prefix,
 * because a frame carries one and a received packet does not.
 */
/**
 * The login packet, with its credential replaced.
 *
 * `BuildPacketLogin` puts a utf string first and that string is the session
 * token — in the official recordings it is plainly readable on the first line
 * of every file, next to the account id. A capture is a debugging artefact that
 * gets copied into scratch directories, attached to reports and read by
 * whoever is chasing a bug, and none of that is a place for a bearer
 * credential.
 *
 * The length is kept and the bytes are not, so every offset after it still
 * lines up and the decoder reads the frame exactly as before.
 */
const REDACTED = 0x2a; // '*'

export const withoutCredentials = (body) => {
  if (body.length < 4 || body.readUInt16LE(0) !== OP.CLIENT_LOGIN_DUNGEONBUSTER) return body;
  const length = body.readUInt16LE(2);
  if (length <= 0 || 4 + length > body.length) return body;
  const masked = Buffer.from(body);
  masked.fill(REDACTED, 4, 4 + length);
  return masked;
};

export const createCaptureRecorder = ({
  directory = config.captureDir,
  clock = () => new Date(),
  monotonic = () => Number(process.hrtime.bigint() / 1_000_000n),
} = {}) => {
  const opened = new Map();
  const runStamp = stampOf(clock());
  const manifest = directory ? path.join(directory, `capture-run-${runStamp}.jsonl`) : null;

  const keyOf = (session) => session ?? GLOBAL_SESSION;
  const openStream = (session) => {
    const key = keyOf(session);
    if (opened.has(key)) return opened.get(key);
    if (!directory) {
      opened.set(key, null);
      return null;
    }

    try {
      fs.mkdirSync(directory, { recursive: true });
      const id = session?.id ?? "global";
      // One official-shaped log per client perspective. A single global file
      // interleaves owner and remote packets from every socket and cannot be
      // replayed as a multiplayer run.
      const file = path.join(directory, `socket-${stampOf(clock())}-s${id}.jsonl`);
      const stream = fs.createWriteStream(file, { flags: "a" });
      stream.on("error", (error) => warn(`capture: ${file}: ${error.message}`));
      const entry = {
        stream,
        file,
        seq: 0,
        startedAt: clock(),
        startedMono: monotonic(),
        account: session?.accountId ?? null,
        matches: new Set(),
        mapNodes: new Set(),
      };
      opened.set(key, entry);
      info(`capture: recording session ${id} to ${file}`);
      return entry;
    } catch (error) {
      warn(`capture: could not open ${directory}: ${error.message}`);
      opened.set(key, null);
      return null;
    }
  };

  const record = (session, direction, body) => {
    const entry = openStream(session);
    if (!entry?.stream || !body?.length) return false;

    const safe = withoutCredentials(body);
    entry.account ??= session?.accountId ?? null;
    if (session?.dungeonMatch?.id != null) entry.matches.add(session.dungeonMatch.id);
    if (session?.mapNodeId != null) entry.mapNodes.add(session.mapNodeId);
    const wall = clock();
    entry.stream.write(
      `${JSON.stringify({
        ts: wall.toISOString().slice(0, 23),
        dir: direction,
        op: safe.length >= 2 ? safe.readUInt16LE(0) : -1,
        len: safe.length,
        hex: safe.toString("hex").toUpperCase(),
        // Extra metadata is ignored by official-log readers and is what lets a
        // directory of local captures be correlated back into one match.
        session: session?.id ?? null,
        account: session?.accountId ?? null,
        match: session?.dungeonMatch?.id ?? null,
        seq: ++entry.seq,
        elapsed_ms: Math.max(0, monotonic() - entry.startedMono),
      })}\n`
    );
    return true;
  };

  const close = (session) => {
    const key = keyOf(session);
    const entry = opened.get(key);
    opened.delete(key);
    if (!entry?.stream) return Promise.resolve(entry?.file ?? null);
    return new Promise((resolve) => entry.stream.end(() => {
      if (manifest) {
        fs.appendFileSync(
          manifest,
          `${JSON.stringify({
            file: path.basename(entry.file),
            session: session?.id ?? null,
            account: entry.account,
            matches: [...entry.matches],
            map_nodes: [...entry.mapNodes],
            packets: entry.seq,
            started_at: entry.startedAt.toISOString(),
            ended_at: clock().toISOString(),
          })}\n`
        );
      }
      resolve(entry.file);
    }));
  };

  return {
    record,
    recordSent: (session, frame) => record(session, "in", frame.subarray(2)),
    recordReceived: (session, body) => record(session, "out", body),
    close,
    fileFor: (session) => opened.get(keyOf(session))?.file ?? null,
    manifestFile: manifest,
  };
};

const recorder = createCaptureRecorder();

/** Server→client. The client logs this as arriving, so it is written as `in`. */
export const recordSent = (session, frame) => recorder.recordSent(session, frame);

/** Client→server, which the client logs as `out`. */
export const recordReceived = (session, body) => recorder.recordReceived(session, body);

/** Flushes and releases one session's capture stream. */
export const closeSessionCapture = (session) => recorder.close(session);

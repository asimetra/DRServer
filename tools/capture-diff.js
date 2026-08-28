/**
 * Where our server and the official one disagree, read off the wire.
 *
 *   DR_CAPTURE=ours.jsonl node tools/probe.js request-entry
 *   node tools/capture-diff.js theirs.jsonl ours.jsonl
 *   node tools/capture-diff.js theirs.jsonl ours.jsonl --names ../client-worktree
 *
 * Pair comparable runs. Rates are per minute, but a seven second probe against
 * a twelve minute session still reports most of the game as missing —
 * tools/capture-index.js is there to find a recording of the same thing.
 *
 * The comparison is of *vocabulary and rate*, not of bytes. Two runs never
 * agree on a doid or a timestamp and it would mean nothing if they did, so a
 * record is reduced to what it is — a field update on 168, a create of a
 * DistributedBuffGameObject — and the two sides are compared on that.
 *
 * What it finds is the class of bug that cost the most here: not a wrong value,
 * which a test catches, but a message that was never sent at all. The buff
 * floater, the defeat countdown, the floor teardown and the bomb's own
 * explosion were each missing for weeks, each found by hand, and each would
 * have been one line of this output.
 *
 * Rates are per minute because the two recordings are never the same length. A
 * kind either side never sends is reported before anything else, since that is
 * the finding; a kind both send at wildly different rates is the next most
 * interesting, and the threshold for "wildly" is deliberately loose.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readCapture, kindOf } from "./capture-lib.js";

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
};

/**
 * Field names, if a client checkout is to hand.
 *
 * NetNames.hx is generated from the same source as the wire itself, so it is
 * the one place a number can be turned into a name without guessing.
 */
const loadNames = async (clientPath) => {
  if (!clientPath) return new Map();
  const file = path.join(clientPath, "src/brain/logger/NetNames.hx");
  try {
    const source = await fs.readFile(file, "utf8");
    return new Map(
      [...source.matchAll(/(\d+)\s*=>\s*"([^"]+)"/g)].map((m) => [Number(m[1]), m[2]])
    );
  } catch {
    console.error(`(no NetNames.hx at ${file}; reporting field ids only)`);
    return new Map();
  }
};

/**
 * Two things in the recordings are not disagreements and have to go, or they
 * drown the output:
 *
 * The client logs both directions and `DR_CAPTURE` records only what the probe
 * receives, so every client->server message would read as one the official
 * sends and we never do. Only the server's own half is compared unless --both
 * is asked for.
 *
 * And the client's logger drops heartbeats unless DR_SOCKETLOG_PING is set,
 * while ours keeps them, so they would read as ours alone.
 */
const bothDirections = process.argv.includes("--both");

const tally = async (file) => {
  const counts = new Map();
  let first = null;
  let last = null;
  await readCapture(file, (decoded) => {
    if (!bothDirections && decoded.dir !== "in") return;
    if (decoded.opName === "CLIENT_HEART_BEAT") return;
    first ??= decoded.ts;
    last = decoded.ts;
    const kind = kindOf(decoded);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  });
  const minutes = Math.max((Date.parse(last) - Date.parse(first)) / 60000, 1 / 60);
  return { counts, minutes };
};

const describe = (kind, names) =>
  kind.replace(/field (\d+)/, (whole, id) => {
    const name = names.get(Number(id));
    return name ? `field ${id} ${name}` : whole;
  });

const main = async () => {
  const [theirs, ours] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!theirs || !ours) {
    console.error("usage: node tools/capture-diff.js <theirs.jsonl> <ours.jsonl> [--names <client-worktree>]");
    process.exit(2);
  }

  const names = await loadNames(argument("names"));
  const a = await tally(theirs);
  const b = await tally(ours);

  const rate = (side, kind) => (side.counts.get(kind) ?? 0) / side.minutes;
  const kinds = new Set([...a.counts.keys(), ...b.counts.keys()]);

  const missing = [];
  const extra = [];
  const skewed = [];
  for (const kind of kinds) {
    const theirRate = rate(a, kind);
    const ourRate = rate(b, kind);
    if (theirRate > 0 && ourRate === 0) missing.push([kind, theirRate]);
    else if (ourRate > 0 && theirRate === 0) extra.push([kind, ourRate]);
    else if (theirRate > 0 && (theirRate / ourRate > 4 || ourRate / theirRate > 4)) {
      skewed.push([kind, theirRate, ourRate]);
    }
  }

  console.log(
    `theirs ${path.basename(theirs)} (${a.minutes.toFixed(1)} min) vs ` +
      `ours ${path.basename(ours)} (${b.minutes.toFixed(1)} min)\n`
  );

  const report = (title, rows, format) => {
    console.log(`${title} (${rows.length})`);
    if (!rows.length) console.log("   none");
    for (const row of rows.sort((x, y) => y[1] - x[1])) console.log("   " + format(row));
    console.log();
  };

  report("THEY SEND, WE NEVER DO", missing, ([kind, r]) =>
    `${r.toFixed(1)}/min  ${describe(kind, names)}`
  );
  report("WE SEND, THEY NEVER DO", extra, ([kind, r]) =>
    `${r.toFixed(1)}/min  ${describe(kind, names)}`
  );
  report("BOTH SEND, FOUR TIMES APART OR MORE", skewed, ([kind, t, o]) =>
    `theirs ${t.toFixed(1)}/min  ours ${o.toFixed(1)}/min  ${describe(kind, names)}`
  );
};

main();
